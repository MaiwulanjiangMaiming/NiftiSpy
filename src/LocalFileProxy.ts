import * as http from 'http';
import * as fs from 'fs';
import { randomBytes } from 'crypto';
import * as vscode from 'vscode';
import { VolumeCache } from './VolumeCache';
import { parseNiiHeaderQuick, type NiiHeader } from './nifti/headerParser';
import { errorMessage, isAbortError } from './errors';
import {
  extractAxialSliceFromRange,
  extractCoronalSliceFromRange,
  extractSagittalSliceFromRange,
  extractPreviewSlices,
} from './nifti/sliceExtractor';
import { computeSliceMinMax } from './nifti/previewEncoder';
import { readLocalFilePartial, readHttpPartial } from './io/fileReader';
import { compressResponse, gunzipAsync, streamingGunzipPreview, streamingHttpGunzipPreview } from './io/compression';
import { GzipIndex } from './io/gzipIndex';
import { GzipScanSession, type GzipOrthoPreview } from './io/gzipScan';
import { isWanRemote } from './remoteEnv';
import type { FileEntry } from './proxy/types';
import { handleFile, getHttpRemoteSize, downloadHttpFileInChunks, type HttpStreamContext } from './proxy/httpStream';
import { handleSlice, handleLOD, type SliceHost } from './proxy/slice';
import { handlePreviewVolume, type PreviewHost } from './proxy/preview';
import {
  handleGzipMeta,
  handlePreview,
  handlePreviewBinary,
  handlePreviewOrtho,
  type LocalPreviewHost,
} from './proxy/localPreview';

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
  /**
   * Capability token for every route. The webview is the only client and
   * receives the token in each registered URL; a local process or a website
   * scanning 127.0.0.1 cannot read volumes without it.
   */
  private readonly token = randomBytes(18).toString('base64url');
  private cleanupInterval: NodeJS.Timeout | null = null;
  private volumeCache: VolumeCache | null;
  private stats: ConnectionStats = { protocol: 'http/1.1', activeStreams: 0, totalRequests: 0, pushedSlices: 0 };
  private recentSliceRequests = new Map<string, number>(); // key -> timestamp
  private priorityQueue: PrioritizedRequest[] = [];
  private activeStreamCount = 0;
  private inflightFileStreams = new Set<{ destroy: () => void; background: boolean }>();
  private readonly httpCtx: HttpStreamContext = {
    inflightFileStreams: this.inflightFileStreams,
    remoteSizeCache: new Map<string, number>(),
  };
  private readonly sliceHost: SliceHost;
  private readonly previewHost: PreviewHost;
  private readonly localPreviewHost: LocalPreviewHost;

  constructor(
    volumeCache?: VolumeCache,
    /**
     * Optional per-request trace sink (route + status + latency). The webview
     * lives on another machine in Remote-SSH, so the only way to tell whether
     * a slice never arrived or arrived broken is to log it host-side.
     */
    private readonly accessLog?: (line: string) => void,
  ) {
    this.volumeCache = volumeCache || null;
    this.sliceHost = {
      headerPath: (entry) => this.headerPath(entry),
      dataPath: (entry) => this.dataPath(entry),
      parseEntryHeader: (entry, bytes) => this.parseEntryHeader(entry, bytes),
      ensureGzipScan: (entry, onProgress) => this.ensureGzipScan(entry, onProgress),
      loadFileData: (entry, signal) => this.loadFileData(entry, signal),
    };
    this.previewHost = {
      ensureGzipScan: (entry) => this.ensureGzipScan(entry),
      parseEntryHeader: (entry, bytes) => this.parseEntryHeader(entry, bytes),
      loadFileData: (entry, signal) => this.loadFileData(entry, signal),
      volumeCache: this.volumeCache,
    };
    this.localPreviewHost = {
      headerPath: (entry) => this.headerPath(entry),
      dataPath: (entry) => this.dataPath(entry),
      parseEntryHeader: (entry, bytes) => this.parseEntryHeader(entry, bytes),
      ensureGzipScan: (entry) => this.ensureGzipScan(entry),
      loadFileData: (entry, signal) => this.loadFileData(entry, signal),
    };
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
          const createdServer = http.createServer((req, res) => {
            void this.handleRequest(req, res);
          });
          this.stats.protocol = 'http/1.1';
          // Slice fetches pause while the user reads a plane. Keep the
          // forwarded socket alive instead of paying a new connection setup.
          createdServer.keepAliveTimeout = 30_000;
          createdServer.headersTimeout = 31_000;

          createdServer.on('error', (err: NodeJS.ErrnoException) => {
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
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE' && tryPort !== 0 && attempt < maxRetries) {
          tryPort = tryPort + 1;
          continue;
        }
        if (tryPort !== 0 && attempt >= maxRetries) {
          throw new Error(
            `NiftiSpy: Failed to start HTTP proxy after ${maxRetries} retries. Port ${configuredPort}–${tryPort} are all in use. Set niftispy.proxyPort to 0 for auto-assign.`,
          );
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

  registerFile(uri: vscode.Uri, dataUri?: vscode.Uri, hostHeader?: NiiHeader): string {
    const id = String(this.idCounter++);
    const data = dataUri || uri;
    let sourceStamp: string | undefined;
    try {
      const st = fs.statSync(data.fsPath);
      sourceStamp = `${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
    } catch {
      /* virtual FS: no local stamp */
    }
    this.files.set(id, {
      sourceStamp,
      uri,
      dataUri: data,
      separateImg: data.toString() !== uri.toString(),
      id,
      headerCache: hostHeader,
      hostHeader,
      sliceCache: new Map(),
      lodCache: new Map(),
    });
    return `http://127.0.0.1:${this.port}/${this.token}/file/${id}`;
  }

  getEntry(entryId: string): FileEntry | undefined {
    return this.files.get(entryId);
  }

  /**
   * Loopback URL the extension host itself can fetch. In Remote-SSH the
   * webview only reaches the proxy through VS Code's port forwarding, which
   * can be slow to establish or unavailable; the host always can.
   */
  internalFileUrl(entryId: string): string | null {
    if (!this.files.has(entryId)) return null;
    return `http://127.0.0.1:${this.port}/${this.token}/file/${entryId}`;
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

  subscribeGzipPreview(entryId: string, listener: (preview: GzipOrthoPreview) => void): () => void {
    const entry = this.files.get(entryId);
    return (entry ? this.ensureGzipScan(entry)?.subscribe(listener) : undefined) || (() => {});
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
    const session = GzipScanSession.start(fsPath, undefined, onProgress, {
      directory: vscode.workspace.getConfiguration('niftispy').get<string>('remoteCacheDirectory', '') || undefined,
      budgetBytes:
        Math.max(0, vscode.workspace.getConfiguration('niftispy').get<number>('remoteCacheBudgetMB', 4096)) *
        1024 *
        1024,
    });
    entry.gzipScan = session;
    void session.done.then((idx) => {
      if (entry.gzipScan !== session) return;
      if (idx) entry.gzipIndex = idx;
      if (session.unpackPath) entry.unpackPath = session.unpackPath;
    });
    void session.z0
      .then((preview) => {
        if (entry.gzipScan !== session) return;
        if (preview.header) entry.headerCache = preview.header;
      })
      .catch(() => {});
    return session;
  }

  private readonly maxConcurrentRequests = 32;
  private activeRequests = 0;

  private async validateEntrySource(entry: FileEntry): Promise<void> {
    if (!entry.dataUri.fsPath || !['file', 'vscode-remote'].includes(entry.dataUri.scheme)) return;
    const st = await fs.promises.stat(entry.dataUri.fsPath);
    const stamp = `${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
    if (entry.sourceStamp && entry.sourceStamp !== stamp) {
      entry.dataCache = undefined;
      entry.headerCache = entry.hostHeader;
      entry.previewBinaryCache = undefined;
      entry.gzipScan = undefined;
      entry.gzipIndex = undefined;
      entry.unpackPath = undefined;
      entry.size = st.size;
      entry.sliceCache?.clear();
      entry.lodCache?.clear();
    }
    entry.sourceStamp = stamp;
    if (entry.unpackPath && !(await fs.promises.stat(entry.unpackPath).catch(() => null))) {
      entry.unpackPath = undefined;
      entry.gzipScan = undefined;
    }
  }

  private headerPath(entry: FileEntry): string {
    return entry.uri.fsPath;
  }

  private dataPath(entry: FileEntry): string {
    return (entry.dataUri || entry.uri).fsPath;
  }

  private parseEntryHeader(entry: FileEntry, bytes: Uint8Array): NiiHeader | null {
    if (entry.hostHeader) return entry.hostHeader;
    return parseNiiHeaderQuick(bytes, { separateImg: !!entry.separateImg });
  }

  private enqueueRequest(priority: number, execute: () => Promise<void>, opts?: { preemptible?: boolean }): void {
    if (priority > REQUEST_PRIORITY.file) this.pauseBackgroundFileLoads();
    // Binary insert into sorted array — O(log n) instead of O(n log n) sort
    let lo = 0,
      hi = this.priorityQueue.length;
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
    this.priorityQueue = this.priorityQueue.filter((job) => !job.preemptible);
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

  /**
   * Echo CORS only for VS Code webview origins. Unknown origins get no
   * `Access-Control-Allow-Origin`, so a website cannot read a response even
   * if it guesses the localhost port.
   */
  private applySecurityHeaders(req: http.IncomingMessage, res: http.ServerResponse): void {
    const origin = req.headers.origin;
    let allowedOrigin: string | null = null;
    if (!origin) {
      // Local tests, benchmarks and curl-style clients still need the token.
      allowedOrigin = '*';
    } else if (origin === 'null') {
      allowedOrigin = 'null';
    } else if (origin.startsWith('vscode-webview://')) {
      allowedOrigin = origin;
    } else {
      try {
        const url = new URL(origin);
        if (
          url.protocol === 'https:' &&
          (url.hostname === 'vscode-cdn.net' ||
            url.hostname.endsWith('.vscode-cdn.net') ||
            url.hostname === 'vscode-webview.net' ||
            url.hostname.endsWith('.vscode-webview.net'))
        ) {
          allowedOrigin = origin;
        }
      } catch {
        // Malformed Origin: leave CORS disabled.
      }
    }

    if (allowedOrigin) res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
    if (origin) res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Range, Accept-Encoding, X-NiftiSpy-Priority');
    res.setHeader(
      'Access-Control-Expose-Headers',
      'Content-Range, Content-Length, Accept-Ranges, Content-Encoding, X-Remote-Source, X-Width, X-Height, X-Factor, X-NiftiSpy-Slice-Format, X-NiftiSpy-Dtype, X-NiftiSpy-Slope, X-NiftiSpy-Inter, Server-Timing',
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const _req = req as http.IncomingMessage;
    const _res = res as http.ServerResponse;

    this.applySecurityHeaders(_req, _res);
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

    const rawUrl = _req.url || '';
    const qIndex = rawUrl.indexOf('?');
    const pathname = qIndex >= 0 ? rawUrl.slice(0, qIndex) : rawUrl;
    const query = qIndex >= 0 ? new URLSearchParams(rawUrl.slice(qIndex + 1)) : new URLSearchParams();

    // Every route lives behind a per-session capability token. Without it a
    // local port scanner (or a website probing 127.0.0.1) cannot read data.
    const tokenPrefix = `/${this.token}/`;
    if (!pathname.startsWith(tokenPrefix)) {
      _res.writeHead(403);
      _res.end('Forbidden');
      return;
    }
    const routePath = pathname.slice(tokenPrefix.length - 1);

    if (_req.method === 'OPTIONS') {
      _res.writeHead(204);
      _res.end();
      return;
    }

    if (this.accessLog) {
      const accessStart = Date.now();
      // Log the route only: the path prefix is the session capability token.
      _res.once('finish', () => {
        this.accessLog?.(`[proxy] ${_req.method} ${routePath} -> ${_res.statusCode} ${Date.now() - accessStart}ms`);
      });
    }

    this.stats.totalRequests++;

    const statsMatch = routePath === '/stats';
    if (statsMatch) {
      _res.writeHead(200, { 'Content-Type': 'application/json' });
      _res.end(JSON.stringify(this.getStats()));
      return;
    }

    const headerMatch = routePath.match(/^\/header\/(\d+)$/);
    const previewMatch = routePath.match(/^\/preview\/(\d+)$/);
    const previewBinMatch = routePath.match(/^\/preview-bin\/(\d+)$/);
    const previewVolumeMatch = routePath.match(/^\/preview-volume\/(\d+)/);
    const previewOrthoMatch = routePath.match(/^\/preview-ortho\/(\d+)$/);
    const metaMatch = routePath.match(/^\/meta\/(\d+)$/);
    const sliceMatch = routePath.match(/^\/slice\/(\d+)\/(axial|coronal|sagittal)\/(\d+)$/);
    const lodMatch = routePath.match(/^\/lod\/(\d+)\/(\d+)$/);
    const fileMatch = routePath.match(/^\/file\/(\d+)$/);
    const match =
      headerMatch ||
      previewMatch ||
      previewBinMatch ||
      previewVolumeMatch ||
      previewOrthoMatch ||
      metaMatch ||
      sliceMatch ||
      lodMatch ||
      fileMatch;
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

    const priority = headerMatch
      ? REQUEST_PRIORITY.header
      : previewMatch
        ? REQUEST_PRIORITY.preview
        : previewBinMatch
          ? REQUEST_PRIORITY.previewBin
          : previewVolumeMatch
            ? REQUEST_PRIORITY.previewVolume
            : previewOrthoMatch
              ? REQUEST_PRIORITY.preview
              : metaMatch
                ? REQUEST_PRIORITY.header
                : sliceMatch
                  ? REQUEST_PRIORITY.slice
                  : lodMatch
                    ? REQUEST_PRIORITY.lod
                    : REQUEST_PRIORITY.file;

    const backgroundFile =
      !!fileMatch && String(_req.headers['x-niftispy-priority'] || '').toLowerCase() === 'background';
    const queuedAt = performance.now();
    this.enqueueRequest(
      priority,
      async () => {
        try {
          _res.setHeader('Server-Timing', `queue;dur=${(performance.now() - queuedAt).toFixed(2)}`);
          await this.validateEntrySource(entry);
          if (_res.destroyed) return;
          if (headerMatch) {
            await this.handleHeader(entry, _res, _req);
            return;
          }
          if (metaMatch) {
            handleGzipMeta(entry, _res);
            return;
          }
          if (previewMatch) {
            await handlePreview(entry, _res, _req, this.localPreviewHost);
            return;
          }
          if (previewBinMatch) {
            await handlePreviewBinary(entry, _res, _req, this.localPreviewHost);
            return;
          }
          if (previewOrthoMatch) {
            await handlePreviewOrtho(entry, _res, _req, this.localPreviewHost);
            return;
          }
          if (previewVolumeMatch) {
            const factor = parseFactorFromPath(_req.url || '');
            await handlePreviewVolume(entry, factor, _res, _req, this.previewHost);
            return;
          }
          if (sliceMatch) {
            const timeIdx = parseInt(query.get('t') || '0', 10) || 0;
            await handleSlice(
              entry,
              sliceMatch[2],
              parseInt(sliceMatch[3], 10),
              _res,
              _req,
              this.sliceHost,
              timeIdx,
              Math.max(1, Math.min(32, Math.floor(Number(query.get('factor'))) || 1)),
              // fmt=f32 asks for scaled Float32 instead of raw int16; the
              // host-side Remote-SSH relay cannot expand raw slices.
              query.get('fmt') !== 'f32',
            );
            return;
          }
          if (lodMatch) {
            await handleLOD(entry, parseInt(lodMatch[2]), _res, _req, this.sliceHost);
            return;
          }

          await handleFile(entry, _res, _req, this.httpCtx);
        } catch (err) {
          console.error('LocalFileProxy error:', err);
          _res.writeHead(500);
          _res.end(String(err));
        }
      },
      { preemptible: backgroundFile },
    );
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
          const idx = entry.gzipIndex || (await session.done);
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
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: errorMessage(err) }));
    }
  }

  public async loadFileData(
    entry: FileEntry,
    signal?: AbortSignal,
  ): Promise<{ rawData: Uint8Array; header: NiiHeader | null }> {
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
        let header: NiiHeader | null;
        let rawData: Uint8Array;

        if (entry.separateImg) {
          const headerData = await vscode.workspace.fs.readFile(entry.uri);
          header = this.parseEntryHeader(
            entry,
            new Uint8Array(headerData.buffer, headerData.byteOffset, headerData.byteLength),
          );
          const fullData = await vscode.workspace.fs.readFile(fileUri);
          rawData = new Uint8Array(fullData.buffer, fullData.byteOffset, fullData.byteLength);
          if (header) entry.headerCache = header;
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
                compressedSize = await getHttpRemoteSize(fileUri.toString(), this.httpCtx);
                entry.size = compressedSize;
              }
              compressed = await downloadHttpFileInChunks(fileUri.toString(), compressedSize, signal);
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
              totalSize = await getHttpRemoteSize(fileUri.toString(), this.httpCtx);
              entry.size = totalSize;
            }
            rawData = await downloadHttpFileInChunks(fileUri.toString(), totalSize, signal);
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

        if (header) entry.headerCache = header;
        entry.lastAccess = Date.now();

        if (this.volumeCache && header) {
          const uriKey = entry.uri.toString();
          const cached = this.volumeCache.get(uriKey);
          if (!cached) {
            const { nx, ny, nz, datatype, scl_slope, scl_inter, littleEndian, voxOffset } = header;
            const n = nx * ny * nz;
            const byteOff = rawData.byteOffset + voxOffset;
            const le = littleEndian;
            const elemSize =
              datatype === 64
                ? 8
                : datatype === 8 || datatype === 16 || datatype === 768
                  ? 4
                  : datatype === 4 || datatype === 512
                    ? 2
                    : 1;
            const canUseTypedArray =
              byteOff % elemSize === 0 && byteOff + n * elemSize <= rawData.buffer.byteLength && le;

            let voxelData:
              | Int8Array
              | Uint8Array
              | Int16Array
              | Uint16Array
              | Int32Array
              | Uint32Array
              | Float32Array
              | Float64Array;
            switch (datatype) {
              case 2:
                voxelData = canUseTypedArray
                  ? new Uint8Array(rawData.buffer, byteOff, n)
                  : new Uint8Array(rawData.slice(voxOffset, voxOffset + n));
                break;
              case 4:
                voxelData = canUseTypedArray ? new Int16Array(rawData.buffer, byteOff, n) : new Int16Array(n);
                break;
              case 8:
                voxelData = canUseTypedArray ? new Int32Array(rawData.buffer, byteOff, n) : new Int32Array(n);
                break;
              case 16:
                voxelData = canUseTypedArray ? new Float32Array(rawData.buffer, byteOff, n) : new Float32Array(n);
                break;
              case 64:
                voxelData = canUseTypedArray ? new Float64Array(rawData.buffer, byteOff, n) : new Float64Array(n);
                break;
              case 256:
                voxelData = canUseTypedArray ? new Int8Array(rawData.buffer, byteOff, n) : new Int8Array(n);
                break;
              case 512:
                voxelData = canUseTypedArray ? new Uint16Array(rawData.buffer, byteOff, n) : new Uint16Array(n);
                break;
              case 768:
                voxelData = canUseTypedArray ? new Uint32Array(rawData.buffer, byteOff, n) : new Uint32Array(n);
                break;
              default:
                voxelData = new Float32Array(n);
                break;
            }

            if (!canUseTypedArray && datatype !== 2 && datatype !== 256) {
              const view = new DataView(rawData.buffer, byteOff, n * elemSize);
              switch (datatype) {
                case 4: {
                  const a = voxelData as Int16Array;
                  for (let i = 0; i < n; i++) a[i] = view.getInt16(i * 2, le);
                  break;
                }
                case 8: {
                  const a = voxelData as Int32Array;
                  for (let i = 0; i < n; i++) a[i] = view.getInt32(i * 4, le);
                  break;
                }
                case 16: {
                  const a = voxelData as Float32Array;
                  for (let i = 0; i < n; i++) a[i] = view.getFloat32(i * 4, le);
                  break;
                }
                case 64: {
                  const a = voxelData as Float64Array;
                  for (let i = 0; i < n; i++) a[i] = view.getFloat64(i * 8, le);
                  break;
                }
                case 512: {
                  const a = voxelData as Uint16Array;
                  for (let i = 0; i < n; i++) a[i] = view.getUint16(i * 2, le);
                  break;
                }
                case 768: {
                  const a = voxelData as Uint32Array;
                  for (let i = 0; i < n; i++) a[i] = view.getUint32(i * 4, le);
                  break;
                }
              }
            }

            let min = Infinity,
              max = -Infinity;
            const sampleStep = Math.max(1, Math.floor(n / 50000));
            const slope = scl_slope || 1;
            const inter = scl_inter || 0;
            for (let i = 0; i < n; i += sampleStep) {
              const v = (voxelData as ArrayLike<number>)[i] * slope + inter;
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

  async extractPreviewForWebview(
    entryId: string,
    signal?: AbortSignal,
  ): Promise<{
    header: NiiHeader;
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
          readLocalFilePartial(fsPath!, sliceStart, sliceEnd - 1).then((bytes) =>
            extractAxialSliceFromRange(bytes, header),
          ),
          extractCoronalSliceFromRange(fsPath!, header, coMid)
            .then((s) => s || new Float32Array(nx * nz))
            .catch(() => new Float32Array(nx * nz)),
          extractSagittalSliceFromRange(fsPath!, header, saMid)
            .then((s) => s || new Float32Array(ny * nz))
            .catch(() => new Float32Array(ny * nz)),
        ]);

        let min = Infinity,
          max = -Infinity;
        for (const s of [axialSlice, coronalSlice, sagittalSlice]) {
          for (let i = 0; i < s.length; i++) {
            if (s[i] < min) min = s[i];
            if (s[i] > max) max = s[i];
          }
        }

        return {
          header,
          slices: { axial: axialSlice, coronal: coronalSlice, sagittal: sagittalSlice },
          globalMin: min,
          globalMax: max,
          sliceIdx: { axial: axMid, coronal: coMid, sagittal: saMid },
          slope: header.scl_slope || 1,
          inter: header.scl_inter || 0,
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
            globalMin: preview.min,
            globalMax: preview.max,
            sliceIdx: preview.sliceIdx,
            slope: preview.slope,
            inter: preview.inter,
            partialPreview: true,
          };
        }
        const { header, axialSlice } = await streamingGunzipPreview(fsPath!, signal);
        if (!header) return null;
        const { nx, ny, nz } = header;
        let min = Infinity,
          max = -Infinity;
        for (let i = 0; i < axialSlice.length; i++) {
          if (axialSlice[i] < min) min = axialSlice[i];
          if (axialSlice[i] > max) max = axialSlice[i];
        }
        return {
          header,
          slices: { axial: axialSlice, coronal: new Float32Array(nx * nz), sagittal: new Float32Array(ny * nz) },
          globalMin: min,
          globalMax: max,
          // streamingGunzipPreview now returns z=0 slice for instant preview
          sliceIdx: { axial: 0, coronal: Math.floor(ny / 2), sagittal: Math.floor(nx / 2) },
          slope: header.scl_slope || 1,
          inter: header.scl_inter || 0,
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
            let min = Infinity,
              max = -Infinity;
            for (let i = 0; i < axialSlice.length; i++) {
              if (axialSlice[i] < min) min = axialSlice[i];
              if (axialSlice[i] > max) max = axialSlice[i];
            }
            return {
              header,
              slices: { axial: axialSlice, coronal: new Float32Array(nx * nz), sagittal: new Float32Array(ny * nz) },
              globalMin: min,
              globalMax: max,
              // streamingHttpGunzipPreview now returns z=0 slice for instant preview
              sliceIdx: { axial: 0, coronal: Math.floor(ny / 2), sagittal: Math.floor(nx / 2) },
              slope: header.scl_slope || 1,
              inter: header.scl_inter || 0,
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

            let min = Infinity,
              max = -Infinity;
            for (let i = 0; i < axialSlice.length; i++) {
              if (axialSlice[i] < min) min = axialSlice[i];
              if (axialSlice[i] > max) max = axialSlice[i];
            }

            return {
              header,
              slices: { axial: axialSlice, coronal: new Float32Array(nx * nz), sagittal: new Float32Array(ny * nz) },
              globalMin: min,
              globalMax: max,
              sliceIdx: { axial: 0, coronal: Math.floor(ny / 2), sagittal: Math.floor(nx / 2) },
              slope: header.scl_slope || 1,
              inter: header.scl_inter || 0,
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
        globalMin: min,
        globalMax: max,
        sliceIdx: {
          axial: Math.floor(header.nz / 2),
          coronal: Math.floor(header.ny / 2),
          sagittal: Math.floor(header.nx / 2),
        },
        slope: header.scl_slope || 1,
        inter: header.scl_inter || 0,
      };
    } catch (err) {
      if (isAbortError(err)) return null;
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
