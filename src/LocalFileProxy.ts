import * as http from 'http';
import * as https from 'https';
import * as fs from 'fs';
import * as zlib from 'zlib';
import * as vscode from 'vscode';
import { VolumeCache } from './VolumeCache';
import { parseNiiHeaderQuick, timepointByteOffset } from './nifti/headerParser';
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
} from './io/compression';
import { GzipIndex } from './io/gzipIndex';
import {
  GzipScanSession,
  extractStridedVolumeFromIndex,
  extractSliceFromGzipIndex,
  type GzipOrthoPreview,
} from './io/gzipScan';
import { isWanRemote } from './remoteEnv';

interface FileEntry {
  uri: vscode.Uri;
  dataUri: vscode.Uri;
  separateImg: boolean;
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
  gzipScan?: GzipScanSession;
  unpackPath?: string;
}

interface ConnectionStats {
  protocol: 'h2' | 'http/1.1';
  activeStreams: number;
  totalRequests: number;
  pushedSlices: number;
}

interface PrioritizedRequest {
  priority: number;
  preemptible?: boolean;
  execute: () => Promise<void>;
}

const REQUEST_PRIORITY = {
  header: 100,
  preview: 90,
  previewBin: 90,
  slice: 80,
  previewVolume: 40,
  lod: 20,
  file: 10,
  stats: 0,
} as const;

export class LocalFileProxy {
  private server: http.Server | null = null;
  private port = 0;
  private files = new Map<string, FileEntry>();
  private idCounter = 0;
  private cleanupInterval: NodeJS.Timeout | null = null;
  private volumeCache: VolumeCache | null;
  private stats: ConnectionStats = { protocol: 'http/1.1', activeStreams: 0, totalRequests: 0, pushedSlices: 0 };
  private recentSliceRequests = new Map<string, number>(); // key -> timestamp
  private priorityQueue: PrioritizedRequest[] = [];
  private activeStreamCount = 0;
  private inflightFileStreams = new Set<{ destroy: () => void; background: boolean }>();

  constructor(volumeCache?: VolumeCache) {
    this.volumeCache = volumeCache || null;
  }

