import * as http from 'http';
import { compressResponse } from '../io/compression';
import { GzipIndex } from '../io/gzipIndex';
import { extractSliceFromGzipIndex, type GzipScanSession } from '../io/gzipScan';
import { readHttpPartial, readLocalFilePartial } from '../io/fileReader';
import { timepointByteOffset } from '../nifti/headerParser';
import {
  extractAxialSliceFromRange,
  extractLocalSlice,
  extractLocalSliceRaw,
  extractSingleSlice,
  downsampleSlice,
  sampleSlice,
} from '../nifti/sliceExtractor';
import type { NiiHeader } from '../nifti/headerParser';
import { errorMessage } from '../errors';
import type { FileEntry, RawSliceMeta } from './types';

/** Per-entry slice cache bounds (server-side L2 behind the client cache). */
const MAX_SLICE_CACHE_ENTRIES = 64;
const MAX_SLICE_CACHE_BYTES = 64 * 1024 * 1024;

/** Proxy services the slice handler needs; keeps the router free of them. */
export interface SliceHost {
  headerPath(entry: FileEntry): string;
  dataPath(entry: FileEntry): string;
  parseEntryHeader(entry: FileEntry, bytes: Uint8Array): NiiHeader | null;
  ensureGzipScan(entry: FileEntry, onProgress?: (pct: number) => void): GzipScanSession | null;
  loadFileData(entry: FileEntry, signal?: AbortSignal): Promise<{ rawData: Uint8Array; header: NiiHeader | null }>;
}

export function sliceHeaders(
  header: NiiHeader,
  axis: string,
  factor: number,
  startedAt: number,
  cache: string,
  raw?: RawSliceMeta,
): Record<string, string> {
  const headers: Record<string, string> = {
    'X-Width': String(Math.max(1, Math.floor((axis === 'sagittal' ? header.ny : header.nx) / factor))),
    'X-Height': String(Math.max(1, Math.floor((axis === 'axial' ? header.ny : header.nz) / factor))),
    'X-Factor': String(factor),
    'Server-Timing': `slice;dur=${(performance.now() - startedAt).toFixed(2)};desc="${cache}"`,
  };
  if (raw) {
    headers['X-NiftiSpy-Slice-Format'] = 'raw';
    headers['X-NiftiSpy-Dtype'] = String(raw.dtype);
    headers['X-NiftiSpy-Slope'] = String(raw.slope);
    headers['X-NiftiSpy-Inter'] = String(raw.inter);
  }
  return headers;
}

export function trimSliceCache(entry: FileEntry): void {
  const cache = entry.sliceCache;
  if (!cache) return;
  let bytes = 0;
  for (const value of cache.values()) bytes += value.data.length;
  while (cache.size > MAX_SLICE_CACHE_ENTRIES || bytes > MAX_SLICE_CACHE_BYTES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    const value = cache.get(oldest);
    cache.delete(oldest);
    if (value) bytes -= value.data.length;
  }
}

/** Raw slices only for little-endian 8/16-bit data; others stay Float32. */
export function rawSliceMeta(header: NiiHeader): RawSliceMeta | null {
  if (!header || !header.littleEndian) return null;
  const dtype = header.datatype;
  if (dtype !== 2 && dtype !== 256 && dtype !== 4 && dtype !== 512) return null;
  return {
    dtype,
    slope: header.scl_slope || 1,
    inter: header.scl_inter || 0,
  };
}

