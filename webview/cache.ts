const DB_NAME = 'niftispy-cache';
const DB_VERSION = 2;
const STORE_NAME = 'chunks';
const META_STORE = 'meta';
const MAX_CACHE_SIZE = 1.5 * 1024 * 1024 * 1024; // 1.5 GB

let dbInstance: IDBDatabase | null = null;

function openDB(): Promise<IDBDatabase> {
  if (dbInstance) return Promise.resolve(dbInstance);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'key' });
        store.createIndex('timestamp', 'timestamp', { unique: false });
        store.createIndex('size', 'size', { unique: false });
      }
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => {
      dbInstance = req.result;
      resolve(req.result);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function getCachedChunk(key: string): Promise<ArrayBuffer | null> {
  const db = await openDB();
  return new Promise((resolve) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.get(key);
    req.onsuccess = () => {
      const record = req.result;
      if (record && record.data) {
        const touchTx = db.transaction(STORE_NAME, 'readwrite');
        const touchStore = touchTx.objectStore(STORE_NAME);
        record.timestamp = Date.now();
        touchStore.put(record);
        resolve(record.data);
      } else {
        resolve(null);
      }
    };
    req.onerror = () => resolve(null);
  });
}

export async function setCachedChunk(key: string, data: ArrayBuffer): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.put({
      key,
      data,
      timestamp: Date.now(),
      size: data.byteLength,
    });
    tx.oncomplete = () => {
      evictIfNeeded();
      resolve();
    };
    tx.onerror = () => reject(tx.error);
  });
}

export async function evictIfNeeded(): Promise<void> {
  const db = await openDB();
  const tx = db.transaction(STORE_NAME, 'readwrite');
  const store = tx.objectStore(STORE_NAME);

  let totalSize = 0;
  const entries: { key: string; timestamp: number; size: number }[] = [];

  const cursorReq = store.openCursor();
  cursorReq.onsuccess = () => {
    const cursor = cursorReq.result;
    if (cursor) {
      totalSize += cursor.value.size || 0;
      entries.push({ key: cursor.value.key, timestamp: cursor.value.timestamp, size: cursor.value.size || 0 });
      cursor.continue();
    } else {
      if (totalSize > MAX_CACHE_SIZE) {
        entries.sort((a, b) => a.timestamp - b.timestamp);
        let freed = 0;
        const target = totalSize - MAX_CACHE_SIZE * 0.7;
        const deleteTx = db.transaction(STORE_NAME, 'readwrite');
        const deleteStore = deleteTx.objectStore(STORE_NAME);
        for (const entry of entries) {
          if (freed >= target) break;
          deleteStore.delete(entry.key);
          freed += entry.size;
        }
      }
    }
  };
}

export async function clearCache(): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export function makeCacheKey(url: string, axis: string, index: number): string {
  return `${url}::${axis}::${index}`;
}

export interface CacheStats {
  l1Hits: number;
  l1Misses: number;
  l2Hits: number;
  l2Misses: number;
  l3Hits: number;
  l3Misses: number;
  l4Fetches: number;
  l3Size: number;
  l3Entries: number;
}

let stats: CacheStats = {
  l1Hits: 0, l1Misses: 0,
  l2Hits: 0, l2Misses: 0,
  l3Hits: 0, l3Misses: 0,
  l4Fetches: 0,
  l3Size: 0, l3Entries: 0,
};

export function recordCacheHit(level: 'l1' | 'l2' | 'l3'): void {
  switch (level) {
    case 'l1': stats.l1Hits++; break;
    case 'l2': stats.l2Hits++; break;
    case 'l3': stats.l3Hits++; break;
  }
}

export function recordCacheMiss(level: 'l1' | 'l2' | 'l3'): void {
  switch (level) {
    case 'l1': stats.l1Misses++; break;
    case 'l2': stats.l2Misses++; break;
    case 'l3': stats.l3Misses++; break;
  }
}

export function recordL4Fetch(): void {
  stats.l4Fetches++;
}

export function getCacheStats(): CacheStats {
  return { ...stats };
}

export function resetCacheStats(): void {
  stats = {
    l1Hits: 0, l1Misses: 0,
    l2Hits: 0, l2Misses: 0,
    l3Hits: 0, l3Misses: 0,
    l4Fetches: 0,
    l3Size: 0, l3Entries: 0,
  };
}

export async function getCacheSize(): Promise<{ totalSize: number; entryCount: number }> {
  const db = await openDB();
  return new Promise((resolve) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    let totalSize = 0;
    let entryCount = 0;
    const cursorReq = store.openCursor();
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (cursor) {
        totalSize += cursor.value.size || 0;
        entryCount++;
        cursor.continue();
      } else {
        stats.l3Size = totalSize;
        stats.l3Entries = entryCount;
        resolve({ totalSize, entryCount });
      }
    };
    cursorReq.onerror = () => resolve({ totalSize: 0, entryCount: 0 });
  });
}

export async function getCacheMeta(key: string): Promise<string | null> {
  const db = await openDB();
  return new Promise((resolve) => {
    const tx = db.transaction(META_STORE, 'readonly');
    const store = tx.objectStore(META_STORE);
    const req = store.get(key);
    req.onsuccess = () => {
      resolve(req.result?.value ?? null);
    };
    req.onerror = () => resolve(null);
  });
}

export async function setCacheMeta(key: string, value: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(META_STORE, 'readwrite');
    const store = tx.objectStore(META_STORE);
    store.put({ key, value });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
