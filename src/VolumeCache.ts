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

const MAX_BYTES = 2 * 1024 * 1024 * 1024;
const ACTIVE_TTL_MS = 5 * 60 * 1000;
const IDLE_TTL_MS = 60 * 1000;

export class VolumeCache {
  private cache = new Map<string, CachedVolume>();

  get(uri: string): CachedVolume | undefined {
    const entry = this.cache.get(uri);
    if (entry) {
      entry.timestamp = Date.now();
    }
    return entry;
  }

  set(
    uri: string,
    volume: Omit<CachedVolume, "timestamp" | "byteSize" | "activeWebviewId">
  ): void {
    const entry: CachedVolume = {
      ...volume,
      timestamp: Date.now(),
      byteSize: volume.voxelData.byteLength,
      activeWebviewId: null,
    };
    this.cache.set(uri, entry);
  }

  setActive(uri: string, webviewId: string | null): void {
    const entry = this.cache.get(uri);
    if (entry) {
      entry.activeWebviewId = webviewId;
    }
  }

  totalByteSize(): number {
    let total = 0;
    for (const entry of this.cache.values()) {
      total += entry.byteSize;
    }
    return total;
  }

  evictIfNeeded(): void {
    if (this.totalByteSize() <= MAX_BYTES) {
      return;
    }

    const entries = Array.from(this.cache.entries())
      .filter(([, v]) => v.activeWebviewId === null)
      .sort(([, a], [, b]) => a.timestamp - b.timestamp);

    for (const [uri] of entries) {
      this.cache.delete(uri);
      if (this.totalByteSize() <= MAX_BYTES) {
        break;
      }
    }
  }

  cleanup(): void {
    const now = Date.now();
    for (const [uri, entry] of this.cache) {
      if (entry.activeWebviewId !== null) {
        continue;
      }
      const age = now - entry.timestamp;
      const ttl = age < ACTIVE_TTL_MS ? ACTIVE_TTL_MS : IDLE_TTL_MS;
      if (age > ttl) {
        this.cache.delete(uri);
      }
    }
  }

}
