import * as http from 'http';
import * as zlib from 'zlib';
import * as vscode from 'vscode';
import * as fs from 'fs';
import { VolumeCache } from './VolumeCache';

interface FileEntry {
  uri: vscode.Uri;
  id: string;
  size?: number;
  dataCache?: Uint8Array;
  lastAccess?: number;
  headerCache?: any;
  previewCache?: any;
  previewBinaryCache?: Buffer;
  sliceCache?: Map<string, { data: Buffer; timestamp: number }>;
  lodCache?: Map<number, { header: any; data: Float32Array; timestamp: number }>;
  pendingLoad?: Promise<{ rawData: Uint8Array; header: any }>;
}

interface LRUCache<K, V> {
  get(key: K): V | undefined;
  set(key: K, value: V): void;
  delete(key: K): void;
  size: number;
}

function createLRUCache<K, V>(maxSize: number): LRUCache<K, V> & { entries(): IterableIterator<[K, V]> } {
  const map = new Map<K, V>();
  return {
    get(key: K) {
      const v = map.get(key);
      if (v !== undefined) { map.delete(key); map.set(key, v); }
      return v;
    },
    set(key: K, value: V) {
      map.delete(key);
      map.set(key, value);
      if (map.size > maxSize) {
        const first = map.keys().next().value;
        if (first !== undefined) map.delete(first);
      }
    },
    delete(key: K) { map.delete(key); },
    get size() { return map.size; },
    entries() { return map.entries(); },
  };
}

const globalSliceCache = createLRUCache<string, { data: Buffer; timestamp: number }>(512);

function parseNiiHeaderQuick(buf: Uint8Array): any | null {
  if (buf.length < 348) return null;
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const le = v.getInt32(0, true) === 348 || v.getInt32(0, true) === 540;
  if (!le && v.getInt32(0, false) !== 348 && v.getInt32(0, false) !== 540) return null;
  const sizeofHdr = v.getInt32(0, le);
  const version = sizeofHdr === 540 ? 2 : 1;
  const ndim = version === 1 ? v.getInt16(40, le) : v.getInt8(16);
  if (ndim < 1 || ndim > 7) return null;
  let nx: number, ny: number, nz: number, dx: number, dy: number, dz: number;
  let datatype: number, bitpix: number, voxOffset: number;
  let scl_slope: number, scl_inter: number;
  let qform_code: number, sform_code: number;
  let quatern_b: number, quatern_c: number, quatern_d: number;
  let qoffset_x: number, qoffset_y: number, qoffset_z: number;
  let srow_x: number[], srow_y: number[], srow_z: number[];

  if (version === 1) {
    nx = Math.max(1, v.getInt16(42, le));
    ny = Math.max(1, v.getInt16(44, le));
    nz = Math.max(1, v.getInt16(46, le));
    datatype = v.getInt16(70, le);
    bitpix = v.getInt16(72, le);
    dx = Math.abs(v.getFloat32(76 + 4, le)) || 1;
    dy = Math.abs(v.getFloat32(76 + 8, le)) || 1;
    dz = Math.abs(v.getFloat32(76 + 12, le)) || 1;
    voxOffset = v.getFloat32(108, le);
    scl_slope = v.getFloat32(112, le);
    scl_inter = v.getFloat32(116, le);
    qform_code = v.getInt16(252, le);
    sform_code = v.getInt16(254, le);
    quatern_b = v.getFloat32(256, le);
    quatern_c = v.getFloat32(260, le);
    quatern_d = v.getFloat32(264, le);
    qoffset_x = v.getFloat32(268, le);
    qoffset_y = v.getFloat32(272, le);
    qoffset_z = v.getFloat32(276, le);
    srow_x = [v.getFloat32(280, le), v.getFloat32(284, le), v.getFloat32(288, le), v.getFloat32(292, le)];
    srow_y = [v.getFloat32(296, le), v.getFloat32(300, le), v.getFloat32(304, le), v.getFloat32(308, le)];
    srow_z = [v.getFloat32(312, le), v.getFloat32(316, le), v.getFloat32(320, le), v.getFloat32(324, le)];
    voxOffset = Math.max(352, voxOffset);
  } else {
    nx = Number(v.getBigInt64(24, le));
    ny = Number(v.getBigInt64(32, le));
    nz = Number(v.getBigInt64(40, le));
    datatype = v.getInt16(12, le);
    bitpix = v.getInt16(14, le);
    dx = Math.abs(v.getFloat64(104, le)) || 1;
    dy = Math.abs(v.getFloat64(112, le)) || 1;
    dz = Math.abs(v.getFloat64(120, le)) || 1;
    voxOffset = Number(v.getBigInt64(168, le));
    scl_slope = v.getFloat64(176, le);
    scl_inter = v.getFloat64(184, le);
    qform_code = v.getInt16(196, le);
    sform_code = v.getInt16(198, le);
    quatern_b = v.getFloat32(200, le);
    quatern_c = v.getFloat32(204, le);
    quatern_d = v.getFloat32(208, le);
    qoffset_x = v.getFloat32(212, le);
    qoffset_y = v.getFloat32(216, le);
    qoffset_z = v.getFloat32(220, le);
    srow_x = [v.getFloat64(224, le), v.getFloat64(232, le), v.getFloat64(240, le), v.getFloat64(248, le)];
    srow_y = [v.getFloat64(256, le), v.getFloat64(264, le), v.getFloat64(272, le), v.getFloat64(280, le)];
    srow_z = [v.getFloat64(288, le), v.getFloat64(296, le), v.getFloat64(304, le), v.getFloat64(312, le)];
    voxOffset = Math.max(544, voxOffset);
  }

  return {
    version, ndim, nx, ny, nz, dx, dy, dz, datatype, bitpix, voxOffset,
    scl_slope: scl_slope || 1, scl_inter: scl_inter || 0,
    littleEndian: le, qform_code, sform_code,
    quatern_b, quatern_c, quatern_d,
    qoffset_x, qoffset_y, qoffset_z,
    srow_x, srow_y, srow_z,
    nt: 1, nu: 1, dt: 0, isGzip: false,
    bytesPerVoxel: Math.max(1, bitpix / 8),
    totalVoxels3D: nx * ny * nz,
    sliceSizeXY: nx * ny,
    volumeBytes: nx * ny * nz * Math.max(1, bitpix / 8),
    descrip: '', xyzt_units: 0, orientation: 'unknown',
  };
}

