/**
 * Manifest Sync Engine for DaemonClient
 * 
 * Bridges IndexedDB (local speed) ↔ Firestore (cloud truth).
 * 
 * Architecture:
 * ─────────────────────────────────────────────────────
 * 1. On app load: Read from IndexedDB first (instant, 0 Firestore reads)
 * 2. Then sync with Firestore in background (1 read)
 * 3. On mutations: Update IndexedDB immediately (optimistic UI)
 *    → Debounce Firestore write (batch multiple changes into 1 write)
 * 4. Periodic version check: Only re-read if remote version changed
 * ─────────────────────────────────────────────────────
 * 
 * Cost savings:
 * - Old: N reads per folder (1 per file) + onSnapshot per change
 * - New: 1 read per session (manifest doc) + 1 write per batch of changes
 */

import firebase from 'firebase/compat/app';
import 'firebase/compat/firestore';
import {
    getItemsByParent,
    saveManifestItem,
    saveManifestBatch,
    deleteManifestItem,
    replaceManifest,
    getAllManifestItems,
    getManifestCount,
    getSyncState,
    setSyncState,
    searchManifest,
    clearAllLocalData,
    getManifestItem,
} from './idb-store.js';

let _db = null;
const getDb = () => { if (!_db) _db = firebase.firestore(); return _db; };
const appIdentifier = 'default-daemon-client';

// ═══════════════════════════════════════════════════════════════════════════
// FIRESTORE PATHS
// ═══════════════════════════════════════════════════════════════════════════

function getUserFilesCollection(uid) {
    return getDb().collection(`artifacts/${appIdentifier}/users/${uid}/files`);
}

function getUserSyncDoc(uid) {
    return getDb().collection(`artifacts/${appIdentifier}/users/${uid}/config`).doc('sync_meta');
}

// ═══════════════════════════════════════════════════════════════════════════
// SYNC ENGINE CLASS
// ═══════════════════════════════════════════════════════════════════════════

class ManifestSyncEngine {
    constructor(uid) {
        this.uid = uid;
        this._syncTimer = null;
        this._pendingChanges = [];  // Queue of changes to batch-write
        this._listeners = new Set();
        this._syncing = false;
        this._syncVersion = 0;
    }

    /**
     * Register a listener that gets called when the manifest changes
     * @param {Function} callback - (items: Array) => void
     * @returns {Function} Unsubscribe function
     */
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
     * Initial load: IndexedDB first, then Firestore sync.
     * Returns items from IndexedDB immediately for instant UI.
     */
    async initialLoad() {
        // 1. Check if we have local data
        const localCount = await getManifestCount();
        const syncState = await getSyncState(this.uid);

        if (localCount > 0 && syncState) {
            // We have cached data — return it immediately
            const localItems = await getAllManifestItems();
            this._syncVersion = syncState.version || 0;
            
            // Trigger background sync (don't await)
            this._backgroundSync();
            
            return localItems;
        }

        // 2. No local data — do a full sync from Firestore (cold start)
        return this._fullSync();
    }

    /**
     * Full sync: Pull ALL files from Firestore → replace IndexedDB.
     * Used on first login or when local cache is stale.
     * Cost: N reads (we read each file doc once), but this is a one-time cost.
     */
    async _fullSync() {
        this._syncing = true;
        try {
            const snapshot = await getUserFilesCollection(this.uid).get();
            const items = snapshot.docs.map(doc => {
                const data = doc.data();
                return this._serializeForIDB(doc.id, data);
            });

            // Replace local cache
            await replaceManifest(items);

            // Update sync state
            const newVersion = Date.now();
            this._syncVersion = newVersion;
            await setSyncState(this.uid, {
                version: newVersion,
                lastFullSync: Date.now(),
                itemCount: items.length,
            });

            // Update remote sync version
            await getUserSyncDoc(this.uid).set({
                version: newVersion,
                lastModified: firebase.firestore.FieldValue.serverTimestamp(),
            }, { merge: true });

            return items;
        } finally {
            this._syncing = false;
        }
    }

