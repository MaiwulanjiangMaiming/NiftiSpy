import { CHUNK_SIZE, type ChunkKey, type VolumeInfo } from './chunkCache';
import { VolumeProvider } from './volumeProvider';

// ---------------------------------------------------------------------------
// ZarrVolumeProvider – read-only Zarr v2 support
// ---------------------------------------------------------------------------

export interface ZarrMetadata {
  zarr_format: number;
  shape: number[];
  chunks: number[];
  dtype: string;
  compressor: {
    id: string;
    [key: string]: unknown;
  } | null;
  fill_value: number | null;
  order: 'C' | 'F';
  filters: unknown[] | null;
}

export class ZarrVolumeProvider extends VolumeProvider {
  private basePath: string;
  private isHttp: boolean;
  private zarrMeta: ZarrMetadata | null = null;
  private bytesPerElement = 1;
  private littleEndian = true;

  constructor(basePath: string) {
    super();
    this.basePath = basePath;
    this.isHttp = basePath.startsWith('http://') || basePath.startsWith('https://');
  }

  async getInfo(): Promise<VolumeInfo> {
    if (this.info) return this.info;

    // Read .zarray metadata
    const metaText = await this.readTextFile('.zarray');
    if (!metaText) throw new Error('Failed to read .zarray metadata');
    this.zarrMeta = JSON.parse(metaText) as ZarrMetadata;

    if (this.zarrMeta.zarr_format !== 2) {
      throw new Error(`Unsupported Zarr format: ${this.zarrMeta.zarr_format}`);
    }

    // Parse dtype to determine bytes per element and endianness
    this.parseDtype(this.zarrMeta.dtype);

    // Zarr shape is [z, y, x] for 3D volumes (C-order)
    const shape = this.zarrMeta.shape;
    const nz = shape.length >= 3 ? shape[0] : 1;
    const ny = shape.length >= 2 ? shape[1] : 1;
    const nx = shape.length >= 1 ? (shape.length >= 3 ? shape[2] : shape[0]) : 1;

    this.info = {
      nx,
      ny,
      nz,
      bytesPerVoxel: this.bytesPerElement,
      voxOffset: 0,
      datatype: this.zarrDtypeToNiftiDatatype(this.zarrMeta.dtype),
      littleEndian: this.littleEndian,
      scl_slope: 1,
      scl_inter: 0,
    };
    return this.info;
  }

  async loadChunk(key: ChunkKey): Promise<Float32Array | null> {
    if (!this.info) await this.getInfo();
    if (!this.zarrMeta) return null;

    const { nx, ny, nz } = this.info!;
    const chunkShape = this.zarrMeta!.chunks;

    // Zarr chunk shape is [cz, cy, cx] in C-order
    const czSize = chunkShape.length >= 3 ? chunkShape[0] : 1;
    const cySize = chunkShape.length >= 2 ? chunkShape[1] : 1;
    const cxSize = chunkShape.length >= 1 ? (chunkShape.length >= 3 ? chunkShape[2] : chunkShape[0]) : 1;

    // Compute how many Zarr chunks span each dimension
    const zarrChunksZ = Math.ceil(nz / czSize);
    const zarrChunksY = Math.ceil(ny / cySize);
    const zarrChunksX = Math.ceil(nx / cxSize);

    // Map our 64³ chunk key to Zarr chunk keys
    // Our chunk grid is 64³, Zarr chunk grid may differ
    const ourChunkSize = CHUNK_SIZE;
    const factor = Math.pow(2, key.lod);

    const startZ = key.cz * ourChunkSize * factor;
    const startY = key.cy * ourChunkSize * factor;
    const startX = key.cx * ourChunkSize * factor;
    const endZ = Math.min(startZ + ourChunkSize * factor, nz);
    const endY = Math.min(startY + ourChunkSize * factor, ny);
    const endX = Math.min(startX + ourChunkSize * factor, nx);

    const outW = Math.ceil((endX - startX) / factor);
    const outH = Math.ceil((endY - startY) / factor);
    const outD = Math.ceil((endZ - startZ) / factor);
    const result = new Float32Array(outW * outH * outD);

    // Load all Zarr chunks that intersect our requested region
    const zarrStartZ = Math.floor(startZ / czSize);
    const zarrEndZ = Math.min(Math.ceil(endZ / czSize), zarrChunksZ);
    const zarrStartY = Math.floor(startY / cySize);
    const zarrEndY = Math.min(Math.ceil(endY / cySize), zarrChunksY);
    const zarrStartX = Math.floor(startX / cxSize);
    const zarrEndX = Math.min(Math.ceil(endX / cxSize), zarrChunksX);

    // Load all needed Zarr chunks
    const zarrChunkMap = new Map<string, Float32Array>();
    const loadPromises: Promise<void>[] = [];

    for (let zc = zarrStartZ; zc < zarrEndZ; zc++) {
      for (let yc = zarrStartY; yc < zarrEndY; yc++) {
        for (let xc = zarrStartX; xc < zarrEndX; xc++) {
          const zarrKey = `${zc}.${yc}.${xc}`;
          loadPromises.push(
            this.loadZarrChunk(zarrKey)
              .then((data) => {
                zarrChunkMap.set(zarrKey, data);
              })
              .catch(() => {
                // Missing chunk – fill with zeros
              }),
          );
        }
      }
    }

    await Promise.all(loadPromises);

    // Assemble our chunk from the Zarr chunks
    for (let z = startZ; z < endZ; z += factor) {
      for (let y = startY; y < endY; y += factor) {
        for (let x = startX; x < endX; x += factor) {
          const zc = Math.floor(z / czSize);
          const yc = Math.floor(y / cySize);
          const xc = Math.floor(x / cxSize);
          const zarrKey = `${zc}.${yc}.${xc}`;
          const zarrData = zarrChunkMap.get(zarrKey);

          if (!zarrData) continue;

          // Local coordinates within the Zarr chunk
          const lz = z - zc * czSize;
          const ly = y - yc * cySize;
          const lx = x - xc * cxSize;

          // Actual Zarr chunk dimensions
          const actualCy = Math.min(cySize, ny - yc * cySize);
          const actualCx = Math.min(cxSize, nx - xc * cxSize);

          // Index into Zarr chunk data (C-order: z * cy * cx + y * cx + x)
          const zarrIdx = lz * actualCy * actualCx + ly * actualCx + lx;
          if (zarrIdx >= 0 && zarrIdx < zarrData.length) {
            const outIdx =
              Math.floor((z - startZ) / factor) * outH * outW +
              Math.floor((y - startY) / factor) * outW +
              Math.floor((x - startX) / factor);
            if (outIdx >= 0 && outIdx < result.length) {
              result[outIdx] = zarrData[zarrIdx];
            }
          }
        }
      }
    }

    return result;
  }

