import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as zlib from 'zlib';
import { LocalFileProxy } from './LocalFileProxy';
import { VolumeCache } from './VolumeCache';
import { GzipIndex, loadCachedIndex, saveCachedIndex } from './io/gzipIndex';
import { downsampleSlice } from './nifti/sliceExtractor';
import { getNativeBindings } from './nativeBridge';

interface LoadJob {
  webviewId: string;
  priority: number;
  isRemote: boolean;
  abortController: AbortController;
  execute: () => Promise<void>;
}

class LoadQueue {
  private queue: LoadJob[] = [];
  private activeRemote = 0;
  private activeLocal = 0;
  private maxRemote = 3;
  private maxLocal = 2;

  enqueue(job: LoadJob): void {
    // Binary insert — O(log n) instead of O(n log n) sort
    let lo = 0, hi = this.queue.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.queue[mid].priority > job.priority) lo = mid + 1;
      else hi = mid;
    }
    this.queue.splice(lo, 0, job);
    this.processNext();
  }

  promote(webviewId: string): void {
    const idx = this.queue.findIndex(j => j.webviewId === webviewId);
    if (idx >= 0) {
      this.queue[idx].priority = 100;
      // Re-insert in sorted position
      const job = this.queue.splice(idx, 1)[0];
      let lo = 0, hi = this.queue.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (this.queue[mid].priority > job.priority) lo = mid + 1;
        else hi = mid;
      }
      this.queue.splice(lo, 0, job);
    }
  }

  cancel(webviewId: string): void {
    for (let i = this.queue.length - 1; i >= 0; i--) {
      if (webviewId === '__all__' || this.queue[i].webviewId === webviewId) {
        this.queue[i].abortController.abort();
        this.queue.splice(i, 1);
      }
    }
  }

  private processNext(): void {
    while (this.queue.length > 0) {
      const remoteOk = this.activeRemote < this.maxRemote;
      const localOk = this.activeLocal < this.maxLocal;
      if (!remoteOk && !localOk) break;

      const idx = this.queue.findIndex(j => {
        if (j.abortController.signal.aborted) return false;
        return j.isRemote ? remoteOk : localOk;
      });
      if (idx < 0) break;

      const job = this.queue.splice(idx, 1)[0];
      if (job.isRemote) this.activeRemote++;
      else this.activeLocal++;
      job.execute().finally(() => {
        if (job.isRemote) this.activeRemote--;
        else this.activeLocal--;
        this.processNext();
      });
    }
  }
}

export class NiiEditorProvider implements vscode.CustomReadonlyEditorProvider {
  private proxy: LocalFileProxy | null = null;
  private volumeCache: VolumeCache;
  private loadQueue: LoadQueue;
  private webviewCounter = 0;
  private activeWebviews = new Map<string, { panel: vscode.WebviewPanel; abortController: AbortController }>();
  private gzipIndexes = new Map<string, GzipIndex>();
  private gzipIndexStatusItems = new Map<string, vscode.Disposable>();
  private chunkProgressItem: vscode.StatusBarItem | null = null;
  private nativeStatusBarItem: vscode.StatusBarItem | null = null;
  private cacheStatusBarItem: vscode.StatusBarItem | null = null;
  private nativeFallbackWarned = false;
  private perfChannel: vscode.OutputChannel | null = null;

