/**
 * Preview routes for the localhost proxy.
 *
 * Extracted from LocalFileProxy so the router only owns lifecycle/queueing:
 * these handlers resolve a preview payload (local NIfTI, local gzip, remote
 * HTTP, or in-memory) and write it to the response.
 */
import type * as http from 'http';
import * as vscode from 'vscode';
import { errorMessage } from '../errors';
import type { NiiHeader } from '../nifti/headerParser';
import { computeSliceMinMax, encodePreviewBinary } from '../nifti/previewEncoder';
import { extractAxialSliceFromRange, extractPreviewSlices } from '../nifti/sliceExtractor';
import { readHttpPartial, readLocalFilePartial } from '../io/fileReader';
import { compressResponse, streamingGunzipPreview, streamingHttpGunzipPreview } from '../io/compression';
import type { GzipScanSession } from '../io/gzipScan';
import type { FileEntry } from './types';

export interface LocalPreviewHost {
  headerPath(entry: FileEntry): string;
  dataPath(entry: FileEntry): string;
  parseEntryHeader(entry: FileEntry, bytes: Uint8Array): NiiHeader | null;
  ensureGzipScan(entry: FileEntry): GzipScanSession | null;
  loadFileData(entry: FileEntry, signal?: AbortSignal): Promise<{ rawData: Uint8Array; header: NiiHeader | null }>;
}

export function handleGzipMeta(entry: FileEntry, res: http.ServerResponse): void {
  const index = entry.gzipIndex || entry.gzipScan?.index || null;
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({
      indexReady: !!index,
      indexEntries: index?.entries.length ?? 0,
    }),
  );
}

export async function handlePreview(
  entry: FileEntry,
  res: http.ServerResponse,
  req: http.IncomingMessage,
  host: LocalPreviewHost,
): Promise<void> {
  try {
    if (entry.previewBinaryCache) {
      compressResponse(entry.previewBinaryCache, req, res, 'application/octet-stream');
      return;
    }

    const fsPath = entry.uri.fsPath;
    const isGzip = fsPath ? fsPath.endsWith('.gz') : entry.uri.toString().endsWith('.gz');
    const isLocal = !!fsPath;

    if (isLocal && !isGzip) {
      await handlePreviewLocalNii(entry, res, req, host);
      return;
    }

    if (isLocal && isGzip) {
      await handlePreviewLocalGz(entry, res, req, host);
      return;
    }

    await handlePreviewRemote(entry, res, req, host);
  } catch (err) {
    res.writeHead(500);
    res.end(errorMessage(err));
  }
}

async function handlePreviewLocalNii(
  entry: FileEntry,
  res: http.ServerResponse,
  req: http.IncomingMessage,
  host: LocalPreviewHost,
): Promise<void> {
  const headerFs = host.headerPath(entry);
  const dataFs = host.dataPath(entry);

  if (!entry.headerCache) {
    const headerBytes = await readLocalFilePartial(headerFs, 0, 543);
    const header = host.parseEntryHeader(entry, headerBytes);
    if (!header) {
      res.writeHead(500);
      res.end('Failed to parse header');
      return;
    }
    entry.headerCache = header;
  }

  const header = entry.headerCache;
  const { nx, ny, nz, voxOffset, bytesPerVoxel } = header;
  const axMid = Math.floor(nz / 2);
  const sliceStart = voxOffset + axMid * nx * ny * bytesPerVoxel;
  const sliceEnd = sliceStart + nx * ny * bytesPerVoxel;

  const sliceBytes = await readLocalFilePartial(dataFs, sliceStart, sliceEnd - 1);
  const axialSlice = extractAxialSliceFromRange(sliceBytes, header);

  let min = Infinity,
    max = -Infinity;
  for (let i = 0; i < axialSlice.length; i++) {
    if (axialSlice[i] < min) min = axialSlice[i];
    if (axialSlice[i] > max) max = axialSlice[i];
  }

  const emptyCoronal = new Float32Array(nx * nz);
  const emptySagittal = new Float32Array(ny * nz);

  const slices = { axial: axialSlice, coronal: emptyCoronal, sagittal: emptySagittal };
  const buf = encodePreviewBinary(header, slices, min, max);
  entry.previewBinaryCache = buf;
  compressResponse(buf, req, res, 'application/octet-stream');
}

export async function handlePreviewOrtho(
  entry: FileEntry,
  res: http.ServerResponse,
  req: http.IncomingMessage,
  host: LocalPreviewHost,
): Promise<void> {
  const session = host.ensureGzipScan(entry);
  if (!session) {
    res.writeHead(404);
    res.end('Not a local gzip file');
    return;
  }
  const preview = await session.ortho.catch(() => null);
  if (!preview) {
    res.writeHead(404);
    res.end('Orthogonal preview unavailable');
    return;
  }
  const buf = encodePreviewBinary(
    preview.header,
    { axial: preview.axial, coronal: preview.coronal, sagittal: preview.sagittal },
    preview.min,
    preview.max,
    preview.sliceIdx,
  );
  compressResponse(buf, req, res, 'application/octet-stream');
}