    /**
     * Background sync: Check if remote version changed, and if so re-sync.
     * Cost: 1 read (sync_meta doc)
     */
    async _backgroundSync() {
        try {
            const syncDoc = await getUserSyncDoc(this.uid).get();
            if (!syncDoc.exists) {
                // No sync doc — do initial sync and create it
                const items = await this._fullSync();
                this._notifyListeners(items);
                return;
            }

            const remoteVersion = syncDoc.data().version || 0;

            if (remoteVersion > this._syncVersion) {
                // Remote is newer — re-sync
                console.log('[Sync] Remote version newer, re-syncing...');
                const items = await this._fullSync();
                this._notifyListeners(items);
            }
        } catch (e) {
            console.warn('[Sync] Background sync failed:', e);
        }
    }

    /**
     * Serialize Firestore document to IndexedDB-compatible format.
     * Converts Timestamps to epoch ms for storage.
     */
    _serializeForIDB(id, data) {
        const item = { ...data, id };

        // Convert Firestore Timestamps to plain numbers
        if (item.uploadedAt?.toMillis) {
            item.uploadedAt = item.uploadedAt.toMillis();
        } else if (item.uploadedAt?.seconds) {
            item.uploadedAt = item.uploadedAt.seconds * 1000;
        }

        return item;
    }

    /**
     * Deserialize IndexedDB item back to Firestore-writeable format
     */
    _serializeForFirestore(item) {
        const data = { ...item };
        delete data.id; // ID is the document key, not a field we set manually

        // Convert epoch ms back to Firestore Timestamp
        if (typeof data.uploadedAt === 'number') {
            data.uploadedAt = firebase.firestore.Timestamp.fromMillis(data.uploadedAt);
        }

        return data;
    }

    // ═══════════════════════════════════════════════════════════════════
    // MUTATION METHODS (Optimistic local + debounced Firestore write)
    // ═══════════════════════════════════════════════════════════════════

    /**
     * Add a new file/folder
     */
    async addItem(item) {
        // 1. Save to IndexedDB immediately
        const idbItem = this._serializeForIDB(item.id, item);
        await saveManifestItem(idbItem);

        // 2. Queue Firestore write
        this._queueChange({ type: 'add', id: item.id, data: item });
        this._scheduleSyncToFirestore();

        return idbItem;
    }

    /**
     * Update an existing file/folder (e.g., rename)
     */
    async updateItem(id, updates) {
        // 1. Update IndexedDB
        const existing = await getManifestItem(id);
        if (!existing) return;
        const updated = { ...existing, ...updates };
        await saveManifestItem(updated);

        // 2. Queue Firestore write
        this._queueChange({ type: 'update', id, data: updates });
        this._scheduleSyncToFirestore();

        return updated;
    }

    /**
     * Delete a file/folder
     */
    async removeItem(id) {
        // 1. Delete from IndexedDB
        await deleteManifestItem(id);

        // 2. Queue Firestore delete  
        this._queueChange({ type: 'delete', id });
        this._scheduleSyncToFirestore();
    }

    /**
     * Add many items at once (batch upload completion)
     */
    async addItemsBatch(items) {
        const idbItems = items.map(item => this._serializeForIDB(item.id, item));
        await saveManifestBatch(idbItems);

        items.forEach(item => {
            this._queueChange({ type: 'add', id: item.id, data: item });
        });
        this._scheduleSyncToFirestore();

        return idbItems;
    }

    // ═══════════════════════════════════════════════════════════════════
    // QUERY METHODS (All from IndexedDB — 0 Firestore reads)
    // ═══════════════════════════════════════════════════════════════════

    /**
     * Get items in a specific folder
     */
    async getItemsInFolder(parentId) {
        return getItemsByParent(parentId);
    }