function extractAxialSliceFromRange(sliceBytes: Uint8Array, header: any): Float32Array {
  const { nx, ny, datatype, scl_slope, scl_inter, littleEndian } = header;
  const bpv = Math.max(1, header.bitpix / 8);
  const le = littleEndian;
  const slope = scl_slope || 1;
  const inter = scl_inter || 0;
  const n = nx * ny;
  const slice = new Float32Array(n);
  const view = new DataView(sliceBytes.buffer, sliceBytes.byteOffset, sliceBytes.byteLength);

  for (let i = 0; i < n; i++) {
    const off = i * bpv;
    let val: number;
    switch (datatype) {
      case 2: val = sliceBytes[off]; break;
      case 4: val = view.getInt16(off, le); break;
      case 8: val = view.getInt32(off, le); break;
      case 16: val = view.getFloat32(off, le); break;
      case 64: val = view.getFloat64(off, le); break;
      case 256: val = (sliceBytes[off] << 24) >> 24; break;
      case 512: val = view.getUint16(off, le); break;
      case 768: val = view.getUint32(off, le); break;
      default: val = 0;
    }
    slice[i] = val * slope + inter;
  }
  return slice;
}

function extractPreviewSlices(rawData: Uint8Array, header: any): { axial: Float32Array; coronal: Float32Array; sagittal: Float32Array } | null {
  const { nx, ny, nz, datatype, scl_slope, scl_inter, littleEndian, voxOffset } = header;
  const n = nx * ny * nz;
  const bpv = Math.max(1, header.bitpix / 8);
  const dataStart = voxOffset;
  const dataEnd = dataStart + n * bpv;
  if (rawData.length < dataEnd) return null;

  const le = littleEndian;
  const slope = scl_slope || 1;
  const inter = scl_inter || 0;
  const view = new DataView(rawData.buffer, rawData.byteOffset, rawData.byteLength);

  function getVoxel(idx: number): number {
    const off = dataStart + idx * bpv;
    switch (datatype) {
      case 2: return rawData[off];
      case 4: return view.getInt16(off, le);
      case 8: return view.getInt32(off, le);
      case 16: return view.getFloat32(off, le);
      case 64: return view.getFloat64(off, le);
      case 256: return (rawData[off] << 24) >> 24;
      case 512: return view.getUint16(off, le);
      case 768: return view.getUint32(off, le);
      default: return 0;
    }
  }

  const axMid = Math.floor(nz / 2);
  const coMid = Math.floor(ny / 2);
  const saMid = Math.floor(nx / 2);

  const axial = new Float32Array(nx * ny);
  const coronal = new Float32Array(nx * nz);
  const sagittal = new Float32Array(ny * nz);

  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) {
      axial[y * nx + x] = getVoxel(axMid * ny * nx + y * nx + x) * slope + inter;
    }
  }
  for (let z = 0; z < nz; z++) {
    for (let x = 0; x < nx; x++) {
      coronal[z * nx + x] = getVoxel(z * ny * nx + coMid * nx + x) * slope + inter;
    }
  }
  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      sagittal[z * ny + y] = getVoxel(z * ny * nx + y * nx + saMid) * slope + inter;
    }
  }

  return { axial, coronal, sagittal };
}

function computeSliceMinMax(...slices: Float32Array[]): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;

  for (const slice of slices) {
    for (let i = 0; i < slice.length; i++) {
      const value = slice[i];
      if (value < min) min = value;
      if (value > max) max = value;
    }
  }

  if (min === max) {
    max = min + 1;
  }

  return { min, max };
}

function extractSingleSlice(rawData: Uint8Array, header: any, axis: string, idx: number): Float32Array | null {
  const { nx, ny, nz, datatype, scl_slope, scl_inter, littleEndian, voxOffset } = header;
  const bpv = Math.max(1, header.bitpix / 8);
  const dataStart = voxOffset;
  const le = littleEndian;
  const slope = scl_slope || 1;
  const inter = scl_inter || 0;
  const view = new DataView(rawData.buffer, rawData.byteOffset, rawData.byteLength);

  function getVoxel(vidx: number): number {
    const off = dataStart + vidx * bpv;
    if (off + bpv > rawData.length) return 0;
    switch (datatype) {
      case 2: return rawData[off];
      case 4: return view.getInt16(off, le);
      case 8: return view.getInt32(off, le);
      case 16: return view.getFloat32(off, le);
      case 64: return view.getFloat64(off, le);
      case 256: return (rawData[off] << 24) >> 24;
      case 512: return view.getUint16(off, le);
      case 768: return view.getUint32(off, le);
      default: return 0;
    }
  }

  if (axis === 'axial') {
    if (idx < 0 || idx >= nz) return null;
    const slice = new Float32Array(nx * ny);
    const base = idx * ny * nx;
    for (let i = 0; i < nx * ny; i++) {
      slice[i] = getVoxel(base + i) * slope + inter;
    }
    return slice;
  } else if (axis === 'coronal') {
    if (idx < 0 || idx >= ny) return null;
    const slice = new Float32Array(nx * nz);
    for (let z = 0; z < nz; z++) {
      const base = z * ny * nx + idx * nx;
      for (let x = 0; x < nx; x++) {
        slice[z * nx + x] = getVoxel(base + x) * slope + inter;
      }
    }
    return slice;
  } else if (axis === 'sagittal') {
    if (idx < 0 || idx >= nx) return null;
    const slice = new Float32Array(ny * nz);
    for (let z = 0; z < nz; z++) {
      const base = z * ny * nx;
      for (let y = 0; y < ny; y++) {
        slice[z * ny + y] = getVoxel(base + y * nx + idx) * slope + inter;
      }
    }
    return slice;
  }
  return null;
}