  async start(): Promise<void> {
    const maxRetries = 3;
    const configuredPort = vscode.workspace.getConfiguration('niftispy').get<number>('proxyPort', 0);
    let tryPort = configuredPort;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const server = await new Promise<http.Server>((resolve, reject) => {
          // HTTP/1.1 only: browser fetch() cannot speak cleartext HTTP/2
          // (h2c is unsupported in Chromium), so an http2.createServer()
          // would reject every webview request with a protocol error.
          const createdServer = http.createServer(this.handleRequest.bind(this) as any);
          this.stats.protocol = 'http/1.1';

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

  registerFile(uri: vscode.Uri, dataUri?: vscode.Uri): string {
    const id = String(this.idCounter++);
    const data = dataUri || uri;
    this.files.set(id, {
      uri,
      dataUri: data,
      separateImg: data.toString() !== uri.toString(),
      id,
      sliceCache: new Map(),
      lodCache: new Map(),
    });
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

  /** Start a single gzip inflate that builds the random-access index. */
  startGzipIndex(entryId: string, onProgress?: (pct: number) => void): void {
    const entry = this.files.get(entryId);
    if (entry) this.ensureGzipScan(entry, onProgress);
  }

  whenGzipOrthoReady(entryId: string): Promise<GzipOrthoPreview | null> {
    const entry = this.files.get(entryId);
    const session = entry ? this.ensureGzipScan(entry) : null;
    if (!session) return Promise.resolve(null);
    return session.ortho.catch(() => null);
  }

  whenGzipIndexReady(entryId: string): Promise<GzipIndex | null> {
    const entry = this.files.get(entryId);
    const session = entry ? this.ensureGzipScan(entry) : null;
    if (!session) return Promise.resolve(null);
    return session.done;
  }

  private ensureGzipScan(entry: FileEntry, onProgress?: (pct: number) => void): GzipScanSession | null {
    const fsPath = entry.uri.fsPath;
    if (!fsPath || !fsPath.endsWith('.gz')) return null;
    if (entry.gzipScan) return entry.gzipScan;
    const session = GzipScanSession.start(fsPath, undefined, onProgress);
    entry.gzipScan = session;
    void session.done.then(idx => {
      if (idx) entry.gzipIndex = idx;
      if (session.unpackPath) entry.unpackPath = session.unpackPath;
    });
    void session.z0.then(preview => {
      if (preview.header) entry.headerCache = preview.header;
    }).catch(() => {});
    return session;
  }

  private readonly maxConcurrentRequests = 32;
  private activeRequests = 0;

  private headerPath(entry: FileEntry): string {
    return entry.uri.fsPath;
  }

  private dataPath(entry: FileEntry): string {
    return (entry.dataUri || entry.uri).fsPath;
  }

  private parseEntryHeader(entry: FileEntry, bytes: Uint8Array): any | null {
    return parseNiiHeaderQuick(bytes, { separateImg: !!entry.separateImg });
  }

  private enqueueRequest(priority: number, execute: () => Promise<void>, opts?: { preemptible?: boolean }): void {
    if (priority > REQUEST_PRIORITY.file) this.pauseBackgroundFileLoads();
    // Binary insert into sorted array — O(log n) instead of O(n log n) sort
    let lo = 0, hi = this.priorityQueue.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.priorityQueue[mid].priority > priority) lo = mid + 1;
      else hi = mid;
    }
    this.priorityQueue.splice(lo, 0, { priority, execute, preemptible: opts?.preemptible });
    this.processPriorityQueue();
  }

  private pauseBackgroundFileLoads(): void {
    for (const handle of [...this.inflightFileStreams]) {
      if (handle.background) handle.destroy();
    }
    this.priorityQueue = this.priorityQueue.filter(job => !job.preemptible);
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

  getStats(): ConnectionStats {
    return { ...this.stats, activeStreams: this.activeStreamCount };
  }

  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    const _req = req as http.IncomingMessage;
    const _res = res as http.ServerResponse;

    _res.setHeader('Access-Control-Allow-Origin', '*');
    _res.setHeader('Access-Control-Allow-Headers', 'Range, Accept-Encoding, X-NiftiSpy-Priority');
    _res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges, Content-Encoding, X-Remote-Source');
    _res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    _res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    _res.setHeader('Connection', 'keep-alive');
    _res.setHeader('Keep-Alive', 'timeout=30, max=100');
    // Only SSH / Codespaces / Tunnels pay a real RTT on 127.0.0.1: the
    // Worker keys chunk size off this flag. WSL and Dev Containers are
    // loopback-class and must not be marked remote.
    if (isWanRemote()) {
      _res.setHeader('X-Remote-Source', 'true');
    }

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

    const rawUrl = _req.url || '';
    const qIndex = rawUrl.indexOf('?');
    const pathname = qIndex >= 0 ? rawUrl.slice(0, qIndex) : rawUrl;
    const query = qIndex >= 0 ? new URLSearchParams(rawUrl.slice(qIndex + 1)) : new URLSearchParams();

    const headerMatch = pathname.match(/^\/header\/(\d+)$/);
    const previewMatch = pathname.match(/^\/preview\/(\d+)$/);
    const previewBinMatch = pathname.match(/^\/preview-bin\/(\d+)$/);
    const previewVolumeMatch = pathname.match(/^\/preview-volume\/(\d+)/);
    const previewOrthoMatch = pathname.match(/^\/preview-ortho\/(\d+)$/);
    const metaMatch = pathname.match(/^\/meta\/(\d+)$/);
    const sliceMatch = pathname.match(/^\/slice\/(\d+)\/(axial|coronal|sagittal)\/(\d+)$/);
    const lodMatch = pathname.match(/^\/lod\/(\d+)\/(\d+)$/);
    const fileMatch = pathname.match(/^\/file\/(\d+)$/);
    const match = headerMatch || previewMatch || previewBinMatch || previewVolumeMatch || previewOrthoMatch || metaMatch || sliceMatch || lodMatch || fileMatch;
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
      : previewOrthoMatch ? REQUEST_PRIORITY.preview
      : metaMatch ? REQUEST_PRIORITY.header
      : sliceMatch ? REQUEST_PRIORITY.slice
      : lodMatch ? REQUEST_PRIORITY.lod
      : REQUEST_PRIORITY.file;

    const backgroundFile = !!fileMatch && String(_req.headers['x-niftispy-priority'] || '').toLowerCase() === 'background';
    this.enqueueRequest(priority, async () => {
      try {
        if (headerMatch) {
          await this.handleHeader(entry, _res, _req);
          return;
        }
        if (metaMatch) {
          this.handleGzipMeta(entry, _res);
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
        if (previewOrthoMatch) {
          await this.handlePreviewOrtho(entry, _res, _req);
          return;
        }
        if (previewVolumeMatch) {
          const factor = parseFactorFromPath(_req.url || '');
          await this.handlePreviewVolume(entry, factor, _res, _req);
          return;
        }
        if (sliceMatch) {
          const timeIdx = parseInt(query.get('t') || '0', 10) || 0;
          await this.handleSlice(entry, sliceMatch[2], parseInt(sliceMatch[3], 10), _res, _req, timeIdx);
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
    }, { preemptible: backgroundFile });
  }

  private async handleFile(entry: FileEntry, res: http.ServerResponse, req: http.IncomingMessage): Promise<void> {
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
      await this.streamHttpRangeToResponse(fileUri.toString(), rangeHeader, res, entry, req, background);
      return;
    }

    // ── Remote full-file GET: stream directly without buffering ──
    if (isHttpRemote && method === 'GET' && !rangeHeader) {
      await this.streamHttpToResponse(fileUri.toString(), res, entry, req, background);
      return;
    }

    // ── HEAD: answer with cached size or do one HEAD to the remote ──
    if (method === 'HEAD') {
      if (!entry.size) {
        if (isHttpRemote) {
          try { entry.size = await this.getHttpRemoteSize(fileUri.toString()); } catch { /* unknown */ }
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
        await this.pipeLocalFile(req, res, stream, background);
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
        await this.pipeLocalFile(req, res, stream, background);
      } else if (fsPath && shouldCompress) {
        res.writeHead(200, {
          'Content-Encoding': 'gzip',
          'Accept-Ranges': 'bytes',
          'Content-Type': 'application/octet-stream',
        });
        const stream = fs.createReadStream(fsPath);
        const gzip = zlib.createGzip({ level: 1 });
        stream.pipe(gzip);
        await this.pipeLocalFile(req, res, gzip, background, stream);
      } else {
        entry.lastAccess = Date.now();
        if (!entry.dataCache) {
          entry.dataCache = await vscode.workspace.fs.readFile(fileUri);
        }
        compressResponse(Buffer.from(entry.dataCache), req, res, 'application/octet-stream', { 'Accept-Ranges': 'bytes' });
      }
    }
  }

  private pipeLocalFile(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    stream: NodeJS.ReadableStream,
    background: boolean,
    extra?: { destroy: () => void },
  ): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        this.inflightFileStreams.delete(handle);
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
      this.inflightFileStreams.add(handle);
      req.on('close', destroy);
      stream.on('error', finish);
      res.on('finish', finish);
      res.on('close', finish);
      stream.pipe(res);
    });
  }

  private trackHttpAbort(
    clientReq: http.IncomingMessage | undefined,
    remoteReq: { destroy: () => void },
    background: boolean,
  ): () => void {
    const destroy = () => {
      try { remoteReq.destroy(); } catch { /* already closed */ }
    };
    const handle = { destroy, background };
    this.inflightFileStreams.add(handle);
    clientReq?.on('close', destroy);
    return () => this.inflightFileStreams.delete(handle);
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

  private streamHttpRangeToResponse(
    url: string,
    rangeHeader: string,
    res: http.ServerResponse,
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
      untrack = this.trackHttpAbort(clientReq, request, background);
      request.on('error', (err) => { untrack(); reject(err); });
      request.setTimeout(30000, () => { request.destroy(); untrack(); reject(new Error('Range request timeout')); });
      request.end();
    });
  }

  private streamHttpToResponse(
    url: string,
    res: http.ServerResponse,
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
      untrack = this.trackHttpAbort(clientReq, request, background);
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
        const session = this.ensureGzipScan(entry);
        if (session) {
          await session.z0.catch(() => null);
          if (entry.headerCache) {
            compressResponse(Buffer.from(JSON.stringify(entry.headerCache)), req, res, 'application/json');
            return;
          }
          const idx = entry.gzipIndex || await session.done;
          if (idx && fsPath) {
            const headerBytes = await GzipIndex.readRange(fsPath, idx, 0, 544);
            const header = this.parseEntryHeader(entry, headerBytes);
            if (header) {
              entry.headerCache = header;
              compressResponse(Buffer.from(JSON.stringify(header)), req, res, 'application/json');
              return;
            }
          }
          const unpack = entry.unpackPath || session.unpackPath;
          if (unpack) {
            const headerBytes = await readLocalFilePartial(unpack, 0, 543);
            const header = this.parseEntryHeader(entry, headerBytes);
            if (header) {
              entry.headerCache = header;
              compressResponse(Buffer.from(JSON.stringify(header)), req, res, 'application/json');
              return;
            }
          }
        }
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

      const header = this.parseEntryHeader(entry, headerBytes);
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
    const headerFs = this.headerPath(entry);
    const dataFs = this.dataPath(entry);

    if (!entry.headerCache) {
      const headerBytes = await readLocalFilePartial(headerFs, 0, 543);
      const header = this.parseEntryHeader(entry, headerBytes);
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

  private handleGzipMeta(entry: FileEntry, res: http.ServerResponse): void {
    const index = entry.gzipIndex || entry.gzipScan?.index || null;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      indexReady: !!index,
      indexEntries: index?.entries.length ?? 0,
    }));
  }

