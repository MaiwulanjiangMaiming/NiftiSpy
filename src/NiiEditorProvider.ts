import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { LocalFileProxy } from './LocalFileProxy';
import { LoadQueue } from './editor/loadQueue';
import { computeVoxelStats } from './editor/stats';
import { buildViewerHtml } from './editor/html';
import { LocalVolumeLoader } from './editor/localLoader';
import { VolumeCache } from './VolumeCache';
import { getNativeBindings } from './nativeBridge';
import { parseNiiHeaderQuick, type NiiHeader } from './nifti/headerParser';
import { prepareParsedPayload } from './formats/payload';
import { findVolumeFormat, VOLUME_EXTENSIONS } from './formats/registry';
import { removeTempVolumes } from './formats/header';
import type { ParsedVolume, VolumeFormat } from './formats/types';
import { isWanRemote, shouldUseSliceMode } from './remoteEnv';
import { resolveAnalyzePair, isAnalyzeHeaderPath } from './io/analyzePair';
import { errorMessage } from './errors';

interface PerfTiming {
  fsToFirstData?: number;
  headerParse?: number;
  previewReady?: number;
  totalDecompress?: number;
  statsCompute?: number;
  nativeDecompress?: number;
  postMessageSync?: number;
  decompressedBytes?: number;
  nativeBackend?: string;
}

interface PerfExt {
  stream?: PerfTiming;
  isRemoteSSH?: boolean;
  totalLoad?: number;
  downcastOrStats?: number;
  cacheSet?: number;
  postMessageSync?: number;
}

interface PerfReportMessage {
  fileName?: string;
  isGzip?: boolean;
  voxelBytes: number;
  viewSetupMs?: number;
  ext?: PerfExt;
}

export class NiiEditorProvider implements vscode.CustomReadonlyEditorProvider {
  private proxy: LocalFileProxy | null = null;
  private volumeCache: VolumeCache;
  private loadQueue: LoadQueue;
  private webviewCounter = 0;
  private activeWebviews = new Map<string, { panel: vscode.WebviewPanel; abortController: AbortController }>();
  private gzipIndexStatusItems = new Map<string, vscode.Disposable>();
  private chunkProgressItem: vscode.StatusBarItem | null = null;
  private nativeStatusBarItem: vscode.StatusBarItem | null = null;
  private cacheStatusBarItem: vscode.StatusBarItem | null = null;
  private debugStatusBarItem: vscode.StatusBarItem | null = null;
  private nativeFallbackWarned = false;
  private perfChannel: vscode.OutputChannel | null = null;
  /** Materialized raw volumes (npz/mgz/gzip nrrd/...) per webview. */
  private parsedTempFiles = new Map<string, string[]>();
  // Remote-SSH fast-path fallback contexts, keyed by per-dispatch loadId.
  // If the webview cannot fetch the port-forwarded proxy URL (forwarding
  // blocked, CSP, tunnel hiccup), it reports back and we fall back to the
  // chunked postMessage transfer from this stashed context.
  private remoteHttpFallbacks = new Map<string, {
    webview: vscode.Webview;
    fsPath: string;
    fileSize: number;
    validationToken: string;
    signal: AbortSignal;
    isGzip: boolean;
  }>();
  // Same idea for host-parsed formats: re-read the volume in the host and
  // push it as cachedVolume when the forwarded proxy URL is unreachable.
  private parsedRemoteFallbacks = new Map<string, {
    webview: vscode.Webview;
    uri: vscode.Uri;
    format: VolumeFormat;
    signal: AbortSignal;
  }>();
  private loadIdCounter = 0;
  private readonly loader: LocalVolumeLoader;

  /**
   * Unique per dispatched load. A webview can own several volumes (Add Image /
   * compare), so fallback contexts must never be keyed by webviewId alone.
   */
  private newLoadId(): string {
    return `${Date.now().toString(36)}-${this.loadIdCounter++}`;
  }
  // Debug mode: when on, perf reports are written to the OutputChannel AND
  // the panel is auto-revealed. Toggled by clicking the $(bug) status bar item.
  // Persists across sessions via workspaceState. Initial value also honors
  // the "niftispy.showPerfReport" setting for backward compatibility.
  private debugMode = false;

  constructor(private readonly context: vscode.ExtensionContext, volumeCache: VolumeCache) {
    this.volumeCache = volumeCache;
    this.loadQueue = new LoadQueue();
    this.cacheStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 97);
    this.updateCacheStatusBar();
    this.cacheStatusBarItem.show();
    this.perfChannel = vscode.window.createOutputChannel('NiftiSpy Performance');

    // Restore debug mode: prefer workspaceState (button toggle), fall back to
    // the showPerfReport setting for users who already had it enabled.
    const saved = this.context.workspaceState.get<boolean | undefined>('niftispy.debugMode', undefined);
    if (saved !== undefined) {
      this.debugMode = saved;
    } else {
      this.debugMode = vscode.workspace.getConfiguration('niftispy').get<boolean>('showPerfReport', false);
    }

