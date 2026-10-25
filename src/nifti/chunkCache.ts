export interface ChunkKey {
  cx: number;
  cy: number;
  cz: number;
  lod: number;
}

export interface VolumeChunk {
  key: ChunkKey;
  data: Float32Array;
  width: number;
  height: number;
  depth: number;
  timestamp: number;
}

export interface VolumeInfo {
  nx: number;
  ny: number;
  nz: number;
  bytesPerVoxel: number;
  voxOffset: number;
  datatype: number;
  littleEndian: boolean;
  scl_slope: number;
  scl_inter: number;
}

export const CHUNK_SIZE = 64;
export const MAX_CHUNKS = 512;

// ---------------------------------------------------------------------------
// LRU Chunk Cache – shared by all providers
// ---------------------------------------------------------------------------

export class ChunkLRUCache {
  private chunks = new Map<string, VolumeChunk>();
  private pendingLoads = new Map<string, Promise<Float32Array | null>>();
  private readonly maxChunks: number;

  constructor(maxChunks = MAX_CHUNKS) {
    this.maxChunks = maxChunks;
  }

  private chunkKeyToString(key: ChunkKey): string {
    return `${key.cx}:${key.cy}:${key.cz}:lod${key.lod}`;
  }

  get(key: ChunkKey): VolumeChunk | null {
    return this.chunks.get(this.chunkKeyToString(key)) || null;
  }

  set(key: ChunkKey, chunk: VolumeChunk): void {
    this.chunks.set(this.chunkKeyToString(key), chunk);
    this.evictIfNeeded();
  }

  has(key: ChunkKey): boolean {
    return this.chunks.has(this.chunkKeyToString(key));
  }

  delete(key: ChunkKey): boolean {
    return this.chunks.delete(this.chunkKeyToString(key));
  }

  getPending(key: ChunkKey): Promise<Float32Array | null> | undefined {
    return this.pendingLoads.get(this.chunkKeyToString(key));
  }

  setPending(key: ChunkKey, promise: Promise<Float32Array | null>): void {
    this.pendingLoads.set(this.chunkKeyToString(key), promise);
  }

  deletePending(key: ChunkKey): void {
    this.pendingLoads.delete(this.chunkKeyToString(key));
  }

  touch(key: ChunkKey): void {
    const strKey = this.chunkKeyToString(key);
    const existing = this.chunks.get(strKey);
    if (existing) {
      existing.timestamp = Date.now();
    }
  }

  get size(): number {
    return this.chunks.size;
  }

  clear(): void {
    this.chunks.clear();
    this.pendingLoads.clear();
  }

  private evictIfNeeded(): void {
    if (this.chunks.size <= this.maxChunks) return;
    const entries = Array.from(this.chunks.entries()).sort((a, b) => a[1].timestamp - b[1].timestamp);
    const toRemove = this.chunks.size - this.maxChunks + Math.floor(this.maxChunks * 0.2);
    for (let i = 0; i < toRemove && i < entries.length; i++) {
      this.chunks.delete(entries[i][0]);
    }
  }
}