function downsampleSlice(data: Float32Array, w: number, h: number, factor: number): { data: Float32Array; w: number; h: number } {
  const nw = Math.max(1, Math.floor(w / factor));
  const nh = Math.max(1, Math.floor(h / factor));
  const out = new Float32Array(nw * nh);
  for (let y = 0; y < nh; y++) {
    for (let x = 0; x < nw; x++) {
      let sum = 0;
      let count = 0;
      const sy0 = y * factor;
      const sx0 = x * factor;
      const sy1 = Math.min(h, (y + 1) * factor);
      const sx1 = Math.min(w, (x + 1) * factor);
      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0; sx < sx1; sx++) {
          sum += data[sy * w + sx];
          count++;
        }
      }
      out[y * nw + x] = count > 0 ? sum / count : 0;
    }
  }
  return { data: out, w: nw, h: nh };
}

function shouldCompress(req: http.IncomingMessage): boolean {
  const acceptEncoding = req.headers['accept-encoding'] || '';
  return acceptEncoding.includes('gzip');
}

function compressResponse(data: Buffer, req: http.IncomingMessage, res: http.ServerResponse, contentType: string, extraHeaders?: Record<string, string>): void {
  const headers: Record<string, string> = {
    'Content-Type': contentType,
    ...extraHeaders,
  };

  if (shouldCompress(req)) {
    zlib.gzip(data, (err, compressed) => {
      if (err) {
        headers['Content-Length'] = String(data.length);
        res.writeHead(200, headers);
        res.end(data);
        return;
      }
      headers['Content-Encoding'] = 'gzip';
      headers['Content-Length'] = String(compressed.length);
      res.writeHead(200, headers);
      res.end(compressed);
    });
  } else {
    headers['Content-Length'] = String(data.length);
    res.writeHead(200, headers);
    res.end(data);
  }
}

function gunzipAsync(data: Uint8Array, signal?: AbortSignal): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }
    zlib.gunzip(Buffer.from(data.buffer, data.byteOffset, data.byteLength), (err, result) => {
      if (signal?.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }
      if (err) reject(err);
      else resolve(new Uint8Array(result.buffer, result.byteOffset, result.byteLength));
    });
  });
}

function readLocalFilePartial(fsPath: string, start: number, end: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const stream = fs.createReadStream(fsPath, { start, end });
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('end', () => {
      const total = chunks.reduce((s, c) => s + c.length, 0);
      const result = Buffer.alloc(total);
      let offset = 0;
      for (const chunk of chunks) { chunk.copy(result, offset); offset += chunk.length; }
      resolve(new Uint8Array(result.buffer, result.byteOffset, result.byteLength));
    });
    stream.on('error', reject);
  });
}

function streamingGunzipPreview(fsPath: string, signal?: AbortSignal): Promise<{ header: any; axialSlice: Float32Array; rawData: Uint8Array }> {
  return new Promise((resolve, reject) => {
    const gunzip = zlib.createGunzip();
    const chunks: Buffer[] = [];
    let totalSize = 0;
    let resolved = false;
    let header: any = null;
    let axialNeeded = Infinity;

    const stream = fs.createReadStream(fsPath);
    stream.pipe(gunzip);

    const onAbort = () => {
      if (!resolved) {
        resolved = true;
        stream.destroy();
        gunzip.destroy();
        reject(new DOMException('Aborted', 'AbortError'));
      }
    };
    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }

    gunzip.on('data', (chunk: Buffer) => {
      if (resolved) return;
      if (signal?.aborted) { gunzip.destroy(); return; }
      chunks.push(chunk);
      totalSize += chunk.length;

      if (!header && totalSize >= 544) {
        const buf = Buffer.concat(chunks);
        header = parseNiiHeaderQuick(new Uint8Array(buf.buffer, buf.byteOffset, buf.length));
        if (header) {
          const { nx, ny, nz, voxOffset, bytesPerVoxel } = header;
          axialNeeded = voxOffset + (Math.floor(nz / 2) + 1) * nx * ny * bytesPerVoxel;
        }
      }

      if (header && totalSize >= axialNeeded && !resolved) {
        const buf = Buffer.concat(chunks);
        const { nx, ny, nz, voxOffset, bytesPerVoxel } = header;
        const axMid = Math.floor(nz / 2);
        const sliceStart = voxOffset + axMid * nx * ny * bytesPerVoxel;
        const sliceEnd = sliceStart + nx * ny * bytesPerVoxel;
        if (buf.length >= sliceEnd) {
          const sliceBytes = new Uint8Array(buf.buffer, buf.byteOffset + sliceStart, nx * ny * bytesPerVoxel);
          const axialSlice = extractAxialSliceFromRange(sliceBytes, header);
          resolved = true;
          const rawData = new Uint8Array(buf.buffer, buf.byteOffset, buf.length);
          resolve({ header, axialSlice, rawData });
        }
      }
    });

    gunzip.on('end', () => {
      if (signal) signal.removeEventListener('abort', onAbort);
      if (!resolved) {
        const buf = Buffer.concat(chunks);
        const rawData = new Uint8Array(buf.buffer, buf.byteOffset, buf.length);
        if (!header) {
          header = parseNiiHeaderQuick(rawData);
        }
        if (header) {
          const { nx, ny, nz, voxOffset, bytesPerVoxel } = header;
          const axMid = Math.floor(nz / 2);
          const sliceStart = voxOffset + axMid * nx * ny * bytesPerVoxel;
          const sliceEnd = sliceStart + nx * ny * bytesPerVoxel;
          let axialSlice: Float32Array;
          if (rawData.length >= sliceEnd) {
            const sliceBytes = new Uint8Array(rawData.buffer, rawData.byteOffset + sliceStart, nx * ny * bytesPerVoxel);
            axialSlice = extractAxialSliceFromRange(sliceBytes, header);
          } else {
            axialSlice = new Float32Array(nx * ny);
          }
          resolve({ header, axialSlice, rawData });
        } else {
          reject(new Error('Failed to parse NIfTI header from decompressed data'));
        }
      }
    });

    gunzip.on('error', (err) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      if (!resolved) {
        resolved = true;
        reject(err);
      }
    });

    stream.on('error', (err) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      if (!resolved) {
        resolved = true;
        reject(err);
      }
    });
  });
}