  // --- Zarr-specific helpers ---

  private parseDtype(dtype: string): void {
    // Zarr dtype format: e.g. '<f4' (little-endian float32), '>i2' (big-endian int16)
    const match = dtype.match(/^([<>|])([a-z])(\d+)$/i);
    if (!match) {
      this.bytesPerElement = 4;
      this.littleEndian = true;
      return;
    }
    this.littleEndian = match[1] !== '>';
    this.bytesPerElement = parseInt(match[3], 10);
  }

  private zarrDtypeToNiftiDatatype(dtype: string): number {
    const match = dtype.match(/^([<>|])([a-z])(\d+)$/i);
    if (!match) return 16; // default float32
    const kind = match[2].toLowerCase();
    const size = parseInt(match[3], 10);
    if (kind === 'f') return size === 8 ? 64 : 16;
    if (kind === 'i') {
      if (size === 1) return 256;
      if (size === 2) return 4;
      if (size === 4) return 8;
    }
    if (kind === 'u') {
      if (size === 1) return 2;
      if (size === 2) return 512;
      if (size === 4) return 768;
    }
    return 16;
  }

  private async readTextFile(relativePath: string): Promise<string | null> {
    const fullPath = this.basePath.endsWith('/') ? this.basePath + relativePath : this.basePath + '/' + relativePath;

    if (this.isHttp) {
      try {
        // For metadata, we just need the whole file
        const data = await this.readHttpFile(fullPath);
        return new TextDecoder().decode(data);
      } catch {
        return null;
      }
    }

    try {
      const fs = await import('fs');
      return fs.readFileSync(fullPath, 'utf-8');
    } catch {
      return null;
    }
  }

