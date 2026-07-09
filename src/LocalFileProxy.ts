import * as http from 'http';
import * as https from 'https';
import * as http2 from 'http2';
import * as fs from 'fs';
import * as zlib from 'zlib';
import * as vscode from 'vscode';
import { VolumeCache } from './VolumeCache';
import { parseNiiHeaderQuick } from './nifti/headerParser';
import {
  extractAxialSliceFromRange,
  extractCoronalSliceFromRange,
  extractSagittalSliceFromRange,
  extractSingleSlice,
  extractPreviewSlices,
  downsampleSlice,
} from './nifti/sliceExtractor';
import { computeSliceMinMax, encodePreviewBinary } from './nifti/previewEncoder';
import { readLocalFilePartial, readHttpPartial, readHttpPartialInto, getAgentForUrl } from './io/fileReader';
import {
  compressResponse,
  gunzipAsync,
  streamingGunzipPreview,
  streamingHttpGunzipPreview,
  streamingGunzipPreviewVolume,
  type VolumePreviewResult,
} from './io/compression';
import { GzipIndex, loadCachedIndex, saveCachedIndex } from './io/gzipIndex';

interface FileEntry {
  uri: vscode.Uri;
  id: string;
  size?: number;
  dataCache?: Uint8Array;
  lastAccess?: number;
  headerCache?: any;
  previewBinaryCache?: Buffer;
  sliceCache?: Map<string, { data: Buffer; timestamp: number }>;
  lodCache?: Map<number, { header: any; data: Float32Array; timestamp: number }>;
  pendingLoad?: Promise<{ rawData: Uint8Array; header: any }>;
  gzipIndex?: GzipIndex;
  gzipIndexBuilding?: boolean;
}

interface ConnectionStats {
  protocol: 'h2' | 'http/1.1';
  activeStreams: number;
  totalRequests: number;
  pushedSlices: number;
}

interface PrioritizedRequest {
  priority: number;
  execute: () => Promise<void>;
}

const REQUEST_PRIORITY = {
  header: 100,
  preview: 80,
  previewBin: 80,
  previewVolume: 90, // higher than slice — users want to see *something* fast
  slice: 50,
  lod: 20,
  file: 10,
  stats: 0,
} as const;

export class LocalFileProxy {
  private server: http2.Http2Server | http.Server | null = null;
  private port = 0;
  private files = new Map<string, FileEntry>();
  private idCounter = 0;
  private cleanupInterval: NodeJS.Timeout | null = null;
  private volumeCache: VolumeCache | null;
  private useHttp2 = false;
  private stats: ConnectionStats = { protocol: 'http/1.1', activeStreams: 0, totalRequests: 0, pushedSlices: 0 };
  private recentSliceRequests = new Map<string, number>(); // key -> timestamp
  private priorityQueue: PrioritizedRequest[] = [];
  private activeStreamCount = 0;

  constructor(volumeCache?: VolumeCache) {
    this.volumeCache = volumeCache || null;
  }

