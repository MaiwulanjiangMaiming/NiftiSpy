export interface CachedVolume {
  header: any;
  voxelData:
    | Int8Array
    | Uint8Array
    | Int16Array
    | Uint16Array
    | Int32Array
    | Uint32Array
    | Float32Array
    | Float64Array;
  min: number;
  max: number;
  slope: number;
  inter: number;
  timestamp: number;
  byteSize: number;
  activeWebviewId: string | null;
}

interface LRUNode {
  key: string;
  entry: CachedVolume;
  prev: LRUNode | null;
  next: LRUNode | null;
}

const MAX_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_MAX_ENTRIES = 5;

export class VolumeCache {
  private map = new Map<string, LRUNode>();
  private head: LRUNode | null = null; // most recently used
  private tail: LRUNode | null = null; // least recently used
  private _totalBytes = 0;
  private readonly maxEntries: number;
  private readonly maxBytes: number;

  constructor(maxEntries = DEFAULT_MAX_ENTRIES, maxBytes = MAX_BYTES) {
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
  }

  private removeNode(node: LRUNode): void {
    if (node.prev) node.prev.next = node.next;
    else this.head = node.next;
    if (node.next) node.next.prev = node.prev;
    else this.tail = node.prev;
    node.prev = null;
    node.next = null;
  }

  private addToHead(node: LRUNode): void {
    node.prev = null;
    node.next = this.head;
    if (this.head) this.head.prev = node;
    this.head = node;
    if (!this.tail) this.tail = node;
  }

  private moveToHead(node: LRUNode): void {
    if (node === this.head) return;
    this.removeNode(node);
    this.addToHead(node);
  }

  get(uri: string): CachedVolume | undefined {
    const node = this.map.get(uri);
    if (!node) return undefined;
    node.entry.timestamp = Date.now();
    this.moveToHead(node);
    return node.entry;
  }

  set(
    uri: string,
    volume: Omit<CachedVolume, "timestamp" | "byteSize" | "activeWebviewId">
  ): void {
    const existing = this.map.get(uri);
    if (existing) {
      this._totalBytes -= existing.entry.byteSize;
      existing.entry.header = volume.header;
      existing.entry.voxelData = volume.voxelData;
      existing.entry.min = volume.min;
      existing.entry.max = volume.max;
      existing.entry.slope = volume.slope;
      existing.entry.inter = volume.inter;
      existing.entry.byteSize = volume.voxelData.byteLength;
      existing.entry.timestamp = Date.now();
      this._totalBytes += existing.entry.byteSize;
      this.moveToHead(existing);
    } else {
      const entry: CachedVolume = {
        ...volume,
        timestamp: Date.now(),
        byteSize: volume.voxelData.byteLength,
        activeWebviewId: null,
      };
      const node: LRUNode = { key: uri, entry, prev: null, next: null };
      this.map.set(uri, node);
      this.addToHead(node);
      this._totalBytes += entry.byteSize;
    }
    this.evictIfNeeded();
  }

  setActive(uri: string, webviewId: string | null): void {
    const node = this.map.get(uri);
    if (node) {
      node.entry.activeWebviewId = webviewId;
    }
  }

  totalByteSize(): number {
    return this._totalBytes;
  }

  private evictIfNeeded(): void {
    // Evict from tail (LRU) until under both limits.
    // Skip entries with active webviews instead of stopping —
    // previously a single active entry at the tail would block
    // eviction of all idle entries before it, potentially causing OOM.
    while (this.tail && (this.map.size > this.maxEntries || this._totalBytes > this.maxBytes)) {
      const lru = this.tail;
      if (lru.entry.activeWebviewId !== null) {
        // Skip this active entry — move it to head so we can inspect
        // the next LRU candidate. If all entries are active, stop.
        this.removeNode(lru);
        this.addToHead(lru);
        // If moving it didn't change the tail, all entries are active
        if (this.tail === lru) break;
        continue;
      }
      this.removeNode(lru);
      this.map.delete(lru.key);
      this._totalBytes -= lru.entry.byteSize;
    }
  }

  cleanup(): void {
    const ACTIVE_TTL_MS = 5 * 60 * 1000;
    const IDLE_TTL_MS = 60 * 1000;
    const now = Date.now();
    let node = this.tail;
    while (node) {
      const prev = node.prev;
      // TTL based on active status, not age
      const ttl = node.entry.activeWebviewId !== null ? ACTIVE_TTL_MS : IDLE_TTL_MS;
      const age = now - node.entry.timestamp;
      if (age > ttl) {
        this.removeNode(node);
        this.map.delete(node.key);
        this._totalBytes -= node.entry.byteSize;
      }
      node = prev;
    }
  }

  getCacheInfo(): { entries: number; totalBytes: number; maxEntries: number; maxBytes: number } {
    return {
      entries: this.map.size,
      totalBytes: this._totalBytes,
      maxEntries: this.maxEntries,
      maxBytes: this.maxBytes,
    };
  }
}
