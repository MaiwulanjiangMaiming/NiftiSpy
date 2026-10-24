import * as http from 'http';
import * as https from 'https';
import * as fs from 'fs';
import * as zlib from 'zlib';
import * as vscode from 'vscode';
import { compressResponse } from '../io/compression';
import { getAgentForUrl, readHttpPartial, readHttpPartialInto } from '../io/fileReader';
import type { FileEntry } from './types';

/** Shared state between the proxy router and the streaming helpers. */
export interface HttpStreamContext {
  inflightFileStreams: Set<{ destroy: () => void; background: boolean }>;
  remoteSizeCache: Map<string, number>;
}

export async function handleFile(
  entry: FileEntry,
  res: http.ServerResponse,
  req: http.IncomingMessage,
  ctx: HttpStreamContext,
): Promise<void> {
  const fileUri = entry.dataUri || entry.uri;
  const isHttpRemote = fileUri.scheme === 'http' || fileUri.scheme === 'https';
  const method = (req.method || 'GET').toUpperCase();
  const rangeHeader = req.headers['range'];
  const background = String(req.headers['x-niftispy-priority'] || '').toLowerCase() === 'background';

  // ── Remote range request: forward directly, skip HEAD size lookup ──
  // The remote's Content-Range response header carries the total size,
  // so we cache it from the response and avoid a separate HEAD RTT.
  // This is critical: the worker issues ~16 parallel range probes and
  // a HEAD-per-request would add a full RTT to every single one.
  if (isHttpRemote && method === 'GET' && rangeHeader) {
    await streamHttpRangeToResponse(fileUri.toString(), rangeHeader, res, ctx, entry, req, background);
    return;
  }

  // ── Remote full-file GET: stream directly without buffering ──
  if (isHttpRemote && method === 'GET' && !rangeHeader) {
    await streamHttpToResponse(fileUri.toString(), res, ctx, entry, req, background);
    return;
  }

  // ── HEAD: answer with cached size or do one HEAD to the remote ──
  if (method === 'HEAD') {
    if (!entry.size) {
      if (isHttpRemote) {
        try { entry.size = await getHttpRemoteSize(fileUri.toString(), ctx); } catch { /* unknown */ }
      }
      if (!entry.size) {
        const stat = await vscode.workspace.fs.stat(fileUri);
        entry.size = Number(stat.size);
      }
    }
    const headHeaders: Record<string, string | number> = {
      'Content-Length': entry.size || 0,
      'Accept-Ranges': 'bytes',
      'Content-Type': 'application/octet-stream',
    };
    if (isHttpRemote) headHeaders['X-Remote-Source'] = 'true';
    res.writeHead(200, headHeaders);
    res.end();
    return;
  }

  // ── Local file paths (fsPath or vscode-remote) need a size lookup ──
  if (!entry.size) {
    const stat = await vscode.workspace.fs.stat(fileUri);
    entry.size = Number(stat.size);
  }
  const totalSize = entry.size!;

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

    const fsPath = fileUri.fsPath;
    if (fsPath) {
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${totalSize}`,
        'Content-Length': chunkSize,
        'Accept-Ranges': 'bytes',
        'Content-Type': 'application/octet-stream',
      });
      const stream = fs.createReadStream(fsPath, { start, end, highWaterMark: 4 * 1024 * 1024 });
      await pipeLocalFile(req, res, stream, background, ctx);
    } else {
      entry.lastAccess = Date.now();
      if (!entry.dataCache) {
        entry.dataCache = await vscode.workspace.fs.readFile(fileUri);
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
    const fsPath = fileUri.fsPath;
    // Never re-compress an already-compressed payload: gzip-of-gzip wastes
    // server CPU (~2-5s per 100MB) with zero size benefit, and browsers
    // cannot skip Accept-Encoding on fetch() (it is a forbidden header).
    const isAlreadyCompressed = /\.gz$/i.test(fsPath || '') || /\.gz$/i.test(fileUri.path || '');
    const shouldCompress = !isAlreadyCompressed && (req.headers['accept-encoding'] || '').includes('gzip');
    if (fsPath && !shouldCompress) {
      res.writeHead(200, {
        'Content-Length': totalSize,
        'Accept-Ranges': 'bytes',
        'Content-Type': 'application/octet-stream',
      });
      const stream = fs.createReadStream(fsPath, { highWaterMark: 4 * 1024 * 1024 });
      await pipeLocalFile(req, res, stream, background, ctx);
    } else if (fsPath && shouldCompress) {
      res.writeHead(200, {
        'Content-Encoding': 'gzip',
        'Accept-Ranges': 'bytes',
        'Content-Type': 'application/octet-stream',
      });
      const stream = fs.createReadStream(fsPath);
      const gzip = zlib.createGzip({ level: 1 });
      stream.pipe(gzip);
      await pipeLocalFile(req, res, gzip, background, ctx, stream);
    } else {
      entry.lastAccess = Date.now();
      if (!entry.dataCache) {
        entry.dataCache = await vscode.workspace.fs.readFile(fileUri);
      }
      compressResponse(Buffer.from(entry.dataCache), req, res, 'application/octet-stream', { 'Accept-Ranges': 'bytes' });
    }
  }
}

export function pipeLocalFile(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  stream: NodeJS.ReadableStream,
  background: boolean,
  ctx: HttpStreamContext,
  extra?: { destroy: () => void },
): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      ctx.inflightFileStreams.delete(handle);
      resolve();
    };
    const destroy = () => {
      try { extra?.destroy(); } catch { /* already closed */ }
      try { (stream as any).destroy?.(); } catch { /* already closed */ }
      if (!res.writableEnded) {
        try { res.destroy(); } catch { /* already closed */ }
      }
      finish();
    };
    const handle = { destroy, background };
    ctx.inflightFileStreams.add(handle);
    req.on('close', destroy);
    stream.on('error', finish);
    res.on('finish', finish);
    res.on('close', finish);
    stream.pipe(res);
  });
}

export function trackHttpAbort(
  clientReq: http.IncomingMessage | undefined,
  remoteReq: { destroy: () => void },
  background: boolean,
  ctx: HttpStreamContext,
): () => void {
  const destroy = () => {
    try { remoteReq.destroy(); } catch { /* already closed */ }
  };
  const handle = { destroy, background };
  ctx.inflightFileStreams.add(handle);
  clientReq?.on('close', destroy);
  return () => ctx.inflightFileStreams.delete(handle);
}

export function getHttpRemoteSize(url: string, ctx: HttpStreamContext): Promise<number> {
  const cached = ctx.remoteSizeCache.get(url);
  if (cached !== undefined) return Promise.resolve(cached);

  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'HEAD',
      agent: getAgentForUrl(url),
    };
    const mod = parsed.protocol === 'https:' ? https : http;
    const request = mod.request(options, (response: any) => {
      const contentLength = parseInt(response.headers['content-length'] || '0', 10);
      if (contentLength > 0) {
        ctx.remoteSizeCache.set(url, contentLength);
        resolve(contentLength);
      } else {
        reject(new Error('Content-Length not available'));
      }
      response.resume(); // drain the response
    });
    request.on('error', reject);
    request.setTimeout(5000, () => { request.destroy(); reject(new Error('HEAD request timeout')); });
    request.end();
  });
}

export function streamHttpRangeToResponse(
  url: string,
  rangeHeader: string,
  res: http.ServerResponse,
  ctx: HttpStreamContext,
  entry?: FileEntry,
  clientReq?: http.IncomingMessage,
  background = false,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options: any = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: { Range: rangeHeader },
      agent: getAgentForUrl(url),
    };
    const mod = parsed.protocol === 'https:' ? https : http;
    let untrack = () => {};
    const request = mod.request(options, (response: any) => {
      if (response.statusCode === 206 || response.statusCode === 200) {
        const contentRange = response.headers['content-range'];
        const contentLength = parseInt(response.headers['content-length'] || '0', 10);

        // Cache total size from Content-Range so subsequent requests
        // (and the HEAD path) don't need another round-trip.
        if (entry && contentRange) {
          const m = contentRange.match(/\/(\d+)/);
          if (m) entry.size = parseInt(m[1]);
        } else if (entry && contentLength && response.statusCode === 200) {
          entry.size = contentLength;
        }

        const headers: Record<string, string | number> = {
          'Accept-Ranges': 'bytes',
          'Content-Type': 'application/octet-stream',
          'X-Remote-Source': 'true',
        };
        if (contentRange) {
          headers['Content-Range'] = contentRange;
        }
        if (contentLength) {
          headers['Content-Length'] = contentLength;
        }
        res.writeHead(response.statusCode, headers);
        response.pipe(res, { end: true });
        response.on('end', () => { untrack(); resolve(); });
        response.on('error', (err: Error) => { untrack(); reject(err); });
      } else {
        untrack();
        reject(new Error(`Remote responded with ${response.statusCode}`));
        response.resume();
      }
    });
    untrack = trackHttpAbort(clientReq, request, background, ctx);
    request.on('error', (err) => { untrack(); reject(err); });
    request.setTimeout(30000, () => { request.destroy(); untrack(); reject(new Error('Range request timeout')); });
    request.end();
  });
}

export function streamHttpToResponse(
  url: string,
  res: http.ServerResponse,
  ctx: HttpStreamContext,
  entry?: FileEntry,
  clientReq?: http.IncomingMessage,
  background = false,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'GET',
      agent: getAgentForUrl(url),
    };
    const mod = parsed.protocol === 'https:' ? https : http;
    let untrack = () => {};
    const request = mod.request(options, (response: any) => {
      if (response.statusCode === 200) {
        const contentLength = parseInt(response.headers['content-length'] || '0', 10);
        if (entry && contentLength) entry.size = contentLength;
        const headers: Record<string, string | number> = {
          'Accept-Ranges': 'bytes',
          'Content-Type': 'application/octet-stream',
          'X-Remote-Source': 'true',
        };
        if (contentLength) {
          headers['Content-Length'] = contentLength;
        }
        res.writeHead(200, headers);
        response.pipe(res, { end: true });
        response.on('end', () => { untrack(); resolve(); });
        response.on('error', (err: Error) => { untrack(); reject(err); });
      } else {
        untrack();
        reject(new Error(`Remote responded with ${response.statusCode}`));
        response.resume();
      }
    });
    untrack = trackHttpAbort(clientReq, request, background, ctx);
    request.on('error', (err) => { untrack(); reject(err); });
    request.setTimeout(60000, () => { request.destroy(); untrack(); reject(new Error('Full file request timeout')); });
    request.end();
  });
}

/**
 * Download a remote HTTP file using parallel byte-range requests.
 * This saturates high-bandwidth links and avoids the latency of many
 * sequential small requests, which is critical for large uncompressed
 * NIfTI volumes.
 */
export async function downloadHttpFileInChunks(url: string, totalSize: number, signal?: AbortSignal): Promise<Uint8Array> {
  const CHUNK_SIZE = 32 * 1024 * 1024; // 32 MB — larger chunks = fewer requests, better throughput
  const MAX_CONCURRENT = 32;            // match agent maxSockets for full utilization

  if (totalSize <= CHUNK_SIZE) {
    return readHttpPartial(url, 0, totalSize - 1, signal);
  }

  const ranges: { start: number; end: number }[] = [];
  for (let start = 0; start < totalSize; start += CHUNK_SIZE) {
    const end = Math.min(start + CHUNK_SIZE - 1, totalSize - 1);
    ranges.push({ start, end });
  }

  // Pre-allocate the entire result buffer and write each chunk directly
  // into it via readHttpPartialInto — avoids one intermediate Buffer
  // allocation + memcpy per chunk (saves ~CHUNK_SIZE bytes of temp
  // memory and a full-copy per request).
  const result = Buffer.alloc(totalSize);
  let running = 0;
  let nextIdx = 0;
  let poolError: Error | null = null;

  return new Promise((resolve, reject) => {
    const tryLaunch = (): void => {
      while (running < MAX_CONCURRENT && nextIdx < ranges.length && !poolError) {
        const idx = nextIdx++;
        const { start, end } = ranges[idx];
        running++;
        readHttpPartialInto(url, start, end, result, start, signal)
          .then(() => {
            if (poolError) return;
          })
          .catch(err => {
            if (!poolError) poolError = err;
          })
          .finally(() => {
            running--;
            if (poolError) {
              reject(poolError);
              return;
            }
            if (nextIdx >= ranges.length && running === 0) {
              resolve(new Uint8Array(result.buffer, result.byteOffset, result.byteLength));
            } else {
              tryLaunch();
            }
          });
      }
      if (ranges.length === 0) {
        resolve(new Uint8Array(result.buffer, result.byteOffset, result.byteLength));
      }
    };
    tryLaunch();
  });
}
