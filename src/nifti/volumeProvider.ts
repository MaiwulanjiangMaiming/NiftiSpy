import { CHUNK_SIZE, ChunkLRUCache, type ChunkKey, type VolumeChunk, type VolumeInfo } from './chunkCache';

// ---------------------------------------------------------------------------
// Abstract VolumeProvider
// ---------------------------------------------------------------------------

export abstract class VolumeProvider {
  protected info: VolumeInfo | null = null;
  protected cache = new ChunkLRUCache();

  // --- Required abstract methods (v1.9.1 API) ---

  abstract loadChunk(key: ChunkKey): Promise<Float32Array | null>;
  abstract getInfo(): Promise<VolumeInfo>;

  // --- New v1.9.1 public API ---

  getDimensions(): { nx: number; ny: number; nz: number } {
    if (!this.info) return { nx: 0, ny: 0, nz: 0 };
    return { nx: this.info.nx, ny: this.info.ny, nz: this.info.nz };
  }

  getVoxelSize(): { dx: number; dy: number; dz: number } {
    if (!this.info) return { dx: 1, dy: 1, dz: 1 };
    // VolumeInfo doesn't store voxel size directly; default to 1
    return { dx: 1, dy: 1, dz: 1 };
  }

  getChunkSize(): { cx: number; cy: number; cz: number } {
    return { cx: CHUNK_SIZE, cy: CHUNK_SIZE, cz: CHUNK_SIZE };
  }

  async getChunk(chunkX: number, chunkY: number, chunkZ: number): Promise<Float32Array> {
    const key: ChunkKey = { cx: chunkX, cy: chunkY, cz: chunkZ, lod: 0 };
    const chunk = await this.getOrLoadChunk(key);
    return chunk ? chunk.data : new Float32Array(0);
  }

  getChunksForSlice(axis: 'axial' | 'coronal' | 'sagittal', sliceIndex: number, lod: number = 0): ChunkKey[] {
    if (!this.info) return [];
    const { nx, ny, nz } = this.info;
    const factor = Math.pow(2, lod);
    const chunksPerAxis = {
      x: Math.ceil(nx / (factor * CHUNK_SIZE)),
      y: Math.ceil(ny / (factor * CHUNK_SIZE)),
      z: Math.ceil(nz / (factor * CHUNK_SIZE)),
    };

    const keys: ChunkKey[] = [];
    if (axis === 'axial') {
      const cz = Math.floor(sliceIndex / (factor * CHUNK_SIZE));
      for (let cy = 0; cy < chunksPerAxis.y; cy++) {
        for (let cx = 0; cx < chunksPerAxis.x; cx++) {
          keys.push({ cx, cy, cz, lod });
        }
      }
    } else if (axis === 'coronal') {
      const cy = Math.floor(sliceIndex / (factor * CHUNK_SIZE));
      for (let cz = 0; cz < chunksPerAxis.z; cz++) {
        for (let cx = 0; cx < chunksPerAxis.x; cx++) {
          keys.push({ cx, cy, cz, lod });
        }
      }
    } else {
      const cx = Math.floor(sliceIndex / (factor * CHUNK_SIZE));
      for (let cz = 0; cz < chunksPerAxis.z; cz++) {
        for (let cy = 0; cy < chunksPerAxis.y; cy++) {
          keys.push({ cx, cy, cz, lod });
        }
      }
    }
    return keys;
  }

  async extractSlice(axis: 'axial' | 'coronal' | 'sagittal', sliceIndex: number): Promise<Float32Array> {
    if (!this.info) return new Float32Array(0);
    const chunkKeys = this.getChunksForSlice(axis, sliceIndex, 0);

    // Load all needed chunks
    await Promise.all(chunkKeys.map((k) => this.getOrLoadChunk(k)));

    return this.extractSliceFromChunks(axis, sliceIndex, 0) || new Float32Array(0);
  }

  isChunkLoaded(chunkX: number, chunkY: number, chunkZ: number): boolean {
    return this.cache.has({ cx: chunkX, cy: chunkY, cz: chunkZ, lod: 0 });
  }

  getLoadedChunksCount(): number {
    return this.cache.size;
  }

