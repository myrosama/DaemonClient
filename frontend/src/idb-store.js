/**
 * IndexedDB Store for DaemonClient
 * 
 * Provides local-first storage for:
 * - File/folder manifest (all metadata cached locally)
 * - Upload sessions (for resumable uploads)
 * - Sync state (version tracking for Firestore delta sync)
 * 
 * This eliminates most Firestore reads — navigation, search, and listing
 * all happen from IndexedDB (instant, free, offline-capable).
 */

const DB_NAME = 'daemonclient';
const DB_VERSION = 1;

const STORES = {
    MANIFEST: 'manifest',       // File/folder metadata
    UPLOAD_SESSIONS: 'uploads', // Resumable upload sessions
    SYNC_STATE: 'sync',         // Sync metadata (version, timestamps)
    SETTINGS: 'settings',       // Cached config/ZKE
};

let _dbPromise = null;

/**
 * Open (or create) the IndexedDB database
 */
function openDB() {
    if (_dbPromise) return _dbPromise;

    _dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = (event) => {
            const db = event.target.result;

            // Manifest store: keyed by file/folder ID
            if (!db.objectStoreNames.contains(STORES.MANIFEST)) {
                const manifest = db.createObjectStore(STORES.MANIFEST, { keyPath: 'id' });
                manifest.createIndex('parentId', 'parentId', { unique: false });
                manifest.createIndex('type', 'type', { unique: false });
                manifest.createIndex('fileName', 'fileName', { unique: false });
            }

            // Upload sessions store: keyed by session ID
            if (!db.objectStoreNames.contains(STORES.UPLOAD_SESSIONS)) {
                const uploads = db.createObjectStore(STORES.UPLOAD_SESSIONS, { keyPath: 'sessionId' });
                uploads.createIndex('status', 'status', { unique: false });
            }

            // Sync state store: keyed by userId
            if (!db.objectStoreNames.contains(STORES.SYNC_STATE)) {
                db.createObjectStore(STORES.SYNC_STATE, { keyPath: 'userId' });
            }

            // Settings store: key-value
            if (!db.objectStoreNames.contains(STORES.SETTINGS)) {
                db.createObjectStore(STORES.SETTINGS, { keyPath: 'key' });
            }
        };

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });

    return _dbPromise;
}

/**
 * Generic transaction helper
 */
async function withStore(storeName, mode, callback) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, mode);
        const store = tx.objectStore(storeName);
        const result = callback(store);

        tx.oncomplete = () => resolve(result);
        tx.onerror = () => reject(tx.error);
    });
}

/**
 * Get a single item by key
 */
async function getItem(storeName, key) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readonly');
        const store = tx.objectStore(storeName);
        const request = store.get(key);
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(request.error);
    });
}

/**
 * Put a single item
 */
async function putItem(storeName, item) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite');
        const store = tx.objectStore(storeName);
        store.put(item);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

/**
 * Delete a single item by key
 */
async function deleteItem(storeName, key) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite');
        const store = tx.objectStore(storeName);
        store.delete(key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

/**
 * Get all items matching an index value
 */
async function getByIndex(storeName, indexName, value) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readonly');
        const store = tx.objectStore(storeName);
        const index = store.index(indexName);
        const request = index.getAll(value);
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error);
    });
}

/**
 * Get all items from a store
 */
async function getAll(storeName) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readonly');
        const store = tx.objectStore(storeName);
        const request = store.getAll();
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error);
    });
}

/**
 * Put multiple items in a single transaction (fast batch write)
 */
