import * as http from 'http';
import * as vscode from 'vscode';
import * as zlib from 'zlib';

interface FileEntry {
  uri: vscode.Uri;
  id: string;
  size?: number;
  dataCache?: Uint8Array;
  lastAccess?: number;
  headerCache?: any;
  previewCache?: any;
}

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
      const v = getVoxel(axMid * ny * nx + y * nx + x) * slope + inter;
      axial[y * nx + x] = v;
    }
  }
  for (let z = 0; z < nz; z++) {
    for (let x = 0; x < nx; x++) {
      const v = getVoxel(z * ny * nx + coMid * nx + x) * slope + inter;
      coronal[z * nx + x] = v;
    }
  }
  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      const v = getVoxel(z * ny * nx + y * nx + saMid) * slope + inter;
      sagittal[z * ny + y] = v;
    }
  }

  return { axial, coronal, sagittal };
}

export class LocalFileProxy {
  private server: http.Server | null = null;
  private port = 0;
  private files = new Map<string, FileEntry>();
  private idCounter = 0;
  private cleanupInterval: NodeJS.Timeout | null = null;

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
        if (entry.dataCache && entry.lastAccess && now - entry.lastAccess > 60000) {
          entry.dataCache = undefined;
          entry.previewCache = undefined;
          entry.headerCache = undefined;
        }
      }
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

  getPort(): number {
    return this.port;
  }

  registerFile(uri: vscode.Uri): string {
    const id = String(this.idCounter++);
    this.files.set(id, { uri, id });
    return `http://127.0.0.1:${this.port}/file/${id}`;
  }

  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Range');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const previewMatch = req.url?.match(/^\/preview\/(\d+)$/);
    const fileMatch = req.url?.match(/^\/file\/(\d+)$/);
    const match = previewMatch || fileMatch;
    if (!match) {
      res.writeHead(404);
      res.end();
      return;
    }

    const isPreview = !!previewMatch;
    const entry = this.files.get(match[1]);
    if (!entry) {
      res.writeHead(404);
      res.end();
      return;
    }

    try {
      if (isPreview) {
        await this.handlePreview(entry, res);
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
          const fs = await import('fs');
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
        res.writeHead(200, {
          'Content-Length': totalSize,
          'Accept-Ranges': 'bytes',
          'Content-Type': 'application/octet-stream',
        });

        if (fsPath) {
          const fs = await import('fs');
          fs.createReadStream(fsPath).pipe(res);
        } else {
          entry.lastAccess = Date.now();
          if (!entry.dataCache) {
            entry.dataCache = await vscode.workspace.fs.readFile(entry.uri);
          }
          res.end(Buffer.from(entry.dataCache));
        }
      }
    } catch (err) {
      console.error('LocalFileProxy error:', err);
      res.writeHead(500);
      res.end(String(err));
    }
  }

  private async handlePreview(entry: FileEntry, res: http.ServerResponse): Promise<void> {
    try {
      const isGzip = entry.uri.fsPath?.endsWith('.gz') ?? false;

      if (entry.previewCache) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(entry.previewCache));
        return;
      }

      const headerSize = isGzip ? 0 : 544;
      const headerBytes = await this.readPartial(entry, 0, Math.max(544, headerSize));

      let header: any;
      let rawData: Uint8Array;

      if (isGzip) {
        const fullData = await vscode.workspace.fs.readFile(entry.uri);
        const decompressed = zlib.gunzipSync(Buffer.from(fullData));
        rawData = new Uint8Array(decompressed.buffer, decompressed.byteOffset, decompressed.byteLength);
        header = parseNiiHeaderQuick(rawData);
      } else {
        header = parseNiiHeaderQuick(new Uint8Array(headerBytes.buffer, headerBytes.byteOffset, headerBytes.byteLength));
        if (!header) {
          const fullData = await vscode.workspace.fs.readFile(entry.uri);
          rawData = new Uint8Array(fullData.buffer, fullData.byteOffset, fullData.byteLength);
          header = parseNiiHeaderQuick(rawData);
        }
      }

      if (!header) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to parse NIfTI header' }));
        return;
      }

      if (!rawData) {
        const bpv = Math.max(1, header.bitpix / 8);
        const neededBytes = header.voxOffset + header.nx * header.ny * header.nz * bpv;
        const fullData = await vscode.workspace.fs.readFile(entry.uri);
        rawData = new Uint8Array(fullData.buffer, fullData.byteOffset, fullData.byteLength);
      }

      const slices = extractPreviewSlices(rawData, header);
      if (!slices) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to extract preview slices' }));
        return;
      }

      let min = Infinity, max = -Infinity;
      const allData = new Float32Array([...slices.axial, ...slices.coronal, ...slices.sagittal]);
      for (let i = 0; i < allData.length; i++) {
        if (allData[i] < min) min = allData[i];
        if (allData[i] > max) max = allData[i];
      }
      if (min === max) max = min + 1;

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
      entry.headerCache = header;

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err: any) {
      console.error('Preview error:', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(err?.message ?? err) }));
    }
  }

  private async readPartial(entry: FileEntry, start: number, length: number): Promise<Uint8Array> {
    if (entry.dataCache && entry.dataCache.length >= start + length) {
      return entry.dataCache.slice(start, start + length);
    }
    const fullData = await vscode.workspace.fs.readFile(entry.uri);
    entry.dataCache = new Uint8Array(fullData.buffer, fullData.byteOffset, fullData.byteLength);
    entry.lastAccess = Date.now();
    return entry.dataCache.slice(start, start + length);
  }
}
