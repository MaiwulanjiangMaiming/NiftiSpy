/**
 * SliceCacheDB — IndexedDB-backed persistent slice cache with LRU eviction.
 *
 * Database : niftispy-slice-cache
 * Store    : slices (keyPath = "key", index on lastAccess)
 * Entry    : { key, data: ArrayBuffer, lastAccess, size, validationToken? }
 * Key fmt  : ${fileHash}_${axis}_${sliceIndex}
 */

const DB_NAME = 'niftispy-slice-cache';
const DB_VERSION = 1;
const STORE_NAME = 'slices';
const DEFAULT_MAX_BYTES = 500 * 1024 * 1024; // 500 MB

export interface SliceCacheEntry {
  key: string;
  data: ArrayBuffer;
  lastAccess: number;
  size: number;
  validationToken?: string;
}

export class SliceCacheDB {
  private db: IDBDatabase | null = null;
  private _hits = 0;
  private _misses = 0;

  // ── Lifecycle ──────────────────────────────────────────────────────

  async init(): Promise<void> {
    if (this.db) return;
    this.db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: 'key' });
          store.createIndex('lastAccess', 'lastAccess', { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  // ── Core CRUD ──────────────────────────────────────────────────────

  async get(key: string): Promise<ArrayBuffer | null> {
    const db = await this.ensureDB();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(key);
      req.onsuccess = () => {
        const record = req.result as SliceCacheEntry | undefined;
        if (record && record.data) {
          // Touch-on-read for LRU accuracy
          record.lastAccess = Date.now();
          const touchTx = db.transaction(STORE_NAME, 'readwrite');
          touchTx.objectStore(STORE_NAME).put(record);
          this._hits++;
          resolve(record.data);
        } else {
          this._misses++;
          resolve(null);
        }
      };
      req.onerror = () => {
        this._misses++;
        resolve(null);
      };
    });
  }

  async put(key: string, data: ArrayBuffer, validationToken?: string): Promise<void> {
    const db = await this.ensureDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const entry: SliceCacheEntry = {
        key,
        data,
        lastAccess: Date.now(),
        size: data.byteLength,
      };
      if (validationToken !== undefined) {
        entry.validationToken = validationToken;
      }
      store.put(entry);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async delete(key: string): Promise<void> {
    const db = await this.ensureDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async clear(): Promise<void> {
    const db = await this.ensureDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  // ── Usage & Eviction ───────────────────────────────────────────────

  async getUsage(): Promise<number> {
    const db = await this.ensureDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      let total = 0;
      const cursorReq = store.openCursor();
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (cursor) {
          total += (cursor.value as SliceCacheEntry).size || 0;
          cursor.continue();
        } else {
          resolve(total);
        }
      };
      cursorReq.onerror = () => reject(cursorReq.error);
    });
  }

  async evictLRU(maxBytes: number = DEFAULT_MAX_BYTES): Promise<void> {
    const db = await this.ensureDB();
    const entries: { key: string; lastAccess: number; size: number }[] = [];
    let totalSize = 0;

    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const idx = store.index('lastAccess');
      const cursorReq = idx.openCursor();
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (cursor) {
          const entry = cursor.value as SliceCacheEntry;
          totalSize += entry.size || 0;
          entries.push({ key: entry.key, lastAccess: entry.lastAccess, size: entry.size || 0 });
          cursor.continue();
        } else {
          resolve();
        }
      };
      cursorReq.onerror = () => reject(cursorReq.error);
    });

    if (totalSize <= maxBytes) return;

    // Entries are already sorted by lastAccess ascending via the index
    // Evict oldest first until under threshold (70% of max)
    const target = totalSize - maxBytes * 0.7;
    let freed = 0;
    const toDelete: string[] = [];

    for (const entry of entries) {
      if (freed >= target) break;
      toDelete.push(entry.key);
      freed += entry.size;
    }

    if (toDelete.length === 0) return;

    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      for (const key of toDelete) {
        store.delete(key);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  // ── Cache Invalidation ────────────────────────────────────────────

  async invalidateByPrefix(prefix: string): Promise<number> {
    const db = await this.ensureDB();
    const toDelete: string[] = [];

    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const cursorReq = store.openCursor();
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (cursor) {
          const entry = cursor.value as SliceCacheEntry;
          if (entry.key.startsWith(prefix)) {
            toDelete.push(entry.key);
          }
          cursor.continue();
        } else {
          resolve();
        }
      };
      cursorReq.onerror = () => reject(cursorReq.error);
    });

    if (toDelete.length === 0) return 0;

    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      for (const key of toDelete) {
        store.delete(key);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });

    return toDelete.length;
  }

  async invalidateByValidationToken(token: string): Promise<number> {
    const db = await this.ensureDB();
    const toDelete: string[] = [];

    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const cursorReq = store.openCursor();
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (cursor) {
          const entry = cursor.value as SliceCacheEntry;
          if (entry.validationToken === token) {
            toDelete.push(entry.key);
          }
          cursor.continue();
        } else {
          resolve();
        }
      };
      cursorReq.onerror = () => reject(cursorReq.error);
    });

    if (toDelete.length === 0) return 0;

    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      for (const key of toDelete) {
        store.delete(key);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });

    return toDelete.length;
  }

  async getValidationToken(key: string): Promise<string | null> {
    const db = await this.ensureDB();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(key);
      req.onsuccess = () => {
        const record = req.result as SliceCacheEntry | undefined;
        resolve(record?.validationToken ?? null);
      };
      req.onerror = () => resolve(null);
    });
  }

  // ── Statistics ─────────────────────────────────────────────────────

  get cacheHits(): number {
    return this._hits;
  }

  get cacheMisses(): number {
    return this._misses;
  }

  async cacheSize(): Promise<number> {
    return this.getUsage();
  }

  async cacheEntries(): Promise<number> {
    const db = await this.ensureDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const countReq = store.count();
      countReq.onsuccess = () => resolve(countReq.result);
      countReq.onerror = () => reject(countReq.error);
    });
  }

  getStats(): { cacheHits: number; cacheMisses: number } {
    return { cacheHits: this._hits, cacheMisses: this._misses };
  }

  resetStats(): void {
    this._hits = 0;
    this._misses = 0;
  }

  // ── Helpers ────────────────────────────────────────────────────────

  private async ensureDB(): Promise<IDBDatabase> {
    if (!this.db) await this.init();
    return this.db!;
  }
}

// ── Key Helpers ──────────────────────────────────────────────────────

/**
 * Derive a short hash from filename + file size for use as the fileHash
 * portion of a cache key. Uses a simple FNV-1a-style hash to avoid
 * pulling in crypto dependencies in the webview worker context.
 */
export function deriveFileHash(fileName: string, fileSize: number): string {
  const raw = `${fileName}:${fileSize}`;
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < raw.length; i++) {
    h ^= raw.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/**
 * Build a cache key: ${fileHash}_${axis}_${sliceIndex}
 */
export function makeSliceCacheKey(
  fileHash: string,
  axis: string,
  sliceIndex: number
): string {
  return `${fileHash}_${axis}_${sliceIndex}`;
}

// Singleton for convenient shared usage
let _instance: SliceCacheDB | null = null;

export function getSliceCacheDB(): SliceCacheDB {
  if (!_instance) {
    _instance = new SliceCacheDB();
  }
  return _instance;
}