  private async handlePreviewOrtho(entry: FileEntry, res: http.ServerResponse, req: http.IncomingMessage): Promise<void> {
    const session = this.ensureGzipScan(entry);
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

  private async handlePreviewLocalGz(entry: FileEntry, res: http.ServerResponse, req: http.IncomingMessage): Promise<void> {
    const fsPath = entry.uri.fsPath!;
    const session = this.ensureGzipScan(entry);
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
      let min = Infinity, max = -Infinity;
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
        const header = this.parseEntryHeader(entry, headerBytes);
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

      const fsPath = entry.uri.fsPath;
      if (fsPath && fsPath.endsWith('.gz')) {
        await this.handlePreviewLocalGz(entry, res, req);
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

  private sendPreviewVolumeBuffer(
    loHeader: any,
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
    const buf = Buffer.alloc(4 + headerBuf.length + 4 * 7 + voxelBuf.length);
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
      // Slow links (VPN) may request up to 32 (≈3% of the compressed
      // stream) so the first preview lands in seconds instead of minutes.
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
              const session = this.ensureGzipScan(entry);
              const index = entry.gzipIndex || (session ? await session.done : null);
              const lod = session?.lod;
              if (lod && lod.factor === f) {
                this.sendPreviewVolumeBuffer(
                  lod.header, lod.volume, f, lod.outNx, lod.outNy, lod.outNz,
                  lod.min, lod.max, lod.header.scl_slope || 1, lod.header.scl_inter || 0,
                  req, res,
                );
                return;
              }
              if (index) {
                const indexed = await extractStridedVolumeFromIndex(fsPath, index, f, ac.signal);
                this.sendPreviewVolumeBuffer(
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
          const header = this.parseEntryHeader(entry, headerBytes);
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

      // If the full volume is already in the proxy-side VolumeCache (e.g. the
      // user viewed this file before and it hasn't been evicted), subsample
      // directly from the cached decoded voxel data.  This avoids 16 fresh
      // HTTP Range requests and DataView decoding — pure memory copy, ~100x
      // faster for a cached remote file.
      let cachedVolume: { voxelData: any; min: number; max: number } | null = null;
      if (isHttpRemote && this.volumeCache) {
        const cv = this.volumeCache.get(uriStr);
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

  private async handleSlice(entry: FileEntry, axis: string, idx: number, res: http.ServerResponse, req: http.IncomingMessage, timeIdx = 0): Promise<void> {
    try {
      const cacheKey = `${entry.id}:${axis}:${idx}:${timeIdx}`;
      const cached = entry.sliceCache?.get(cacheKey);
      if (cached) {
        compressResponse(cached.data, req, res, 'application/octet-stream');
        return;
      }

      const headerFs = this.headerPath(entry);
      const dataFs = entry.unpackPath || this.dataPath(entry);
      const isGzip = !entry.unpackPath && (dataFs ? dataFs.endsWith('.gz') : (entry.dataUri || entry.uri).toString().endsWith('.gz'));

      const reply = (slice: Float32Array) => {
        const buf = Buffer.from(slice.buffer, slice.byteOffset, slice.byteLength);
        entry.sliceCache?.set(cacheKey, { data: buf, timestamp: Date.now() });
        compressResponse(buf, req, res, 'application/octet-stream');
      };

      if (dataFs && !isGzip) {
        if (!entry.headerCache) {
          const headerReadPath = entry.unpackPath || headerFs || dataFs;
          const headerBytes = await readLocalFilePartial(headerReadPath, 0, 543);
          const header = this.parseEntryHeader(entry, headerBytes);
          if (!header) {
            res.writeHead(500);
            res.end('Failed to parse header');
            return;
          }
          entry.headerCache = header;
        }
        const header = entry.headerCache;
        const { nx, ny, voxOffset, bytesPerVoxel } = header;
        const tOff = timepointByteOffset(header, timeIdx);

        if (axis === 'axial') {
          const sliceStart = voxOffset + tOff + idx * nx * ny * bytesPerVoxel;
          const sliceSize = nx * ny * bytesPerVoxel;
          const sliceBytes = await readLocalFilePartial(dataFs, sliceStart, sliceStart + sliceSize - 1);
          reply(extractAxialSliceFromRange(sliceBytes, header));
          return;
        } else if (axis === 'coronal') {
          const slice = await extractCoronalSliceFromRange(dataFs, header, idx, timeIdx);
          if (!slice) { res.writeHead(404); res.end('Slice not found'); return; }
          reply(slice);
          return;
        } else {
          const slice = await extractSagittalSliceFromRange(dataFs, header, idx, timeIdx);
          if (!slice) { res.writeHead(404); res.end('Slice not found'); return; }
          reply(slice);
          return;
        }
      }

      if (dataFs && isGzip) {
        const session = this.ensureGzipScan(entry);
        if (!entry.gzipIndex && session) {
          const built = await session.done;
          if (built) entry.gzipIndex = built;
          if (session.unpackPath) entry.unpackPath = session.unpackPath;
        }
      }

      if (entry.unpackPath) {
        return this.handleSlice(entry, axis, idx, res, req, timeIdx);
      }

      if (dataFs && isGzip && entry.gzipIndex) {
        if (!entry.headerCache) {
          const headerBytes = await GzipIndex.readRange(dataFs, entry.gzipIndex, 0, 544);
          const header = this.parseEntryHeader(entry, headerBytes);
          if (!header) { res.writeHead(500); res.end('Failed to parse header'); return; }
          entry.headerCache = header;
        }
        try {
          const slice = await extractSliceFromGzipIndex(dataFs, entry.gzipIndex, entry.headerCache, axis, idx, timeIdx);
          if (!slice) { res.writeHead(404); res.end('Slice not found'); return; }
          reply(slice);
          return;
        } catch {
          // fall through to full decompression path
        }
      }

      if (dataFs && isGzip && !entry.gzipIndex) {
        this.ensureGzipScan(entry);
      }

      const fileUri = entry.dataUri || entry.uri;
      const uriStr = fileUri.toString();
      const isHttpRemote = fileUri.scheme === 'http' || fileUri.scheme === 'https';

      if (isHttpRemote && !isGzip) {
        if (!entry.headerCache) {
          try {
            const headerUri = entry.uri.toString();
            const headerBytes = await readHttpPartial(headerUri, 0, 543);
            const header = this.parseEntryHeader(entry, headerBytes);
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
          const { rawData } = await this.loadFileData(entry);
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

      const { rawData, header } = await this.loadFileData(entry);
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

    const fileUri = entry.dataUri || entry.uri;
    const fsPath = fileUri.fsPath;
    const isGzip = fsPath ? fsPath.endsWith('.gz') : fileUri.toString().endsWith('.gz');
    const isLocal = !!fsPath;
    const isHttpRemote = fileUri.scheme === 'http' || fileUri.scheme === 'https';

    entry.pendingLoad = (async () => {
      try {
        let header: any;
        let rawData: Uint8Array;

        if (entry.separateImg) {
          const headerData = await vscode.workspace.fs.readFile(entry.uri);
          header = this.parseEntryHeader(entry, new Uint8Array(headerData.buffer, headerData.byteOffset, headerData.byteLength));
          const fullData = await vscode.workspace.fs.readFile(fileUri);
          rawData = new Uint8Array(fullData.buffer, fullData.byteOffset, fullData.byteLength);
          entry.headerCache = header;
          entry.dataCache = rawData;
        } else if (isLocal && isGzip) {
          if (entry.dataCache) {
            rawData = entry.dataCache;
            header = entry.headerCache || this.parseEntryHeader(entry, rawData);
          } else {
            const fullData = await vscode.workspace.fs.readFile(fileUri);
            if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
            const decompressed = await gunzipAsync(fullData, signal);
            rawData = decompressed;
            header = this.parseEntryHeader(entry, rawData);
            entry.dataCache = rawData;
          }
        } else if (isLocal && !isGzip) {
          if (entry.dataCache) {
            rawData = entry.dataCache;
          } else {
            const fullData = await vscode.workspace.fs.readFile(fileUri);
            rawData = new Uint8Array(fullData.buffer, fullData.byteOffset, fullData.byteLength);
            entry.dataCache = rawData;
          }
          header = entry.headerCache || this.parseEntryHeader(entry, rawData);
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
                compressedSize = await this.getHttpRemoteSize(fileUri.toString());
                entry.size = compressedSize;
              }
              compressed = await this.downloadHttpFileInChunks(fileUri.toString(), compressedSize, signal);
            } else {
              const fullData = await vscode.workspace.fs.readFile(fileUri);
              compressed = new Uint8Array(fullData.buffer, fullData.byteOffset, fullData.byteLength);
            }
            if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
            const decompressed = await gunzipAsync(compressed, signal);
            rawData = decompressed;
            entry.dataCache = rawData;
          }
          header = entry.headerCache || this.parseEntryHeader(entry, rawData);
        } else if (isHttpRemote) {
          // Remote uncompressed HTTP(S) file: use parallel Range requests
          // to saturate bandwidth instead of a single sequential read.
          if (entry.dataCache) {
            rawData = entry.dataCache;
          } else {
            let totalSize = entry.size;
            if (!totalSize) {
              totalSize = await this.getHttpRemoteSize(fileUri.toString());
              entry.size = totalSize;
            }
            rawData = await this.downloadHttpFileInChunks(fileUri.toString(), totalSize, signal);
            entry.dataCache = rawData;
          }
          header = entry.headerCache || this.parseEntryHeader(entry, rawData);
        } else {
          const fullData = await vscode.workspace.fs.readFile(fileUri);
          if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
          rawData = new Uint8Array(fullData.buffer, fullData.byteOffset, fullData.byteLength);
          header = this.parseEntryHeader(entry, rawData);
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
          const header = this.parseEntryHeader(entry, headerBytes);
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
        const session = this.ensureGzipScan(entry);
        if (session) {
          const preview = await session.z0;
          if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
          entry.headerCache = preview.header;
          return {
            header: preview.header,
            slices: { axial: preview.axial, coronal: preview.coronal, sagittal: preview.sagittal },
            globalMin: preview.min, globalMax: preview.max,
            sliceIdx: preview.sliceIdx,
            slope: preview.slope, inter: preview.inter,
            partialPreview: true,
          };
        }
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
            const header = this.parseEntryHeader(entry, headerBytes);
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
