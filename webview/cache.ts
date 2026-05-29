const DB_NAME = 'niftispy-cache';
const DB_VERSION = 1;
const STORE_NAME = 'chunks';
const MAX_CACHE_SIZE = 500 * 1024 * 1024;

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
  const sizeIndex = store.index('size');
  const timestampIndex = store.index('timestamp');

  let totalSize = 0;
  let count = 0;

  const cursorReq = store.openCursor();
  const entries: { key: string; timestamp: number; size: number }[] = [];

  cursorReq.onsuccess = () => {
    const cursor = cursorReq.result;
    if (cursor) {
      totalSize += cursor.value.size || 0;
      entries.push({ key: cursor.value.key, timestamp: cursor.value.timestamp, size: cursor.value.size || 0 });
      count++;
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