  private async readHttpFile(url: string): Promise<Uint8Array> {
    const http = await import('http');
    const https = await import('https');
    return new Promise((resolve, reject) => {
      const urlObj = new URL(url);
      const mod = urlObj.protocol === 'https:' ? https : http;
      mod
        .get(url, (res: import('http').IncomingMessage) => {
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode}`));
            return;
          }
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            const total = chunks.reduce((s, c) => s + c.length, 0);
            const result = Buffer.alloc(total);
            let offset = 0;
            for (const chunk of chunks) {
              chunk.copy(result, offset);
              offset += chunk.length;
            }
            resolve(new Uint8Array(result.buffer, result.byteOffset, result.byteLength));
          });
          res.on('error', reject);
        })
        .on('error', reject);
    });
  }

  private async loadZarrChunk(zarrKey: string): Promise<Float32Array> {
    const chunkPath = this.basePath.endsWith('/')
      ? this.basePath + 'data/' + zarrKey
      : this.basePath + '/data/' + zarrKey;

    let rawBytes: Uint8Array;

    if (this.isHttp) {
      rawBytes = await this.readHttpFile(chunkPath);
    } else {
      const fs = await import('fs');
      const data = fs.readFileSync(chunkPath);
      rawBytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    }

    // Decompress if needed
    if (this.zarrMeta?.compressor) {
      rawBytes = await this.decompressZarrChunk(rawBytes, this.zarrMeta.compressor);
    }

    // Convert raw bytes to Float32Array
    return this.convertToFloat32(rawBytes);
  }

  private async decompressZarrChunk(
    data: Uint8Array,
    compressor: { id: string; [key: string]: unknown },
  ): Promise<Uint8Array> {
    const id = compressor.id;

    if (id === 'zlib' || id === 'gzip') {
      const zlib = await import('zlib');
      return new Promise((resolve, reject) => {
        zlib.gunzip(Buffer.from(data.buffer, data.byteOffset, data.byteLength), (err, result) => {
          if (err) reject(err);
          else resolve(new Uint8Array(result.buffer, result.byteOffset, result.byteLength));
        });
      });
    }

    if (id === 'blosc') {
      // Blosc: read header to determine decompressed size and codec
      // Blosc header: 16 bytes – byte 0 = version, byte 1 = versionlz, byte 2 = flags,
      //   bytes 4-7 = uncompressed size (LE), bytes 8-11 = compressed size (LE)
      if (data.length < 16) throw new Error('Invalid blosc chunk header');
      const view = new DataView(data.buffer, data.byteOffset, data.length);
      const uncompressedSize = view.getUint32(4, true);

      // Try native blosc decompression via fflate or fallback
      // Since we don't have a blosc library, we'll try a simple approach:
      // Blosc can use lz4, snappy, zlib internally.
      // For now, we'll use a basic approach: try to decompress with zlib
      // if the blosc chunk uses zlib internally
      try {
        const zlib = await import('zlib');
        // Blosc header is 16 bytes, then compressed data
        // This is a simplified approach – full blosc support would need a native module
        const compressedPayload = data.slice(16);
        return new Promise((resolve, reject) => {
          zlib.inflateRaw(
            Buffer.from(compressedPayload.buffer, compressedPayload.byteOffset, compressedPayload.byteLength),
            (err, result) => {
              if (err) reject(new Error(`Blosc decompression failed: ${err.message}`));
              else if (result.length === uncompressedSize) {
                resolve(new Uint8Array(result.buffer, result.byteOffset, result.byteLength));
              } else {
                // Try gunzip
                zlib.gunzip(Buffer.from(data.buffer, data.byteOffset, data.byteLength), (err2, result2) => {
                  if (err2) reject(new Error(`Blosc decompression failed`));
                  else resolve(new Uint8Array(result2.buffer, result2.byteOffset, result2.byteLength));
                });
              }
            },
          );
        });
      } catch {
        throw new Error(`Blosc decompression not fully supported`);
      }
    }

    if (id === 'lz4') {
      // LZ4 block format: we need an LZ4 decompressor
      // fflate does not support LZ4; try zlib-compatible decompression.
      try {
        // fflate doesn't support LZ4, so we'll try zlib-compatible decompression
        const zlib = await import('zlib');
        return new Promise((resolve, reject) => {
          zlib.gunzip(Buffer.from(data.buffer, data.byteOffset, data.byteLength), (err, result) => {
            if (err) reject(new Error(`LZ4 decompression failed: ${err.message}`));
            else resolve(new Uint8Array(result.buffer, result.byteOffset, result.byteLength));
          });
        });
      } catch {
        throw new Error(`LZ4 decompression not fully supported`);
      }
    }

    // Unknown compressor – try zlib as a fallback
    try {
      const zlib = await import('zlib');
      return new Promise((resolve, reject) => {
        zlib.gunzip(Buffer.from(data.buffer, data.byteOffset, data.byteLength), (err, result) => {
          if (err) reject(err);
          else resolve(new Uint8Array(result.buffer, result.byteOffset, result.byteLength));
        });
      });
    } catch {
      throw new Error(`Unsupported Zarr compressor: ${id}`);
    }
  }

  private convertToFloat32(rawBytes: Uint8Array): Float32Array {
    if (!this.zarrMeta) return new Float32Array(0);

    const n = rawBytes.length / this.bytesPerElement;
    const result = new Float32Array(n);
    const view = new DataView(rawBytes.buffer, rawBytes.byteOffset, rawBytes.length);
    const le = this.littleEndian;
    const dtype = this.zarrMeta.dtype;

    const match = dtype.match(/^([<>|])([a-z])(\d+)$/i);
    if (!match) {
      // Default: treat as float32
      for (let i = 0; i < n; i++) result[i] = view.getFloat32(i * 4, le);
      return result;
    }

    const kind = match[2].toLowerCase();
    const size = parseInt(match[3], 10);

    for (let i = 0; i < n; i++) {
      const off = i * size;
      if (off + size > rawBytes.length) break;

      switch (kind) {
        case 'f':
          result[i] = size === 8 ? view.getFloat64(off, le) : view.getFloat32(off, le);
          break;
        case 'i':
          if (size === 1) result[i] = view.getInt8(off);
          else if (size === 2) result[i] = view.getInt16(off, le);
          else if (size === 4) result[i] = view.getInt32(off, le);
          else if (size === 8) result[i] = Number(view.getBigInt64(off, le));
          break;
        case 'u':
          if (size === 1) result[i] = view.getUint8(off);
          else if (size === 2) result[i] = view.getUint16(off, le);
          else if (size === 4) result[i] = view.getUint32(off, le);
          break;
        default:
          result[i] = view.getFloat32(off, le);
      }
    }

    return result;
  }
}