    /**
     * Search files by name
     */
    async search(query) {
        return searchManifest(query);
    }

    /**
     * Get total item count
     */
    async getCount() {
        return getManifestCount();
    }

    // ═══════════════════════════════════════════════════════════════════
    // DEBOUNCED SYNC TO FIRESTORE
    // ═══════════════════════════════════════════════════════════════════

    _queueChange(change) {
        this._pendingChanges.push(change);
    }

    _scheduleSyncToFirestore() {
        // Debounce: wait 3 seconds of inactivity before writing
        if (this._syncTimer) clearTimeout(this._syncTimer);
        this._syncTimer = setTimeout(() => this._flushToFirestore(), 3000);
    }

    /**
     * Flush all pending changes to Firestore in a single batch.
     * This is the ONLY place Firestore writes happen.
     */
    async _flushToFirestore() {
        if (this._pendingChanges.length === 0) return;

        // Grab and clear the queue
        const changes = [...this._pendingChanges];
        this._pendingChanges = [];

        try {
            const batch = getDb().batch();
            const filesCol = getUserFilesCollection(this.uid);

            for (const change of changes) {
                switch (change.type) {
                    case 'add': {
                        const docRef = filesCol.doc(change.id);
                        const data = this._serializeForFirestore(change.data);
                        batch.set(docRef, data);
                        break;
                    }
                    case 'update': {
                        const docRef = filesCol.doc(change.id);
                        const data = this._serializeForFirestore(change.data);
                        batch.update(docRef, data);
                        break;
                    }
                    case 'delete': {
                        const docRef = filesCol.doc(change.id);
                        batch.delete(docRef);
                        break;
                    }
                }
            }

            // Update sync version
            const newVersion = Date.now();
            batch.set(getUserSyncDoc(this.uid), {
                version: newVersion,
                lastModified: firebase.firestore.FieldValue.serverTimestamp(),
            }, { merge: true });

            await batch.commit();
            this._syncVersion = newVersion;

            // Update local sync state
            await setSyncState(this.uid, {
                version: newVersion,
                lastSync: Date.now(),
                itemCount: await getManifestCount(),
            });

            console.log(`[Sync] Flushed ${changes.length} changes to Firestore`);

        } catch (error) {
            // On failure, re-queue the changes for retry
            console.error('[Sync] Flush failed, re-queuing:', error);
            this._pendingChanges = [...changes, ...this._pendingChanges];
            // Retry after 10 seconds
            this._syncTimer = setTimeout(() => this._flushToFirestore(), 10000);
        }
    }

    /**
     * Force immediate sync (call before logout or page unload)
     */
    async forceSync() {
        if (this._syncTimer) clearTimeout(this._syncTimer);
        await this._flushToFirestore();
    }

    /**
     * Cleanup on logout
     */
    async destroy() {
        await this.forceSync();
        if (this._syncTimer) clearTimeout(this._syncTimer);
        this._listeners.clear();
        this._pendingChanges = [];
    }

    /**
     * Full reset (clear local data + resync)
     */
    async hardReset() {
        if (this._syncTimer) clearTimeout(this._syncTimer);
        this._pendingChanges = [];
        await clearAllLocalData();
        return this._fullSync();
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// SINGLETON FACTORY
// ═══════════════════════════════════════════════════════════════════════════

let _instance = null;
let _instanceUid = null;

/**
 * Get or create the sync engine instance for the current user
 */
export function getSyncEngine(uid) {
    if (_instance && _instanceUid === uid) return _instance;
    
    // Destroy old instance if switching users
    if (_instance) {
        _instance.destroy();
    }

    _instance = new ManifestSyncEngine(uid);
    _instanceUid = uid;
    return _instance;
}

/**
 * Destroy the current sync engine (call on logout)
 */
export async function destroySyncEngine() {
    if (_instance) {
        await _instance.destroy();
        _instance = null;
        _instanceUid = null;
    }
}

export default ManifestSyncEngine;