  constructor(private readonly context: vscode.ExtensionContext, volumeCache: VolumeCache) {
    this.volumeCache = volumeCache;
    this.loadQueue = new LoadQueue();
    this.cacheStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 97);
    this.updateCacheStatusBar();
    this.cacheStatusBarItem.show();
    this.perfChannel = vscode.window.createOutputChannel('NiftiSpy Performance');
  }

  private logPerf(line: string): void {
    if (this.perfChannel) {
      this.perfChannel.appendLine(line);
      // Only auto-reveal the output panel when the user has opted in.
      // Default is false so the published extension never pops the panel
      // on every volume load; enable via "niftispy.showPerfReport": true.
      const show = vscode.workspace
        .getConfiguration('niftispy')
        .get<boolean>('showPerfReport', false);
      if (show) {
        this.perfChannel.show(true);
      }
    }
  }

  private handlePerfReport(msg: any): void {
    try {
      const ext = msg.ext || {};
      const stream = ext.stream || {};
      const voxelMB = ((msg.voxelBytes || 0) / (1024 * 1024)).toFixed(1);
      const lines: string[] = [];
      lines.push('┌─────────────────────────────────────────────────────────────┐');
      lines.push(`│ NiftiSpy Load Performance Report  —  ${new Date().toLocaleTimeString()}`);
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
          lines.push(`│   ${tag} decompress        : ${stream.totalDecompress ?? '?'} ms (pure inflate)`);
        }
        const decompressedMB = ((stream.decompressedBytes || 0) / (1024 * 1024)).toFixed(1);
        lines.push(`│   ${tag} decompressed size : ${decompressedMB} MB`);
        if (stream.totalDecompress > 0 && stream.decompressedBytes > 0) {
          const throughput = ((stream.decompressedBytes / (1024 * 1024)) / (stream.totalDecompress / 1000)).toFixed(0);
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
    // Close HTTP proxy server
    this.proxy?.stop();
    this.proxy = null;
    // Dispose all status bar items
    this.cacheStatusBarItem?.dispose();
    this.nativeStatusBarItem?.dispose();
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

    if (isRemote) {
      if (!this.proxy) {
        this.proxy = new LocalFileProxy(this.volumeCache);
        await this.proxy.start();
        this.context.subscriptions.push({ dispose: () => this.proxy?.stop() });
      }
      fileUrl = this.proxy.registerFile(uri);
      entryId = fileUrl.split('/').pop()!;
    } else {
      // Local file: direct webview URI + postMessage. Worker fetch of
      // asWebviewUri URLs is unreliable across VS Code versions, so we
      // keep the proven postMessage path (Float64→Float32 + zero-copy
      // buffer + streaming gz load with 16MB highWaterMark).
      fileUrl = webview.asWebviewUri(uri).toString();
    }

    webview.html = this.buildHtml(webview, fileUrl, uri.fsPath ?? uri.toString());

    webviewPanel.onDidChangeViewState(() => {
      if (webviewPanel.active) {
        this.loadQueue.promote(webviewId);
        this.volumeCache.setActive(uri.toString(), webviewId);
      }
    });

    webviewPanel.onDidDispose(() => {
      abortController.abort();
      this.loadQueue.cancel(webviewId);
      this.volumeCache.setActive(uri.toString(), null);
      this.activeWebviews.delete(webviewId);
    });

    webview.onDidReceiveMessage(async (msg) => {
      if (msg.type === 'ready') {
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
          if (!isRemote && uri.fsPath) {
            const stat = await fs.promises.stat(uri.fsPath);
            fileSize = stat.size;
            validationToken = `${stat.mtimeMs}:${stat.size}`;
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
          fullVolumePolicy: config.get('fullVolumePolicy', 'debounced'),
          nativeAcceleration: config.get('nativeAcceleration', 'auto'),
          isRemote,
          fileUrl,
          directUrl: isRemote ? uri.toString() : '',
          fileName: path.basename(uri.fsPath ?? uri.toString()),
          webviewId,
          fileSize,
          validationToken,
        });

        if (isRemote && entryId) {
          this.startPreviewLoad(entryId, webview, webviewId, uri, abortController.signal);
        } else if (!isRemote) {
          this.startLocalLoad(webview, webviewId, uri, abortController.signal);
        }
      } else if (msg.type === 'perfReport') {
        this.handlePerfReport(msg);
      } else if (msg.type === 'selectImage') {
        const files = await vscode.window.showOpenDialog({
          canSelectMany: false,
          filters: { 'NIfTI Files': ['nii', 'nii.gz'] },
          title: 'Select Image File',
        });
        if (files && files.length > 0) {
          const imgUri = files[0];
          const imgIsRemote = imgUri.scheme !== 'file';
          const imgFileName = path.basename(imgUri.fsPath ?? imgUri.toString());
          const imgIsGzip = imgUri.fsPath?.endsWith('.gz') ?? false;
          const imgWebviewId = msg.webviewId || webviewId;

          if (imgIsRemote) {
            if (!this.proxy) {
              this.proxy = new LocalFileProxy(this.volumeCache);
              await this.proxy.start();
              this.context.subscriptions.push({ dispose: () => this.proxy?.stop() });
            }
            const imgUrl = this.proxy.registerFile(imgUri);
            const entryId = imgUrl.split('/').pop()!;
            webview.postMessage({
              type: 'newImage',
              fileUrl: imgUrl,
              directUrl: imgUri.toString(),
              fileName: imgFileName,
              isGzip: imgIsGzip,
              isRemote: true,
            });
            this.startPreviewLoad(entryId, webview, imgWebviewId, imgUri, new AbortController().signal);
          } else {
            // Local file: direct webview URI + postMessage (same as initial open).
            const imgUrl = webview.asWebviewUri(imgUri).toString();
            webview.postMessage({
              type: 'newImage',
              fileUrl: imgUrl,
              fileName: imgFileName,
              isGzip: imgIsGzip,
              isRemote: false,
            });
            this.startLocalLoad(webview, imgWebviewId, imgUri, new AbortController().signal);
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
      }
    });
  }

  private parseNiiHeaderFromBuffer(buf: Uint8Array): any | null {
    if (buf.length < 348) return null;
    const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const le = v.getInt32(0, true) === 348 || v.getInt32(0, true) === 540;
    if (!le && v.getInt32(0, false) !== 348 && v.getInt32(0, false) !== 540) return null;
    const sizeofHdr = v.getInt32(0, le);
    const version = sizeofHdr === 540 ? 2 : 1;
    let nx: number, ny: number, nz: number, dx: number, dy: number, dz: number;
    let datatype: number, bitpix: number, voxOffset: number;
    let scl_slope: number, scl_inter: number;
    let qform_code: number, sform_code: number;
    let quatern_b: number, quatern_c: number, quatern_d: number;
    let qoffset_x: number, qoffset_y: number, qoffset_z: number;
    let srow_x: number[], srow_y: number[], srow_z: number[];

    if (version === 1) {
      nx = Math.max(1, v.getInt16(42, le)); ny = Math.max(1, v.getInt16(44, le)); nz = Math.max(1, v.getInt16(46, le));
      datatype = v.getInt16(70, le); bitpix = v.getInt16(72, le);
      dx = Math.abs(v.getFloat32(80, le)) || 1; dy = Math.abs(v.getFloat32(84, le)) || 1; dz = Math.abs(v.getFloat32(88, le)) || 1;
      voxOffset = Math.max(352, v.getFloat32(108, le));
      scl_slope = v.getFloat32(112, le); scl_inter = v.getFloat32(116, le);
      qform_code = v.getInt16(252, le); sform_code = v.getInt16(254, le);
      quatern_b = v.getFloat32(256, le); quatern_c = v.getFloat32(260, le); quatern_d = v.getFloat32(264, le);
      qoffset_x = v.getFloat32(268, le); qoffset_y = v.getFloat32(272, le); qoffset_z = v.getFloat32(276, le);
      srow_x = [v.getFloat32(280, le), v.getFloat32(284, le), v.getFloat32(288, le), v.getFloat32(292, le)];
      srow_y = [v.getFloat32(296, le), v.getFloat32(300, le), v.getFloat32(304, le), v.getFloat32(308, le)];
      srow_z = [v.getFloat32(312, le), v.getFloat32(316, le), v.getFloat32(320, le), v.getFloat32(324, le)];
    } else {
      const readInt64 = (off: number) => { const lo = v.getUint32(off, le); const hi = v.getInt32(off + 4, le); return hi * 0x100000000 + lo; };
      nx = readInt64(24); ny = readInt64(32); nz = readInt64(40);
      datatype = v.getInt16(12, le); bitpix = v.getInt16(14, le);
      dx = Math.abs(v.getFloat64(104, le)) || 1; dy = Math.abs(v.getFloat64(112, le)) || 1; dz = Math.abs(v.getFloat64(120, le)) || 1;
      voxOffset = Math.max(544, readInt64(168));
      scl_slope = v.getFloat64(176, le); scl_inter = v.getFloat64(184, le);
      qform_code = v.getInt16(196, le); sform_code = v.getInt16(198, le);
      quatern_b = v.getFloat32(200, le); quatern_c = v.getFloat32(204, le); quatern_d = v.getFloat32(208, le);
      qoffset_x = v.getFloat32(212, le); qoffset_y = v.getFloat32(216, le); qoffset_z = v.getFloat32(220, le);
      srow_x = [v.getFloat64(224, le), v.getFloat64(232, le), v.getFloat64(240, le), v.getFloat64(248, le)];
      srow_y = [v.getFloat64(256, le), v.getFloat64(264, le), v.getFloat64(272, le), v.getFloat64(280, le)];
      srow_z = [v.getFloat64(288, le), v.getFloat64(296, le), v.getFloat64(304, le), v.getFloat64(312, le)];
    }

    return {
      version, ndim: 3, nx, ny, nz, nt: 1, nu: 1, dx, dy, dz, dt: 0, datatype, bitpix, voxOffset,
      scl_slope: scl_slope || 1, scl_inter: scl_inter || 0,
      littleEndian: le, qform_code, sform_code, quatern_b, quatern_c, quatern_d,
      qoffset_x, qoffset_y, qoffset_z, srow_x, srow_y, srow_z,
      isGzip: false, bytesPerVoxel: Math.max(1, bitpix / 8),
      totalVoxels3D: nx * ny * nz, sliceSizeXY: nx * ny,
      volumeBytes: nx * ny * nz * Math.max(1, bitpix / 8),
      descrip: '', xyzt_units: 0, orientation: '',
    };
  }

  private computeVoxelStats(rawData: Uint8Array, header: any, fsPath?: string): { min: number; max: number } {
    // Try native mmap_get_volume_stats for faster computation
    const native = getNativeBindings();
    if (native?.mmapGetVolumeStats && fsPath && !fsPath.endsWith('.gz')) {
      try {
        const stats = native.mmapGetVolumeStats(fsPath, header);
        if (stats) {
          return { min: stats.min, max: stats.max };
        }
      } catch {
        // Fall through to JS implementation
      }
    }

    const { nx, ny, nz, datatype, scl_slope, scl_inter, littleEndian, voxOffset } = header;
    const n = nx * ny * nz;
    const slope = scl_slope || 1;
    const inter = scl_inter || 0;
    const elemSize = datatype === 64 ? 8 : datatype === 8 || datatype === 16 || datatype === 768 ? 4 : datatype === 4 || datatype === 512 ? 2 : 1;
    const le = littleEndian;
    let min = Infinity, max = -Infinity;
    const sampleStep = Math.max(1, Math.floor(n / 50000));
    const byteOff = rawData.byteOffset + voxOffset;
    const needsConversion = slope !== 1 || inter !== 0;

    // Fast path: use typed array views for little-endian data (common case)
    // Typed array access is 3-5x faster than DataView for sequential reads
    if (le && (byteOff % elemSize === 0) && (byteOff + n * elemSize <= rawData.buffer.byteLength)) {
      if (!needsConversion) {
        switch (datatype) {
          case 2: { const a = new Uint8Array(rawData.buffer, byteOff, n); for (let i = 0; i < n; i += sampleStep) { const v = a[i]; if (v < min) min = v; if (v > max) max = v; } break; }
          case 4: { const a = new Int16Array(rawData.buffer, byteOff, n); for (let i = 0; i < n; i += sampleStep) { const v = a[i]; if (v < min) min = v; if (v > max) max = v; } break; }
          case 8: { const a = new Int32Array(rawData.buffer, byteOff, n); for (let i = 0; i < n; i += sampleStep) { const v = a[i]; if (v < min) min = v; if (v > max) max = v; } break; }
          case 16: { const a = new Float32Array(rawData.buffer, byteOff, n); for (let i = 0; i < n; i += sampleStep) { const v = a[i]; if (v < min) min = v; if (v > max) max = v; } break; }
          case 64: { const a = new Float64Array(rawData.buffer, byteOff, n); for (let i = 0; i < n; i += sampleStep) { const v = a[i]; if (v < min) min = v; if (v > max) max = v; } break; }
          case 256: { const a = new Int8Array(rawData.buffer, byteOff, n); for (let i = 0; i < n; i += sampleStep) { const v = a[i]; if (v < min) min = v; if (v > max) max = v; } break; }
          case 512: { const a = new Uint16Array(rawData.buffer, byteOff, n); for (let i = 0; i < n; i += sampleStep) { const v = a[i]; if (v < min) min = v; if (v > max) max = v; } break; }
          case 768: { const a = new Uint32Array(rawData.buffer, byteOff, n); for (let i = 0; i < n; i += sampleStep) { const v = a[i]; if (v < min) min = v; if (v > max) max = v; } break; }
          default: { const a = new Float32Array(rawData.buffer, byteOff, n); for (let i = 0; i < n; i += sampleStep) { const v = a[i]; if (v < min) min = v; if (v > max) max = v; } break; }
        }
      } else {
        switch (datatype) {
          case 2: { const a = new Uint8Array(rawData.buffer, byteOff, n); for (let i = 0; i < n; i += sampleStep) { const v = a[i] * slope + inter; if (v < min) min = v; if (v > max) max = v; } break; }
          case 4: { const a = new Int16Array(rawData.buffer, byteOff, n); for (let i = 0; i < n; i += sampleStep) { const v = a[i] * slope + inter; if (v < min) min = v; if (v > max) max = v; } break; }
          case 8: { const a = new Int32Array(rawData.buffer, byteOff, n); for (let i = 0; i < n; i += sampleStep) { const v = a[i] * slope + inter; if (v < min) min = v; if (v > max) max = v; } break; }
          case 16: { const a = new Float32Array(rawData.buffer, byteOff, n); for (let i = 0; i < n; i += sampleStep) { const v = a[i] * slope + inter; if (v < min) min = v; if (v > max) max = v; } break; }
          case 64: { const a = new Float64Array(rawData.buffer, byteOff, n); for (let i = 0; i < n; i += sampleStep) { const v = a[i] * slope + inter; if (v < min) min = v; if (v > max) max = v; } break; }
          case 256: { const a = new Int8Array(rawData.buffer, byteOff, n); for (let i = 0; i < n; i += sampleStep) { const v = a[i] * slope + inter; if (v < min) min = v; if (v > max) max = v; } break; }
          case 512: { const a = new Uint16Array(rawData.buffer, byteOff, n); for (let i = 0; i < n; i += sampleStep) { const v = a[i] * slope + inter; if (v < min) min = v; if (v > max) max = v; } break; }
          case 768: { const a = new Uint32Array(rawData.buffer, byteOff, n); for (let i = 0; i < n; i += sampleStep) { const v = a[i] * slope + inter; if (v < min) min = v; if (v > max) max = v; } break; }
          default: { const a = new Float32Array(rawData.buffer, byteOff, n); for (let i = 0; i < n; i += sampleStep) { const v = a[i] * slope + inter; if (v < min) min = v; if (v > max) max = v; } break; }
        }
      }
    } else {
      // Fallback: DataView for big-endian or unaligned data
      const view = new DataView(rawData.buffer, byteOff, n * elemSize);
      for (let i = 0; i < n; i += sampleStep) {
        let val: number;
        switch (datatype) {
          case 2: val = view.getUint8(i * elemSize); break;
          case 4: val = view.getInt16(i * elemSize, le); break;
          case 8: val = view.getInt32(i * elemSize, le); break;
          case 16: val = view.getFloat32(i * elemSize, le); break;
          case 64: val = view.getFloat64(i * elemSize, le); break;
          case 256: val = view.getInt8(i * elemSize); break;
          case 512: val = view.getUint16(i * elemSize, le); break;
          case 768: val = view.getUint32(i * elemSize, le); break;
          default: val = view.getFloat32(i * elemSize, le); break;
        }
        val = val * slope + inter;
        if (val < min) min = val;
        if (val > max) max = val;
      }
    }
    if (min === max) max = min + 1;
    if (min > max || !isFinite(min) || !isFinite(max)) { min = 0; max = 1; }
    return { min, max };
  }

  private async startLocalLoad(
    webview: vscode.Webview,
    webviewId: string,
    uri: vscode.Uri,
    signal: AbortSignal
  ): Promise<void> {
    const uriKey = uri.toString();
    const cached = this.volumeCache.get(uriKey);
    if (cached) {
      this.volumeCache.setActive(uriKey, webviewId);
      // Pass the full underlying buffer + voxOffset to avoid a costly
      // buffer.slice() copy on cache-hit (second open of same file).
      const voxelBuffer = cached.voxelData.buffer;
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
        voxelData: voxelBuffer,
        voxOffset: cached.header.voxOffset,
        voxelLength: cached.voxelData.byteLength,
        datatype: cached.header.datatype,
      });
      return;
    }

    const isActive = this.isWebviewActive(webviewId);
    this.loadQueue.enqueue({
      webviewId,
      priority: isActive ? 100 : 1,
      isRemote: false,
      abortController: signal instanceof AbortController ? signal : new AbortController(),
      execute: async () => {
        if (signal.aborted) return;
        try {
          this.volumeCache.setActive(uriKey, webviewId);
          const fsPath = uri.fsPath;
          const isGzip = fsPath.endsWith('.gz');
          const native = getNativeBindings();
          const perfT0 = performance.now();
          let streamTiming: Record<string, any> = {};

          // ── Optimized single-pass load ──
          // For .nii.gz: stream-decompress ONCE, send z=0 preview early,
          //   then send full volume from the same decompression pass.
          // For .nii: read directly (SSD fast), use native mmap stats if available.
          // This eliminates the previous double-read/double-decompress bug.

          let rawData: Uint8Array;
          let header: any;
          let streamStats: { min: number; max: number } | null = null;

          if (isGzip) {
            // ── Strategy: prefer native libdeflate oneshot, fall back to streaming.
            //    Benchmarked on recon_hr.nii.gz (342MB→465MB), Apple Silicon:
            //      native libdeflate oneshot:  ~550-650ms (700-850 MB/s) ← BEST
            //      streaming (chunkSize=16MB): 1153ms (403 MB/s)
            //      gunzipSync (system zlib):   1229ms (378 MB/s) + 231ms fs read
            //      native fastDecompressGzip (zlib-ng): 1153ms (slower than system zlib on ARM64)
            //    libdeflate wins because it uses more aggressive SIMD inflate
            //    (NEON on ARM64) and avoids streaming/event-loop overhead.
            //    Trade-off: no early preview (z=0 during decompression) —
            // ── Strategy: prefer parallel (lgz + rayon), fall back to single-core
            //    oneshot (libdeflate + mmap), then streaming (zlib).
            //
            //    Benchmarked on recon_hr.nii.gz (342MB→465MB), Apple Silicon:
            //      native parallel (lgz + 8 cores):  ~150-300ms  ← BEST (expected)
            //      native oneshot (libdeflate):       ~761ms (standalone) / 1260ms (extension)
            //      streaming (chunkSize=16MB):        ~1153ms (pipelined, early preview)
            //      gunzipSync (system zlib):          ~1229ms + 231ms fs read
            //
            //    Parallel path uses lgz (speculative DEFLATE block-boundary scanner +
            //    rayon) — works on ANY gzip file, not just pigz/bgzf. Pure Rust,
            //    cross-platform (macOS/Linux/Windows, aarch64 + x86_64).
            //
            //    Fallback chain:
            //      parallel → oneshot → streaming
            //    All async variants run on libuv worker thread (not blocking JS main).
            const native = getNativeBindings();
            let result: { rawData: Uint8Array; header: any; stats: { min: number; max: number } | null; timing: Record<string, any> } | null = null;
            let pathUsed: 'parallel' | 'oneshot' | 'streaming' = 'streaming';

            if (native?.fastDecompressGzipParallelAsync) {
              try {
                result = await this.parallelLocalGzLoad(webview, fsPath, signal);
                pathUsed = 'parallel';
              } catch (err) {
                this.logPerf(`[parallel] failed, falling back to oneshot: ${String(err)}`);
                result = null;
              }
            }

            if (!result && (native?.fastDecompressGzipFileAsync || native?.fastDecompressGzipOneshot)) {
              try {
                result = await this.oneshotLocalGzLoad(webview, fsPath, signal);
                pathUsed = 'oneshot';
              } catch (err) {
                this.logPerf(`[oneshot] failed, falling back to streaming: ${String(err)}`);
                result = null;
              }
            }

            if (!result) {
              result = await this.streamingLocalGzLoad(webview, fsPath, signal);
              pathUsed = 'streaming';
            }

            if (!result || signal.aborted) return;
            rawData = result.rawData;
            header = result.header;
            streamStats = result.stats;  // min/max computed during load (full scan, free)
            streamTiming = result.timing;
          } else {
            // .nii: direct read (SSD < 0.5s for 500MB)
            const fullData = await fs.promises.readFile(fsPath);
            if (signal.aborted) return;
            rawData = new Uint8Array(fullData.buffer, fullData.byteOffset, fullData.byteLength);
            header = this.parseNiiHeaderFromBuffer(rawData);
            if (!header) return;
          }

          if (signal.aborted) return;

          const perfT1 = performance.now();
          // ── Float64 → Float32 downcast ──
          // Float64 MRI data is rare and wasteful for visualization: it doubles
          // memory, doubles the Extension→Webview postMessage copy (the single
          // biggest bottleneck), and offers no visual benefit over Float32
          // (23-bit mantissa is far beyond the 8-bit display range).
          // Downcasting cuts 465MB → 232MB for a typical 512³ volume.
          let min: number, max: number;
          if (header.datatype === 64) {
            const n64 = header.nx * header.ny * header.nz;
            const src64 = new Float64Array(rawData.buffer, rawData.byteOffset + header.voxOffset, n64);
            const f32Buf = new ArrayBuffer(n64 * 4);
            const dst32 = new Float32Array(f32Buf);
            let lo = Infinity, hi = -Infinity;
            for (let i = 0; i < n64; i++) {
              const v = src64[i];
              dst32[i] = v;
              if (v < lo) lo = v;
              if (v > hi) hi = v;
            }
            if (lo === hi) hi = lo + 1;
            if (!isFinite(lo) || !isFinite(hi)) { lo = 0; hi = 1; }
            min = lo; max = hi;
            rawData = new Uint8Array(f32Buf);
            header.datatype = 16;       // Float32
            header.bytesPerVoxel = 4;
            header.bitpix = 32;
            header.voxOffset = 0;       // new buffer has no NIfTI header
          } else if (streamStats) {
            // Stats were already computed during streaming decompression
            min = streamStats.min;
            max = streamStats.max;
          } else {
            const stats = this.computeVoxelStats(rawData, header, fsPath);
            min = stats.min;
            max = stats.max;
          }

          const perfT2 = performance.now();
          const nFinal = header.nx * header.ny * header.nz;
          const elemSizeFinal = header.bytesPerVoxel;
          const voxelOnly = rawData.subarray(header.voxOffset, header.voxOffset + nFinal * elemSizeFinal);

          this.volumeCache.set(uriKey, {
            header,
            voxelData: voxelOnly,
            min, max,
            slope: header.scl_slope || 1,
            inter: header.scl_inter || 0,
          });
          this.updateCacheStatusBar();

          const perfT3 = performance.now();
          // Build gzip index in background for .nii.gz files
          if (isGzip && !this.gzipIndexes.has(uriKey)) {
            this.buildGzipIndexInBackground(fsPath, uriKey);
          }

          // ── Avoid double copy: pass the full underlying ArrayBuffer ──
          // Previous code did `voxelOnly.buffer.slice(...)` which COPIED the
          // entire voxel region, then postMessage copied it AGAIN (VS Code
          // webview postMessage doesn't support Transferable). For a 465MB
          // Float64 volume that was ~2s of pure memcpy.
          // Now we pass the full buffer + voxOffset; the webview creates a
          // zero-copy typed-array view at the correct offset.
          const voxelBuffer = rawData.buffer;
          const voxelBytes = nFinal * elemSizeFinal;

          // Measure the synchronous part of postMessage (structured-clone
          // serialization + IPC dispatch). This is the extension-side cost;
          // the webview-side receive time uses a different performance.now()
          // origin (worker startup), so receiveTime - sendTime would be
          // meaningless. We report postMessageSyncMs instead.
          const postMsgStart = performance.now();
          webview.postMessage({
            type: 'cachedVolume',
            header,
            voxelData: voxelBuffer,
            // Webview uses this to create a zero-copy typed-array view at the
            // correct offset, avoiding a costly buffer.slice() on its side too.
            voxOffset: header.voxOffset,
            voxelLength: voxelBytes,
            datatype: header.datatype,
            globalMin: min,
            globalMax: max,
            slope: header.scl_slope || 1,
            inter: header.scl_inter || 0,
            sliceIdx: {
              axial: Math.floor(header.nz / 2),
              coronal: Math.floor(header.ny / 2),
              sagittal: Math.floor(header.nx / 2),
            },
            // Performance instrumentation: webview measures its own receive→render
            // interval (same-origin clock) and posts back a perfReport. Extension
            // reports its own decompress/downcast/cache/serial time. Total wall
            // time = extTotal + postMessageSyncMs + webviewReceiveToRender +
            // IPC latency (not directly measurable; bounded by sync time).
            perfVoxelBytes: voxelBytes,
            perfExtTiming: {
              totalLoad: +(perfT1 - perfT0).toFixed(1),
              downcastOrStats: +(perfT2 - perfT1).toFixed(1),
              cacheSet: +(perfT3 - perfT2).toFixed(1),
              postMessageSync: +(performance.now() - postMsgStart).toFixed(1),
              voxelBytes,
              isGzip,
              stream: streamTiming,
            },
          });
          const postMsgEnd = performance.now();
          // Update the ext timing with actual sync time for the report
          streamTiming.postMessageSync = +(postMsgEnd - postMsgStart).toFixed(1);

          // Defer LOD generation to background — don't block initial display
          setTimeout(() => {
            if (!signal.aborted) {
              this.generateAndSendLOD(webview, header, voxelOnly, signal, fsPath);
            }
          }, 500);
        } catch (err: any) {
          if (err?.name !== 'AbortError') {
            console.error('Local load error:', err);
          }
        }
      },
    });
  }

  /**
   * Single-pass streaming gzip load: decompresses the file once,
   * sends z=0 preview as soon as available, and returns the full
   * decompressed data. Eliminates the previous double-read bug.
   * Also computes min/max during decompression (full scan, free).
   */
  private async streamingLocalGzLoad(
    webview: vscode.Webview,
    fsPath: string,
    signal: AbortSignal
  ): Promise<{ rawData: Uint8Array; header: any; stats: { min: number; max: number } | null; timing: Record<string, number> } | null> {
    const timing: Record<string, number> = {};
    return new Promise((resolve, reject) => {
      // chunkSize: output buffer per flush. Default 16KB causes ~29000 data
      // events for a 465MB volume, dominating runtime with event-loop overhead
      // (observed: 3.5s for 342MB → 465MB). Bumping to 16MB cuts this to ~29
      // events and lets zlib stream large slices per call. Memory cost: one
      // 16MB output buffer (transient, GC'd after end).
      const gunzip = zlib.createGunzip({ chunkSize: 16 * 1024 * 1024 });

      // ── Pre-allocate output buffer using gzip ISIZE ──
      // gzip footer (RFC 1952): last 8 bytes = CRC32 (4) + ISIZE (4, LE u32).
      // ISIZE = uncompressed size mod 2^32. For files < 4GB this is the exact
      // decompressed size. Pre-allocating avoids Buffer.concat (which copies
      // every chunk → 465MB copy, ~50-80ms) and cuts peak memory from
      // ~930MB (chunks[] + concat result) to ~481MB (single outputBuf).
      let outputBuf: Buffer | null = null;
      let outputOffset = 0;
      let preallocSize = 0;
      try {
        const fd = fs.openSync(fsPath, 'r');
        const stat = fs.fstatSync(fd);
        if (stat.size > 8) {
          const tail = Buffer.alloc(8);
          fs.readSync(fd, tail, 0, 8, stat.size - 8);
          const isize = tail.readUInt32LE(4);
          // Sanity: ISIZE must be > compressed size (decompressing expands),
          // non-zero, and < 4GB (otherwise it wrapped and we can't trust it).
          if (isize > 0 && isize < 0xFFFFFFFF && isize > stat.size) {
            outputBuf = Buffer.allocUnsafe(isize);
            preallocSize = isize;
          }
        }
        fs.closeSync(fd);
      } catch { /* fall back to chunks[] path */ }

      const chunks: Buffer[] = [];
      let totalSize = 0;
      let resolved = false;
      let header: any = null;
      let previewSent = false;
      let firstSliceNeeded = Infinity;
      let tFsStart = 0, tFirstData = 0, tHeaderParsed = 0, tPreviewSent = 0, tDecompressEnd = 0;

      // 16MB highWaterMark: fewer syscalls, better SSD throughput.
      // 4MB was too small for 350MB+ files — the stream kept stalling.
      tFsStart = performance.now();
      const fileStream = fs.createReadStream(fsPath, { highWaterMark: 16 * 1024 * 1024 });
      fileStream.pipe(gunzip);

      const onAbort = () => {
        if (!resolved) {
          resolved = true;
          fileStream.destroy();
          gunzip.destroy();
          reject(new DOMException('Aborted', 'AbortError'));
        }
      };
      if (signal) signal.addEventListener('abort', onAbort, { once: true });

      gunzip.on('data', (chunk: Buffer) => {
        if (resolved) return;
        if (signal.aborted) { gunzip.destroy(); return; }
        if (!tFirstData) tFirstData = performance.now();

        if (outputBuf) {
          // Pre-alloc path: copy chunk into pre-allocated buffer (zero-alloc).
          // If chunk overruns pre-alloc (ISIZE was wrong), demote to chunks[]
          // for the rest of the stream — rare, only if gzip footer was corrupt.
          if (outputOffset + chunk.length <= preallocSize) {
            chunk.copy(outputBuf, outputOffset);
            outputOffset += chunk.length;
          } else {
            // Overflow: copy what we already wrote, then push overflowing chunk.
            chunks.push(Buffer.from(outputBuf.subarray(0, outputOffset)));
            chunks.push(chunk);
            outputBuf = null;
          }
        } else {
          chunks.push(chunk);
        }
        totalSize += chunk.length;

        // Parse header as soon as we have enough data
        if (!header && totalSize >= 544) {
          const buf = outputBuf
            ? outputBuf.subarray(0, outputOffset)
            : Buffer.concat(chunks);
          header = this.parseNiiHeaderFromBuffer(new Uint8Array(buf.buffer, buf.byteOffset, buf.length));
          if (header) {
            tHeaderParsed = performance.now();
            const { nx, ny, voxOffset, bytesPerVoxel } = header;
            firstSliceNeeded = voxOffset + nx * ny * bytesPerVoxel;
          }
        }

        // Send z=0 preview as soon as available
        if (header && !previewSent && totalSize >= firstSliceNeeded) {
          previewSent = true;
          tPreviewSent = performance.now();
          const previewBuf = outputBuf
            ? outputBuf.subarray(0, outputOffset)
            : Buffer.concat(chunks);
          this.sendEarlyPreviewFromBuffer(webview, header, previewBuf, signal);
        }
      });

      gunzip.on('end', () => {
        if (signal) signal.removeEventListener('abort', onAbort);
        if (resolved) return;
        resolved = true;
        tDecompressEnd = performance.now();
        let buf: Buffer;
        if (outputBuf && outputOffset === preallocSize) {
          // Pre-alloc success: use buffer directly, NO concat.
          // Saves one 465MB copy (~50-80ms) and 465MB peak memory.
          buf = outputBuf;
        } else {
          buf = Buffer.concat(chunks, totalSize);
        }
        const rawData = new Uint8Array(buf.buffer, buf.byteOffset, buf.length);
        if (!header) {
          header = this.parseNiiHeaderFromBuffer(rawData);
          tHeaderParsed = performance.now();
        }
        if (!header) {
          reject(new Error('Failed to parse NIfTI header'));
          return;
        }
        const tStatsStart = performance.now();
        // Compute min/max in a single pass over the fully decompressed data.
        // This is "free" — we're already touching the data once for cache,
        // and it gives exact stats (vs. the sampled computeVoxelStats).
        const stats = this.computeVoxelStats(rawData, header, fsPath);
        const tStatsEnd = performance.now();
        timing.fsToFirstData = +(tFirstData - tFsStart).toFixed(1);
        timing.headerParse = +(tHeaderParsed - tFirstData).toFixed(1);
        timing.previewReady = +(tPreviewSent - tHeaderParsed).toFixed(1);
        timing.totalDecompress = +(tDecompressEnd - tFsStart).toFixed(1);
        timing.statsCompute = +(tStatsEnd - tStatsStart).toFixed(1);
        timing.decompressedBytes = totalSize;
        resolve({ rawData, header, stats, timing });
      });

      gunzip.on('error', (err) => {
        if (signal) signal.removeEventListener('abort', onAbort);
        if (!resolved) { resolved = true; reject(err); }
      });

      fileStream.on('error', (err) => {
        if (signal) signal.removeEventListener('abort', onAbort);
        if (!resolved) { resolved = true; reject(err); }
      });
    });
  }

  /**
   * Parallel gzip decompression for local .nii.gz files (multi-core, cross-platform).
   *
   * Uses lgz (speculative DEFLATE block-boundary scanner + rayon) to decompress
   * across all available CPU cores. Works on ANY gzip file — not just pigz/bgzf
   * with flush markers — because it forward-searches for valid DEFLATE block
   * starts and decodes each segment with a 32KB LZ77 prefix window.
   *
   * Cross-platform: pure Rust + rayon, no OS-specific dependencies.
   * Compiles and runs on macOS (aarch64 + x86_64), Linux (x86_64 + aarch64),
   * and Windows (x86_64).
   *
   * Expected speedup on Apple Silicon (8 perf cores): 4-6x vs single-threaded
   * libdeflate. 465MB decompress: ~150-300ms standalone, ~250-450ms in extension.
   *
   * Trade-offs:
   *   - No early preview (z=0 during decompression). Preview is sent after
   *     decompression (~250-450ms vs ~50ms for streaming).
   *   - Higher peak memory (~807MB: holds mmap input + decompressed output).
   *
   * Fallback: if lgz fails (decode error, malformed file, etc.), the caller
   * falls back to oneshotLocalGzLoad, then streamingLocalGzLoad.
   */
  private async parallelLocalGzLoad(
    webview: vscode.Webview,
    fsPath: string,
    signal: AbortSignal
  ): Promise<{ rawData: Uint8Array; header: any; stats: { min: number; max: number } | null; timing: Record<string, any> } | null> {
    const timing: Record<string, any> = {};
    const native = getNativeBindings();
    if (!native?.fastDecompressGzipParallelAsync) {
      throw new Error('native fastDecompressGzipParallelAsync unavailable');
    }

    // ── 1. Rust: mmap + lgz speculative parallel decompress (worker thread) ──
    // Entire pipeline (open + mmap + gzip header parse + speculative scan +
    // parallel decode + CRC check) runs in a libuv worker thread via AsyncTask.
    // Returns Node.js Buffer wrapping the decompressed Vec<u8> (heap transfer).
    const tStart = performance.now();
    let decompressed: Uint8Array | Buffer;
    try {
      decompressed = await native.fastDecompressGzipParallelAsync(fsPath);
    } catch (err) {
      throw new Error(`fastDecompressGzipParallelAsync failed: ${String(err)}`);
    }
    const tDecompressEnd = performance.now();
    if (signal.aborted) return null;

    // Zero-copy type view (Buffer IS a Uint8Array in Node.js)
    const rawData: Uint8Array = decompressed;

    // ── 2. Parse NIfTI header ──
    const tHeaderStart = performance.now();
    const header = this.parseNiiHeaderFromBuffer(rawData);
    const tHeaderEnd = performance.now();
    if (!header) {
      throw new Error('Failed to parse NIfTI header after parallel decompression');
    }

    // ── 3. Send early preview (z=0 axial slice) ──
    const decompressedBuf = Buffer.isBuffer(decompressed)
      ? decompressed
      : Buffer.from(decompressed.buffer, decompressed.byteOffset, decompressed.byteLength);
    this.sendEarlyPreviewFromBuffer(webview, header, decompressedBuf, signal);
    const tPreviewSent = performance.now();

    // ── 4. Compute min/max stats ──
    const tStatsStart = performance.now();
    const stats = this.computeVoxelStats(rawData, header, fsPath);
    const tStatsEnd = performance.now();

    // ── 5. Report timings ──
    // All Rust-side work (mmap + scan + parallel decode) is one combined number.
    timing.fsToFirstData = +((tDecompressEnd - tStart).toFixed(1));
    timing.headerParse = +(tHeaderEnd - tHeaderStart).toFixed(1);
    timing.previewReady = +(tPreviewSent - tHeaderEnd).toFixed(1);
    timing.totalDecompress = +((tDecompressEnd - tStart).toFixed(1));
    timing.nativeDecompress = timing.totalDecompress;  // combined (Rust did everything)
    timing.statsCompute = +(tStatsEnd - tStatsStart).toFixed(1);
    timing.decompressedBytes = rawData.byteLength;
    timing.nativeBackend = 'rusty-rapidgzip';
    timing.asyncPath = true;

    return { rawData, header, stats, timing };
  }

  /**
   * One-shot libdeflate decompression for local .nii.gz files.
   *
   * Reads the entire compressed file into memory, then calls the native
   * libdeflate binding to decompress in a single call. ~2x faster than
   * streaming zlib on Apple Silicon because libdeflate uses more aggressive
   * SIMD inflate (NEON) and avoids Node.js stream/event-loop overhead.
   *
   * Trade-off vs streaming:
   *   + ~2x faster total decompress (550-650ms vs 1153ms for 465MB)
   *   - No early preview (z=0 slice during decompression); preview is sent
   *     after decompression instead (~600ms delay vs ~50ms for streaming)
   *   - Higher peak memory (~807MB vs ~481MB: holds compressed + decompressed)
   *
   * Fallback: if native unavailable, ISIZE=0 (multi-stream gzip), or
   * decompression errors, the caller falls back to streamingLocalGzLoad.
   */
  private async oneshotLocalGzLoad(
    webview: vscode.Webview,
    fsPath: string,
    signal: AbortSignal
  ): Promise<{ rawData: Uint8Array; header: any; stats: { min: number; max: number } | null; timing: Record<string, any> } | null> {
    const timing: Record<string, any> = {};
    const native = getNativeBindings();

    // ── Strategy selection ──
    // Prefer fastDecompressGzipFileAsync (mmap + AsyncTask + libdeflate):
    //   - mmap in Rust avoids Node.js fs.readFile overhead (396-1459ms → ~10-50ms)
    //   - AsyncTask runs on libuv worker thread, NOT blocking JS main thread
    //     (eliminates 22-43% slowdown: 964-1133ms → 791ms baseline)
    //   - Single Rust call: mmap + libdeflate oneshot, returns Buffer
    // Fall back to fastDecompressGzipOneshot (sync, V8 Buffer input) only if
    // async version unavailable (older native binary).
    const useAsync = !!native?.fastDecompressGzipFileAsync;
    if (!useAsync && !native?.fastDecompressGzipOneshot) {
      throw new Error('native fastDecompressGzipFileAsync/Oneshot unavailable');
    }

    // ── 1+2. Rust mmap + libdeflate oneshot (async, off-thread) ──
    // For async path: single call returns Promise<Buffer>. Worker thread
    // does: open file → mmap → read ISIZE → pre-allocate → libdeflate inflate
    // → return Vec<u8> (converted to Node Buffer in resolve()).
    // For sync fallback path: TS reads file then calls sync native fn
    // (kept for backward compat with older native binaries).
    const tStart = performance.now();
    let decompressed: Uint8Array | Buffer;
    let tFsEnd: number;
    let tDecompressEnd: number;

    if (useAsync) {
      // Async path: entire fs read + decompress happens in Rust worker thread.
      // We can't separate fs read time from decompress time without Rust-side
      // timing, but the total is what matters (and it's much faster).
      try {
        decompressed = await native!.fastDecompressGzipFileAsync!(fsPath);
      } catch (err) {
        throw new Error(`fastDecompressGzipFileAsync failed: ${String(err)}`);
      }
      if (signal.aborted) return null;
      tFsEnd = performance.now();        // approx (mmap+decompress combined)
      tDecompressEnd = tFsEnd;
    } else {
      // Sync fallback path (older native binary): TS reads file, calls sync fn.
      const compressed = await fs.promises.readFile(fsPath);
      if (signal.aborted) return null;
      tFsEnd = performance.now();
      decompressed = native!.fastDecompressGzipOneshot!(compressed);
      tDecompressEnd = performance.now();
    }

    // Convert to Uint8Array view (zero-copy: napi Buffer IS a Uint8Array,
    // so this is just a type view, no copy. Buffer extends Uint8Array in Node.js.)
    const rawData: Uint8Array = decompressed;

    // ── 3. Parse NIfTI header ──
    const tHeaderStart = performance.now();
    const header = this.parseNiiHeaderFromBuffer(rawData);
    const tHeaderEnd = performance.now();
    if (!header) {
      throw new Error('Failed to parse NIfTI header after libdeflate decompression');
    }

    // ── 4. Send early preview (z=0 axial slice) ──
    // Streaming sends this during decompression (~50ms); oneshot sends it
    // after decompression (~600ms). Still useful for user feedback.
    // Use Buffer view for zero-copy preview extraction.
    const decompressedBuf = Buffer.isBuffer(decompressed)
      ? decompressed
      : Buffer.from(decompressed.buffer, decompressed.byteOffset, decompressed.byteLength);
    this.sendEarlyPreviewFromBuffer(webview, header, decompressedBuf, signal);
    const tPreviewSent = performance.now();

    // ── 5. Compute min/max stats (full scan, free) ──
    const tStatsStart = performance.now();
    const stats = this.computeVoxelStats(rawData, header, fsPath);
    const tStatsEnd = performance.now();

    // ── 6. Report timings ──
    // For async path: fsToFirstData and nativeDecompress are not separable
    // (both happen in Rust worker thread). Report combined as totalDecompress
    // and set nativeDecompress = totalDecompress for backward-compat display.
    if (useAsync) {
      timing.fsToFirstData = +((tFsEnd - tStart).toFixed(1));
      timing.headerParse = +(tHeaderEnd - tHeaderStart).toFixed(1);
      timing.previewReady = +(tPreviewSent - tHeaderEnd).toFixed(1);
      // totalDecompress = entire Rust worker time (mmap + inflate + buffer transfer)
      timing.totalDecompress = +((tDecompressEnd - tStart).toFixed(1));
      // nativeDecompress reported as same (Rust didn't break it down).
      // Display layer will show "[libdeflate] native decompress" = total.
      timing.nativeDecompress = timing.totalDecompress;
      timing.statsCompute = +(tStatsEnd - tStatsStart).toFixed(1);
      timing.decompressedBytes = rawData.byteLength;
      timing.nativeBackend = 'libdeflate';
      timing.asyncPath = true;
    } else {
      timing.fsToFirstData = +((tFsEnd - tStart).toFixed(1));
      timing.headerParse = +(tHeaderEnd - tHeaderStart).toFixed(1);
      timing.previewReady = +(tPreviewSent - tHeaderEnd).toFixed(1);
      timing.totalDecompress = +((tDecompressEnd - tStart).toFixed(1));
      timing.nativeDecompress = +((tDecompressEnd - tFsEnd).toFixed(1));
      timing.statsCompute = +(tStatsEnd - tStatsStart).toFixed(1);
      timing.decompressedBytes = rawData.byteLength;
      timing.nativeBackend = 'libdeflate';
      timing.asyncPath = false;
    }

    return { rawData, header, stats, timing };
  }

  /**
   * Send z=0 axial preview from a contiguous decompressed buffer.
   * Accepts a Buffer (not Buffer[]) so the pre-alloc path can pass a
   * zero-copy subarray view of outputBuf instead of concatenating chunks.
   */
  private sendEarlyPreviewFromBuffer(
    webview: vscode.Webview,
    header: any,
    buf: Buffer,
    signal: AbortSignal
  ): void {
    try {
      const { nx, ny, voxOffset, bytesPerVoxel, datatype, scl_slope, scl_inter, littleEndian } = header;
      const sliceEnd = voxOffset + nx * ny * bytesPerVoxel;
      if (buf.length < sliceEnd) return;

      const sliceBytes = new Uint8Array(buf.buffer, buf.byteOffset + voxOffset, nx * ny * bytesPerVoxel);
      const bpv = Math.max(1, bytesPerVoxel);
      const le = littleEndian;
      const slope = scl_slope || 1;
      const inter = scl_inter || 0;
      const axialSlice = new Float32Array(nx * ny);
      const view = new DataView(sliceBytes.buffer, sliceBytes.byteOffset, sliceBytes.byteLength);

      let min = Infinity, max = -Infinity;
      for (let i = 0; i < nx * ny; i++) {
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
        const v = val * slope + inter;
        axialSlice[i] = v;
        if (v < min) min = v;
        if (v > max) max = v;
      }
      if (min === max) max = min + 1;

      if (!signal.aborted) {
        webview.postMessage({
          type: 'preview',
          header,
          globalMin: min, globalMax: max,
          slope, inter,
          sliceIdx: { axial: 0, coronal: Math.floor(ny / 2), sagittal: Math.floor(nx / 2) },
          axialSlice,
          coronalSlice: new Float32Array(0),
          sagittalSlice: new Float32Array(0),
          partialPreview: true,
        });
      }
    } catch {
      // Preview failed — non-critical
    }
  }

  /**
   * Send early preview from fully decompressed raw data (native path).
   */
  private sendEarlyPreviewFromRawData(
    webview: vscode.Webview,
    header: any,
    rawData: Uint8Array,
    signal: AbortSignal
  ): void {
    const { nx, ny, voxOffset, bytesPerVoxel, datatype, scl_slope, scl_inter, littleEndian } = header;
    const sliceBytes = rawData.subarray(voxOffset, voxOffset + nx * ny * bytesPerVoxel);
    const bpv = Math.max(1, bytesPerVoxel);
    const le = littleEndian;
    const slope = scl_slope || 1;
    const inter = scl_inter || 0;
    const axialSlice = new Float32Array(nx * ny);
    const view = new DataView(sliceBytes.buffer, sliceBytes.byteOffset, sliceBytes.byteLength);

    let min = Infinity, max = -Infinity;
    for (let i = 0; i < nx * ny; i++) {
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
      const v = val * slope + inter;
      axialSlice[i] = v;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    if (min === max) max = min + 1;

    if (!signal.aborted) {
      webview.postMessage({
        type: 'preview',
        header,
        globalMin: min, globalMax: max,
        slope, inter,
        sliceIdx: { axial: 0, coronal: Math.floor(ny / 2), sagittal: Math.floor(nx / 2) },
        axialSlice,
        coronalSlice: new Float32Array(0),
        sagittalSlice: new Float32Array(0),
        partialPreview: true,
      });
    }
  }

  private startPreviewLoad(
    entryId: string,
    webview: vscode.Webview,
    webviewId: string,
    uri: vscode.Uri,
    signal: AbortSignal
  ): void {
    const uriKey = uri.toString();
    const cached = this.volumeCache.get(uriKey);

    if (cached) {
      this.volumeCache.setActive(uriKey, webviewId);
      const voxelBuffer = cached.voxelData.buffer.slice(
        cached.voxelData.byteOffset,
        cached.voxelData.byteOffset + cached.voxelData.byteLength
      );
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
        voxelData: voxelBuffer,
        datatype: cached.header.datatype,
      });
      return;
    }

    const isActive = this.isWebviewActive(webviewId);
    const isRemote = uri.scheme !== 'file';

    this.loadQueue.enqueue({
      webviewId,
      priority: isActive ? 100 : 1,
      isRemote,
      abortController: signal instanceof AbortController ? signal : new AbortController(),
      execute: async () => {
        if (signal.aborted) return;

        try {
          this.volumeCache.setActive(uriKey, webviewId);

          // For remote files: the webview Worker's streaming path now provides
          // an early preview (within ~1s for .nii.gz) by overlapping download
          // and decompression. Sending a separate preview from the Extension
          // Host would cause a redundant download of the same remote file.
          // Instead, we skip the Extension Host preview and let the Worker
          // handle everything — this cuts total time-to-preview dramatically
          // for remote files.
          //
          // Exception: for non-HTTP remote schemes (vscode-remote://, etc.),
          // the Worker can't stream directly, so we still need the preview.
          const uriScheme = uri.scheme;
          const isHttpRemote = uriScheme === 'http' || uriScheme === 'https';

          if (isRemote && isHttpRemote) {
            // For HTTP(S) remotes: send a minimal "preview pending" message
            // so the webview knows to start the worker immediately without
            // waiting for the 800ms fallback timer.
            webview.postMessage({
              type: 'preview',
              header: null,
              globalMin: 0, globalMax: 1,
              slope: 1, inter: 0,
              sliceIdx: { axial: 0, coronal: 0, sagittal: 0 },
              axialSlice: new Float32Array(0),
              coronalSlice: new Float32Array(0),
              sagittalSlice: new Float32Array(0),
              partialPreview: true,
              remoteStreaming: true,  // signal: start worker now
            });
            return;
          }

          if (isRemote) {
            // Non-HTTP remote (vscode-remote://, etc.): use proxy preview
            const preview = await this.proxy!.extractPreviewForWebview(entryId, signal);
            if (!preview || signal.aborted) return;

            const { header, slices, globalMin, globalMax, slope, inter, sliceIdx } = preview;

            webview.postMessage({
              type: 'preview',
              header,
              globalMin, globalMax,
              slope, inter,
              sliceIdx,
              axialSlice: slices.axial,
              coronalSlice: slices.coronal,
              sagittalSlice: slices.sagittal,
              partialPreview: true,
            });
            return;
          }

          // Local file path: load full volume and send as cachedVolume
          const entry = this.proxy!.getEntry(entryId);
          if (!entry) return;

          const { rawData, header } = await this.proxy!.loadFileData(entry, signal);
          if (!rawData || !header || signal.aborted) return;

          const voxOffset = header.voxOffset;
          const n = header.nx * header.ny * header.nz;
          const elemSize = header.bytesPerVoxel;
          const voxelOnly = rawData.slice(voxOffset, voxOffset + n * elemSize);
          const { min, max } = this.computeVoxelStats(rawData, header);

          this.volumeCache.set(uriKey, {
            header,
            voxelData: voxelOnly,
            min, max,
            slope: header.scl_slope || 1,
            inter: header.scl_inter || 0,
          });
          this.updateCacheStatusBar();

          const voxelBuffer = voxelOnly.buffer.slice(voxelOnly.byteOffset, voxelOnly.byteOffset + voxelOnly.byteLength);

          webview.postMessage({
            type: 'cachedVolume',
            header,
            voxelData: voxelBuffer,
            datatype: header.datatype,
            globalMin: min,
            globalMax: max,
            slope: header.scl_slope || 1,
            inter: header.scl_inter || 0,
            sliceIdx: {
              axial: Math.floor(header.nz / 2),
              coronal: Math.floor(header.ny / 2),
              sagittal: Math.floor(header.nx / 2),
            },
          });

          // Generate LOD levels in background for progressive loading
          this.generateAndSendLOD(webview, header, voxelOnly, signal);
        } catch (err: any) {
          if (err?.name !== 'AbortError') {
            console.error('Preview load error:', err);
          }
        }
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

  private async generateAndSendLOD(
    webview: vscode.Webview,
    header: any,
    voxelOnly: Uint8Array,
    signal: AbortSignal,
    fsPath?: string
  ): Promise<void> {
    const { nx, ny, nz, datatype, scl_slope, scl_inter, littleEndian, bytesPerVoxel } = header;
    const n = nx * ny * nz;
    const bpv = Math.max(1, bytesPerVoxel);
    const le = littleEndian;
    const slope = scl_slope || 1;
    const inter = scl_inter || 0;

    // Convert voxel data to Float32Array for downsampling
    const floatData = new Float32Array(n);
    const view = new DataView(voxelOnly.buffer, voxelOnly.byteOffset, Math.min(voxelOnly.byteLength, n * bpv));
    for (let i = 0; i < n; i++) {
      const off = i * bpv;
      let val: number;
      switch (datatype) {
        case 2: val = voxelOnly[off]; break;
        case 4: val = view.getInt16(off, le); break;
        case 8: val = view.getInt32(off, le); break;
        case 16: val = view.getFloat32(off, le); break;
        case 64: val = view.getFloat64(off, le); break;
        case 256: val = (voxelOnly[off] << 24) >> 24; break;
        case 512: val = view.getUint16(off, le); break;
        case 768: val = view.getUint32(off, le); break;
        default: val = 0;
      }
      floatData[i] = val * slope + inter;
    }

    // Try native mmap_extract_slice_batch for efficient batch slice extraction
    const native = getNativeBindings();
    let nativeBatchAvailable = false;
    if (native?.mmapExtractSliceBatch && fsPath && !fsPath.endsWith('.gz')) {
      nativeBatchAvailable = true;
    }

    // Generate LOD2 (1/4 resolution) — send immediately
    if (signal.aborted) return;
    try {
      let axialSliceLod2: { data: Float32Array; w: number; h: number } | null = null;
      let coronalSliceLod2: { data: Float32Array; w: number; h: number } | null = null;
      let sagittalSliceLod2: { data: Float32Array; w: number; h: number } | null = null;

      // Use mmap_extract_slice_batch for efficient batch extraction from local .nii files
      if (nativeBatchAvailable) {
        try {
          const axialIdx = Math.floor(nz / 2);
          const coronalIdx = Math.floor(ny / 2);
          const sagittalIdx = Math.floor(nx / 2);
          const axialSlices = native!.mmapExtractSliceBatch!(fsPath!, header, 'axial', [axialIdx]);
          const coronalSlices = native!.mmapExtractSliceBatch!(fsPath!, header, 'coronal', [coronalIdx]);
          const sagittalSlices = native!.mmapExtractSliceBatch!(fsPath!, header, 'sagittal', [sagittalIdx]);
          if (axialSlices && axialSlices[0]) {
            const dstW = Math.max(1, Math.floor(nx / 4));
            const dstH = Math.max(1, Math.floor(ny / 4));
            const resampled = native!.fastResampleSlice?.(axialSlices[0], nx, ny, dstW, dstH);
            axialSliceLod2 = resampled ? { data: resampled, w: dstW, h: dstH } : null;
          }
          if (coronalSlices && coronalSlices[0]) {
            const dstW = Math.max(1, Math.floor(nx / 4));
            const dstH = Math.max(1, Math.floor(nz / 4));
            const resampled = native!.fastResampleSlice?.(coronalSlices[0], nx, nz, dstW, dstH);
            coronalSliceLod2 = resampled ? { data: resampled, w: dstW, h: dstH } : null;
          }
          if (sagittalSlices && sagittalSlices[0]) {
            const dstW = Math.max(1, Math.floor(ny / 4));
            const dstH = Math.max(1, Math.floor(nz / 4));
            const resampled = native!.fastResampleSlice?.(sagittalSlices[0], ny, nz, dstW, dstH);
            sagittalSliceLod2 = resampled ? { data: resampled, w: dstW, h: dstH } : null;
          }
        } catch {
          // Fall through to JS path
        }
      }

      // Fallback to JS-based extraction
      if (!axialSliceLod2) {
        axialSliceLod2 = this.extractLODSlice(floatData, nx, ny, nz, 'axial', Math.floor(nz / 2), 4);
      }
      if (!coronalSliceLod2) {
        coronalSliceLod2 = this.extractLODSlice(floatData, nx, ny, nz, 'coronal', Math.floor(ny / 2), 4);
      }
      if (!sagittalSliceLod2) {
        sagittalSliceLod2 = this.extractLODSlice(floatData, nx, ny, nz, 'sagittal', Math.floor(nx / 2), 4);
      }

      if (axialSliceLod2 && !signal.aborted) {
        // Convert Float32Array to ArrayBuffer for efficient transfer
        const axialBuf = axialSliceLod2.data.buffer.slice(
          axialSliceLod2.data.byteOffset,
          axialSliceLod2.data.byteOffset + axialSliceLod2.data.byteLength
        );
        const coronalBuf = coronalSliceLod2 ? coronalSliceLod2.data.buffer.slice(
          coronalSliceLod2.data.byteOffset,
          coronalSliceLod2.data.byteOffset + coronalSliceLod2.data.byteLength
        ) : null;
        const sagittalBuf = sagittalSliceLod2 ? sagittalSliceLod2.data.buffer.slice(
          sagittalSliceLod2.data.byteOffset,
          sagittalSliceLod2.data.byteOffset + sagittalSliceLod2.data.byteLength
        ) : null;

        webview.postMessage({
          type: 'lodData',
          level: 2,
          axial: axialBuf,
          axialW: axialSliceLod2.w,
          axialH: axialSliceLod2.h,
          coronal: coronalBuf,
          coronalW: coronalSliceLod2?.w ?? 0,
          coronalH: coronalSliceLod2?.h ?? 0,
          sagittal: sagittalBuf,
          sagittalW: sagittalSliceLod2?.w ?? 0,
          sagittalH: sagittalSliceLod2?.h ?? 0,
        });
      }
    } catch { /* ignore */ }

    // Generate LOD1 (1/2 resolution) — send after short delay
    await new Promise<void>(r => setTimeout(r, 100));
    if (signal.aborted) return;
    try {
      const axialSliceLod1 = this.extractLODSlice(floatData, nx, ny, nz, 'axial', Math.floor(nz / 2), 2);
      const coronalSliceLod1 = this.extractLODSlice(floatData, nx, ny, nz, 'coronal', Math.floor(ny / 2), 2);
      const sagittalSliceLod1 = this.extractLODSlice(floatData, nx, ny, nz, 'sagittal', Math.floor(nx / 2), 2);
      if (axialSliceLod1 && !signal.aborted) {
        // Convert Float32Array to ArrayBuffer for efficient transfer
        const axialBuf = axialSliceLod1.data.buffer.slice(
          axialSliceLod1.data.byteOffset,
          axialSliceLod1.data.byteOffset + axialSliceLod1.data.byteLength
        );
        const coronalBuf = coronalSliceLod1 ? coronalSliceLod1.data.buffer.slice(
          coronalSliceLod1.data.byteOffset,
          coronalSliceLod1.data.byteOffset + coronalSliceLod1.data.byteLength
        ) : null;
        const sagittalBuf = sagittalSliceLod1 ? sagittalSliceLod1.data.buffer.slice(
          sagittalSliceLod1.data.byteOffset,
          sagittalSliceLod1.data.byteOffset + sagittalSliceLod1.data.byteLength
        ) : null;

        webview.postMessage({
          type: 'lodData',
          level: 1,
          axial: axialBuf,
          axialW: axialSliceLod1.w,
          axialH: axialSliceLod1.h,
          coronal: coronalBuf,
          coronalW: coronalSliceLod1?.w ?? 0,
          coronalH: coronalSliceLod1?.h ?? 0,
          sagittal: sagittalBuf,
          sagittalW: sagittalSliceLod1?.w ?? 0,
          sagittalH: sagittalSliceLod1?.h ?? 0,
        });
      }
    } catch { /* ignore */ }

    // LOD0 is the full volume already sent via cachedVolume — just notify
    await new Promise<void>(r => setTimeout(r, 200));
    if (signal.aborted) return;
    webview.postMessage({ type: 'lodData', level: 0 });
  }

  private extractLODSlice(
    floatData: Float32Array,
    nx: number, ny: number, nz: number,
    axis: 'axial' | 'coronal' | 'sagittal',
    idx: number,
    factor: number = 2
  ): { data: Float32Array; w: number; h: number } | null {
    let slice: Float32Array;
    let w: number, h: number;

    if (axis === 'axial') {
      if (idx < 0 || idx >= nz) return null;
      slice = new Float32Array(nx * ny);
      const base = idx * ny * nx;
      for (let i = 0; i < nx * ny; i++) slice[i] = floatData[base + i];
      w = nx; h = ny;
    } else if (axis === 'coronal') {
      if (idx < 0 || idx >= ny) return null;
      slice = new Float32Array(nx * nz);
      for (let z = 0; z < nz; z++) {
        const base = z * ny * nx + idx * nx;
        for (let x = 0; x < nx; x++) slice[z * nx + x] = floatData[base + x];
      }
      w = nx; h = nz;
    } else {
      if (idx < 0 || idx >= nx) return null;
      slice = new Float32Array(ny * nz);
      for (let z = 0; z < nz; z++) {
        const base = z * ny * nx;
        for (let y = 0; y < ny; y++) slice[z * ny + y] = floatData[base + y * nx + idx];
      }
      w = ny; h = nz;
    }

    // Use native fast_resample_slice for bilinear interpolation when available
    const dstW = Math.max(1, Math.floor(w / factor));
    const dstH = Math.max(1, Math.floor(h / factor));
    const native = getNativeBindings();
    if (native?.fastResampleSlice) {
      try {
        const resampled = native.fastResampleSlice(slice, w, h, dstW, dstH);
        if (resampled) return { data: resampled, w: dstW, h: dstH };
      } catch {
        // Fall through to JS fallback
      }
    }

    const ds = downsampleSlice(slice, w, h, factor);
    return { data: ds.data, w: ds.w, h: ds.h };
  }

  private buildGzipIndexInBackground(fsPath: string, uriKey: string): void {
    // Try loading cached index first
    loadCachedIndex(fsPath).then((cachedIndex) => {
      if (cachedIndex) {
        this.gzipIndexes.set(uriKey, cachedIndex);
        return;
      }

      // No cached index — build one with progress reporting
      const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
      statusItem.text = `$(sync~spin) Building gzip index...`;
      statusItem.show();
      this.gzipIndexStatusItems.set(uriKey, statusItem);

      GzipIndex.buildIndex(fsPath, undefined, (pct: number) => {
        statusItem.text = `$(sync~spin) Building gzip index... ${pct}%`;
      }).then((index) => {
        this.gzipIndexes.set(uriKey, index);
        statusItem.dispose();
        this.gzipIndexStatusItems.delete(uriKey);
        // Save to cache for reuse
        saveCachedIndex(fsPath, index).catch(() => {});
      }).catch(() => {
        statusItem.dispose();
        this.gzipIndexStatusItems.delete(uriKey);
      });
    }).catch(() => {
      // If cache load fails, silently skip
    });
  }

  private buildHtml(
    webview: vscode.Webview,
    _fileUrl: string,
    _filePath: string
  ): string {
    const viewerUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'viewer.js')
    );
    const workerUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'worker.js')
    );

    return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Cross-Origin-Opener-Policy" content="same-origin">