async function handlePreviewLocalGz(
  entry: FileEntry,
  res: http.ServerResponse,
  req: http.IncomingMessage,
  host: LocalPreviewHost,
): Promise<void> {
  const fsPath = entry.uri.fsPath!;
  const session = host.ensureGzipScan(entry);
  const preview = session ? await session.z0.catch(() => null) : null;
  if (!preview) {
    const { header, axialSlice } = await streamingGunzipPreview(fsPath);
    if (!header) {
      res.writeHead(500);
      res.end('Failed to parse header');
      return;
    }
    entry.headerCache = header;
    const { nx, ny, nz } = header;
    let min = Infinity,
      max = -Infinity;
    for (let i = 0; i < axialSlice.length; i++) {
      if (axialSlice[i] < min) min = axialSlice[i];
      if (axialSlice[i] > max) max = axialSlice[i];
    }
    const slices = {
      axial: axialSlice,
      coronal: new Float32Array(nx * nz),
      sagittal: new Float32Array(ny * nz),
    };
    const buf = encodePreviewBinary(header, slices, min, max, {
      axial: 0,
      coronal: Math.floor(ny / 2),
      sagittal: Math.floor(nx / 2),
    });
    entry.previewBinaryCache = buf;
    compressResponse(buf, req, res, 'application/octet-stream');
    return;
  }

  entry.headerCache = preview.header;
  entry.lastAccess = Date.now();
  const buf = encodePreviewBinary(
    preview.header,
    { axial: preview.axial, coronal: preview.coronal, sagittal: preview.sagittal },
    preview.min,
    preview.max,
    preview.sliceIdx,
  );
  entry.previewBinaryCache = buf;
  compressResponse(buf, req, res, 'application/octet-stream');
}

async function handlePreviewRemote(
  entry: FileEntry,
  res: http.ServerResponse,
  req: http.IncomingMessage,
  host: LocalPreviewHost,
): Promise<void> {
  const uriStr = entry.uri.toString();
  const isHttpRemote = entry.uri.scheme === 'http' || entry.uri.scheme === 'https';
  const isGzip = uriStr.endsWith('.gz');

  if (isHttpRemote) {
    if (isGzip) {
      try {
        const { header, axialSlice } = await streamingHttpGunzipPreview(uriStr);
        if (!header) throw new Error('No NIfTI header in stream');
        entry.headerCache = header;
        const { nx, ny, nz } = header;
        const emptyCoronal = new Float32Array(nx * nz);
        const emptySagittal = new Float32Array(ny * nz);
        const slices = { axial: axialSlice, coronal: emptyCoronal, sagittal: emptySagittal };
        const { min, max } = computeSliceMinMax(axialSlice);
        const buf = encodePreviewBinary(header, slices, min, max);
        entry.previewBinaryCache = buf;
        compressResponse(buf, req, res, 'application/octet-stream');
        return;
      } catch {
        res.writeHead(500);
        res.end('Failed to stream remote gzip preview');
        return;
      }
    }

    try {
      const headerBytes = await readHttpPartial(uriStr, 0, 543);
      const header = host.parseEntryHeader(entry, headerBytes);
      if (!header) {
        res.writeHead(500);
        res.end('Failed to parse header');
        return;
      }
      entry.headerCache = header;

      const { nx, ny, nz, voxOffset, bytesPerVoxel } = header;
      const axMid = Math.floor(nz / 2);
      const sliceStart = voxOffset + axMid * nx * ny * bytesPerVoxel;
      const sliceEnd = sliceStart + nx * ny * bytesPerVoxel - 1;
      const sliceBytes = await readHttpPartial(uriStr, sliceStart, sliceEnd);
      const axialSlice = extractAxialSliceFromRange(sliceBytes, header);

      const emptyCoronal = new Float32Array(nx * nz);
      const emptySagittal = new Float32Array(ny * nz);
      const slices = { axial: axialSlice, coronal: emptyCoronal, sagittal: emptySagittal };
      const { min, max } = computeSliceMinMax(axialSlice);
      const buf = encodePreviewBinary(header, slices, min, max);
      entry.previewBinaryCache = buf;
      compressResponse(buf, req, res, 'application/octet-stream');
      return;
    } catch {
      res.writeHead(500);
      res.end('Failed to fetch remote file via HTTP Range');
      return;
    }
  }

  if (!entry.size) {
    const stat = await vscode.workspace.fs.stat(entry.uri);
    entry.size = Number(stat.size);
  }
  const MAX_REMOTE_PREVIEW_SIZE = 200 * 1024 * 1024;
  if (entry.size && entry.size > MAX_REMOTE_PREVIEW_SIZE) {
    res.writeHead(503, { 'Content-Type': 'text/plain' });
    res.end('Remote preview for large files (>200MB) is not supported yet');
    return;
  }

  const { rawData, header } = await host.loadFileData(entry);
  if (!header) {
    res.writeHead(500);
    res.end('Failed to parse NIfTI header');
    return;
  }

  const slices = extractPreviewSlices(rawData, header);
  if (!slices) {
    res.writeHead(500);
    res.end('Failed to extract preview slices');
    return;
  }

  const { min, max } = computeSliceMinMax(slices.axial, slices.coronal, slices.sagittal);

  const buf = encodePreviewBinary(header, slices, min, max);
  entry.previewBinaryCache = buf;
  compressResponse(buf, req, res, 'application/octet-stream');
}

export async function handlePreviewBinary(
  entry: FileEntry,
  res: http.ServerResponse,
  req: http.IncomingMessage,
  host: LocalPreviewHost,
): Promise<void> {
  try {
    if (entry.previewBinaryCache) {
      compressResponse(entry.previewBinaryCache, req, res, 'application/octet-stream');
      return;
    }

    const fsPath = entry.uri.fsPath;
    if (fsPath && fsPath.endsWith('.gz')) {
      await handlePreviewLocalGz(entry, res, req, host);
      return;
    }

    const { rawData, header } = await host.loadFileData(entry);
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
    const buf = encodePreviewBinary(header, slices, min, max);

    entry.previewBinaryCache = buf;
    entry.headerCache = header;

    compressResponse(buf, req, res, 'application/octet-stream');
  } catch (err) {
    res.writeHead(500);
    res.end(errorMessage(err));
  }
}
