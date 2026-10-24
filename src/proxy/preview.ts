import * as http from 'http';
import type { VolumeCache } from '../VolumeCache';
import { compressResponse, streamingGunzipPreviewVolume } from '../io/compression';
import { extractStridedVolumeFromIndex, type GzipScanSession } from '../io/gzipScan';
import { readHttpPartial, readLocalFilePartial } from '../io/fileReader';
import type { NiiHeader } from '../nifti/headerParser';
import { errorMessage, isAbortError } from '../errors';
import type { CachedVolume } from '../VolumeCache';
import type { FileEntry } from './types';

/** Proxy services the preview-volume handler needs. */
export interface PreviewHost {
  ensureGzipScan(entry: FileEntry): GzipScanSession | null;
  parseEntryHeader(entry: FileEntry, bytes: Uint8Array): NiiHeader | null;
  loadFileData(entry: FileEntry, signal?: AbortSignal): Promise<{ rawData: Uint8Array; header: NiiHeader | null }>;
  readonly volumeCache: VolumeCache | null;
}

export function sendPreviewVolumeBuffer(
  loHeader: NiiHeader,
  volume: Float32Array,
  factor: number,
  outNx: number,
  outNy: number,
  outNz: number,
  min: number,
  max: number,
  slope: number,
  inter: number,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  const headerJson = JSON.stringify(loHeader);
  const headerBuf = Buffer.from(headerJson, 'utf8');
  const voxelBuf = Buffer.from(volume.buffer, volume.byteOffset, volume.byteLength);
  const buf = Buffer.alloc(4 + headerBuf.length + 4 * 8 + voxelBuf.length);
  let offset = 0;
  buf.writeUInt32LE(headerBuf.length, offset); offset += 4;
  headerBuf.copy(buf, offset); offset += headerBuf.length;
  buf.writeUInt32LE(factor, offset); offset += 4;
  buf.writeUInt32LE(outNx, offset); offset += 4;
  buf.writeUInt32LE(outNy, offset); offset += 4;
  buf.writeUInt32LE(outNz, offset); offset += 4;
  buf.writeFloatLE(min, offset); offset += 4;
  buf.writeFloatLE(max, offset); offset += 4;
  buf.writeFloatLE(slope, offset); offset += 4;
  buf.writeFloatLE(inter, offset); offset += 4;
  voxelBuf.copy(buf, offset);
  compressResponse(buf, req, res, 'application/octet-stream');
}

/**
 * Low-resolution subsampled volume endpoint for fast remote preview.
 *
 * Downloads only every `factor`-th axial slice from the source (1/factor of
 * the data) and extracts every `factor`-th voxel in x and y from each
 * fetched slice. The result is a complete (nx/factor × ny/factor ×
 * nz/factor) Float32 volume that can be rendered immediately in all three
 * orthogonal views, at 1/factor³ of the original voxel count.
 *
 * For a 256³ Float32 volume at factor=4: downloads 16 MB (64 source
 * slices × 256 KB), produces a 64³ = 1 MB preview volume. On a 10 Mbps
 * link with 100 ms RTT, the preview arrives in ~2 s instead of ~50 s
 * for the full 64 MB.
 *
 * Stage 1: only uncompressed .nii (local fs + HTTP remote). Gzip falls
 * back to 503 so the worker continues with the existing streaming path.
 */
