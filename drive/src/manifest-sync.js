/**
 * Manifest Sync Engine for DaemonClient Drive
 *
 * Bridges IndexedDB (local speed) ↔ the user's OWN per-user worker + D1.
 *
 * Previously this synced to Firestore with a 3s debounced batch writer, whose
 * only purpose was minimising Firestore write *cost*. On the user's own D1 that
 * reason is gone, so mutations are now WRITE-THROUGH: update IndexedDB
 * optimistically for instant UI, fire the worker request immediately, and revert
 * the local change if it fails. This also removes a latent bug — a debounced
 * flush via raw fetch would die on tab-close (no SDK to persist it).
 *
 * Reads come from IndexedDB (0 network); a background refresh pulls the current
 * list from the worker (one cheap D1 query) and reconciles.
 */

import { driveApi } from './api.js';
import {
    getItemsByParent,
    saveManifestItem,
    deleteManifestItem,
    replaceManifest,
    getAllManifestItems,
    getManifestCount,
    getSyncState,
    setSyncState,
    searchManifest,
    clearAllLocalData,
    getManifestItem,
    saveManifestBatch,
} from './idb-store.js';

// Worker file row → IDB item. The worker already returns `messages` as an array
// and `encrypted` as a boolean; uploadedAt is an ISO string we keep as-is (the
// UI formats it via `new Date(...)`).
function normalize(row) {
    return {
        ...row,
        messages: Array.isArray(row.messages) ? row.messages : [],
        encrypted: !!row.encrypted,
    };
}

class ManifestSyncEngine {
    constructor(uid) {
        this.uid = uid;
        this._listeners = new Set();
        this._syncing = false;
    }

    subscribe(callback) {
        this._listeners.add(callback);
        return () => this._listeners.delete(callback);
    }

    _notifyListeners(items) {
        this._listeners.forEach(cb => {
            try { cb(items); } catch (e) { console.error('[Sync] Listener error:', e); }
        });
    }

    /**
     * Initial load: IndexedDB first (instant), then a background refresh from
     * the worker. Returns local items immediately when present.
     */
    async initialLoad() {
        const localCount = await getManifestCount();
        if (localCount > 0) {
            const localItems = await getAllManifestItems();
            this._backgroundSync(); // fire-and-forget reconcile
            return localItems;
        }
        return this._fullSync();
    }

    /**
     * Pull the full file list from the per-user worker → replace IndexedDB.
     * One D1-backed request.
     */
    async _fullSync() {
        this._syncing = true;
        try {
            const { items = [] } = await driveApi('/api/drive/files');
            const norm = items.map(normalize);
            await replaceManifest(norm);
            await setSyncState(this.uid, { lastFullSync: Date.now(), itemCount: norm.length });
            return norm;
        } finally {
            this._syncing = false;
        }
    }

    async _backgroundSync() {
        try {
            const items = await this._fullSync();
            this._notifyListeners(items);
        } catch (e) {
            console.warn('[Sync] Background sync failed:', e);
        }
    }

    // ── Mutations: optimistic IndexedDB + immediate write-through ────────────

    async addItem(item) {
        const idbItem = normalize(item);
        await saveManifestItem(idbItem);
        try {
            const { item: saved } = await driveApi('/api/drive/files', {
                method: 'POST',
                body: JSON.stringify(item),
            });
            // Reconcile with the server's canonical row (id, parsed messages).
            if (saved) await saveManifestItem(normalize(saved));
            return saved ? normalize(saved) : idbItem;
        } catch (e) {
            await deleteManifestItem(item.id); // revert
            throw e;
        }
    }

    async updateItem(id, updates) {
        const existing = await getManifestItem(id);
        if (!existing) return;
        const updated = { ...existing, ...updates };
        await saveManifestItem(updated);
        try {
            await driveApi(`/api/drive/files/${encodeURIComponent(id)}`, {
                method: 'PATCH',
                body: JSON.stringify(updates),
            });
            return updated;
        } catch (e) {
            await saveManifestItem(existing); // revert
            throw e;
        }
    }

    async removeItem(id) {
        const existing = await getManifestItem(id);
        await deleteManifestItem(id);
        try {
            await driveApi(`/api/drive/files/${encodeURIComponent(id)}`, { method: 'DELETE' });
        } catch (e) {
            if (existing) await saveManifestItem(existing); // revert
            throw e;
        }
    }

    /**
     * Bulk add (folder upload). Optimistic local batch, then POST each item.
     * Limited concurrency keeps the worker + Telegram happy.
     */
    async addItemsBatch(items) {
        const idbItems = items.map(normalize);
        await saveManifestBatch(idbItems);
        const CONCURRENCY = 4;
        for (let i = 0; i < items.length; i += CONCURRENCY) {
            const slice = items.slice(i, i + CONCURRENCY);
            await Promise.all(slice.map(async (item) => {
                try {
                    const { item: saved } = await driveApi('/api/drive/files', {
                        method: 'POST', body: JSON.stringify(item),
                    });
                    if (saved) await saveManifestItem(normalize(saved));
                } catch (e) {
                    await deleteManifestItem(item.id);
                    console.error('[Sync] batch add failed for', item.fileName, e);
                }
            }));
        }
        return idbItems;
    }

    // ── Queries (IndexedDB, 0 network) ───────────────────────────────────────

    async getItemsInFolder(parentId) { return getItemsByParent(parentId); }
    async search(query) { return searchManifest(query); }
    async getCount() { return getManifestCount(); }

    // Write-through means nothing is buffered; these are no-ops kept for the
    // existing call sites (logout / beforeunload).
    async forceSync() { /* writes are immediate */ }

    async destroy() {
        this._listeners.clear();
    }

    async hardReset() {
        await clearAllLocalData();
        return this._fullSync();
    }
}

// ── Singleton factory ────────────────────────────────────────────────────────

let _instance = null;
let _instanceUid = null;

export function getSyncEngine(uid) {
    if (_instance && _instanceUid === uid) return _instance;
    if (_instance) _instance.destroy();
    _instance = new ManifestSyncEngine(uid);
    _instanceUid = uid;
    return _instance;
}

export async function destroySyncEngine() {
    if (_instance) {
        await _instance.destroy();
        _instance = null;
        _instanceUid = null;
    }
}

export default ManifestSyncEngine;