    // Debug toggle button in the status bar
    this.debugStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 96);
    this.updateDebugStatusBar();
    this.debugStatusBarItem.command = 'niftispy.toggleDebugMode';
    this.debugStatusBarItem.show();

    this.loader = new LocalVolumeLoader({
      context: this.context,
      volumeCache: this.volumeCache,
      loadQueue: this.loadQueue,
      remoteHttpFallbacks: this.remoteHttpFallbacks,
      gzipIndexStatusItems: this.gzipIndexStatusItems,
      isWebviewActive: id => this.isWebviewActive(id),
      logPerf: line => this.logPerf(line),
      updateCacheStatusBar: () => this.updateCacheStatusBar(),
      getProxy: () => this.proxy,
      setProxy: proxy => { this.proxy = proxy; },
    });
  }

  /** Toggle debug mode on/off (bound to status bar click command). */
  public toggleDebugMode(): void {
    this.debugMode = !this.debugMode;
    this.context.workspaceState.update('niftispy.debugMode', this.debugMode);
    this.updateDebugStatusBar();
    if (this.debugMode && this.perfChannel) {
      this.perfChannel.show(true);
      this.logPerf(`┌─ NiftiSpy debug mode ON — perf reports will appear here ─`);
    }
  }

  private updateDebugStatusBar(): void {
    if (!this.debugStatusBarItem) return;
    this.debugStatusBarItem.text = this.debugMode ? '$(bug) NiftiSpy Debug: ON' : '$(bug) NiftiSpy Debug';
    this.debugStatusBarItem.tooltip = this.debugMode
      ? 'NiftiSpy debug mode is ON. Click to turn off (hide perf reports).'
      : 'NiftiSpy debug mode is OFF. Click to turn on and show perf reports on each volume load.';
  }

  private logPerf(line: string): void {
    if (!this.perfChannel) return;
    // Always append to the channel buffer (cheap), but only auto-reveal
    // the panel when debug mode is on. This way, if a user turns on debug
    // mode AFTER loading a file, they can still scroll up to see history.
    this.perfChannel.appendLine(line);
    if (this.debugMode) {
      this.perfChannel.show(true);
    }
  }

  private handlePerfReport(msg: PerfReportMessage): void {
    try {
      const ext = msg.ext || {};
      const stream = ext.stream || {};
      const voxelMB = ((msg.voxelBytes || 0) / (1024 * 1024)).toFixed(1);
      const envTag = ext.isRemoteSSH ? ' [Remote-SSH]' : '';
      const lines: string[] = [];
      lines.push('┌─────────────────────────────────────────────────────────────┐');
      lines.push(`│ NiftiSpy Load Performance Report  —  ${new Date().toLocaleTimeString()}${envTag}`);
      lines.push(`│ File: ${msg.fileName || '(unknown)'}`);
      lines.push(`│ Format: ${msg.isGzip ? '.nii.gz' : '.nii'}   Voxel data: ${voxelMB} MB`);
      lines.push('├─────────────────────────────────────────────────────────────┤');
      lines.push('│ EXTENSION HOST (Node.js)');
      if (msg.isGzip && Object.keys(stream).length > 0) {
        // Four backends: streaming (zlib, no nativeBackend field),
        //                gunzipSync (system zlib, nativeBackend='system-zlib'),
        //                libdeflate (native single-core oneshot, nativeBackend='libdeflate'),
        //                rusty-rapidgzip (native multi-core libdeflate-based speculative parallel,
        //                                 nativeBackend='rusty-rapidgzip').
        const backendName = stream.nativeBackend;  // undefined | 'system-zlib' | 'libdeflate' | 'rusty-rapidgzip'
        const isStream = backendName === undefined;
        const isLibdeflate = backendName === 'libdeflate';
        const isParallel = backendName === 'rusty-rapidgzip';
        const tag = isStream
          ? '[stream]'
          : isParallel
            ? '[parallel]'
            : isLibdeflate
              ? '[libdeflate]'
              : '[gunzip]';
        const backendSuffix = !isStream ? ` (${backendName})` : '';
        lines.push(`│   ${tag} fs read            : ${stream.fsToFirstData ?? '?'} ms${backendSuffix}`);
        if (isStream) {
          lines.push(`│   ${tag} header parse      : ${stream.headerParse ?? '?'} ms`);
          lines.push(`│   ${tag} → preview ready   : ${stream.previewReady ?? '?'} ms (z=0 slice sent early)`);
          lines.push(`│   ${tag} total decompress  : ${stream.totalDecompress ?? '?'} ms (fs read + gunzip)`);
          lines.push(`│   ${tag} stats (min/max)   : ${stream.statsCompute ?? '?'} ms`);
        } else if (isParallel) {
          lines.push(`│   ${tag} header parse      : ${stream.headerParse ?? '?'} ms`);
          lines.push(`│   ${tag} → preview ready   : ${stream.previewReady ?? '?'} ms (after parallel decompress)`);
          lines.push(`│   ${tag} parallel decompress: ${stream.nativeDecompress ?? '?'} ms (mmap + rusty-rapidgzip, all cores)`);
          lines.push(`│   ${tag} total decompress  : ${stream.totalDecompress ?? '?'} ms (Rust worker thread)`);
          lines.push(`│   ${tag} stats (min/max)   : ${stream.statsCompute ?? '?'} ms`);
        } else if (isLibdeflate) {
          lines.push(`│   ${tag} header parse      : ${stream.headerParse ?? '?'} ms`);
          lines.push(`│   ${tag} → preview ready   : ${stream.previewReady ?? '?'} ms (after decompress)`);
          lines.push(`│   ${tag} native decompress : ${stream.nativeDecompress ?? '?'} ms (pure libdeflate inflate)`);
          lines.push(`│   ${tag} total decompress  : ${stream.totalDecompress ?? '?'} ms (fs read + native)`);
          lines.push(`│   ${tag} stats (min/max)   : ${stream.statsCompute ?? '?'} ms`);
        } else {
          // [gunzip] path (JS gunzipSync, nativeBackend='system-zlib')
          lines.push(`│   ${tag} header parse      : ${stream.headerParse ?? '?'} ms`);
          lines.push(`│   ${tag} decompress        : ${stream.nativeDecompress ?? stream.totalDecompress ?? '?'} ms (pure gunzipSync)`);
          lines.push(`│   ${tag} total decompress  : ${stream.totalDecompress ?? '?'} ms (fs read + gunzip)`);
          lines.push(`│   ${tag} stats (min/max)   : ${stream.statsCompute ?? '?'} ms`);
        }
        const decompressedMB = ((stream.decompressedBytes || 0) / (1024 * 1024)).toFixed(1);
        lines.push(`│   ${tag} decompressed size : ${decompressedMB} MB`);
        if ((stream.totalDecompress ?? 0) > 0 && (stream.decompressedBytes ?? 0) > 0) {
          const totalDecompress = stream.totalDecompress!;
          const decompressedBytes = stream.decompressedBytes!;
          const throughput = ((decompressedBytes / (1024 * 1024)) / (totalDecompress / 1000)).toFixed(0);
          lines.push(`│   ${tag} decompress throughput: ${throughput} MB/s`);
        }
      }
      lines.push(`│   total load (decompress)    : ${ext.totalLoad ?? '?'} ms`);
      lines.push(`│   downcast/stats             : ${ext.downcastOrStats ?? '?'} ms${msg.isGzip ? '' : ' (Float64→Float32 or sampled stats)'}`);
      lines.push(`│   volumeCache.set            : ${ext.cacheSet ?? '?'} ms`);
      const postMsgSync = ext.postMessageSync ?? stream.postMessageSync ?? 0;
      lines.push(`│   postMessage sync (serial)  : ${postMsgSync} ms (structured-clone of ${voxelMB} MB)`);
      if (postMsgSync > 0) {
        const serialRate = ((msg.voxelBytes / (1024 * 1024)) / (postMsgSync / 1000)).toFixed(0);
        lines.push(`│   serialize throughput       : ${serialRate} MB/s`);
      }
      lines.push('├─────────────────────────────────────────────────────────────┤');
      lines.push('│ WEBVIEW (render thread, same-origin clock)');
      lines.push(`│   receive → render done      : ${msg.viewSetupMs ?? '?'} ms`);
      lines.push('│   (includes IPC dispatch + deserialization + SAB setup + render)');
      lines.push('├─────────────────────────────────────────────────────────────┤');
      const extTotal = (ext.totalLoad || 0) + (ext.downcastOrStats || 0) + (ext.cacheSet || 0) + (postMsgSync || 0);
      const grandTotal = extTotal + (msg.viewSetupMs || 0);
      lines.push(`│ ESTIMATED TOTAL (ext + sync + webview): ${grandTotal.toFixed(1)} ms`);
      lines.push(`│   Note: webview viewSetupMs includes IPC transfer time`);
      lines.push(`│   (cannot be separated from render time due to clock-origin mismatch)`);
      const pct = (v: number) => grandTotal > 0 ? ((v / grandTotal) * 100).toFixed(0) + '%' : '?';
      lines.push(`│   decompress   : ${pct(ext.totalLoad || 0)}${(ext.totalLoad || 0) > 1500 ? '  ← BOTTLENECK' : ''}`);
      lines.push(`│   postMsg sync : ${pct(postMsgSync || 0)}`);
      lines.push(`│   webview      : ${pct(msg.viewSetupMs || 0)}`);
      lines.push(`│   other        : ${pct(grandTotal - (ext.totalLoad || 0) - (postMsgSync || 0) - (msg.viewSetupMs || 0))}`);
      lines.push('└─────────────────────────────────────────────────────────────┘');
      for (const line of lines) {
        this.logPerf(line);
      }
    } catch (err) {
      this.logPerf('Perf report error: ' + String(err));
    }
  }

  dispose(): void {
    // Terminate all active webview abort controllers
    for (const [, entry] of this.activeWebviews) {
      entry.abortController.abort();
    }
    this.activeWebviews.clear();
    // Cancel all queued loads
    this.loadQueue.cancel('__all__');
    // Drop materialized parser scratch volumes
    for (const [, files] of this.parsedTempFiles) {
      void removeTempVolumes(files);
    }
    this.parsedTempFiles.clear();
    // Close HTTP proxy server
    this.proxy?.stop();
    this.proxy = null;
    // Dispose all status bar items
    this.cacheStatusBarItem?.dispose();
    this.nativeStatusBarItem?.dispose();
    this.debugStatusBarItem?.dispose();
    this.perfChannel?.dispose();
    this.chunkProgressItem?.dispose();
    for (const [, item] of this.gzipIndexStatusItems) {
      item.dispose();
    }
    this.gzipIndexStatusItems.clear();
  }

  private updateCacheStatusBar(): void {
    if (!this.cacheStatusBarItem) return;
    const info = this.volumeCache.getCacheInfo();
    const mb = Math.round(info.totalBytes / (1024 * 1024));
    this.cacheStatusBarItem.text = `$(database) NiftiSpy: ${info.entries}/${info.maxEntries} vol, ${mb} MB`;
  }

  async openCustomDocument(
    uri: vscode.Uri,
    _openContext: vscode.CustomDocumentOpenContext,
    _token: vscode.CancellationToken
  ): Promise<vscode.CustomDocument> {
    return { uri, dispose: () => {} };
  }

  async resolveCustomEditor(
    document: vscode.CustomDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): Promise<void> {
    const uri = document.uri;
    // Any format the host can decode (npy/npz/nrrd/mha/mrc/mgh/...) is
    // normalized into a NIfTI-shaped header and then flows through the same
    // cache / stats / LOD / renderer pipeline as .nii.
    const parsedFormat = findVolumeFormat(uri.fsPath || uri.path);
    const isParsed = !!parsedFormat;
    const pair = await resolveAnalyzePair(uri);
    const webview = webviewPanel.webview;
    const webviewId = String(this.webviewCounter++);

    const abortController = new AbortController();
    this.activeWebviews.set(webviewId, { panel: webviewPanel, abortController });

    webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, 'dist'),
        vscode.Uri.joinPath(uri, '.'),
        ...(vscode.workspace.workspaceFolders?.map(f => f.uri) ?? []),
      ],
    };

    const isRemote = uri.scheme !== 'file';
    let fileUrl: string;
    let entryId: string | null = null;

    if (isParsed) {
      // Host-parsed formats are decoded in the extension host and pushed as
      // whole-volume voxel data (or served via the proxy in Remote-SSH slice
      // mode), so no worker fetch is involved.
      fileUrl = isRemote ? uri.toString() : webview.asWebviewUri(uri).toString();
    } else if (isRemote) {
      if (!this.proxy) {
        this.proxy = new LocalFileProxy(this.volumeCache);
        await this.proxy.start();
        this.context.subscriptions.push({ dispose: () => this.proxy?.stop() });
      }
      fileUrl = this.proxy.registerFile(pair.headerUri, pair.separateImg ? pair.dataUri : undefined);
      entryId = fileUrl.split('/').pop()!;
    } else {
      // Local file: direct webview URI + postMessage. Worker fetch of
      // asWebviewUri URLs is unreliable across VS Code versions, so we
      // keep the proven postMessage path (Float64→Float32 + zero-copy
      // buffer + streaming gz load with 16MB highWaterMark).
      fileUrl = webview.asWebviewUri(pair.dataUri).toString();
    }

    webview.html = buildViewerHtml(webview, this.context.extensionUri);

    webviewPanel.onDidChangeViewState(() => {
      if (webviewPanel.active) {
        this.loadQueue.promote(webviewId);
        this.volumeCache.setActive(uri.toString(), webviewId);
      }
    });

    webviewPanel.onDidDispose(() => {
      abortController.abort();
      this.loadQueue.cancel(webviewId);
      for (const [key, fb] of this.remoteHttpFallbacks) {
        if (fb.webview === webview) this.remoteHttpFallbacks.delete(key);
      }
      for (const [key, fb] of this.parsedRemoteFallbacks) {
        if (fb.webview === webview) this.parsedRemoteFallbacks.delete(key);
      }
      this.volumeCache.setActive(uri.toString(), null);
      this.activeWebviews.delete(webviewId);
      const temps = this.parsedTempFiles.get(webviewId);
      if (temps) {
        this.parsedTempFiles.delete(webviewId);
        void removeTempVolumes(temps);
      }
    });

    webview.onDidReceiveMessage(async (msg) => {
      if (msg.type === 'ready') {
        // A ready event starts a fresh dispatch (including webview reloads),
        // so it needs its own fallback identity.
        const loadId = this.newLoadId();
        const config = vscode.workspace.getConfiguration('niftispy');

        // Update native acceleration status bar
        const native = getNativeBindings();
        if (!this.nativeStatusBarItem) {
          this.nativeStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 98);
        }
        if (native) {
          this.nativeStatusBarItem.text = '$(bolt) NiftiSpy: Native+WASM';
          this.nativeStatusBarItem.color = new vscode.ThemeColor('statusBar.foreground');
          this.nativeStatusBarItem.show();
        } else {
          this.nativeStatusBarItem.text = '$(code) NiftiSpy: WASM+JS';
          this.nativeStatusBarItem.color = new vscode.ThemeColor('notificationsWarningIcon.foreground');
          this.nativeStatusBarItem.show();
          if (!this.nativeFallbackWarned) {
            this.nativeFallbackWarned = true;
            vscode.window.showInformationMessage('NiftiSpy: Native acceleration unavailable, using WASM SIMD + JavaScript fallback.');
          }
        }

        // Compute validation token and file size for cache invalidation
        let fileSize = 0;
        let validationToken = '';
        try {
          if (!isRemote && pair.dataUri.fsPath) {
            const stat = await fs.promises.stat(pair.dataUri.fsPath);
            fileSize = stat.size;
            validationToken = `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}:${stat.ino}`;
          } else if (isRemote) {
            try {
              const stat = await vscode.workspace.fs.stat(pair.dataUri);
              fileSize = Number(stat.size);
              validationToken = `${stat.mtime}:${stat.size}`;
            } catch { /* remote stat optional */ }
          }
        } catch {
          // stat may fail for remote URIs; validationToken stays empty
        }

        webview.postMessage({
          type: 'config',
          enableLOD: config.get('enableLOD', true),
          defaultColormap: config.get('defaultColormap', 'gray'),
          previewMode: config.get('previewMode', 'binary'),
          renderBackend: config.get('renderBackend', 'canvas'),
          fullVolumePolicy: config.get('fullVolumePolicy', 'adaptive'),
          nativeAcceleration: config.get('nativeAcceleration', 'auto'),
          isRemote,
          // Remote-SSH (not WSL/Dev Container): startLocalLoad will try
          // port-forwarded HTTP, then either on-demand slices (large files)
          // or a full fetch (small files). The webview skips the HTTP-preview
          // fallback timer while that message is in flight.
          isRemoteSsh: !isParsed && !isRemote && isWanRemote(),
          deferFullVolume: isParsed ? false : (isRemote || shouldUseSliceMode(fileSize)),
          skipHttpFallback: isParsed,
          hostParsed: isParsed,
          fileUrl,
          directUrl: isRemote && !isParsed ? pair.dataUri.toString() : '',
          fileName: path.basename(uri.fsPath ?? uri.toString()),
          webviewId,
          loadId,
          fileSize,
          validationToken,
        });

        if (parsedFormat) {
          await this.loadParsedVolume(
            webview, webviewId, loadId, uri, abortController.signal, parsedFormat, fileSize, validationToken
          );
          return;
        }

        if (isAnalyzeHeaderPath(uri.fsPath || uri.path) && !pair.separateImg) {
          vscode.window.showWarningMessage('NiftiSpy: no matching .img next to this .hdr — voxel data was not found.');
        }

        if (isRemote && entryId) {
          this.loader.startPreviewLoad(entryId, webview, webviewId, loadId, uri, abortController.signal);
        } else if (!isRemote) {
          this.loader.startLocalLoad(webview, webviewId, loadId, uri, abortController.signal, fileSize, validationToken, pair);
        }
      } else if (msg.type === 'remoteHttpFallback') {
        // Host-parsed volume: the forwarded proxy URL is unreachable, so read
        // the file in the host and push it through the normal cachedVolume path.
        // The loadId keeps concurrent images in one webview independent.
        const fallbackId = String(msg.loadId || msg.webviewId || '');
        const parsedFb = this.parsedRemoteFallbacks.get(fallbackId);
        if (parsedFb) {
          this.parsedRemoteFallbacks.delete(fallbackId);
          this.logPerf(`[parsed] webview fetch failed (${String(msg.reason || 'unknown')}) — reading in host`);
          try {
            const { parsed, tempFiles } = await this.parseVolumeUri(parsedFb.uri, parsedFb.format, true);
            if (tempFiles.length) this.trackParsedTemps(msg.webviewId, tempFiles);
            if (parsed.rawData && !parsedFb.signal.aborted) {
              this.publishParsedVolume(
                parsedFb.webview, parsedFb.uri.toString(), parsed.header, parsed.rawData, parsedFb.signal
              );
            }
          } catch (err) {
            if (parsedFb.signal.aborted) return;
            const message = errorMessage(err);
            parsedFb.webview.postMessage({ type: 'loadError', message });
            vscode.window.showErrorMessage(`NiftiSpy: cannot open ${path.basename(parsedFb.uri.fsPath || parsedFb.uri.path)} — ${message}`);
          }
          return;
        }
        // The webview could not fetch the port-forwarded proxy URL
        // (forwarding blocked / CSP / tunnel hiccup). Resume the legacy
        // chunked postMessage transfer from the stashed context.
        const fb = this.remoteHttpFallbacks.get(fallbackId);
        this.remoteHttpFallbacks.delete(fallbackId);
        if (!fb || fb.signal.aborted) return;
        this.logPerf(`[remote-ssh-http] webview fetch failed (${String(msg.reason || 'unknown')}), falling back to chunked transfer`);
        await this.loader.remoteSshChunkedLoad(fb.webview, fb.fsPath, fb.fileSize, fb.validationToken, fb.signal, fb.isGzip);
      } else if (msg.type === 'perfReport') {
        this.handlePerfReport(msg);
      } else if (msg.type === 'selectImage') {
        const files = await vscode.window.showOpenDialog({
          canSelectMany: false,
          filters: {
            'Volumes': ['nii', 'nii.gz', 'hdr', 'img', ...VOLUME_EXTENSIONS.map(ext => ext.slice(1))],
          },
          title: 'Select Image File',
        });
        if (files && files.length > 0) {
          const imgUri = files[0];
          const imgPair = await resolveAnalyzePair(imgUri);
          const imgIsRemote = imgUri.scheme !== 'file';
          const imgFileName = path.basename(imgUri.fsPath ?? imgUri.toString());
          const imgIsGzip = (imgPair.dataUri.fsPath || imgUri.fsPath)?.endsWith('.gz') ?? false;
          const imgWebviewId = msg.webviewId || webviewId;
          const imgFormat = findVolumeFormat(imgUri.fsPath || imgUri.path);
          const imgLoadId = this.newLoadId();

          if (imgFormat) {
            // Add Image must carry the same size/token as a fresh open, or the
            // slice-mode decision and IndexedDB cache key are both lost.
            let imgFileSize = 0;
            let imgValidationToken = '';
            try {
              if (imgIsRemote) {
                const st = await vscode.workspace.fs.stat(imgUri);
                imgFileSize = Number(st.size);
                imgValidationToken = `${st.mtime}:${st.size}`;
              } else if (imgUri.fsPath) {
                const st = await fs.promises.stat(imgUri.fsPath);
                imgFileSize = st.size;
                imgValidationToken = `${st.mtimeMs}:${st.ctimeMs}:${st.size}:${st.ino}`;
              }
            } catch {
              // size/token are optional; parsing still works
            }
            webview.postMessage({
              type: 'newImage',
              fileUrl: imgIsRemote ? imgUri.toString() : webview.asWebviewUri(imgUri).toString(),
              fileName: imgFileName,
              isGzip: false,
              isRemote: imgIsRemote,
              hostParsed: true,
              webviewId: imgWebviewId,
              loadId: imgLoadId,
            });
            await this.loadParsedVolume(
              webview, imgWebviewId, imgLoadId, imgUri, new AbortController().signal,
              imgFormat, imgFileSize, imgValidationToken
            );
            return;
          }

          if (imgIsRemote) {
            if (!this.proxy) {
              this.proxy = new LocalFileProxy(this.volumeCache);
              await this.proxy.start();
              this.context.subscriptions.push({ dispose: () => this.proxy?.stop() });
            }
            const imgUrl = this.proxy.registerFile(imgPair.headerUri, imgPair.separateImg ? imgPair.dataUri : undefined);
            const entryId = imgUrl.split('/').pop()!;
            webview.postMessage({
              type: 'newImage',
              fileUrl: imgUrl,
              directUrl: imgPair.dataUri.toString(),
              fileName: imgFileName,
              isGzip: imgIsGzip,
              isRemote: true,
              webviewId: imgWebviewId,
              loadId: imgLoadId,
            });
            this.loader.startPreviewLoad(entryId, webview, imgWebviewId, imgLoadId, imgUri, new AbortController().signal);
          } else {
            // Local file: direct webview URI + postMessage (same as initial open).
            const imgUrl = webview.asWebviewUri(imgPair.dataUri).toString();
            // stat for size-aware dispatch + cache validation (mirrors initial open).
            let imgFileSize = 0;
            let imgValidationToken = '';
            try {
              if (imgPair.dataUri.fsPath) {
                const st = await fs.promises.stat(imgPair.dataUri.fsPath);
                imgFileSize = st.size;
                imgValidationToken = `${st.mtimeMs}:${st.size}`;
              }
            } catch {
              // stat may fail for unusual URIs; dispatch falls back to streaming
            }
            webview.postMessage({
              type: 'newImage',
              fileUrl: imgUrl,
              fileName: imgFileName,
              isGzip: imgIsGzip,
              isRemote: false,
              webviewId: imgWebviewId,
              loadId: imgLoadId,
            });
            this.loader.startLocalLoad(webview, imgWebviewId, imgLoadId, imgUri, new AbortController().signal, imgFileSize, imgValidationToken, imgPair);
          }
        }
      } else if (msg.type === 'exportSlice') {
        const { axis, sliceIndex, data } = msg;
        const baseName = path.basename(uri.fsPath ?? uri.toString()).replace(/\.nii(\.gz)?$/, '');
        const defaultName = `${baseName}_${axis}_${sliceIndex}.png`;
        const saveUri = await vscode.window.showSaveDialog({
          defaultUri: vscode.Uri.file(defaultName),
          filters: { 'PNG Images': ['png'] },
          title: 'Export Slice as PNG',
        });
        if (saveUri && data) {
          const pngData = new Uint8Array(data);
          await vscode.workspace.fs.writeFile(saveUri, pngData);
          vscode.window.showInformationMessage(`Slice exported to ${saveUri.fsPath}`);
        }
      } else if (msg.type === 'openExternal') {
        const { url } = msg;
        if (typeof url === 'string' && url.startsWith('https://github.com/MaiwulanjiangMaiming/NiftiSpy/issues')) {
          await vscode.env.openExternal(vscode.Uri.parse(url));
        }
      } else if (msg.type === 'getTemplate') {
        // Registration flow, step 1: resolve the template volume for the
        // requested mode and ship its raw bytes to the webview. The MNI path
        // remembers the chosen file in the user-level `niftispy.mniTemplatePath`
        // setting so subsequent runs start instantly; the custom path always
        // asks. Errors land back in the webview as regStatus failures so the
        // sidebar button state recovers cleanly.
        try {
          const cfg = vscode.workspace.getConfiguration('niftispy');
          let tplPath = msg.mode === 'mni' ? (cfg.get<string>('mniTemplatePath') || '') : '';
          if (!tplPath) {
            const picked = await vscode.window.showOpenDialog({
              canSelectMany: false,
              title: msg.mode === 'mni'
                ? 'Select MNI standard template (e.g. MNI152_T1_2mm.nii.gz)'
                : 'Select custom template volume',
              filters: { 'NIfTI volumes': ['nii', 'gz'] },
            });
            if (!picked || picked.length === 0) {
              webview.postMessage({ type: 'regStatus', mode: msg.mode, ok: false, cancelled: true, message: 'Template selection cancelled' });
              return;
            }
            tplPath = picked[0].fsPath;
            if (msg.mode === 'mni') {
              await cfg.update('mniTemplatePath', tplPath, vscode.ConfigurationTarget.Global);
            }
          }
          const tplUri = vscode.Uri.file(tplPath);
          const bytes = new Uint8Array(await vscode.workspace.fs.readFile(tplUri));
          // postMessage clones buffers (no transfer-list support), so hand it
          // a standalone ArrayBuffer of exact payload size.
          webview.postMessage({
            type: 'templateData',
            mode: msg.mode,
            name: path.basename(tplPath),
            bytes,
          });
        } catch (err) {
          webview.postMessage({
            type: 'regStatus',
            mode: msg.mode,
            ok: false,
            message: `Template load failed: ${errorMessage(err)}`,
          });
        }
      }
    });
  }

  private parseNiiHeaderFromBuffer(buf: Uint8Array, separateImg = false): NiiHeader | null {
    return parseNiiHeaderQuick(buf, { separateImg });
  }

  private async loadParsedVolume(
    webview: vscode.Webview,
    webviewId: string,
    loadId: string,
    uri: vscode.Uri,
    signal: AbortSignal,
    format: VolumeFormat,
    fileSize: number,
    validationToken: string
  ): Promise<void> {
    const uriKey = uri.toString();
    const isRemote = uri.scheme !== 'file';

    if (fileSize <= 0) {
      try {
        fileSize = isRemote
          ? Number((await vscode.workspace.fs.stat(uri)).size)
          : (await fs.promises.stat(uri.fsPath)).size;
      } catch {
        // size is only used to pick a transport strategy
      }
    }

    const cached = this.volumeCache.get(uriKey);
    const wantsSlices = isRemote && isWanRemote() && shouldUseSliceMode(fileSize);
    if (cached && !wantsSlices) {
      this.volumeCache.setActive(uriKey, webviewId);
      webview.postMessage({
        type: 'cachedVolume',
        header: cached.header,
        globalMin: cached.min,
        globalMax: cached.max,
        slope: cached.slope,
        inter: cached.inter,
        sliceIdx: {
          axial: Math.floor(cached.header.nz / 2),
          coronal: Math.floor(cached.header.ny / 2),
          sagittal: Math.floor(cached.header.nx / 2),
        },
        voxelData: cached.voxelData.buffer,
        voxOffset: cached.voxelData.byteOffset,
        voxelLength: cached.voxelData.byteLength,
        datatype: cached.header.datatype,
      });
      return;
    }

    this.volumeCache.setActive(uriKey, webviewId);

    if (isRemote) {
      this.parsedRemoteFallbacks.set(loadId, { webview, uri, format, signal });
      const dispatched = await this.startParsedRemoteLoad(
        webview, webviewId, loadId, uri, format, fileSize, validationToken, signal
      );
      if (dispatched) return;
      this.parsedRemoteFallbacks.delete(loadId);
    }

    try {
      const { parsed, tempFiles } = await this.parseVolumeUri(uri, format, true);
      if (tempFiles.length) this.trackParsedTemps(webviewId, tempFiles);
      if (signal.aborted) return;
      if (!parsed.rawData) throw new Error('parser produced no voxel data');
      this.publishParsedVolume(webview, uriKey, parsed.header, parsed.rawData, signal);
    } catch (err) {
      if (signal.aborted) return;
      const message = errorMessage(err);
      webview.postMessage({ type: 'loadError', message });
      vscode.window.showErrorMessage(
        `NiftiSpy: cannot open ${path.basename(uri.fsPath || uri.path)} — ${message}`
      );
    }
  }

  /**
   * Remote path: keep voxel bytes on the remote disk and let the webview read
   * slices (WAN) or fetch the file once (fast link). Container formats
   * (npz/mgz/gzip nrrd) are materialized once so a slice request never
   * re-inflates the whole stream.
   */
  private async startParsedRemoteLoad(
    webview: vscode.Webview,
    webviewId: string,
    loadId: string,
    uri: vscode.Uri,
    format: VolumeFormat,
    fileSize: number,
    validationToken: string,
    signal: AbortSignal
  ): Promise<boolean> {
    try {
      const { parsed, tempFiles } = await this.parseVolumeUri(uri, format, false);
      if (tempFiles.length) this.trackParsedTemps(webviewId, tempFiles);
      if (signal.aborted) return true;

      if (!parsed.dataPath) {
        // ASCII NRRD has no random-access layout; publish from memory.
        if (parsed.rawData) {
          this.publishParsedVolume(webview, uri.toString(), parsed.header, parsed.rawData, signal);
          return true;
        }
        return false;
      }

      if (!this.proxy) {
        this.proxy = new LocalFileProxy(this.volumeCache);
        await this.proxy.start();
        this.context.subscriptions.push({ dispose: () => this.proxy?.stop() });
      }

      const dataUri = vscode.Uri.file(parsed.dataPath);
      const proxyUrl = this.proxy.registerFile(dataUri, undefined, parsed.header);
      const entryId = proxyUrl.split('/').pop()!;
      // Port-forward the proxy so the local webview can reach the remote disk.
      const external = await vscode.env.asExternalUri(vscode.Uri.parse(proxyUrl));

      let dataSize = fileSize;
      try {
        dataSize = (await fs.promises.stat(parsed.dataPath)).size;
      } catch {
        // keep the header-file size
      }

      const fileName = path.basename(uri.fsPath || uri.path);
      const sliceMode = isWanRemote() && shouldUseSliceMode(dataSize);

      if (sliceMode) {
        let preview: Awaited<ReturnType<LocalFileProxy['extractPreviewForWebview']>> = null;
        try {
          preview = await this.proxy.extractPreviewForWebview(entryId, signal);
        } catch (err) {
          this.logPerf(`[remote-ssh-slice] parsed preview failed (${String(err)}) — dispatching header only`);
        }
        if (signal.aborted) return true;
        const header = preview?.header || parsed.header;
        return webview.postMessage({
          type: 'remoteSliceMode',
          sourceIdentity: `${os.hostname()}|${uri.toString()}`,
          url: external.toString(),
          fileName,
          webviewId,
          loadId,
          fileSize: dataSize,
          validationToken,
          isGzip: false,
          hostParsed: true,
          deferFullVolume: true,
          header,
          globalMin: preview?.globalMin ?? 0,
          globalMax: preview?.globalMax ?? 1,
          slope: header.scl_slope || 1,
          inter: header.scl_inter || 0,
          sliceIdx: preview?.sliceIdx ?? {
            axial: 0,
            coronal: Math.floor(header.ny / 2),
            sagittal: Math.floor(header.nx / 2),
          },
          axialSlice: preview?.slices.axial,
          coronalSlice: preview?.slices.coronal,
          sagittalSlice: preview?.slices.sagittal,
          partialPreview: true,
          perfExtTiming: { isRemoteSSH: true, path: 'remote-parsed-slice' },
        });
      }

      return webview.postMessage({
        type: 'remoteSshHttp',
        sourceIdentity: `${os.hostname()}|${uri.toString()}`,
        url: external.toString(),
        fileName,
        webviewId,
        loadId,
        fileSize: dataSize,
        validationToken,
        isGzip: false,
        hostParsed: true,
        header: parsed.header,
        perfExtTiming: { isRemoteSSH: isWanRemote(), path: 'remote-parsed-http' },
      });
    } catch (err) {
      this.logPerf(`[parsed] remote dispatch failed (${String(err)}) — reading in host`);
      return false;
    }
  }

  /**
   * Parsers read from disk; virtual file systems (vscode-vfs) are materialized
   * once so the same path-based parsers can run.
   */
  private async parseVolumeUri(
    uri: vscode.Uri,
    format: VolumeFormat,
    memory: boolean
  ): Promise<{ parsed: ParsedVolume; tempFiles: string[] }> {
    const fsPath = uri.fsPath;
    // file:// and vscode-remote:// paths both exist on the extension host.
    if (fsPath && (uri.scheme === 'file' || uri.scheme.startsWith('vscode-remote'))) {
      try {
        return { parsed: await format.parse(fsPath, { memory }), tempFiles: [] };
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err;
      }
    }
    const bytes = new Uint8Array(await vscode.workspace.fs.readFile(uri));
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'niftispy-'));
    const file = path.join(dir, path.basename(fsPath || uri.path));
    try {
      await fs.promises.writeFile(file, bytes);
      const parsed = await format.parse(file, { memory: true });
      return { parsed, tempFiles: [file, ...(parsed.tempFiles || [])] };
    } catch (err) {
      await removeTempVolumes([file]);
      throw err;
    }
  }

  private trackParsedTemps(webviewId: string, files: string[]): void {
    const existing = this.parsedTempFiles.get(webviewId);
    if (existing) existing.push(...files);
    else this.parsedTempFiles.set(webviewId, [...files]);
  }

  private publishParsedVolume(
    webview: vscode.Webview,
    uriKey: string,
    header: NiiHeader,
    rawData: Uint8Array,
    _signal: AbortSignal
  ): void {
    const slope = header.scl_slope || 1;
    const inter = header.scl_inter || 0;

    // Publish every timepoint so header.nt always matches the bytes on the
    // wire. Alignment and Float64 downcast are handled in one place.
    const prepared = prepareParsedPayload(header, rawData);
    const payload = prepared.payload;
    const outBytes = prepared.voxelBytes;
    let min: number;
    let max: number;
    if (prepared.min !== undefined && prepared.max !== undefined) {
      min = prepared.min;
      max = prepared.max;
    } else {
      const stats = computeVoxelStats(payload, header);
      min = stats.min;
      max = stats.max;
    }
    const voxelOnly = payload.subarray(header.voxOffset, header.voxOffset + outBytes);

    this.volumeCache.set(uriKey, {
      header,
      voxelData: voxelOnly,
      min,
      max,
      slope,
      inter,
    });
    this.updateCacheStatusBar();

    webview.postMessage({
      type: 'cachedVolume',
      header,
      voxelData: voxelOnly.buffer,
      voxOffset: voxelOnly.byteOffset,
      voxelLength: outBytes,
      datatype: header.datatype,
      globalMin: min,
      globalMax: max,
      slope,
      inter,
      sliceIdx: {
        axial: Math.floor(header.nz / 2),
        coronal: Math.floor(header.ny / 2),
        sagittal: Math.floor(header.nx / 2),
      },
    });

  }

  private isWebviewActive(webviewId: string): boolean {
    const entry = this.activeWebviews.get(webviewId);
    return !!entry && entry.panel.active;
  }

  private showChunkProgress(loaded: number, total: number): void {
    if (!this.chunkProgressItem) {
      this.chunkProgressItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
    }
    const pct = total > 0 ? Math.round((loaded / total) * 100) : 0;
    this.chunkProgressItem.text = `$(database) Chunks: ${loaded}/${total} (${pct}%)`;
    this.chunkProgressItem.show();
  }

  private hideChunkProgress(): void {
    if (this.chunkProgressItem) {
      this.chunkProgressItem.hide();
    }
  }

}