export class LocalFileProxy {
  private server: http.Server | null = null;
  private port = 0;
  private files = new Map<string, FileEntry>();
  private idCounter = 0;
  private cleanupInterval: NodeJS.Timeout | null = null;
  private volumeCache: VolumeCache | null;

  constructor(volumeCache?: VolumeCache) {
    this.volumeCache = volumeCache || null;
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer(this.handleRequest.bind(this));
      this.server.listen(0, '127.0.0.1', () => {
        const addr = this.server!.address() as { port: number };
        this.port = addr.port;
        this.startCleanup();
        resolve();
      });
      this.server.on('error', reject);
    });
  }

  private startCleanup(): void {
    this.cleanupInterval = setInterval(() => {
      const now = Date.now();
      for (const [, entry] of this.files.entries()) {
        if (entry.dataCache && entry.lastAccess && now - entry.lastAccess > 120000) {
          entry.dataCache = undefined;
          entry.previewCache = undefined;
          entry.previewBinaryCache = undefined;
          entry.headerCache = undefined;
          entry.sliceCache?.clear();
          entry.lodCache?.clear();
        } else if (entry.sliceCache) {
          for (const [key, val] of entry.sliceCache.entries()) {
            if (now - val.timestamp > 60000) entry.sliceCache.delete(key);
          }
        }
      }
      for (const [key, val] of globalSliceCache.entries()) {
        if (Date.now() - val.timestamp > 90000) globalSliceCache.delete(key);
      }
      this.volumeCache?.cleanup();
      this.volumeCache?.evictIfNeeded();
    }, 30000);
  }

  stop(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.server?.close();
    this.server = null;
  }

  registerFile(uri: vscode.Uri): string {
    const id = String(this.idCounter++);
    this.files.set(id, { uri, id, sliceCache: new Map(), lodCache: new Map() });
    return `http://127.0.0.1:${this.port}/file/${id}`;
  }

  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Range, Accept-Encoding');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges, Content-Encoding');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Keep-Alive', 'timeout=30, max=100');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const headerMatch = req.url?.match(/^\/header\/(\d+)$/);
    const previewMatch = req.url?.match(/^\/preview\/(\d+)$/);
    const previewBinMatch = req.url?.match(/^\/preview-bin\/(\d+)$/);
    const sliceMatch = req.url?.match(/^\/slice\/(\d+)\/(axial|coronal|sagittal)\/(\d+)$/);
    const lodMatch = req.url?.match(/^\/lod\/(\d+)\/(\d+)$/);
    const fileMatch = req.url?.match(/^\/file\/(\d+)$/);
    const match = headerMatch || previewMatch || previewBinMatch || sliceMatch || lodMatch || fileMatch;
    if (!match) {
      res.writeHead(404);
      res.end();
      return;
    }

    const entry = this.files.get(match[1]);
    if (!entry) {
      res.writeHead(404);
      res.end();
      return;
    }

    try {
      if (headerMatch) {
        await this.handleHeader(entry, res, req);
        return;
      }
      if (previewMatch) {
        await this.handlePreview(entry, res, req);
        return;
      }
      if (previewBinMatch) {
        await this.handlePreviewBinary(entry, res, req);
        return;
      }
      if (sliceMatch) {
        await this.handleSlice(entry, sliceMatch[2], parseInt(sliceMatch[3]), res, req);
        return;
      }
      if (lodMatch) {
        await this.handleLOD(entry, parseInt(lodMatch[2]), res, req);
        return;
      }

      if (!entry.size) {
        const stat = await vscode.workspace.fs.stat(entry.uri);
        entry.size = Number(stat.size);
      }
      const totalSize = entry.size!;

      const rangeHeader = req.headers['range'];
      if (rangeHeader) {
        const m = rangeHeader.match(/bytes=(\d+)-(\d*)/);
        if (!m) {
          res.writeHead(416, { 'Content-Range': `bytes */${totalSize}` });
          res.end();
          return;
        }
        const start = parseInt(m[1]);
        const end = m[2] ? Math.min(parseInt(m[2]), totalSize - 1) : totalSize - 1;
        const chunkSize = end - start + 1;

        const fsPath = entry.uri.fsPath;
        if (fsPath) {
          res.writeHead(206, {
            'Content-Range': `bytes ${start}-${end}/${totalSize}`,
            'Content-Length': chunkSize,
            'Accept-Ranges': 'bytes',
            'Content-Type': 'application/octet-stream',
          });
          fs.createReadStream(fsPath, { start, end }).pipe(res);
        } else {
          entry.lastAccess = Date.now();
          if (!entry.dataCache) {
            entry.dataCache = await vscode.workspace.fs.readFile(entry.uri);
          }
          const chunk = entry.dataCache.slice(start, end + 1);
          res.writeHead(206, {
            'Content-Range': `bytes ${start}-${end}/${totalSize}`,
            'Content-Length': chunkSize,
            'Accept-Ranges': 'bytes',
            'Content-Type': 'application/octet-stream',
          });
          res.end(Buffer.from(chunk));
        }
      } else {
        const fsPath = entry.uri.fsPath;
        if (fsPath && !shouldCompress(req)) {
          res.writeHead(200, {
            'Content-Length': totalSize,
            'Accept-Ranges': 'bytes',
            'Content-Type': 'application/octet-stream',
          });
          fs.createReadStream(fsPath).pipe(res);
        } else if (fsPath && shouldCompress(req)) {
          res.writeHead(200, {
            'Content-Encoding': 'gzip',
            'Accept-Ranges': 'bytes',
            'Content-Type': 'application/octet-stream',
          });
          fs.createReadStream(fsPath).pipe(zlib.createGzip({ level: 1 })).pipe(res);
        } else {
          entry.lastAccess = Date.now();
          if (!entry.dataCache) {
            entry.dataCache = await vscode.workspace.fs.readFile(entry.uri);
          }
          compressResponse(Buffer.from(entry.dataCache), req, res, 'application/octet-stream', { 'Accept-Ranges': 'bytes' });
        }
      }
    } catch (err) {
      console.error('LocalFileProxy error:', err);
      res.writeHead(500);
      res.end(String(err));
    }
  }

  private async handleHeader(entry: FileEntry, res: http.ServerResponse, req: http.IncomingMessage): Promise<void> {
    try {
      if (entry.headerCache) {
        compressResponse(Buffer.from(JSON.stringify(entry.headerCache)), req, res, 'application/json');
        return;
      }

      const fsPath = entry.uri.fsPath;
      const isGzip = fsPath ? fsPath.endsWith('.gz') : entry.uri.toString().endsWith('.gz');

      if (isGzip) {
        const { header } = await this.loadFileData(entry);
        compressResponse(Buffer.from(JSON.stringify(header)), req, res, 'application/json');
        return;
      }

      let headerBytes: Uint8Array;
      if (fsPath) {
        headerBytes = await readLocalFilePartial(fsPath, 0, 543);
      } else {
        const fullData = await vscode.workspace.fs.readFile(entry.uri);
        entry.dataCache = new Uint8Array(fullData.buffer, fullData.byteOffset, fullData.byteLength);
        entry.lastAccess = Date.now();
        headerBytes = entry.dataCache.slice(0, 544);
      }

      const header = parseNiiHeaderQuick(headerBytes);
      if (!header) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to parse NIfTI header' }));
        return;
      }

      entry.headerCache = header;
      compressResponse(Buffer.from(JSON.stringify(header)), req, res, 'application/json');
    } catch (err: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(err?.message ?? err) }));
    }
  }

  private async handlePreview(entry: FileEntry, res: http.ServerResponse, req: http.IncomingMessage): Promise<void> {
    try {
      if (entry.previewCache) {
        compressResponse(Buffer.from(JSON.stringify(entry.previewCache)), req, res, 'application/json');
        return;
      }

      const fsPath = entry.uri.fsPath;
      const isGzip = fsPath ? fsPath.endsWith('.gz') : entry.uri.toString().endsWith('.gz');
      const isLocal = !!fsPath;

      if (isLocal && !isGzip) {
        await this.handlePreviewLocalNii(entry, res, req);
        return;
      }

      if (isLocal && isGzip) {
        await this.handlePreviewLocalGz(entry, res, req);
        return;
      }

      await this.handlePreviewRemote(entry, res, req);
    } catch (err: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(err?.message ?? err) }));
    }
  }

  private async handlePreviewLocalNii(entry: FileEntry, res: http.ServerResponse, req: http.IncomingMessage): Promise<void> {
    const fsPath = entry.uri.fsPath!;

    if (!entry.headerCache) {
      const headerBytes = await readLocalFilePartial(fsPath, 0, 543);
      const header = parseNiiHeaderQuick(headerBytes);
      if (!header) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to parse header' }));
        return;
      }
      entry.headerCache = header;
    }

    const header = entry.headerCache;
    const { nx, ny, nz, voxOffset, bytesPerVoxel } = header;
    const axMid = Math.floor(nz / 2);
    const sliceStart = voxOffset + axMid * nx * ny * bytesPerVoxel;
    const sliceEnd = sliceStart + nx * ny * bytesPerVoxel;

    const sliceBytes = await readLocalFilePartial(fsPath, sliceStart, sliceEnd - 1);
    const axialSlice = extractAxialSliceFromRange(sliceBytes, header);

    let min = Infinity, max = -Infinity;
    for (let i = 0; i < axialSlice.length; i++) {
      if (axialSlice[i] < min) min = axialSlice[i];
      if (axialSlice[i] > max) max = axialSlice[i];
    }

    const emptyCoronal = new Float32Array(nx * nz);
    const emptySagittal = new Float32Array(ny * nz);

    const result = {
      header,
      globalMin: min,
      globalMax: max,
      sliceIdx: { axial: axMid, coronal: Math.floor(ny / 2), sagittal: Math.floor(nx / 2) },
      slope: header.scl_slope || 1,
      inter: header.scl_inter || 0,
      slices: {
        axial: Array.from(axialSlice),
        coronal: Array.from(emptyCoronal),
        sagittal: Array.from(emptySagittal),
      },
      partialPreview: true,
    };

    entry.previewCache = result;
    compressResponse(Buffer.from(JSON.stringify(result)), req, res, 'application/json');
  }

  private async handlePreviewLocalGz(entry: FileEntry, res: http.ServerResponse, req: http.IncomingMessage): Promise<void> {
    const fsPath = entry.uri.fsPath!;
    const { header, axialSlice, rawData } = await streamingGunzipPreview(fsPath);

    if (!header) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to parse header' }));
      return;
    }

    entry.headerCache = header;
    entry.dataCache = rawData;
    entry.lastAccess = Date.now();

    const { nx, ny, nz } = header;
    let min = Infinity, max = -Infinity;
    for (let i = 0; i < axialSlice.length; i++) {
      if (axialSlice[i] < min) min = axialSlice[i];
      if (axialSlice[i] > max) max = axialSlice[i];
    }

    const emptyCoronal = new Float32Array(nx * nz);
    const emptySagittal = new Float32Array(ny * nz);

    const result = {
      header,
      globalMin: min,
      globalMax: max,
      sliceIdx: { axial: Math.floor(nz / 2), coronal: Math.floor(ny / 2), sagittal: Math.floor(nx / 2) },
      slope: header.scl_slope || 1,
      inter: header.scl_inter || 0,
      slices: {
        axial: Array.from(axialSlice),
        coronal: Array.from(emptyCoronal),
        sagittal: Array.from(emptySagittal),
      },
      partialPreview: true,
    };

    entry.previewCache = result;
    compressResponse(Buffer.from(JSON.stringify(result)), req, res, 'application/json');
  }

  private async handlePreviewRemote(entry: FileEntry, res: http.ServerResponse, req: http.IncomingMessage): Promise<void> {
    const { rawData, header } = await this.loadFileData(entry);
    if (!header) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to parse NIfTI header' }));
      return;
    }

    const slices = extractPreviewSlices(rawData, header);
    if (!slices) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to extract preview slices' }));
      return;
    }

    const { min, max } = computeSliceMinMax(slices.axial, slices.coronal, slices.sagittal);

    const result = {
      header,
      globalMin: min,
      globalMax: max,
      sliceIdx: {
        axial: Math.floor(header.nz / 2),
        coronal: Math.floor(header.ny / 2),
        sagittal: Math.floor(header.nx / 2),
      },
      slope: header.scl_slope || 1,
      inter: header.scl_inter || 0,
      slices: {
        axial: Array.from(slices.axial),
        coronal: Array.from(slices.coronal),
        sagittal: Array.from(slices.sagittal),
      },
    };

    entry.previewCache = result;
    compressResponse(Buffer.from(JSON.stringify(result)), req, res, 'application/json');
  }

  private async handlePreviewBinary(entry: FileEntry, res: http.ServerResponse, req: http.IncomingMessage): Promise<void> {
    try {
      if (entry.previewBinaryCache) {
        compressResponse(entry.previewBinaryCache, req, res, 'application/octet-stream');
        return;
      }

      const { rawData, header } = await this.loadFileData(entry);
      if (!header) {
        res.writeHead(500);
        res.end('Failed to parse header');
        return;
      }

      const slices = extractPreviewSlices(rawData, header);
      if (!slices) {
        res.writeHead(500);
        res.end('Failed to extract slices');
        return;
      }

      const { min, max } = computeSliceMinMax(slices.axial, slices.coronal, slices.sagittal);

      const sliceIdxVal = {
        axial: Math.floor(header.nz / 2),
        coronal: Math.floor(header.ny / 2),
        sagittal: Math.floor(header.nx / 2),
      };

      const headerJson = JSON.stringify(header);
      const headerBuf = Buffer.from(headerJson, 'utf8');
      const axialBuf = Buffer.from(slices.axial.buffer, slices.axial.byteOffset, slices.axial.byteLength);
      const coronalBuf = Buffer.from(slices.coronal.buffer, slices.coronal.byteOffset, slices.coronal.byteLength);
      const sagittalBuf = Buffer.from(slices.sagittal.buffer, slices.sagittal.byteOffset, slices.sagittal.byteLength);

      const totalLen = 4 + headerBuf.length + 4 * 7 + axialBuf.length + 4 + coronalBuf.length + 4 + sagittalBuf.length;
      const buf = Buffer.alloc(totalLen);
      let offset = 0;

      buf.writeUInt32LE(headerBuf.length, offset); offset += 4;
      headerBuf.copy(buf, offset); offset += headerBuf.length;

      buf.writeFloatLE(min, offset); offset += 4;
      buf.writeFloatLE(max, offset); offset += 4;
      buf.writeUInt32LE(sliceIdxVal.axial, offset); offset += 4;
      buf.writeUInt32LE(sliceIdxVal.coronal, offset); offset += 4;
      buf.writeUInt32LE(sliceIdxVal.sagittal, offset); offset += 4;

      buf.writeUInt32LE(axialBuf.length, offset); offset += 4;
      axialBuf.copy(buf, offset); offset += axialBuf.length;

      buf.writeUInt32LE(coronalBuf.length, offset); offset += 4;
      coronalBuf.copy(buf, offset); offset += coronalBuf.length;

      buf.writeUInt32LE(sagittalBuf.length, offset); offset += 4;
      sagittalBuf.copy(buf, offset); offset += sagittalBuf.length;

      entry.previewBinaryCache = buf;
      entry.headerCache = header;

      compressResponse(buf, req, res, 'application/octet-stream');
    } catch (err: any) {
      res.writeHead(500);
      res.end(String(err?.message ?? err));
    }
  }

  private async handleSlice(entry: FileEntry, axis: string, idx: number, res: http.ServerResponse, req: http.IncomingMessage): Promise<void> {
    try {
      const cacheKey = `${entry.id}:${axis}:${idx}`;
      const cached = globalSliceCache.get(cacheKey) || entry.sliceCache?.get(cacheKey);
      if (cached) {
        compressResponse(cached.data, req, res, 'application/octet-stream');
        return;
      }

      const { rawData, header } = await this.loadFileData(entry);
      if (!header) {
        res.writeHead(500);
        res.end('No header');
        return;
      }

      const slice = extractSingleSlice(rawData, header, axis, idx);
      if (!slice) {
        res.writeHead(404);
        res.end('Slice not found');
        return;
      }

      const buf = Buffer.from(slice.buffer, slice.byteOffset, slice.byteLength);
      const now = Date.now();
      globalSliceCache.set(cacheKey, { data: buf, timestamp: now });
      entry.sliceCache?.set(cacheKey, { data: buf, timestamp: now });

      compressResponse(buf, req, res, 'application/octet-stream');
    } catch (err: any) {
      res.writeHead(500);
      res.end(String(err?.message ?? err));
    }
  }

  private async handleLOD(entry: FileEntry, level: number, res: http.ServerResponse, req: http.IncomingMessage): Promise<void> {
    try {
      const cached = entry.lodCache?.get(level);
      if (cached) {
        const result = { header: cached.header, axial: Array.from(cached.data) };
        compressResponse(Buffer.from(JSON.stringify(result)), req, res, 'application/json');
        return;
      }

      const { rawData, header } = await this.loadFileData(entry);
      if (!header) {
        res.writeHead(500);
        res.end('No header');
        return;
      }

      const factor = Math.pow(2, level);
      const { nx, ny, nz } = header;
      const axMid = Math.floor(nz / 2);
      const axialSlice = extractSingleSlice(rawData, header, 'axial', axMid);
      if (!axialSlice) {
        res.writeHead(500);
        res.end('Failed to extract slice');
        return;
      }

      const downsampled = downsampleSlice(axialSlice, nx, ny, factor);
      const lodHeader = { ...header, nx: downsampled.w, ny: downsampled.h, nz: 1 };

      entry.lodCache?.set(level, { header: lodHeader, data: downsampled.data, timestamp: Date.now() });

      const result = { header: lodHeader, axial: Array.from(downsampled.data) };
      compressResponse(Buffer.from(JSON.stringify(result)), req, res, 'application/json');
    } catch (err: any) {
      res.writeHead(500);
      res.end(String(err?.message ?? err));
    }
  }

  private async loadFileData(entry: FileEntry, signal?: AbortSignal): Promise<{ rawData: Uint8Array; header: any }> {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    if (entry.dataCache && entry.headerCache) {
      entry.lastAccess = Date.now();
      return { rawData: entry.dataCache, header: entry.headerCache };
    }

    if (entry.pendingLoad) {
      return entry.pendingLoad;
    }

    const fsPath = entry.uri.fsPath;
    const isGzip = fsPath ? fsPath.endsWith('.gz') : entry.uri.toString().endsWith('.gz');
    const isLocal = !!fsPath;

    entry.pendingLoad = (async () => {
      try {
        let header: any;
        let rawData: Uint8Array;

        if (isLocal && isGzip) {
          if (entry.dataCache) {
            rawData = entry.dataCache;
            header = entry.headerCache || parseNiiHeaderQuick(rawData);
          } else {
            const result = await streamingGunzipPreview(fsPath!, signal);
            header = result.header;
            rawData = result.rawData;
            entry.dataCache = rawData;
          }
        } else if (isLocal && !isGzip) {
          if (entry.dataCache) {
            rawData = entry.dataCache;
          } else {
            const fullData = await vscode.workspace.fs.readFile(entry.uri);
            rawData = new Uint8Array(fullData.buffer, fullData.byteOffset, fullData.byteLength);
            entry.dataCache = rawData;
          }
          header = entry.headerCache || parseNiiHeaderQuick(rawData);
        } else if (isGzip) {
          const fullData = await vscode.workspace.fs.readFile(entry.uri);
          if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
          const decompressed = await gunzipAsync(fullData, signal);
          rawData = decompressed;
          header = parseNiiHeaderQuick(rawData);
          entry.dataCache = rawData;
        } else {
          const fullData = await vscode.workspace.fs.readFile(entry.uri);
          if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
          rawData = new Uint8Array(fullData.buffer, fullData.byteOffset, fullData.byteLength);
          header = parseNiiHeaderQuick(rawData);
          entry.dataCache = rawData;
        }

        entry.headerCache = header;
        entry.lastAccess = Date.now();

        if (this.volumeCache && header) {
          const uriKey = entry.uri.toString();
          const cached = this.volumeCache.get(uriKey);
          if (!cached) {
            const { nx, ny, nz, datatype, scl_slope, scl_inter, littleEndian, voxOffset } = header;
            const n = nx * ny * nz;
            const bpv = Math.max(1, header.bitpix / 8);
            const byteOff = rawData.byteOffset + voxOffset;
            const le = littleEndian;
            const elemSize = datatype === 64 ? 8 : datatype === 8 || datatype === 16 || datatype === 768 ? 4 : datatype === 4 || datatype === 512 ? 2 : 1;
            const canUseTypedArray = (byteOff % elemSize === 0) && (byteOff + n * elemSize <= rawData.buffer.byteLength) && le;

            let voxelData: Int8Array | Uint8Array | Int16Array | Uint16Array | Int32Array | Uint32Array | Float32Array | Float64Array;
            switch (datatype) {
              case 2: voxelData = canUseTypedArray ? new Uint8Array(rawData.buffer, byteOff, n) : new Uint8Array(rawData.slice(voxOffset, voxOffset + n)); break;
              case 4: voxelData = canUseTypedArray ? new Int16Array(rawData.buffer, byteOff, n) : new Int16Array(n); break;
              case 8: voxelData = canUseTypedArray ? new Int32Array(rawData.buffer, byteOff, n) : new Int32Array(n); break;
              case 16: voxelData = canUseTypedArray ? new Float32Array(rawData.buffer, byteOff, n) : new Float32Array(n); break;
              case 64: voxelData = canUseTypedArray ? new Float64Array(rawData.buffer, byteOff, n) : new Float64Array(n); break;
              case 256: voxelData = canUseTypedArray ? new Int8Array(rawData.buffer, byteOff, n) : new Int8Array(n); break;
              case 512: voxelData = canUseTypedArray ? new Uint16Array(rawData.buffer, byteOff, n) : new Uint16Array(n); break;
              case 768: voxelData = canUseTypedArray ? new Uint32Array(rawData.buffer, byteOff, n) : new Uint32Array(n); break;
              default: voxelData = new Float32Array(n); break;
            }

            if (!canUseTypedArray && datatype !== 2 && datatype !== 256) {
              const view = new DataView(rawData.buffer, byteOff, n * elemSize);
              switch (datatype) {
                case 4: { const a = voxelData as Int16Array; for (let i = 0; i < n; i++) a[i] = view.getInt16(i * 2, le); break; }
                case 8: { const a = voxelData as Int32Array; for (let i = 0; i < n; i++) a[i] = view.getInt32(i * 4, le); break; }
                case 16: { const a = voxelData as Float32Array; for (let i = 0; i < n; i++) a[i] = view.getFloat32(i * 4, le); break; }
                case 64: { const a = voxelData as Float64Array; for (let i = 0; i < n; i++) a[i] = view.getFloat64(i * 8, le); break; }
                case 512: { const a = voxelData as Uint16Array; for (let i = 0; i < n; i++) a[i] = view.getUint16(i * 2, le); break; }
                case 768: { const a = voxelData as Uint32Array; for (let i = 0; i < n; i++) a[i] = view.getUint32(i * 4, le); break; }
              }
            }

            let min = Infinity, max = -Infinity;
            const sampleStep = Math.max(1, Math.floor(n / 50000));
            const slope = scl_slope || 1;
            const inter = scl_inter || 0;
            for (let i = 0; i < n; i += sampleStep) {
              const v = (voxelData as any)[i] * slope + inter;
              if (v < min) min = v;
              if (v > max) max = v;
            }
            if (min === max) max = min + 1;

            this.volumeCache.set(uriKey, { header, voxelData, min, max, slope, inter });
          }
        }

        return { rawData, header };
      } finally {
        entry.pendingLoad = undefined;
      }
    })();

    return entry.pendingLoad;
  }

  async extractPreviewForWebview(entryId: string, signal?: AbortSignal): Promise<{
    header: any;
    slices: { axial: Float32Array; coronal: Float32Array; sagittal: Float32Array };
    globalMin: number;
    globalMax: number;
    sliceIdx: { axial: number; coronal: number; sagittal: number };
    slope: number;
    inter: number;
    partialPreview?: boolean;
  } | null> {
    const entry = this.files.get(entryId);
    if (!entry) return null;

    const fsPath = entry.uri.fsPath;
    const isGzip = fsPath ? fsPath.endsWith('.gz') : entry.uri.toString().endsWith('.gz');
    const isLocal = !!fsPath;

    try {
      if (isLocal && !isGzip) {
        if (!entry.headerCache) {
          const headerBytes = await readLocalFilePartial(fsPath!, 0, 543);
          const header = parseNiiHeaderQuick(headerBytes);
          if (!header) return null;
          entry.headerCache = header;
        }

        const header = entry.headerCache;
        const { nx, ny, nz, voxOffset, bytesPerVoxel } = header;
        const axMid = Math.floor(nz / 2);
        const sliceStart = voxOffset + axMid * nx * ny * bytesPerVoxel;
        const sliceEnd = sliceStart + nx * ny * bytesPerVoxel;

        const sliceBytes = await readLocalFilePartial(fsPath!, sliceStart, sliceEnd - 1);
        const axialSlice = extractAxialSliceFromRange(sliceBytes, header);

        let min = Infinity, max = -Infinity;
        for (let i = 0; i < axialSlice.length; i++) {
          if (axialSlice[i] < min) min = axialSlice[i];
          if (axialSlice[i] > max) max = axialSlice[i];
        }

        return {
          header,
          slices: { axial: axialSlice, coronal: new Float32Array(nx * nz), sagittal: new Float32Array(ny * nz) },
          globalMin: min, globalMax: max,
          sliceIdx: { axial: axMid, coronal: Math.floor(ny / 2), sagittal: Math.floor(nx / 2) },
          slope: header.scl_slope || 1, inter: header.scl_inter || 0,
          partialPreview: true,
        };
      }

      if (isLocal && isGzip) {
        const { header, axialSlice } = await streamingGunzipPreview(fsPath!, signal);
        if (!header) return null;
        const { nx, ny, nz } = header;
        let min = Infinity, max = -Infinity;
        for (let i = 0; i < axialSlice.length; i++) {
          if (axialSlice[i] < min) min = axialSlice[i];
          if (axialSlice[i] > max) max = axialSlice[i];
        }
        return {
          header,
          slices: { axial: axialSlice, coronal: new Float32Array(nx * nz), sagittal: new Float32Array(ny * nz) },
          globalMin: min, globalMax: max,
          sliceIdx: { axial: Math.floor(nz / 2), coronal: Math.floor(ny / 2), sagittal: Math.floor(nx / 2) },
          slope: header.scl_slope || 1, inter: header.scl_inter || 0,
          partialPreview: true,
        };
      }

      const { rawData, header } = await this.loadFileData(entry, signal);
      if (!header) return null;

      const slices = extractPreviewSlices(rawData, header);
      if (!slices) return null;

      const { min, max } = computeSliceMinMax(slices.axial, slices.coronal, slices.sagittal);

      return {
        header,
        slices,
        globalMin: min, globalMax: max,
        sliceIdx: { axial: Math.floor(header.nz / 2), coronal: Math.floor(header.ny / 2), sagittal: Math.floor(header.nx / 2) },
        slope: header.scl_slope || 1, inter: header.scl_inter || 0,
      };
    } catch (err: any) {
      if (err?.name === 'AbortError') return null;
      console.error('extractPreviewForWebview error:', err);
      return null;
    }
  }

}