  async start(): Promise<void> {
    const maxRetries = 3;
    const configuredPort = vscode.workspace.getConfiguration('niftispy').get<number>('proxyPort', 0);
    let tryPort = configuredPort;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const server = await new Promise<http2.Http2Server | http.Server>((resolve, reject) => {
          let createdServer: http2.Http2Server | http.Server;
          try {
            const h2Server = http2.createServer();
            h2Server.on('stream', (stream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders) => {
              this.handleHttp2Stream(stream, headers);
            });
            createdServer = h2Server;
            this.useHttp2 = true;
            this.stats.protocol = 'h2';
          } catch {
            createdServer = http.createServer(this.handleRequest.bind(this) as any);
            this.useHttp2 = false;
            this.stats.protocol = 'http/1.1';
          }

          createdServer.on('error', (err: any) => {
            if (err.code === 'EADDRINUSE' && tryPort !== 0) {
              reject(err);
            } else {
              reject(err);
            }
          });

          createdServer.listen(tryPort, '127.0.0.1', () => {
            resolve(createdServer);
          });
        });

        this.server = server;
        const addr = this.server.address() as { port: number };
        this.port = addr.port;
        this.server.on('error', (err: Error) => {
          console.error('LocalFileProxy server error:', err);
        });
        this.startCleanup();
        return;
      } catch (err: any) {
        if (err.code === 'EADDRINUSE' && tryPort !== 0 && attempt < maxRetries) {
          tryPort = tryPort + 1;
          continue;
        }
        if (tryPort !== 0 && attempt >= maxRetries) {
          throw new Error(`NiftiSpy: Failed to start HTTP proxy after ${maxRetries} retries. Port ${configuredPort}–${tryPort} are all in use. Set niftispy.proxyPort to 0 for auto-assign.`);
        }
        throw err;
      }
    }
  }

  private startCleanup(): void {
    this.cleanupInterval = setInterval(() => {
      const now = Date.now();
      for (const [, entry] of this.files.entries()) {
        if (entry.dataCache && entry.lastAccess && now - entry.lastAccess > 120000) {
          entry.dataCache = undefined;
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
      this.volumeCache?.cleanup();
      this.volumeCache?.evictIfNeeded();
      // Prune stale recent slice request tracking
      for (const [key, ts] of this.recentSliceRequests.entries()) {
        if (now - ts > 30000) this.recentSliceRequests.delete(key);
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

  registerFile(uri: vscode.Uri): string {
    const id = String(this.idCounter++);
    this.files.set(id, { uri, id, sliceCache: new Map(), lodCache: new Map() });
    return `http://127.0.0.1:${this.port}/file/${id}`;
  }

  getEntry(entryId: string): FileEntry | undefined {
    return this.files.get(entryId);
  }

  getEntryIdByUri(uri: vscode.Uri): string | undefined {
    const uriStr = uri.toString();
    for (const [id, entry] of this.files) {
      if (entry.uri.toString() === uriStr) return id;
    }
    return undefined;
  }

  private readonly maxConcurrentRequests = 32;
  private activeRequests = 0;

  private enqueueRequest(priority: number, execute: () => Promise<void>): void {
    // Binary insert into sorted array — O(log n) instead of O(n log n) sort
    let lo = 0, hi = this.priorityQueue.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.priorityQueue[mid].priority > priority) lo = mid + 1;
      else hi = mid;
    }
    this.priorityQueue.splice(lo, 0, { priority, execute });
    this.processPriorityQueue();
  }

  private processPriorityQueue(): void {
    while (this.activeRequests < this.maxConcurrentRequests && this.priorityQueue.length > 0) {
      const job = this.priorityQueue.shift()!;
      this.activeRequests++;
      job.execute().finally(() => {
        this.activeRequests--;
        this.processPriorityQueue();
      });
    }
  }

  private handleHttp2Stream(stream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders): void {
    const path = headers[':path'] || '';
    const method = headers[':method'] || 'GET';

    this.activeStreamCount++;
    this.stats.activeStreams = this.activeStreamCount;
    this.stats.totalRequests++;

    stream.on('close', () => {
      this.activeStreamCount = Math.max(0, this.activeStreamCount - 1);
      this.stats.activeStreams = this.activeStreamCount;
    });

    if (method === 'OPTIONS') {
      stream.respond({
        ':status': 204,
        'access-control-allow-origin': '*',
        'access-control-allow-headers': 'Range, Accept-Encoding',
        'access-control-expose-headers': 'Content-Range, Content-Length, Accept-Ranges, Content-Encoding',
        'cross-origin-opener-policy': 'same-origin',
        'cross-origin-embedder-policy': 'require-corp',
      });
      stream.end();
      return;
    }

    const statsMatch = path.match(/^\/stats$/);
    if (statsMatch) {
      stream.respond({ ':status': 200, 'content-type': 'application/json', 'access-control-allow-origin': '*' });
      stream.end(JSON.stringify(this.getStats()));
      return;
    }

    const headerMatch = path.match(/^\/header\/(\d+)$/);
    const previewMatch = path.match(/^\/preview\/(\d+)$/);
    const previewBinMatch = path.match(/^\/preview-bin\/(\d+)$/);
    const previewVolumeMatch = path.match(/^\/preview-volume\/(\d+)/);
    const sliceMatch = path.match(/^\/slice\/(\d+)\/(axial|coronal|sagittal)\/(\d+)$/);
    const lodMatch = path.match(/^\/lod\/(\d+)\/(\d+)$/);
    const fileMatch = path.match(/^\/file\/(\d+)$/);
    const match = headerMatch || previewMatch || previewBinMatch || previewVolumeMatch || sliceMatch || lodMatch || fileMatch;

    if (!match) {
      stream.respond({ ':status': 404, 'access-control-allow-origin': '*' });
      stream.end();
      return;
    }

    const entry = this.files.get(match[1]);
    if (!entry) {
      stream.respond({ ':status': 404, 'access-control-allow-origin': '*' });
      stream.end('File not found');
      return;
    }

    const priority = headerMatch ? REQUEST_PRIORITY.header
      : previewMatch ? REQUEST_PRIORITY.preview
      : previewBinMatch ? REQUEST_PRIORITY.previewBin
      : previewVolumeMatch ? REQUEST_PRIORITY.previewVolume
      : sliceMatch ? REQUEST_PRIORITY.slice
      : lodMatch ? REQUEST_PRIORITY.lod
      : REQUEST_PRIORITY.file;

    const h2Headers = {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'Range, Accept-Encoding',
      'access-control-expose-headers': 'Content-Range, Content-Length, Accept-Ranges, Content-Encoding',
      'cross-origin-opener-policy': 'same-origin',
      'cross-origin-embedder-policy': 'require-corp',
    };

    const fakeReq = { headers: { 'accept-encoding': (headers['accept-encoding'] as string) || '', 'range': (headers['range'] as string) || '', 'host': (headers[':authority'] as string) || (headers['host'] as string) || '127.0.0.1' }, method, url: path } as any as http.IncomingMessage;
    const h2Response = new Http2ResponseAdapter(stream, h2Headers);

    this.enqueueRequest(priority, async () => {
      try {
        if (headerMatch) {
          await this.handleHeader(entry, h2Response, fakeReq);
        } else if (previewMatch) {
          await this.handlePreview(entry, h2Response, fakeReq);
        } else if (previewBinMatch) {
          await this.handlePreviewBinary(entry, h2Response, fakeReq);
        } else if (previewVolumeMatch) {
          const factor = parseFactorFromPath(path);
          await this.handlePreviewVolume(entry, factor, h2Response, fakeReq);
        } else if (sliceMatch) {
          await this.handleSlice(entry, sliceMatch[2], parseInt(sliceMatch[3]), h2Response, fakeReq);
          // Server push for adjacent slices
          if (this.useHttp2 && sliceMatch) {
            this.pushAdjacentSlices(stream, entry, sliceMatch[2], parseInt(sliceMatch[3]));
          }
        } else if (lodMatch) {
          await this.handleLOD(entry, parseInt(lodMatch[2]), h2Response, fakeReq);
        } else {
          await this.handleFile(entry, h2Response, fakeReq);
        }
      } catch (err) {
        console.error('LocalFileProxy h2 error:', err);
        if (!stream.destroyed) {
          try { stream.respond({ ':status': 500 }); } catch { /* already responded */ }
          stream.end(String(err));
        }
      }
    });
  }

  private pushAdjacentSlices(stream: http2.ServerHttp2Stream, entry: FileEntry, axis: string, idx: number): void {
    const maxIdx = axis === 'axial' ? (entry.headerCache?.nz ?? 0)
      : axis === 'coronal' ? (entry.headerCache?.ny ?? 0)
      : (entry.headerCache?.nx ?? 0);

    for (let offset = 1; offset <= 2; offset++) {
      const pushIdx = idx + offset;
      if (pushIdx >= maxIdx) break;
      const pushKey = `${entry.id}:${axis}:${pushIdx}`;
      if (this.recentSliceRequests.has(pushKey)) continue;
      // Skip if already cached
      if (entry.sliceCache?.has(pushKey)) continue;

      const pushPath = `/slice/${entry.id}/${axis}/${pushIdx}`;
      try {
        stream.pushStream({ ':path': pushPath, ':method': 'GET' }, (err, pushStream) => {
          if (err) return;
          this.stats.pushedSlices++;
          this.recentSliceRequests.set(pushKey, Date.now());
          const pushHeaders = {
            ':status': 200,
            'content-type': 'application/octet-stream',
            'access-control-allow-origin': '*',
            'cross-origin-opener-policy': 'same-origin',
            'cross-origin-embedder-policy': 'require-corp',
          };
          this.handleSlice(entry, axis, pushIdx, new Http2ResponseAdapter(pushStream, {
            'access-control-allow-origin': '*',
            'cross-origin-opener-policy': 'same-origin',
            'cross-origin-embedder-policy': 'require-corp',
          }), { headers: { 'accept-encoding': '', 'range': '' } } as any as http.IncomingMessage).catch(() => {
            try { pushStream.close(http2.constants.NGHTTP2_INTERNAL_ERROR); } catch { /* ignore */ }
          });
        });
      } catch {
        // Push not supported or stream already closed
      }
    }
  }

  getStats(): ConnectionStats {
    return { ...this.stats, activeStreams: this.activeStreamCount };
  }

  private async handleRequest(
    req: http.IncomingMessage | http2.Http2ServerRequest,
    res: http.ServerResponse | http2.Http2ServerResponse
  ): Promise<void> {
    const _req = req as http.IncomingMessage;
    const _res = res as http.ServerResponse;

    _res.setHeader('Access-Control-Allow-Origin', '*');
    _res.setHeader('Access-Control-Allow-Headers', 'Range, Accept-Encoding');
    _res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges, Content-Encoding');
    _res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    _res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    _res.setHeader('Connection', 'keep-alive');
    _res.setHeader('Keep-Alive', 'timeout=30, max=100');

    if (_req.method === 'OPTIONS') {
      _res.writeHead(204);
      _res.end();
      return;
    }

    this.stats.totalRequests++;

    const statsMatch = _req.url?.match(/^\/stats$/);
    if (statsMatch) {
      _res.writeHead(200, { 'Content-Type': 'application/json' });
      _res.end(JSON.stringify(this.getStats()));
      return;
    }

    const headerMatch = _req.url?.match(/^\/header\/(\d+)$/);
    const previewMatch = _req.url?.match(/^\/preview\/(\d+)$/);
    const previewBinMatch = _req.url?.match(/^\/preview-bin\/(\d+)$/);
    const previewVolumeMatch = _req.url?.match(/^\/preview-volume\/(\d+)/);
    const sliceMatch = _req.url?.match(/^\/slice\/(\d+)\/(axial|coronal|sagittal)\/(\d+)$/);
    const lodMatch = _req.url?.match(/^\/lod\/(\d+)\/(\d+)$/);
    const fileMatch = _req.url?.match(/^\/file\/(\d+)$/);
    const match = headerMatch || previewMatch || previewBinMatch || previewVolumeMatch || sliceMatch || lodMatch || fileMatch;
    if (!match) {
      _res.writeHead(404);
      _res.end();
      return;
    }

    const entry = this.files.get(match[1]);
    if (!entry) {
      _res.writeHead(404);
      _res.end('File not found');
      return;
    }

    const priority = headerMatch ? REQUEST_PRIORITY.header
      : previewMatch ? REQUEST_PRIORITY.preview
      : previewBinMatch ? REQUEST_PRIORITY.previewBin
      : previewVolumeMatch ? REQUEST_PRIORITY.previewVolume
      : sliceMatch ? REQUEST_PRIORITY.slice
      : lodMatch ? REQUEST_PRIORITY.lod
      : REQUEST_PRIORITY.file;

    this.enqueueRequest(priority, async () => {
      try {
        if (headerMatch) {
          await this.handleHeader(entry, _res, _req);
          return;
        }
        if (previewMatch) {
          await this.handlePreview(entry, _res, _req);
          return;
        }
        if (previewBinMatch) {
          await this.handlePreviewBinary(entry, _res, _req);
          return;
        }
        if (previewVolumeMatch) {
          const factor = parseFactorFromPath(_req.url || '');
          await this.handlePreviewVolume(entry, factor, _res, _req);
          return;
        }
        if (sliceMatch) {
          await this.handleSlice(entry, sliceMatch[2], parseInt(sliceMatch[3]), _res, _req);
          return;
        }
        if (lodMatch) {
          await this.handleLOD(entry, parseInt(lodMatch[2]), _res, _req);
          return;
        }

        await this.handleFile(entry, _res, _req);
      } catch (err) {
        console.error('LocalFileProxy error:', err);
        _res.writeHead(500);
        _res.end(String(err));
      }
    });
  }

  private async handleFile(entry: FileEntry, res: http.ServerResponse, req: http.IncomingMessage): Promise<void> {
    const isHttpRemote = entry.uri.scheme === 'http' || entry.uri.scheme === 'https';
    const method = (req.method || 'GET').toUpperCase();
    const rangeHeader = req.headers['range'];

    // ── Remote range request: forward directly, skip HEAD size lookup ──
    // The remote's Content-Range response header carries the total size,
    // so we cache it from the response and avoid a separate HEAD RTT.
    // This is critical: the worker issues ~16 parallel range probes and
    // a HEAD-per-request would add a full RTT to every single one.
    if (isHttpRemote && method === 'GET' && rangeHeader) {
      await this.streamHttpRangeToResponse(entry.uri.toString(), rangeHeader, res, entry);
      return;
    }

    // ── Remote full-file GET: stream directly without buffering ──
    if (isHttpRemote && method === 'GET' && !rangeHeader) {
      await this.streamHttpToResponse(entry.uri.toString(), res, entry);
      return;
    }

    // ── HEAD: answer with cached size or do one HEAD to the remote ──
    if (method === 'HEAD') {
      if (!entry.size) {
        if (isHttpRemote) {
          try { entry.size = await this.getHttpRemoteSize(entry.uri.toString()); } catch { /* unknown */ }
        }
        if (!entry.size) {
          const stat = await vscode.workspace.fs.stat(entry.uri);
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
      const stat = await vscode.workspace.fs.stat(entry.uri);
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

      const fsPath = entry.uri.fsPath;
      if (fsPath) {
        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${totalSize}`,
          'Content-Length': chunkSize,
          'Accept-Ranges': 'bytes',
          'Content-Type': 'application/octet-stream',
        });
        fs.createReadStream(fsPath, { start, end, highWaterMark: 4 * 1024 * 1024 }).pipe(res);
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
      const shouldCompress = (req.headers['accept-encoding'] || '').includes('gzip');
      if (fsPath && !shouldCompress) {
        res.writeHead(200, {
          'Content-Length': totalSize,
          'Accept-Ranges': 'bytes',
          'Content-Type': 'application/octet-stream',
        });
        fs.createReadStream(fsPath, { highWaterMark: 4 * 1024 * 1024 }).pipe(res);
      } else if (fsPath && shouldCompress) {
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
  }

  private remoteSizeCache = new Map<string, number>();

  private getHttpRemoteSize(url: string): Promise<number> {
    const cached = this.remoteSizeCache.get(url);
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
          this.remoteSizeCache.set(url, contentLength);
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

  private streamHttpRangeToResponse(url: string, rangeHeader: string, res: http.ServerResponse, entry?: FileEntry): Promise<void> {
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
          response.on('end', resolve);
          response.on('error', reject);
        } else {
          reject(new Error(`Remote responded with ${response.statusCode}`));
          response.resume();
        }
      });
      request.on('error', reject);
      request.setTimeout(30000, () => { request.destroy(); reject(new Error('Range request timeout')); });
      request.end();
    });
  }

  private streamHttpToResponse(url: string, res: http.ServerResponse, entry?: FileEntry): Promise<void> {
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
          response.on('end', resolve);
          response.on('error', reject);
        } else {
          reject(new Error(`Remote responded with ${response.statusCode}`));
          response.resume();
        }
      });
      request.on('error', reject);
      request.setTimeout(60000, () => { request.destroy(); reject(new Error('Full file request timeout')); });
      request.end();
    });
  }

  /**
   * Download a remote HTTP file using parallel byte-range requests.
   * This saturates high-bandwidth links and avoids the latency of many
   * sequential small requests, which is critical for large uncompressed
   * NIfTI volumes.
   */
  private async downloadHttpFileInChunks(url: string, totalSize: number, signal?: AbortSignal): Promise<Uint8Array> {
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
      } else if (entry.uri.scheme === 'http' || entry.uri.scheme === 'https') {
        headerBytes = await readHttpPartial(entry.uri.toString(), 0, 543);
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
      if (entry.previewBinaryCache) {
        compressResponse(entry.previewBinaryCache, req, res, 'application/octet-stream');
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
      res.writeHead(500);
      res.end(String(err?.message ?? err));
    }
  }

  private async handlePreviewLocalNii(entry: FileEntry, res: http.ServerResponse, req: http.IncomingMessage): Promise<void> {
    const fsPath = entry.uri.fsPath!;

    if (!entry.headerCache) {
      const headerBytes = await readLocalFilePartial(fsPath, 0, 543);
      const header = parseNiiHeaderQuick(headerBytes);
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

    const sliceBytes = await readLocalFilePartial(fsPath, sliceStart, sliceEnd - 1);
    const axialSlice = extractAxialSliceFromRange(sliceBytes, header);

    let min = Infinity, max = -Infinity;
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

  private async handlePreviewLocalGz(entry: FileEntry, res: http.ServerResponse, req: http.IncomingMessage): Promise<void> {
    const fsPath = entry.uri.fsPath!;
    const { header, axialSlice } = await streamingGunzipPreview(fsPath);

    if (!header) {
      res.writeHead(500);
      res.end('Failed to parse header');
      return;
    }

    entry.headerCache = header;
    entry.lastAccess = Date.now();

    const { nx, ny, nz } = header;
    let min = Infinity, max = -Infinity;
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

  private async handlePreviewRemote(entry: FileEntry, res: http.ServerResponse, req: http.IncomingMessage): Promise<void> {
    const uriStr = entry.uri.toString();
    const isHttpRemote = entry.uri.scheme === 'http' || entry.uri.scheme === 'https';
    const isGzip = uriStr.endsWith('.gz');

    if (isHttpRemote) {
      if (isGzip) {
        try {
          const { header, axialSlice } = await streamingHttpGunzipPreview(uriStr);
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
        const header = parseNiiHeaderQuick(headerBytes);
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

    const { rawData, header } = await this.loadFileData(entry);
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
      const buf = encodePreviewBinary(header, slices, min, max);

      entry.previewBinaryCache = buf;
      entry.headerCache = header;

      compressResponse(buf, req, res, 'application/octet-stream');
    } catch (err: any) {
      res.writeHead(500);
      res.end(String(err?.message ?? err));
    }
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
  private async handlePreviewVolume(
    entry: FileEntry,
    factor: number,
    res: http.ServerResponse,
    req: http.IncomingMessage,
  ): Promise<void> {
    try {
      const fsPath = entry.uri.fsPath;
      const uriStr = entry.uri.toString();
      const isGzip = fsPath ? fsPath.endsWith('.gz') : uriStr.endsWith('.gz');

      // For gzip, use a larger minimum factor (8) because gzip requires
      // sequential decompression — a larger factor means fewer slices to
      // decompress before the preview is ready (12.5% vs 25% of the file).
      const f = isGzip ? 8 : Math.max(2, Math.min(8, Math.floor(factor) || 4));

      // ── Gzip streaming preview (Stage 2) ──
      // Stream-download + decompress the .nii.gz and extract a strided
      // sub-sampled volume, resolving as soon as the needed z-slices are
      // available — without waiting for the full file to download.
      if (isGzip) {
        const isHttpRemote = entry.uri.scheme === 'http' || entry.uri.scheme === 'https';
        // Only local and HTTP sources support streaming; vscode-remote
        // falls through to the cached-data path below.
        if (fsPath || isHttpRemote) {
          const ac = new AbortController();
          req.on('close', () => { if (!res.writableEnded) ac.abort(); });
          try {
            const source = fsPath
              ? { type: 'file' as const, path: fsPath }
              : { type: 'http' as const, url: uriStr };
            const result = await streamingGunzipPreviewVolume(source, f, ac.signal);
            // Build a low-res header (scaled spacings + adjusted sform)
            const loHeader: any = { ...result.header };
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
            const totalLen = 4 + headerBuf.length + 4 * 7 + voxelBuf.length;
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
          } catch (err: any) {
            if (err?.name === 'AbortError') return;
            if (!res.headersSent) {
              res.writeHead(500);
              res.end(String(err?.message ?? err));
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
          const { header } = await this.loadFileData(entry);
          entry.headerCache = header;
          headerBytes = new Uint8Array(0);
        }
        if (!entry.headerCache) {
          const header = parseNiiHeaderQuick(headerBytes);
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
        await this.loadFileData(entry);
      }
      const cachedData = (!isLocal && !isHttpRemote) ? entry.dataCache : null;

      // ── Fetch each source z-slice and extract every f-th voxel ──
      // Bounded concurrency: 16 parallel range requests. For a 256³ volume
      // at factor=4, this is 64 slices → 4 batches → ~4 RTTs total.
      const MAX_CONCURRENT = 16;
      const sliceByteSize = nx * ny * bpv;

      const fetchAndExtractSlice = async (outZ: number): Promise<void> => {
        const srcZ = outZ * f;
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
        const outSliceBase = outZ * outNy * outNx;

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
      const loHeader: any = { ...header };
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

      const totalLen = 4 + headerBuf.length + 4 * 7 + voxelBuf.length;
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
    } catch (err: any) {
      if (!res.headersSent) {
        res.writeHead(500);
        res.end(String(err?.message ?? err));
      }
    }
  }

  private async handleSlice(entry: FileEntry, axis: string, idx: number, res: http.ServerResponse, req: http.IncomingMessage): Promise<void> {
    try {
      const cacheKey = `${entry.id}:${axis}:${idx}`;
      const cached = entry.sliceCache?.get(cacheKey);
      if (cached) {
        compressResponse(cached.data, req, res, 'application/octet-stream');
        return;
      }

      const fsPath = entry.uri.fsPath;
      const isGzip = fsPath ? fsPath.endsWith('.gz') : entry.uri.toString().endsWith('.gz');

      if (fsPath && !isGzip) {
        if (!entry.headerCache) {
          const headerBytes = await readLocalFilePartial(fsPath, 0, 543);
          const header = parseNiiHeaderQuick(headerBytes);
          if (!header) {
            res.writeHead(500);
            res.end('Failed to parse header');
            return;
          }
          entry.headerCache = header;
        }
        const header = entry.headerCache;
        const { nx, ny, voxOffset, bytesPerVoxel } = header;

        if (axis === 'axial') {
          const sliceStart = voxOffset + idx * nx * ny * bytesPerVoxel;
          const sliceSize = nx * ny * bytesPerVoxel;
          const sliceBytes = await readLocalFilePartial(fsPath, sliceStart, sliceStart + sliceSize - 1);
          const slice = extractAxialSliceFromRange(sliceBytes, header);
          const buf = Buffer.from(slice.buffer, slice.byteOffset, slice.byteLength);
          entry.sliceCache?.set(cacheKey, { data: buf, timestamp: Date.now() });
          compressResponse(buf, req, res, 'application/octet-stream');
          return;
        } else if (axis === 'coronal') {
          const slice = await extractCoronalSliceFromRange(fsPath, header, idx);
          if (!slice) { res.writeHead(404); res.end('Slice not found'); return; }
          const buf = Buffer.from(slice.buffer, slice.byteOffset, slice.byteLength);
          entry.sliceCache?.set(cacheKey, { data: buf, timestamp: Date.now() });
          compressResponse(buf, req, res, 'application/octet-stream');
          return;
        } else {
          const slice = await extractSagittalSliceFromRange(fsPath, header, idx);
          if (!slice) { res.writeHead(404); res.end('Slice not found'); return; }
          const buf = Buffer.from(slice.buffer, slice.byteOffset, slice.byteLength);
          entry.sliceCache?.set(cacheKey, { data: buf, timestamp: Date.now() });
          compressResponse(buf, req, res, 'application/octet-stream');
          return;
        }
      }

      if (fsPath && isGzip && entry.gzipIndex) {
        if (!entry.headerCache) {
          const { header } = await this.loadFileData(entry);
          if (!header) { res.writeHead(500); res.end('Failed to parse header'); return; }
        }
        const header = entry.headerCache;
        const { nx, ny, nz, voxOffset, bytesPerVoxel } = header;

        try {
          let sliceStart: number;
          let sliceSize: number;

          if (axis === 'axial') {
            sliceStart = voxOffset + idx * nx * ny * bytesPerVoxel;
            sliceSize = nx * ny * bytesPerVoxel;
          } else if (axis === 'coronal') {
            sliceStart = voxOffset + idx * nx * bytesPerVoxel;
            sliceSize = nx * bytesPerVoxel;
          } else {
            sliceStart = voxOffset + idx * bytesPerVoxel;
            sliceSize = bytesPerVoxel;
          }

          if (axis === 'axial') {
            const sliceBytes = await GzipIndex.readRange(fsPath, entry.gzipIndex, sliceStart, sliceStart + sliceSize);
            const slice = extractAxialSliceFromRange(sliceBytes, header);
            const buf = Buffer.from(slice.buffer, slice.byteOffset, slice.byteLength);
            entry.sliceCache?.set(cacheKey, { data: buf, timestamp: Date.now() });
            compressResponse(buf, req, res, 'application/octet-stream');
            return;
          }

          if (axis === 'coronal') {
            const slice = new Float32Array(nx * nz);
            const bpv = Math.max(1, header.bitpix / 8);
            const le = header.littleEndian;
            const slope = header.scl_slope || 1;
            const inter = header.scl_inter || 0;
            for (let z = 0; z < nz; z++) {
              const rowOffset = voxOffset + (z * ny * nx + idx * nx) * bytesPerVoxel;
              const rowBytes = await GzipIndex.readRange(fsPath, entry.gzipIndex, rowOffset, rowOffset + nx * bpv);
              const view = new DataView(rowBytes.buffer, rowBytes.byteOffset, rowBytes.byteLength);
              for (let x = 0; x < nx; x++) {
                const off = x * bpv;
                let val: number;
                switch (header.datatype) {
                  case 2: val = rowBytes[off]; break;
                  case 4: val = view.getInt16(off, le); break;
                  case 8: val = view.getInt32(off, le); break;
                  case 16: val = view.getFloat32(off, le); break;
                  case 64: val = view.getFloat64(off, le); break;
                  case 256: val = (rowBytes[off] << 24) >> 24; break;
                  case 512: val = view.getUint16(off, le); break;
                  case 768: val = view.getUint32(off, le); break;
                  default: val = 0;
                }
                slice[z * nx + x] = val * slope + inter;
              }
            }
            const buf = Buffer.from(slice.buffer, slice.byteOffset, slice.byteLength);
            entry.sliceCache?.set(cacheKey, { data: buf, timestamp: Date.now() });
            compressResponse(buf, req, res, 'application/octet-stream');
            return;
          }

          {
            const slice = new Float32Array(ny * nz);
            const bpv = Math.max(1, header.bitpix / 8);
            const le = header.littleEndian;
            const slope = header.scl_slope || 1;
            const inter = header.scl_inter || 0;
            for (let z = 0; z < nz; z++) {
              const axialOffset = voxOffset + z * nx * ny * bytesPerVoxel;
              const axialBytes = await GzipIndex.readRange(fsPath, entry.gzipIndex, axialOffset, axialOffset + nx * ny * bpv);
              const view = new DataView(axialBytes.buffer, axialBytes.byteOffset, axialBytes.byteLength);
              for (let y = 0; y < ny; y++) {
                const off = (y * nx + idx) * bpv;
                let val: number;
                switch (header.datatype) {
                  case 2: val = axialBytes[off]; break;
                  case 4: val = view.getInt16(off, le); break;
                  case 8: val = view.getInt32(off, le); break;
                  case 16: val = view.getFloat32(off, le); break;
                  case 64: val = view.getFloat64(off, le); break;
                  case 256: val = (axialBytes[off] << 24) >> 24; break;
                  case 512: val = view.getUint16(off, le); break;
                  case 768: val = view.getUint32(off, le); break;
                  default: val = 0;
                }
                slice[z * ny + y] = val * slope + inter;
              }
            }
            const buf = Buffer.from(slice.buffer, slice.byteOffset, slice.byteLength);
            entry.sliceCache?.set(cacheKey, { data: buf, timestamp: Date.now() });
            compressResponse(buf, req, res, 'application/octet-stream');
            return;
          }
        } catch {
          // fall through to full decompression path
        }
      }

      if (fsPath && isGzip && !entry.gzipIndex && !entry.gzipIndexBuilding) {
        entry.gzipIndexBuilding = true;
        // Try loading cached index first, then build if needed
        loadCachedIndex(fsPath).then(cachedIdx => {
          if (cachedIdx) {
            entry.gzipIndex = cachedIdx;
            entry.gzipIndexBuilding = false;
          } else {
            GzipIndex.buildIndex(fsPath).then(idx => {
              entry.gzipIndex = idx;
              entry.gzipIndexBuilding = false;
              saveCachedIndex(fsPath, idx).catch(() => {});
            }).catch(() => {
              entry.gzipIndexBuilding = false;
            });
          }
        }).catch(() => {
          GzipIndex.buildIndex(fsPath).then(idx => {
            entry.gzipIndex = idx;
            entry.gzipIndexBuilding = false;
            saveCachedIndex(fsPath, idx).catch(() => {});
          }).catch(() => {
            entry.gzipIndexBuilding = false;
          });
        });
      }

      const uriStr = entry.uri.toString();
      const isHttpRemote = entry.uri.scheme === 'http' || entry.uri.scheme === 'https';

      if (isHttpRemote && !isGzip) {
        if (!entry.headerCache) {
          try {
            const headerBytes = await readHttpPartial(uriStr, 0, 543);
            const header = parseNiiHeaderQuick(headerBytes);
            if (!header) { res.writeHead(500); res.end('Failed to parse header'); return; }
            entry.headerCache = header;
          } catch {
            res.writeHead(500); res.end('Failed to fetch header via HTTP Range'); return;
          }
        }
        const header = entry.headerCache;
        const { nx, ny, voxOffset, bytesPerVoxel } = header;

        try {
          if (axis === 'axial') {
            const sliceStart = voxOffset + idx * nx * ny * bytesPerVoxel;
            const sliceEnd = sliceStart + nx * ny * bytesPerVoxel - 1;
            const sliceBytes = await readHttpPartial(uriStr, sliceStart, sliceEnd);
            const slice = extractAxialSliceFromRange(sliceBytes, header);
            const buf = Buffer.from(slice.buffer, slice.byteOffset, slice.byteLength);
            entry.sliceCache?.set(cacheKey, { data: buf, timestamp: Date.now() });
            compressResponse(buf, req, res, 'application/octet-stream');
            return;
          }

          // Coronal/sagittal slices access scattered voxels across many axial
          // slices. Serving them with one tiny Range request per z-row causes
          // massive round-trip overhead on remote files. Instead, fetch the
          // full volume once using parallel chunked ranges and extract locally.
          // Subsequent slice requests are then served from entry.dataCache.
          const { rawData } = await this.loadFileData(entry);
          const slice = extractSingleSlice(rawData, header, axis, idx);
          if (!slice) {
            res.writeHead(404); res.end('Slice not found'); return;
          }
          const buf = Buffer.from(slice.buffer, slice.byteOffset, slice.byteLength);
          entry.sliceCache?.set(cacheKey, { data: buf, timestamp: Date.now() });
          compressResponse(buf, req, res, 'application/octet-stream');
          return;
        } catch {
          res.writeHead(500); res.end('Failed to fetch slice via HTTP Range'); return;
        }
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
      entry.sliceCache?.set(cacheKey, { data: buf, timestamp: Date.now() });

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

  public async loadFileData(entry: FileEntry, signal?: AbortSignal): Promise<{ rawData: Uint8Array; header: any }> {
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
    const isHttpRemote = entry.uri.scheme === 'http' || entry.uri.scheme === 'https';

    entry.pendingLoad = (async () => {
      try {
        let header: any;
        let rawData: Uint8Array;

        if (isLocal && isGzip) {
          if (entry.dataCache) {
            rawData = entry.dataCache;
            header = entry.headerCache || parseNiiHeaderQuick(rawData);
          } else {
            const fullData = await vscode.workspace.fs.readFile(entry.uri);
            if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
            const decompressed = await gunzipAsync(fullData, signal);
            rawData = decompressed;
            header = parseNiiHeaderQuick(rawData);
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
          // Remote gzip files benefit from parallel compressed download followed
          // by local decompression, which is faster than a single HTTP stream on
          // high-bandwidth or high-latency links.
          if (entry.dataCache) {
            rawData = entry.dataCache;
          } else {
            let compressed: Uint8Array;
            if (isHttpRemote) {
              let compressedSize = entry.size;
              if (!compressedSize) {
                compressedSize = await this.getHttpRemoteSize(entry.uri.toString());
                entry.size = compressedSize;
              }
              compressed = await this.downloadHttpFileInChunks(entry.uri.toString(), compressedSize, signal);
            } else {
              const fullData = await vscode.workspace.fs.readFile(entry.uri);
              compressed = new Uint8Array(fullData.buffer, fullData.byteOffset, fullData.byteLength);
            }
            if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
            const decompressed = await gunzipAsync(compressed, signal);
            rawData = decompressed;
            entry.dataCache = rawData;
          }
          header = entry.headerCache || parseNiiHeaderQuick(rawData);
        } else if (isHttpRemote) {
          // Remote uncompressed HTTP(S) file: use parallel Range requests
          // to saturate bandwidth instead of a single sequential read.
          if (entry.dataCache) {
            rawData = entry.dataCache;
          } else {
            let totalSize = entry.size;
            if (!totalSize) {
              totalSize = await this.getHttpRemoteSize(entry.uri.toString());
              entry.size = totalSize;
            }
            rawData = await this.downloadHttpFileInChunks(entry.uri.toString(), totalSize, signal);
            entry.dataCache = rawData;
          }
          header = entry.headerCache || parseNiiHeaderQuick(rawData);
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
    const uriStr = entry.uri.toString();
    const isGzip = fsPath ? fsPath.endsWith('.gz') : uriStr.endsWith('.gz');
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
        const coMid = Math.floor(ny / 2);
        const saMid = Math.floor(nx / 2);
        const sliceStart = voxOffset + axMid * nx * ny * bytesPerVoxel;
        const sliceEnd = sliceStart + nx * ny * bytesPerVoxel;

        // Extract all three preview slices in parallel for local .nii files
        const [axialSlice, coronalSlice, sagittalSlice] = await Promise.all([
          readLocalFilePartial(fsPath!, sliceStart, sliceEnd - 1)
            .then(bytes => extractAxialSliceFromRange(bytes, header)),
          extractCoronalSliceFromRange(fsPath!, header, coMid)
            .catch(() => new Float32Array(nx * nz)),
          extractSagittalSliceFromRange(fsPath!, header, saMid)
            .catch(() => new Float32Array(ny * nz)),
        ]);

        let min = Infinity, max = -Infinity;
        for (const s of [axialSlice, coronalSlice, sagittalSlice]) {
          for (let i = 0; i < s.length; i++) {
            if (s[i] < min) min = s[i];
            if (s[i] > max) max = s[i];
          }
        }

        return {
          header,
          slices: { axial: axialSlice, coronal: coronalSlice, sagittal: sagittalSlice },
          globalMin: min, globalMax: max,
          sliceIdx: { axial: axMid, coronal: coMid, sagittal: saMid },
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
          // streamingGunzipPreview now returns z=0 slice for instant preview
          sliceIdx: { axial: 0, coronal: Math.floor(ny / 2), sagittal: Math.floor(nx / 2) },
          slope: header.scl_slope || 1, inter: header.scl_inter || 0,
          partialPreview: true,
        };
      }

      // HTTP remote URI: use HTTP Range requests to fetch only the header + middle axial slice
      const isHttpRemote = entry.uri.scheme === 'http' || entry.uri.scheme === 'https';
      if (isHttpRemote) {
        if (isGzip) {
          try {
            const { header, axialSlice } = await streamingHttpGunzipPreview(uriStr, signal);
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
              // streamingHttpGunzipPreview now returns z=0 slice for instant preview
              sliceIdx: { axial: 0, coronal: Math.floor(ny / 2), sagittal: Math.floor(nx / 2) },
              slope: header.scl_slope || 1, inter: header.scl_inter || 0,
              partialPreview: true,
            };
          } catch {
            // Fall through to full download
          }
        } else {
          try {
            const headerBytes = await readHttpPartial(uriStr, 0, 543);
            const header = parseNiiHeaderQuick(headerBytes);
            if (!header) return null;
            entry.headerCache = header;

            const { nx, ny, nz, voxOffset, bytesPerVoxel } = header;
            // Use z=0 slice for instant preview (right after header)
            const sliceStart = voxOffset;
            const sliceEnd = voxOffset + nx * ny * bytesPerVoxel - 1;
            const sliceBytes = await readHttpPartial(uriStr, sliceStart, sliceEnd);
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
              sliceIdx: { axial: 0, coronal: Math.floor(ny / 2), sagittal: Math.floor(nx / 2) },
              slope: header.scl_slope || 1, inter: header.scl_inter || 0,
              partialPreview: true,
            };
          } catch {
            // Fall through to full download
          }
        }
      }

      // Non-HTTP remote URIs (e.g. vscode-remote://): fall back to full download
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

/**
 * Parse the `factor` query parameter from a request path.
 * Returns 4 if the parameter is missing or invalid.
 */
function parseFactorFromPath(path: string): number {
  const qIdx = path.indexOf('?');
  if (qIdx < 0) return 4;
  const params = new URLSearchParams(path.slice(qIdx + 1));
  const f = parseInt(params.get('factor') || '4', 10);
  return Number.isFinite(f) ? f : 4;
}

/**
 * Adapter that wraps an HTTP/2 ServerHttp2Stream to provide the same
 * interface as http.ServerResponse, so existing handler methods work
 * without modification for both HTTP/1.1 and HTTP/2.
 */
class Http2ResponseAdapter extends (require('http').ServerResponse as any) {
  private stream: http2.ServerHttp2Stream;
  private extraHeaders: Record<string, string>;
  private responded = false;
  private statusCode = 200;
  private statusMessage = 'OK';
  private headersSent = false;
  private storedHeaders: Record<string, string | string[]> = {};

  constructor(stream: http2.ServerHttp2Stream, extraHeaders: Record<string, string> = {}) {
    super({ /* fake socket to satisfy ServerResponse constructor */ });
    this.stream = stream;
    this.extraHeaders = extraHeaders;
  }

  setHeader(name: string, value: string | string[]): this {
    this.storedHeaders[name] = value;
    return this;
  }

  getHeader(name: string): string | string[] | undefined {
    return this.storedHeaders[name];
  }

  writeHead(statusCode: number, headers?: Record<string, string | string[]>): this {
    this.statusCode = statusCode;
    if (headers) {
      for (const [k, v] of Object.entries(headers)) {
        this.storedHeaders[k] = v;
      }
    }
    this.responded = true;
    return this;
  }

  end(data?: any, encoding?: any, callback?: any): this {
    if (!this.headersSent) {
      this.flushHeaders();
    }
    if (data !== undefined) {
      this.stream.end(data);
    } else {
      this.stream.end();
    }
    return this;
  }

  write(data: any, encoding?: any, callback?: any): boolean {
    if (!this.headersSent) {
      this.flushHeaders();
    }
    return this.stream.write(data);
  }

  private flushHeaders(): void {
    if (this.headersSent) return;
    const h2Headers: http2.OutgoingHttpHeaders = {
      ':status': this.statusCode,
    };
    for (const [k, v] of Object.entries(this.extraHeaders)) {
      h2Headers[k] = v;
    }
    for (const [k, v] of Object.entries(this.storedHeaders)) {
      h2Headers[k] = v;
    }
    this.stream.respond(h2Headers);
    this.headersSent = true;
  }

  get finished(): boolean {
    return this.stream.destroyed || this.stream.writableEnded;
  }
}