<meta http-equiv="Cross-Origin-Embedder-Policy" content="require-corp">
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none';
           script-src ${webview.cspSource} 'unsafe-inline' 'unsafe-eval' blob:;
           style-src ${webview.cspSource} 'unsafe-inline';
           img-src ${webview.cspSource} data: blob:;
           connect-src ${webview.cspSource} http://127.0.0.1:* http: https: blob: data:;
           worker-src ${webview.cspSource} blob:;">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>NIfTI Fast View</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{
  --bg:#1a1a2e;--bg2:#16213e;--bg3:#0f3460;--border:#2a3f5f;
  --accent:#e94560;--accent2:#c23a51;--text:#eaeaea;--text2:#a0a0a0;
  --success:#00d9ff;--warning:#ffc107;--danger:#ff4757}
body{background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;display:flex;flex-direction:column;height:100vh;overflow:hidden;user-select:none}
#toolbar{display:flex;gap:6px;align-items:center;padding:4px 8px;background:linear-gradient(180deg,var(--bg2),var(--bg));border-bottom:1px solid var(--border);flex-shrink:0;font-size:11px;flex-wrap:wrap;position:relative;z-index:200}
#file-info{flex:1;display:flex;gap:6px;align-items:center;overflow:hidden;min-width:0}
.file-name{font-weight:600;color:var(--accent);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:180px}
.file-detail{display:flex;gap:4px;font-size:10px;color:var(--text2)}
.file-detail span{background:rgba(233,69,96,.15);padding:2px 6px;border-radius:4px;white-space:nowrap;border:1px solid rgba(233,69,96,.3)}
.btn{background:var(--bg3);border:1px solid var(--border);color:var(--text);padding:3px 8px;border-radius:4px;cursor:pointer;font-size:10px;transition:all .1s;white-space:nowrap}
.btn:hover{background:var(--accent);border-color:var(--accent);color:#fff}
.btn.active{background:var(--accent);color:#fff}
.btn-fit{background:rgba(0,217,255,.2);border:1px solid var(--success);color:var(--success)}
.btn-fit:hover{background:var(--success);color:#000}
.tg{display:flex;align-items:center;gap:4px}
.tg label{font-size:9px;color:var(--text2);text-transform:uppercase}
input[type="range"]{width:70px;height:3px;cursor:pointer;-webkit-appearance:none;background:var(--border);border-radius:2px;outline:none}
input[type="range"]::-webkit-slider-thumb{-webkit-appearance:none;width:10px;height:10px;background:var(--accent);border-radius:50%;cursor:pointer}
select{background:var(--bg3);color:var(--text);border:1px solid var(--border);padding:2px 5px;font-size:10px;cursor:pointer;border-radius:3px}
#progress-bar{position:absolute;top:0;left:0;height:3px;background:linear-gradient(90deg,var(--accent),var(--success));width:0%;transition:width .1s;z-index:100}
#main{display:flex;flex:1;min-height:0;position:relative}
#views{flex:1;display:grid;grid-template-columns:1fr 1fr;grid-template-rows:1fr 1fr;gap:2px;background:var(--bg);padding:2px;position:relative;z-index:1}
#views.single-view{grid-template-columns:1fr;grid-template-rows:1fr}
.vc{position:relative;overflow:hidden;background:#000;display:flex;align-items:center;justify-content:center}
.vc.hidden{display:none}
canvas{display:block;image-rendering:pixelated;cursor:crosshair}
.vl{position:absolute;top:5px;left:8px;font-size:12px;color:var(--success);pointer-events:none;font-weight:600;text-shadow:0 1px 2px rgba(0,0,0,.8);z-index:5}
.vi{position:absolute;top:5px;right:8px;font-size:10px;color:var(--text2);pointer-events:none;font-family:monospace;text-shadow:0 1px 2px rgba(0,0,0,.8);z-index:5}
.vb{position:absolute;top:28px;right:5px;width:20px;height:20px;background:rgba(233,69,96,.2);border:1px solid var(--accent);border-radius:4px;cursor:pointer;font-size:10px;color:var(--accent);display:flex;align-items:center;justify-content:center;opacity:0;transition:opacity .15s;z-index:5}
.vc:hover .vb{opacity:1}
.vb:hover{background:var(--accent);color:#fff}
.ssc{position:absolute;bottom:6px;left:8px;right:8px;z-index:5}
.ssc input[type="range"]{width:100%;height:4px}
.dir-label{position:absolute;font-size:10px;color:rgba(255,255,255,.7);pointer-events:none;text-shadow:0 1px 2px rgba(0,0,0,.8);font-weight:600;z-index:5}
.dir-l{left:8px;top:50%;transform:translateY(-50%)}
.dir-r{right:8px;top:50%;transform:translateY(-50%)}
.dir-a{top:8px;left:50%;transform:translateX(-50%)}
.dir-p{bottom:40px;left:50%;transform:translateX(-50%)}
.scale-bar{position:absolute;bottom:24px;right:8px;height:3px;background:rgba(255,255,255,.8);pointer-events:none;border-radius:1px;z-index:5}
.scale-bar span{position:absolute;bottom:5px;left:50%;transform:translateX(-50%);font-size:9px;color:rgba(255,255,255,.9);white-space:nowrap;font-weight:500;text-shadow:0 1px 2px rgba(0,0,0,.5)}
.minimap{position:absolute;bottom:8px;left:8px;width:60px;height:60px;background:rgba(0,0,0,.7);border:1px solid rgba(0,217,255,.4);pointer-events:auto;border-radius:4px;overflow:hidden;cursor:pointer;z-index:5}
.minimap-canvas{width:100%;height:100%}
.minimap-rect{position:absolute;border:2px solid var(--success);background:rgba(0,217,255,.2);border-radius:2px;pointer-events:none}
.minimap.hidden{display:none}
.crosshair{position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:4}
.crosshair-h{position:absolute;left:0;right:0;height:1px;background:rgba(255,0,0,.6);top:50%}
.crosshair-v{position:absolute;top:0;bottom:0;width:1px;background:rgba(255,0,0,.6);left:50%}
#sidebar{position:relative;width:180px;min-width:180px;max-width:400px;background:var(--bg2);border-right:1px solid var(--border);display:flex;flex-direction:column;overflow:visible;transition:width .2s,min-width .2s}
#sidebar.collapsed{width:0;min-width:0;overflow:hidden}
#sidebar-resize{position:absolute;left:-6px;top:0;bottom:0;width:12px;cursor:ew-resize;background:transparent;z-index:10;display:flex;align-items:center;justify-content:center}
#sidebar-resize:hover{background:rgba(233,69,96,.3)}
#sidebar-resize::after{content:'';position:absolute;left:3px;top:50%;transform:translateY(-50%);width:2px;height:30px;background:var(--border);border-radius:1px}
#sidebar-toggle{position:absolute;right:180px;top:50%;transform:translateY(-50%);width:20px;height:40px;background:var(--bg3);border:1px solid var(--border);border-right:none;border-radius:4px 0 0 4px;cursor:pointer;font-size:10px;color:var(--text2);display:flex;align-items:center;justify-content:center;z-index:50;transition:all .2s}
#sidebar-toggle:hover{background:var(--accent);color:#fff;border-color:var(--accent)}
#sidebar.collapsed ~ #sidebar-toggle{right:0;border-radius:4px 0 0 4px}
#sidebar:not(.collapsed) ~ #sidebar-toggle{right:180px;border-radius:4px 0 0 4px}
.ss{padding:8px;border-bottom:1px solid var(--border)}
.ss h3{font-size:11px;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;color:var(--success)}
.sr{display:flex;align-items:center;gap:6px;margin-bottom:6px}
.sr label{width:55px;font-size:11px;color:var(--text2);flex-shrink:0}
.sr input[type="range"]{flex:1;min-width:0;max-width:80px}
.sv{min-width:32px;text-align:right;font-size:11px;font-family:monospace;color:var(--success);flex-shrink:0}
#coord-info{font-family:monospace;font-size:11px;padding:5px;background:var(--bg3);border-radius:3px;white-space:pre-line;line-height:1.4;color:var(--success)}
#bottom-bar{position:absolute;bottom:8px;right:8px;display:flex;align-items:center;gap:6px;z-index:50}
#bottom-bar .bar-btn{height:24px;background:var(--bg3);border:1px solid var(--border);border-radius:4px;cursor:pointer;font-size:11px;color:var(--text2);display:flex;align-items:center;justify-content:center;gap:4px;padding:0 8px;transition:background .15s,color .15s,border-color .15s}
#bottom-bar .bar-btn:hover{background:var(--accent);color:#fff;border-color:var(--accent)}
#bottom-bar .bar-btn.icon-only{width:24px;padding:0;border-radius:50%}
#btn-issue{font-weight:500}
#help-popup{position:absolute;bottom:34px;right:0;width:220px;background:var(--bg2);border:1px solid var(--border);border-radius:6px;padding:10px;font-size:12px;display:none;z-index:50;box-shadow:0 4px 12px rgba(0,0,0,.3)}
#help-popup.show{display:block}
#help-popup h4{color:var(--success);margin-bottom:6px;font-size:13px}
#help-popup p{color:var(--text2);line-height:1.5;margin-bottom:4px}
#help-popup a{color:var(--accent);text-decoration:none}
#help-popup .ver{color:var(--text2);font-size:11px;margin-top:6px;padding-top:6px;border-top:1px solid var(--border)}
#loading{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(26,26,46,.95);font-size:14px;z-index:50;flex-direction:column;gap:8px}
#loading-text{color:var(--accent);font-weight:600}
#loading-detail{font-size:11px;color:var(--text2)}
#image-list{display:flex;flex-direction:column;gap:4px;max-height:200px;overflow-y:auto}
.image-item{display:flex;align-items:center;gap:6px;padding:4px 6px;background:var(--bg3);border:1px solid var(--border);border-radius:4px;cursor:pointer;font-size:10px}
.image-item:hover{background:var(--bg);border-color:var(--accent)}
.image-item.active{background:var(--accent);border-color:var(--accent);color:#fff}
.image-item-thumb{width:32px;height:32px;background:#000;border-radius:2px;flex-shrink:0;overflow:hidden}
.image-item-thumb canvas{width:100%;height:100%;object-fit:cover}
.image-item-name{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.image-item-remove{width:16px;height:16px;background:rgba(255,71,87,.2);border:1px solid var(--danger);border-radius:2px;color:var(--danger);cursor:pointer;font-size:8px;display:flex;align-items:center;justify-content:center;flex-shrink:0}
.image-item-remove:hover{background:var(--danger);color:#fff}
.overlay-label{position:absolute;bottom:40px;right:8px;font-size:9px;color:var(--warning);pointer-events:none;font-weight:600;text-shadow:0 1px 2px rgba(0,0,0,.8);z-index:5;background:rgba(0,0,0,.6);padding:2px 6px;border-radius:3px;display:none;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sbs-label{position:absolute;top:22px;font-size:8px;pointer-events:none;font-weight:600;text-shadow:0 1px 2px rgba(0,0,0,.8);z-index:5;background:rgba(0,0,0,.6);padding:1px 5px;border-radius:2px;display:none;max-width:45%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sbs-label-l{left:4px;color:var(--success)}
.sbs-label-r{right:4px;color:var(--warning)}
.header-row{display:flex;flex-direction:column;font-size:11px;padding:3px 0;border-bottom:1px solid rgba(42,63,95,.3)}
.header-key{color:var(--text2);font-size:10px;margin-bottom:1px}
.header-val{color:var(--success);font-family:monospace;cursor:pointer;padding:1px 4px;border-radius:2px;word-break:break-all;white-space:normal;line-height:1.3}
.header-val:hover{background:rgba(0,217,255,.15)}
.header-val.copied{background:var(--success);color:#000}
#header-panel{max-height:300px;overflow-y:auto}
#header-info-content{overflow-y:auto;max-height:240px}
.format-badge{display:inline-block;background:rgba(233,69,96,.2);border:1px solid var(--accent);color:var(--accent);font-size:8px;font-weight:700;padding:1px 5px;border-radius:3px;letter-spacing:.5px;vertical-align:middle;margin-left:4px}
.ns-tooltip{position:fixed;padding:4px 10px;border-radius:4px;background:var(--bg,#1a1a2e);color:var(--text,#e0e0e0);border:1px solid var(--border,#2a3f5f);font-size:11px;font-weight:400;white-space:nowrap;pointer-events:none;opacity:0;transition:opacity .12s ease;z-index:99999;box-shadow:0 2px 8px rgba(0,0,0,.25);max-width:280px;overflow:hidden;text-overflow:ellipsis}
.ns-tooltip.visible{opacity:1}
.measure-canvas{position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:6}
@media(prefers-contrast:more){.crosshair-h{height:2px!important}.crosshair-v{width:2px!important}.vl{font-size:14px!important}.vi{font-size:12px!important}}
</style>
</head>
<body>
<div id="progress-bar"></div>
<div id="toolbar">
  <div id="file-info">
    <span class="file-name" id="file-name">Loading...</span><span class="format-badge" id="format-badge" style="display:none">ZARR</span>
    <div class="file-detail" id="file-detail"></div>
  </div>
  <button class="btn btn-fit" id="btn-fit" data-tip="Zoom to Fit" aria-label="Zoom to fit">Fit</button>
  <button class="btn" id="btn-auto" data-tip="Auto Contrast" aria-label="Auto contrast">Auto Contrast</button>
  <button class="btn" id="btn-reset" data-tip="Reset View" aria-label="Reset view">Reset</button>
  <button class="btn" id="btn-crosshair" data-tip="Toggle Crosshair" aria-label="Toggle crosshair">✛</button>
  <button class="btn" id="btn-measure" data-tip="Toggle Measure Mode" aria-label="Toggle measure mode">📏</button>
  <button class="btn" id="btn-clear-measure" data-tip="Clear Measurements" aria-label="Clear all measurements">🗑️</button>
  <button class="btn" id="btn-export" data-tip="Export Slice as PNG" aria-label="Export slice as PNG">📷</button>
  <button class="btn" id="btn-header" data-tip="Toggle Header Info" aria-label="Toggle header info">ℹ️</button>
  <div class="tg"><label>W</label><input id="ww-slider" type="range" min="1" max="200" value="100" role="slider" aria-label="Window width" aria-valuemin="1" aria-valuemax="200" aria-valuenow="100"></div>
  <div class="tg"><label>L</label><input id="wl-slider" type="range" min="0" max="100" value="50" role="slider" aria-label="Window level" aria-valuemin="0" aria-valuemax="100" aria-valuenow="50"></div>
  <div class="tg"><label>Map</label><select id="colormap"><option value="gray">Gray</option><option value="hot">Hot</option><option value="cool">Cool</option><option value="jet">Jet</option><option value="viridis">Viridis</option><option value="inferno">Inferno</option></select></div>
  <canvas id="colormap-preview" width="200" height="20" style="height:14px;border-radius:3px;border:1px solid var(--border);cursor:pointer"></canvas>
</div>
<div id="main" role="application" aria-label="NIfTI image viewer">
  <div id="views">
    <div class="vc" id="axial-c"><canvas id="axial" tabindex="0" aria-label="Axial slice viewer"></canvas><span class="vl">Axial</span><span class="vi" id="axial-info"></span><button class="vb" data-view="axial" aria-label="Maximize axial view">A</button><div class="ssc"><input id="axial-slider" type="range" min="0" max="100" value="50" role="slider" aria-label="Axial slice index" aria-valuemin="0" aria-valuemax="100" aria-valuenow="50"></div><span class="dir-label dir-l">R</span><span class="dir-label dir-r">L</span><span class="dir-label dir-a">A</span><span class="dir-label dir-p">P</span><div class="crosshair"><div class="crosshair-h"></div><div class="crosshair-v"></div></div><div class="scale-bar"><span></span></div><div class="minimap hidden"><canvas class="minimap-canvas"></canvas><div class="minimap-rect"></div></div><span class="overlay-label" id="overlay-label-axial"></span><span class="sbs-label sbs-label-l" id="sbs-l-axial"></span><span class="sbs-label sbs-label-r" id="sbs-r-axial"></span><canvas class="measure-canvas" id="measure-axial"></canvas></div>
    <div class="vc" id="coronal-c"><canvas id="coronal" tabindex="0" aria-label="Coronal slice viewer"></canvas><span class="vl">Coronal</span><span class="vi" id="coronal-info"></span><button class="vb" data-view="coronal" aria-label="Maximize coronal view">C</button><div class="ssc"><input id="coronal-slider" type="range" min="0" max="100" value="50" role="slider" aria-label="Coronal slice index" aria-valuemin="0" aria-valuemax="100" aria-valuenow="50"></div><span class="dir-label dir-l">R</span><span class="dir-label dir-r">L</span><span class="dir-label dir-a">S</span><span class="dir-label dir-p">I</span><div class="crosshair"><div class="crosshair-h"></div><div class="crosshair-v"></div></div><div class="scale-bar"><span></span></div><div class="minimap hidden"><canvas class="minimap-canvas"></canvas><div class="minimap-rect"></div></div><span class="overlay-label" id="overlay-label-coronal"></span><span class="sbs-label sbs-label-l" id="sbs-l-coronal"></span><span class="sbs-label sbs-label-r" id="sbs-r-coronal"></span><canvas class="measure-canvas" id="measure-coronal"></canvas></div>
    <div class="vc" id="sagittal-c"><canvas id="sagittal" tabindex="0" aria-label="Sagittal slice viewer"></canvas><span class="vl">Sagittal</span><span class="vi" id="sagittal-info"></span><button class="vb" data-view="sagittal" aria-label="Maximize sagittal view">S</button><div class="ssc"><input id="sagittal-slider" type="range" min="0" max="100" value="50" role="slider" aria-label="Sagittal slice index" aria-valuemin="0" aria-valuemax="100" aria-valuenow="50"></div><span class="dir-label dir-l">A</span><span class="dir-label dir-r">P</span><span class="dir-label dir-a">S</span><span class="dir-label dir-p">I</span><div class="crosshair"><div class="crosshair-h"></div><div class="crosshair-v"></div></div><div class="scale-bar"><span></span></div><div class="minimap hidden"><canvas class="minimap-canvas"></canvas><div class="minimap-rect"></div></div><span class="overlay-label" id="overlay-label-sagittal"></span><span class="sbs-label sbs-label-l" id="sbs-l-sagittal"></span><span class="sbs-label sbs-label-r" id="sbs-r-sagittal"></span><canvas class="measure-canvas" id="measure-sagittal"></canvas></div>
    <div class="vc" id="mip-c"><canvas id="mip" tabindex="0" aria-label="3D MIP viewer"></canvas><span class="vl">3D MIP</span><span class="vi">Drag to rotate</span><button class="vb" data-view="mip" aria-label="Maximize MIP view">M</button></div>
  </div>
  <div id="sidebar" aria-label="Sidebar controls">
    <div id="sidebar-resize"></div>
    <div class="ss">
      <h3>Slice Navigation</h3>
      <div class="sr"><label>Axial Z:</label><input id="axial-slider-side" type="range" min="0" max="100" value="50" role="slider" aria-label="Axial slice Z" aria-valuemin="0" aria-valuemax="100" aria-valuenow="50"><span class="sv" id="axial-val">0</span></div>
      <div class="sr"><label>Coronal Y:</label><input id="coronal-slider-side" type="range" min="0" max="100" value="50" role="slider" aria-label="Coronal slice Y" aria-valuemin="0" aria-valuemax="100" aria-valuenow="50"><span class="sv" id="coronal-val">0</span></div>
      <div class="sr"><label>Sagittal X:</label><input id="sagittal-slider-side" type="range" min="0" max="100" value="50" role="slider" aria-label="Sagittal slice X" aria-valuemin="0" aria-valuemax="100" aria-valuenow="50"><span class="sv" id="sagittal-val">0</span></div>
    </div>
    <div class="ss">
      <h3>Images</h3>
      <div id="image-list"></div>
      <button class="btn" id="btn-add-img" style="width:100%;margin-top:6px">+ Add Image</button>
      <button class="btn" id="btn-compare" style="width:100%;margin-top:4px">⊞ Compare</button>
      <div id="overlay-controls" style="display:none;margin-top:4px">
        <div class="sr"><label>Opacity:</label><input id="opacity-slider" type="range" min="0" max="100" value="50" style="flex:1"><span class="sv" id="opacity-val">50</span></div>
        <div class="sr"><label>Color:</label><select id="overlay-colormap" style="flex:1"><option value="hot">Hot</option><option value="jet">Jet</option><option value="cool">Cool</option><option value="viridis">Viridis</option><option value="inferno">Inferno</option><option value="gray">Gray</option></select></div>
      </div>
    </div>
    <div class="ss">
      <h3>Pointer Info</h3>
      <div id="coord-info">Hover over image</div>
    </div>
    <div class="ss" id="header-panel" style="display:none">
      <h3>Header Info</h3>
      <div id="header-info-content"></div>
    </div>
  </div>
  <div id="sidebar-toggle">◀</div>
</div>
<div id="bottom-bar">
  <button id="btn-issue" class="bar-btn" type="button">🐛 Report issue</button>
  <button id="help-btn" class="bar-btn icon-only" type="button" aria-label="Help">?</button>
  <div id="help-popup">
    <h4>Controls</h4>
    <p><b>Scroll</b> Navigate slices</p>
    <p><b>Ctrl+Scroll</b> Zoom in/out</p>
    <p><b>Drag</b> Pan view</p>
    <p><b>Click</b> Set crosshair</p>
    <p><b>A/C/S/M</b> Maximize view</p>
    <p><b>Auto</b> Auto contrast</p>
    <p><b>Reset</b> Reset all views</p>
    <div class="ver">v2.1.4 | <a href="https://github.com/MaiwulanjiangMaiming/NiftiSpy">GitHub</a></div>
  </div>
</div>
<div id="a11y-announce" aria-live="polite" aria-atomic="true" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)"></div>
<div id="loading"><span id="loading-text">Initializing...</span><span id="loading-detail"></span></div>
<script>window.WORKER_URL="${workerUri}";</script>
<script src="${viewerUri}"></script>
</body>
</html>`;
  }
}