export async function handleSlice(
  entry: FileEntry,
  axis: string,
  idx: number,
  res: http.ServerResponse,
  req: http.IncomingMessage,
  host: SliceHost,
  timeIdx = 0,
  factor = 1,
): Promise<void> {
  const startedAt = performance.now();
  const ac = new AbortController();
  res.once('close', () => { if (!res.writableEnded) ac.abort(); });
  try {
    const cacheKey = `${entry.id}:${axis}:${idx}:${timeIdx}:${factor}`;
    const cached = entry.sliceCache?.get(cacheKey);
    if (cached) {
      const h = entry.headerCache!;
      compressResponse(cached.data, req, res, 'application/octet-stream',
        sliceHeaders(h, axis, factor, startedAt, 'memory', cached.raw));
      return;
    }

    const headerFs = host.headerPath(entry);
    const dataFs = entry.unpackPath || host.dataPath(entry);
    const isGzip = !entry.unpackPath && (dataFs ? dataFs.endsWith('.gz') : (entry.dataUri || entry.uri).toString().endsWith('.gz'));

    const reply = (slice: Float32Array, sampled = false) => {
      if (ac.signal.aborted) return;
      const h = entry.headerCache!;
      if (!sampled && factor > 1) slice = sampleSlice(slice, axis === 'sagittal' ? h.ny : h.nx, axis === 'axial' ? h.ny : h.nz, factor);
      const buf = Buffer.from(slice.buffer, slice.byteOffset, slice.byteLength);
      entry.sliceCache?.set(cacheKey, { data: buf, timestamp: Date.now() });
      trimSliceCache(entry);
      compressResponse(buf, req, res, 'application/octet-stream', sliceHeaders(h, axis, factor, startedAt, entry.unpackPath ? 'disk' : 'source'));
    };

    const replyRaw = (slice: { data: Uint8Array; width: number; height: number }, raw: RawSliceMeta) => {
      if (ac.signal.aborted) return;
      const h = entry.headerCache!;
      const buf = Buffer.from(slice.data.buffer, slice.data.byteOffset, slice.data.byteLength);
      entry.sliceCache?.set(cacheKey, { data: buf, timestamp: Date.now(), raw });
      trimSliceCache(entry);
      compressResponse(buf, req, res, 'application/octet-stream',
        sliceHeaders(h, axis, factor, startedAt, entry.unpackPath ? 'disk-raw' : 'source-raw', raw));
    };

    if (dataFs && !isGzip) {
      if (!entry.headerCache) {
        const headerReadPath = entry.unpackPath || headerFs || dataFs;
        const headerBytes = await readLocalFilePartial(headerReadPath, 0, 543);
        const header = host.parseEntryHeader(entry, headerBytes);
        if (!header) {
          res.writeHead(500);
          res.end('Failed to parse header');
          return;
        }
        entry.headerCache = header;
      }
      const header = entry.headerCache;
      const rawMeta = rawSliceMeta(header);
      if (rawMeta) {
        const raw = await extractLocalSliceRaw(dataFs, header, axis, idx, timeIdx, factor, ac.signal);
        if (!raw) { res.writeHead(404); res.end('Slice not found'); return; }
        replyRaw(raw, rawMeta);
        return;
      }
      const slice = await extractLocalSlice(dataFs, header, axis, idx, timeIdx, factor, ac.signal);
      if (!slice) { res.writeHead(404); res.end('Slice not found'); return; }
      reply(slice, true);
      return;
    }

    if (dataFs && isGzip) {
      const session = host.ensureGzipScan(entry);
      if (!entry.gzipIndex && session) {
        const built = await session.done;
        if (built) entry.gzipIndex = built;
        if (session.unpackPath) entry.unpackPath = session.unpackPath;
      }
    }

    if (entry.unpackPath) {
      return handleSlice(entry, axis, idx, res, req, host, timeIdx, factor);
    }

    if (dataFs && isGzip && entry.gzipIndex) {
      if (!entry.headerCache) {
        const headerBytes = await GzipIndex.readRange(dataFs, entry.gzipIndex, 0, 544);
        const header = host.parseEntryHeader(entry, headerBytes);
        if (!header) { res.writeHead(500); res.end('Failed to parse header'); return; }
        entry.headerCache = header;
      }
      try {
        const slice = await extractSliceFromGzipIndex(dataFs, entry.gzipIndex, entry.headerCache, axis, idx, timeIdx, ac.signal);
        if (!slice) { res.writeHead(404); res.end('Slice not found'); return; }
        reply(slice);
        return;
      } catch {
        // fall through to full decompression path
      }
    }

    if (dataFs && isGzip && !entry.gzipIndex) {
      host.ensureGzipScan(entry);
    }

    const fileUri = entry.dataUri || entry.uri;
    const uriStr = fileUri.toString();
    const isHttpRemote = fileUri.scheme === 'http' || fileUri.scheme === 'https';

    if (isHttpRemote && !isGzip) {
      if (!entry.headerCache) {
        try {
          const headerUri = entry.uri.toString();
          const headerBytes = await readHttpPartial(headerUri, 0, 543);
          const header = host.parseEntryHeader(entry, headerBytes);
          if (!header) { res.writeHead(500); res.end('Failed to parse header'); return; }
          entry.headerCache = header;
        } catch {
          res.writeHead(500); res.end('Failed to fetch header via HTTP Range'); return;
        }
      }
      const header = entry.headerCache;
      const { nx, ny, voxOffset, bytesPerVoxel } = header;
      const tOff = timepointByteOffset(header, timeIdx);

      try {
        if (axis === 'axial') {
          const sliceStart = voxOffset + tOff + idx * nx * ny * bytesPerVoxel;
          const sliceEnd = sliceStart + nx * ny * bytesPerVoxel - 1;
          const sliceBytes = await readHttpPartial(uriStr, sliceStart, sliceEnd);
          reply(extractAxialSliceFromRange(sliceBytes, header));
          return;
        }

        // Coronal/sagittal slices access scattered voxels across many axial
        // slices. Serving them with one tiny Range request per z-row causes
        // massive round-trip overhead on remote files. Instead, fetch the
        // full volume once using parallel chunked ranges and extract locally.
        // Subsequent slice requests are then served from entry.dataCache.
        const { rawData } = await host.loadFileData(entry);
        const slice = extractSingleSlice(rawData, header, axis, idx, timeIdx);
        if (!slice) {
          res.writeHead(404); res.end('Slice not found'); return;
        }
        reply(slice);
        return;
      } catch {
        res.writeHead(500); res.end('Failed to fetch slice via HTTP Range'); return;
      }
    }

    const { rawData, header } = await host.loadFileData(entry);
    if (!header) {
      res.writeHead(500);
      res.end('No header');
      return;
    }

    const slice = extractSingleSlice(rawData, header, axis, idx, timeIdx);
    if (!slice) {
      res.writeHead(404);
      res.end('Slice not found');
      return;
    }

    reply(slice);
  } catch (err) {
    res.writeHead(500);
    res.end(errorMessage(err));
  }
}

export async function handleLOD(
  entry: FileEntry,
  level: number,
  res: http.ServerResponse,
  req: http.IncomingMessage,
  host: SliceHost,
): Promise<void> {
  try {
    const cached = entry.lodCache?.get(level);
    if (cached) {
      const result = { header: cached.header, axial: Array.from(cached.data) };
      compressResponse(Buffer.from(JSON.stringify(result)), req, res, 'application/json');
      return;
    }

    const { rawData, header } = await host.loadFileData(entry);
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
  } catch (err) {
    res.writeHead(500);
    res.end(errorMessage(err));
  }
}