  getTotalChunksCount(): number {
    if (!this.info) return 0;
    const { nx, ny, nz } = this.info;
    const cx = Math.ceil(nx / CHUNK_SIZE);
    const cy = Math.ceil(ny / CHUNK_SIZE);
    const cz = Math.ceil(nz / CHUNK_SIZE);
    return cx * cy * cz;
  }

  evictChunk(chunkX: number, chunkY: number, chunkZ: number): void {
    this.cache.delete({ cx: chunkX, cy: chunkY, cz: chunkZ, lod: 0 });
  }

  // --- Existing methods (kept for backward compatibility) ---

  getChunkSync(key: ChunkKey): VolumeChunk | null {
    return this.cache.get(key);
  }

  async getOrLoadChunk(key: ChunkKey): Promise<VolumeChunk | null> {
    const existing = this.cache.get(key);
    if (existing) {
      this.cache.touch(key);
      return existing;
    }

    const pending = this.cache.getPending(key);
    if (pending) {
      const data = await pending;
      return data ? this.cache.get(key) : null;
    }

    const loadPromise = this.loadChunk(key);
    this.cache.setPending(key, loadPromise);

    try {
      const data = await loadPromise;
      if (data) {
        const { cx, cy, cz, lod } = key;
        const factor = Math.pow(2, lod);
        const w = Math.min(CHUNK_SIZE, Math.ceil(this.info!.nx / factor - cx * CHUNK_SIZE));
        const h = Math.min(CHUNK_SIZE, Math.ceil(this.info!.ny / factor - cy * CHUNK_SIZE));
        const d = Math.min(CHUNK_SIZE, Math.ceil(this.info!.nz / factor - cz * CHUNK_SIZE));
        const chunk: VolumeChunk = { key, data, width: w, height: h, depth: d, timestamp: Date.now() };
        this.cache.set(key, chunk);
        return chunk;
      }
      return null;
    } finally {
      this.cache.deletePending(key);
    }
  }

  extractSliceFromChunks(axis: 'axial' | 'coronal' | 'sagittal', sliceIndex: number, lod: number): Float32Array | null {
    if (!this.info) return null;
    const { nx, ny, nz, scl_slope, scl_inter } = this.info;
    const factor = Math.pow(2, lod);
    const chunkKeys = this.getChunksForSlice(axis, sliceIndex, lod);

    let outW: number, outH: number;
    if (axis === 'axial') {
      outW = Math.ceil(nx / factor);
      outH = Math.ceil(ny / factor);
    } else if (axis === 'coronal') {
      outW = Math.ceil(nx / factor);
      outH = Math.ceil(nz / factor);
    } else {
      outW = Math.ceil(ny / factor);
      outH = Math.ceil(nz / factor);
    }

    const result = new Float32Array(outW * outH);
    const slope = scl_slope || 1;
    const inter = scl_inter || 0;

    for (const key of chunkKeys) {
      const chunk = this.cache.get(key);
      if (!chunk) return null;

      const { cx, cy, cz } = key;
      const localSlice =
        axis === 'axial'
          ? Math.floor(sliceIndex / factor) - cz * CHUNK_SIZE
          : axis === 'coronal'
            ? Math.floor(sliceIndex / factor) - cy * CHUNK_SIZE
            : Math.floor(sliceIndex / factor) - cx * CHUNK_SIZE;

      if (localSlice < 0 || localSlice >= chunk.depth) continue;

      for (let ly = 0; ly < chunk.height; ly++) {
        for (let lx = 0; lx < chunk.width; lx++) {
          const chunkVal = chunk.data[localSlice * chunk.width * chunk.height + ly * chunk.width + lx];
          const val = chunkVal * slope + inter;

          let outX: number, outY: number;
          if (axis === 'axial') {
            outX = cx * CHUNK_SIZE + lx;
            outY = cy * CHUNK_SIZE + ly;
          } else if (axis === 'coronal') {
            outX = cx * CHUNK_SIZE + lx;
            outY = cz * CHUNK_SIZE + ly;
          } else {
            outX = cy * CHUNK_SIZE + lx;
            outY = cz * CHUNK_SIZE + ly;
          }

          if (outX < outW && outY < outH) {
            result[outY * outW + outX] = val;
          }
        }
      }
    }

    return result;
  }

  clearChunks(): void {
    this.cache.clear();
  }

  getLoadedChunkCount(): number {
    return this.cache.size;
  }
}
