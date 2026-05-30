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

const CHUNK_SIZE = 64;
const MAX_CHUNKS = 512;

export abstract class VolumeProvider {
  protected info: VolumeInfo | null = null;
  protected chunks = new Map<string, VolumeChunk>();
  protected pendingLoads = new Map<string, Promise<Float32Array | null>>();

  abstract loadChunk(key: ChunkKey): Promise<Float32Array | null>;
  abstract getInfo(): Promise<VolumeInfo>;

  private chunkKeyToString(key: ChunkKey): string {
    return `${key.cx}:${key.cy}:${key.cz}:lod${key.lod}`;
  }

  getChunk(key: ChunkKey): VolumeChunk | null {
    return this.chunks.get(this.chunkKeyToString(key)) || null;
  }

  async getOrLoadChunk(key: ChunkKey): Promise<VolumeChunk | null> {
    const strKey = this.chunkKeyToString(key);
    const existing = this.chunks.get(strKey);
    if (existing) {
      existing.timestamp = Date.now();
      return existing;
    }

    const pending = this.pendingLoads.get(strKey);
    if (pending) {
      const data = await pending;
      return data ? this.chunks.get(strKey) || null : null;
    }

    const loadPromise = this.loadChunk(key);
    this.pendingLoads.set(strKey, loadPromise);

    try {
      const data = await loadPromise;
      if (data) {
        const { cx, cy, cz, lod } = key;
        const factor = Math.pow(2, lod);
        const w = Math.min(CHUNK_SIZE, Math.ceil((this.info!.nx / factor - cx * CHUNK_SIZE)));
        const h = Math.min(CHUNK_SIZE, Math.ceil((this.info!.ny / factor - cy * CHUNK_SIZE)));
        const d = Math.min(CHUNK_SIZE, Math.ceil((this.info!.nz / factor - cz * CHUNK_SIZE)));
        const chunk: VolumeChunk = { key, data, width: w, height: h, depth: d, timestamp: Date.now() };
        this.chunks.set(strKey, chunk);
        this.evictIfNeeded();
        return chunk;
      }
      return null;
    } finally {
      this.pendingLoads.delete(strKey);
    }
  }

  getChunksForSlice(axis: 'axial' | 'coronal' | 'sagittal', sliceIndex: number, lod: number): ChunkKey[] {
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

  extractSliceFromChunks(
    axis: 'axial' | 'coronal' | 'sagittal',
    sliceIndex: number,
    lod: number
  ): Float32Array | null {
    if (!this.info) return null;
    const { nx, ny, nz, scl_slope, scl_inter } = this.info;
    const factor = Math.pow(2, lod);
    const chunkKeys = this.getChunksForSlice(axis, sliceIndex, lod);

    let outW: number, outH: number;
    if (axis === 'axial') { outW = Math.ceil(nx / factor); outH = Math.ceil(ny / factor); }
    else if (axis === 'coronal') { outW = Math.ceil(nx / factor); outH = Math.ceil(nz / factor); }
    else { outW = Math.ceil(ny / factor); outH = Math.ceil(nz / factor); }

    const result = new Float32Array(outW * outH);
    const slope = scl_slope || 1;
    const inter = scl_inter || 0;

    for (const key of chunkKeys) {
      const chunk = this.getChunk(key);
      if (!chunk) return null;

      const { cx, cy, cz } = key;
      const localSlice = axis === 'axial'
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

  private evictIfNeeded(): void {
    if (this.chunks.size <= MAX_CHUNKS) return;
    const entries = Array.from(this.chunks.entries()).sort((a, b) => a[1].timestamp - b[1].timestamp);
    const toRemove = this.chunks.size - MAX_CHUNKS + MAX_CHUNKS * 0.2;
    for (let i = 0; i < toRemove && i < entries.length; i++) {
      this.chunks.delete(entries[i][0]);
    }
  }

  clearChunks(): void {
    this.chunks.clear();
    this.pendingLoads.clear();
  }

  getLoadedChunkCount(): number {
    return this.chunks.size;
  }
}

export class LocalVolumeProvider extends VolumeProvider {
  private fsPath: string;
  private rawData: Uint8Array | null = null;

  constructor(fsPath: string) {
    super();
    this.fsPath = fsPath;
  }

  async getInfo(): Promise<VolumeInfo> {
    if (this.info) return this.info;
    const { parseNiiHeaderQuick } = await import('../nifti/headerParser');
    const { readLocalFilePartial } = await import('../io/fileReader');
    const headerBytes = await readLocalFilePartial(this.fsPath, 0, 543);
    const header = parseNiiHeaderQuick(headerBytes);
    if (!header) throw new Error('Failed to parse NIfTI header');
    this.info = {
      nx: header.nx, ny: header.ny, nz: header.nz,
      bytesPerVoxel: header.bytesPerVoxel,
      voxOffset: header.voxOffset,
      datatype: header.datatype,
      littleEndian: header.littleEndian,
      scl_slope: header.scl_slope || 1,
      scl_inter: header.scl_inter || 0,
    };
    return this.info;
  }

  async loadChunk(key: ChunkKey): Promise<Float32Array | null> {
    if (!this.info) await this.getInfo();
    if (!this.rawData) {
      const fs = await import('fs');
      const data = fs.readFileSync(this.fsPath);
      this.rawData = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    }
    const { nx, ny, nz, voxOffset, bytesPerVoxel, datatype, littleEndian } = this.info!;
    const factor = Math.pow(2, key.lod);
    const bpv = Math.max(1, bytesPerVoxel);

    const startX = key.cx * CHUNK_SIZE * factor;
    const startY = key.cy * CHUNK_SIZE * factor;
    const startZ = key.cz * CHUNK_SIZE * factor;
    const endX = Math.min(startX + CHUNK_SIZE * factor, nx);
    const endY = Math.min(startY + CHUNK_SIZE * factor, ny);
    const endZ = Math.min(startZ + CHUNK_SIZE * factor, nz);

    const outW = Math.ceil((endX - startX) / factor);
    const outH = Math.ceil((endY - startY) / factor);
    const outD = Math.ceil((endZ - startZ) / factor);
    const result = new Float32Array(outW * outH * outD);

    const le = littleEndian;
    let outIdx = 0;
    for (let z = startZ; z < endZ; z += factor) {
      for (let y = startY; y < endY; y += factor) {
        for (let x = startX; x < endX; x += factor) {
          const offset = voxOffset + (z * ny * nx + y * nx + x) * bpv;
          if (offset + bpv > this.rawData!.length) { result[outIdx++] = 0; continue; }
          const view = new DataView(this.rawData!.buffer, this.rawData!.byteOffset + offset, bpv);
          let val: number;
          switch (datatype) {
            case 2: val = this.rawData![offset]; break;
            case 4: val = view.getInt16(0, le); break;
            case 8: val = view.getInt32(0, le); break;
            case 16: val = view.getFloat32(0, le); break;
            case 64: val = view.getFloat64(0, le); break;
            case 256: val = (this.rawData![offset] << 24) >> 24; break;
            case 512: val = view.getUint16(0, le); break;
            case 768: val = view.getUint32(0, le); break;
            default: val = 0;
          }
          result[outIdx++] = val;
        }
      }
    }

    return result;
  }
}