async function putMany(storeName, items) {
    if (!items.length) return;
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite');
        const store = tx.objectStore(storeName);
        items.forEach(item => store.put(item));
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

/**
 * Delete multiple items by keys
 */
async function deleteMany(storeName, keys) {
    if (!keys.length) return;
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite');
        const store = tx.objectStore(storeName);
        keys.forEach(key => store.delete(key));
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

/**
 * Clear all items from a store
 */
async function clearStore(storeName) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite');
        const store = tx.objectStore(storeName);
        store.clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

/**
 * Count items in a store
 */
async function countItems(storeName) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readonly');
        const store = tx.objectStore(storeName);
        const request = store.count();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

// ═══════════════════════════════════════════════════════════════════════════
// HIGH-LEVEL API — Manifest (File/Folder Index)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Get all files/folders in a given parent folder.
 * Returns items sorted: folders first, then files, both alphabetically.
 */
export async function getItemsByParent(parentId) {
    const items = await getByIndex(STORES.MANIFEST, 'parentId', parentId);
    return items.sort((a, b) => {
        // Folders first
        if (a.type === 'folder' && b.type !== 'folder') return -1;
        if (a.type !== 'folder' && b.type === 'folder') return 1;
        // Then alphabetical
        return (a.fileName || '').localeCompare(b.fileName || '');
    });
}

/**
 * Get a single file/folder by ID
 */
export async function getManifestItem(id) {
    return getItem(STORES.MANIFEST, id);
}

/**
 * Save a file/folder to the local manifest
 */
export async function saveManifestItem(item) {
    return putItem(STORES.MANIFEST, item);
}

/**
 * Save many file/folders at once (used for initial sync)
 */
export async function saveManifestBatch(items) {
    return putMany(STORES.MANIFEST, items);
}

/**
 * Delete a file/folder from the local manifest
 */
export async function deleteManifestItem(id) {
    return deleteItem(STORES.MANIFEST, id);
}

/**
 * Replace the entire manifest (full sync)
 */
export async function replaceManifest(items) {
    await clearStore(STORES.MANIFEST);
    return putMany(STORES.MANIFEST, items);
}

/**
 * Get ALL items in the manifest
 */
export async function getAllManifestItems() {
    return getAll(STORES.MANIFEST);
}

/**
 * Count total files/folders in the manifest
 */
export async function getManifestCount() {
    return countItems(STORES.MANIFEST);
}

/**
 * Search files by name (case-insensitive substring match)
 */
export async function searchManifest(query) {
    const all = await getAll(STORES.MANIFEST);
    const q = query.toLowerCase();
    return all.filter(item => 
        (item.fileName || '').toLowerCase().includes(q)
    );
}

// ═══════════════════════════════════════════════════════════════════════════
// HIGH-LEVEL API — Sync State
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Get the sync state for a user
 */
export async function getSyncState(userId) {
    return getItem(STORES.SYNC_STATE, userId);
}

/** 
 * Update the sync state for a user
 */
export async function setSyncState(userId, state) {
    return putItem(STORES.SYNC_STATE, { userId, ...state });
}

// ═══════════════════════════════════════════════════════════════════════════
// HIGH-LEVEL API — Upload Sessions (Resumable Uploads)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Create or update an upload session
 */
export async function saveUploadSession(session) {
    return putItem(STORES.UPLOAD_SESSIONS, session);
}

/**
 * Get an upload session by ID
 */
export async function getUploadSession(sessionId) {
    return getItem(STORES.UPLOAD_SESSIONS, sessionId);
}

/**
 * Get all incomplete upload sessions
 */
export async function getIncompleteUploads() {
    return getByIndex(STORES.UPLOAD_SESSIONS, 'status', 'in_progress');
}

/**
 * Get all upload sessions (any status)
 */
export async function getAllUploadSessions() {
    return getAll(STORES.UPLOAD_SESSIONS);
}

/**
 * Delete an upload session (after completion or user dismissal)
 */
export async function deleteUploadSession(sessionId) {
    return deleteItem(STORES.UPLOAD_SESSIONS, sessionId);
}

/**
 * Clear all upload sessions
 */
export async function clearUploadSessions() {
    return clearStore(STORES.UPLOAD_SESSIONS);
}

// ═══════════════════════════════════════════════════════════════════════════
// HIGH-LEVEL API — Settings Cache
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Cache a setting locally
 */
export async function cacheSetting(key, value) {
    return putItem(STORES.SETTINGS, { key, value, cachedAt: Date.now() });
}

/**
 * Get a cached setting
 */
export async function getCachedSetting(key) {
    const item = await getItem(STORES.SETTINGS, key);
    return item?.value || null;
}

/**
 * Clear all cached settings (on logout)
 */
export async function clearSettings() {
    return clearStore(STORES.SETTINGS);
}

// ═══════════════════════════════════════════════════════════════════════════
// CLEANUP
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Clear ALL local data (for logout/factory reset)
 */
export async function clearAllLocalData() {
    await clearStore(STORES.MANIFEST);
    await clearStore(STORES.UPLOAD_SESSIONS);
    await clearStore(STORES.SYNC_STATE);
    await clearStore(STORES.SETTINGS);
}