export async function handlePreviewVolume(
  entry: FileEntry,
  factor: number,
  res: http.ServerResponse,
  req: http.IncomingMessage,
  host: PreviewHost,
): Promise<void> {
  try {
    const fsPath = entry.uri.fsPath;
    const uriStr = entry.uri.toString();
    const isGzip = fsPath ? fsPath.endsWith('.gz') : uriStr.endsWith('.gz');

    // A larger factor reduces conversion and transport, not the gzip inflate span.
    const f = isGzip ? Math.max(8, Math.min(32, Math.floor(factor) || 8)) : Math.max(2, Math.min(8, Math.floor(factor) || 4));

    // Local gzip: reuse the in-flight inflate (index + coarse volume).
    // HTTP gzip: sequential inflate until the last sampled z.
    if (isGzip) {
      const isHttpRemote = entry.uri.scheme === 'http' || entry.uri.scheme === 'https';
      if (fsPath || isHttpRemote) {
        const ac = new AbortController();
        req.on('close', () => { if (!res.writableEnded) ac.abort(); });
        try {
          if (fsPath) {
            const session = host.ensureGzipScan(entry);
            const index = entry.gzipIndex || (session ? await session.done : null);
            const lod = session?.lod;
            if (lod && f >= lod.factor && f % lod.factor === 0) {
              const coarse = coarsenLod(lod, f);
              sendPreviewVolumeBuffer(
                coarse.header, coarse.volume, f, coarse.outNx, coarse.outNy, coarse.outNz,
                coarse.min, coarse.max, 1, 0,
                req, res,
              );
              return;
            }
            if (index) {
              const indexed = await extractStridedVolumeFromIndex(fsPath, index, f, ac.signal);
              sendPreviewVolumeBuffer(
                indexed.header, indexed.volume, f, indexed.outNx, indexed.outNy, indexed.outNz,
                indexed.min, indexed.max, indexed.header.scl_slope || 1, indexed.header.scl_inter || 0,
                req, res,
              );
              return;
            }
          }
          const result = await streamingGunzipPreviewVolume(
            fsPath ? { type: 'file', path: fsPath } : { type: 'http', url: uriStr },
            f,
            ac.signal,
          );
          // Build a low-res header (scaled spacings + adjusted sform)
          const loHeader: NiiHeader = { ...result.header };
          loHeader.nx = result.outNx;
          loHeader.ny = result.outNy;
          loHeader.nz = result.outNz;
          loHeader.dx = (result.header.dx || 1) * f;
          loHeader.dy = (result.header.dy || 1) * f;
          loHeader.dz = (result.header.dz || 1) * f;
          loHeader.pixDims = [loHeader.dx, loHeader.dy, loHeader.dz];
          if (Array.isArray(result.header.sform)) {
            const sform = result.header.sform.map((row: number[]) => [...row]);
            for (const row of sform) { row[0] *= f; row[1] *= f; row[2] *= f; }
            loHeader.sform = sform;
          }
          const slope = result.header.scl_slope || 1;
          const inter = result.header.scl_inter || 0;

          // Encode binary response (same layout as non-gzip path)
          const headerJson = JSON.stringify(loHeader);
          const headerBuf = Buffer.from(headerJson, 'utf8');
          const voxelBuf = Buffer.from(result.volume.buffer, result.volume.byteOffset, result.volume.byteLength);
          const totalLen = 4 + headerBuf.length + 4 * 8 + voxelBuf.length;
          const buf = Buffer.alloc(totalLen);
          let offset = 0;
          buf.writeUInt32LE(headerBuf.length, offset); offset += 4;
          headerBuf.copy(buf, offset); offset += headerBuf.length;
          buf.writeUInt32LE(f, offset); offset += 4;
          buf.writeUInt32LE(result.outNx, offset); offset += 4;
          buf.writeUInt32LE(result.outNy, offset); offset += 4;
          buf.writeUInt32LE(result.outNz, offset); offset += 4;
          buf.writeFloatLE(result.min, offset); offset += 4;
          buf.writeFloatLE(result.max, offset); offset += 4;
          buf.writeFloatLE(slope, offset); offset += 4;
          buf.writeFloatLE(inter, offset); offset += 4;
          voxelBuf.copy(buf, offset);
          compressResponse(buf, req, res, 'application/octet-stream');
        } catch (err) {
          if (isAbortError(err)) return;
          if (!res.headersSent) {
            res.writeHead(500);
            res.end(errorMessage(err));
          }
        }
        return;
      }
      // vscode-remote gzip: fall through to cached-data path below.
      // loadFileData() will download + decompress the full file, then
      // the standard subsampling code reads from entry.dataCache.
    }

    // ── Parse header (from cache or fetch first 544 bytes) ──
    if (!entry.headerCache) {
      let headerBytes: Uint8Array;
      if (fsPath) {
        headerBytes = await readLocalFilePartial(fsPath, 0, 543);
      } else if (entry.uri.scheme === 'http' || entry.uri.scheme === 'https') {
        headerBytes = await readHttpPartial(uriStr, 0, 543);
      } else {
        // Other remote (vscode-remote://): must load full data to parse header
        const { header } = await host.loadFileData(entry);
        if (header) entry.headerCache = header;
        headerBytes = new Uint8Array(0);
      }
      if (!entry.headerCache) {
        const header = host.parseEntryHeader(entry, headerBytes);
        if (!header) {
          res.writeHead(500);
          res.end('Failed to parse NIfTI header');
          return;
        }
        entry.headerCache = header;
      }
    }

    const header = entry.headerCache;
    const { nx, ny, nz, voxOffset, bytesPerVoxel, datatype, scl_slope, scl_inter, littleEndian } = header;
    const bpv = Math.max(1, bytesPerVoxel);
    const slope = scl_slope || 1;
    const inter = scl_inter || 0;
    const le = littleEndian;

    const outNx = Math.max(1, Math.floor(nx / f));
    const outNy = Math.max(1, Math.floor(ny / f));
    const outNz = Math.max(1, Math.floor(nz / f));
    const outCount = outNx * outNy * outNz;
    const output = new Float32Array(outCount);

    // ── Decide source: local fs, HTTP remote, or cached data ──
    const isLocal = !!fsPath;
    const isHttpRemote = entry.uri.scheme === 'http' || entry.uri.scheme === 'https';

    // For non-HTTP remote (vscode-remote://) without cached data, load full
    // data once and then subsample from memory.
    if (!isLocal && !isHttpRemote && !entry.dataCache) {
      await host.loadFileData(entry);
    }
    const cachedData = (!isLocal && !isHttpRemote) ? entry.dataCache : null;

    // If the full volume is already in the proxy-side VolumeCache (e.g. the
    // user viewed this file before and it hasn't been evicted), subsample
    // directly from the cached decoded voxel data.  This avoids 16 fresh
    // HTTP Range requests and DataView decoding — pure memory copy, ~100x
    // faster for a cached remote file.
    let cachedVolume: { voxelData: CachedVolume['voxelData']; min: number; max: number } | null = null;
    if (isHttpRemote && host.volumeCache) {
      const cv = host.volumeCache.get(uriStr);
      if (cv) cachedVolume = { voxelData: cv.voxelData, min: cv.min, max: cv.max };
    }

    // ── Fetch each source z-slice and extract every f-th voxel ──
    // Bounded concurrency: 16 parallel range requests. For a 256³ volume
    // at factor=4, this is 64 slices → 4 batches → ~4 RTTs total.
    const MAX_CONCURRENT = 16;
    const sliceByteSize = nx * ny * bpv;

    const fetchAndExtractSlice = async (outZ: number): Promise<void> => {
      const srcZ = outZ * f;
      const outSliceBase = outZ * outNy * outNx;

      // ── Fast path: subsample from cached decoded volume data ──
      // VolumeCache stores voxels as a typed array with slope/inter already
      // applied, so we can index directly without DataView decoding.
      if (cachedVolume) {
        const vd = cachedVolume.voxelData;
        for (let outY = 0; outY < outNy; outY++) {
          const srcY = outY * f;
          const srcRowBase = srcZ * ny * nx + srcY * nx;
          const outRowBase = outSliceBase + outY * outNx;
          for (let outX = 0; outX < outNx; outX++) {
            output[outRowBase + outX] = vd[srcRowBase + outX * f];
          }
        }
        return;
      }

      // ── Slow path: fetch raw bytes and decode via DataView ──
      const sliceStart = voxOffset + srcZ * nx * ny * bpv;
      const sliceEnd = sliceStart + sliceByteSize; // exclusive

      let sliceBytes: Uint8Array;
      if (cachedData) {
        sliceBytes = cachedData.subarray(sliceStart, sliceEnd);
      } else if (isLocal) {
        sliceBytes = await readLocalFilePartial(fsPath!, sliceStart, sliceEnd - 1);
      } else {
        sliceBytes = await readHttpPartial(uriStr, sliceStart, sliceEnd - 1);
      }

      const view = new DataView(sliceBytes.buffer, sliceBytes.byteOffset, sliceBytes.byteLength);

      for (let outY = 0; outY < outNy; outY++) {
        const srcY = outY * f;
        const rowBase = srcY * nx;
        const outRowBase = outSliceBase + outY * outNx;
        for (let outX = 0; outX < outNx; outX++) {
          const srcX = outX * f;
          const off = (rowBase + srcX) * bpv;
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
          output[outRowBase + outX] = val * slope + inter;
        }
      }
    };

    // Bounded-concurrency pool
    await new Promise<void>((resolve, reject) => {
      let nextZ = 0;
      let active = 0;
      let settled = false;
      const launch = (): void => {
        while (active < MAX_CONCURRENT && nextZ < outNz && !settled) {
          const z = nextZ++;
          active++;
          fetchAndExtractSlice(z)
            .catch(err => { if (!settled) { settled = true; reject(err); } })
            .finally(() => {
              active--;
              if (settled) return;
              if (nextZ >= outNz && active === 0) {
                settled = true;
                resolve();
              } else {
                launch();
              }
            });
        }
        if (nextZ >= outNz && active === 0 && !settled) {
          settled = true;
          resolve();
        }
      };
      launch();
    });

    // ── Compute min/max from subsampled data ──
    let min = Infinity, max = -Infinity;
    for (let i = 0; i < outCount; i++) {
      const v = output[i];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    if (min === max) max = min + 1;

    // ── Build a low-res header for the viewer ──
    // Scale voxel sizes so the physical volume dimensions are preserved.
    const loHeader: NiiHeader = { ...header };
    loHeader.nx = outNx;
    loHeader.ny = outNy;
    loHeader.nz = outNz;
    loHeader.dx = (header.dx || 1) * f;
    loHeader.dy = (header.dy || 1) * f;
    loHeader.dz = (header.dz || 1) * f;
    loHeader.pixDims = [loHeader.dx, loHeader.dy, loHeader.dz];
    // Preserve sform/qform codes but adjust the translation column so the
    // center of the low-res volume maps to the same world coordinate as the
    // center of the full volume. This keeps the orientation labels correct.
    if (Array.isArray(header.sform)) {
      const sform = header.sform.map((row: number[]) => [...row]);
      // sform maps voxel → world. After subsampling, voxel (i,j,k) in the
      // low-res volume corresponds to voxel (i*f, j*f, k*f) in the full
      // volume. So world = sform * (i*f, j*f, k*f, 1)^T.
      // The new sform is: [a*f, b*f, c*f, d] for each row [a, b, c, d].
      for (const row of sform) {
        row[0] *= f;
        row[1] *= f;
        row[2] *= f;
      }
      loHeader.sform = sform;
    }

    // ── Encode binary response ──
    // Layout (little-endian):
    //   [4]  header_json_length (uint32)
    //   [N]  header_json (UTF-8)
    //   [4]  factor (uint32)
    //   [4]  out_nx (uint32)
    //   [4]  out_ny (uint32)
    //   [4]  out_nz (uint32)
    //   [4]  global_min (float32)
    //   [4]  global_max (float32)
    //   [4]  slope (float32)
    //   [4]  inter (float32)
    //   [M]  voxel_data (Float32, out_nx*out_ny*out_nz * 4 bytes)
    const headerJson = JSON.stringify(loHeader);
    const headerBuf = Buffer.from(headerJson, 'utf8');
    const voxelBuf = Buffer.from(output.buffer, output.byteOffset, output.byteLength);

    const totalLen = 4 + headerBuf.length + 4 * 8 + voxelBuf.length;
    const buf = Buffer.alloc(totalLen);
    let offset = 0;

    buf.writeUInt32LE(headerBuf.length, offset); offset += 4;
    headerBuf.copy(buf, offset); offset += headerBuf.length;

    buf.writeUInt32LE(f, offset); offset += 4;
    buf.writeUInt32LE(outNx, offset); offset += 4;
    buf.writeUInt32LE(outNy, offset); offset += 4;
    buf.writeUInt32LE(outNz, offset); offset += 4;
    buf.writeFloatLE(min, offset); offset += 4;
    buf.writeFloatLE(max, offset); offset += 4;
    buf.writeFloatLE(slope, offset); offset += 4;
    buf.writeFloatLE(inter, offset); offset += 4;

    voxelBuf.copy(buf, offset);

    compressResponse(buf, req, res, 'application/octet-stream');
  } catch (err) {
    if (!res.headersSent) {
      res.writeHead(500);
      res.end(errorMessage(err));
    }
  }
}

export function coarsenLod(
  lod: NonNullable<GzipScanSession['lod']>,
  factor: number,
): NonNullable<GzipScanSession['lod']> {
  if (factor === lod.factor) return lod;
  const step = factor / lod.factor;
  const outNx = Math.max(1, Math.floor(lod.outNx / step)), outNy = Math.max(1, Math.floor(lod.outNy / step)), outNz = Math.max(1, Math.floor(lod.outNz / step));
  const volume = new Float32Array(outNx * outNy * outNz);
  let min = Infinity, max = -Infinity;
  for (let z = 0; z < outNz; z++) for (let y = 0; y < outNy; y++) for (let x = 0; x < outNx; x++) {
    const v = lod.volume[((z * step) * lod.outNy + y * step) * lod.outNx + x * step];
    volume[(z * outNy + y) * outNx + x] = v;
    min = Math.min(min, v); max = Math.max(max, v);
  }
  const header: NiiHeader = { ...lod.header, nx: outNx, ny: outNy, nz: outNz, dx: lod.header.dx * step, dy: lod.header.dy * step, dz: lod.header.dz * step };
  header.pixDims = [header.dx, header.dy, header.dz];
  const scaleRow = (row: number[]): number[] => row.map((v, i) => i < 3 ? v * step : v);
  header.srow_x = scaleRow(lod.header.srow_x);
  header.srow_y = scaleRow(lod.header.srow_y);
  header.srow_z = scaleRow(lod.header.srow_z);
  if (Array.isArray(lod.header.sform)) header.sform = lod.header.sform.map(scaleRow);
  return { header, factor, volume, outNx, outNy, outNz, min, max: max > min ? max : min + 1 };
}
