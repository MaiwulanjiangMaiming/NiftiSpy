import * as vscode from 'vscode';
import * as path from 'path';
import { LocalFileProxy } from './LocalFileProxy';
import { VolumeCache } from './VolumeCache';

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
  private maxRemote = 1;
  private maxLocal = 2;

  enqueue(job: LoadJob): void {
    this.queue.push(job);
    this.queue.sort((a, b) => b.priority - a.priority);
    this.processNext();
  }

  promote(webviewId: string): void {
    const idx = this.queue.findIndex(j => j.webviewId === webviewId);
    if (idx >= 0) {
      this.queue[idx].priority = 100;
      this.queue.sort((a, b) => b.priority - a.priority);
    }
  }

  cancel(webviewId: string): void {
    for (let i = this.queue.length - 1; i >= 0; i--) {
      if (this.queue[i].webviewId === webviewId) {
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

  constructor(private readonly context: vscode.ExtensionContext, volumeCache: VolumeCache) {
    this.volumeCache = volumeCache;
    this.loadQueue = new LoadQueue();
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
        vscode.Uri.joinPath(uri, '..'),
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
        const config = vscode.workspace.getConfiguration('niiFastView');

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
          fileName: path.basename(uri.fsPath ?? uri.toString()),
          webviewId,
        });

        if (isRemote && entryId) {
          this.startPreviewLoad(entryId, webview, webviewId, uri, abortController.signal);
        }
      } else if (msg.type === 'selectImage') {
        const files = await vscode.window.showOpenDialog({
          canSelectMany: false,
          filters: { 'NIfTI Files': ['nii', 'nii.gz'] },
          title: 'Select Image File',
        });
        if (files && files.length > 0) {
          const imgUri = files[0];
          const imgIsRemote = imgUri.scheme !== 'file';
          let imgUrl: string;

          if (imgIsRemote) {
            if (!this.proxy) {
              this.proxy = new LocalFileProxy(this.volumeCache);
              await this.proxy.start();
              this.context.subscriptions.push({ dispose: () => this.proxy?.stop() });
            }
            imgUrl = this.proxy.registerFile(imgUri);
          } else {
            imgUrl = webview.asWebviewUri(imgUri).toString();
          }

          webview.postMessage({
            type: 'newImage',
            fileUrl: imgUrl,
            fileName: path.basename(imgUri.fsPath ?? imgUri.toString()),
            isGzip: imgUri.fsPath?.endsWith('.gz') ?? false,
            isRemote: imgIsRemote,
          });
        }
      }
    });
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
          const preview = await this.proxy!.extractPreviewForWebview(entryId, signal);
          if (!preview || signal.aborted) return;

          this.volumeCache.setActive(uriKey, webviewId);

          const axialBuffer = preview.slices.axial.buffer.slice(
            preview.slices.axial.byteOffset,
            preview.slices.axial.byteOffset + preview.slices.axial.byteLength
          );
          const coronalBuffer = preview.slices.coronal.buffer.slice(
            preview.slices.coronal.byteOffset,
            preview.slices.coronal.byteOffset + preview.slices.coronal.byteLength
          );
          const sagittalBuffer = preview.slices.sagittal.buffer.slice(
            preview.slices.sagittal.byteOffset,
            preview.slices.sagittal.byteOffset + preview.slices.sagittal.byteLength
          );

          webview.postMessage({
            type: 'preview',
            header: preview.header,
            globalMin: preview.globalMin,
            globalMax: preview.globalMax,
            sliceIdx: preview.sliceIdx,
            slope: preview.slope,
            inter: preview.inter,
            partialPreview: preview.partialPreview || false,
            axialSlice: axialBuffer,
            coronalSlice: coronalBuffer,
            sagittalSlice: sagittalBuffer,
          });
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
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none';
           script-src ${webview.cspSource} 'unsafe-inline' 'unsafe-eval' blob:;
           style-src ${webview.cspSource} 'unsafe-inline';
           img-src ${webview.cspSource} data: blob:;
           connect-src ${webview.cspSource} http://127.0.0.1:* blob: data:;
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
.ss h3{font-size:9px;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;color:var(--success)}
.sr{display:flex;align-items:center;gap:6px;margin-bottom:6px}
.sr label{width:55px;font-size:9px;color:var(--text2);flex-shrink:0}
.sr input[type="range"]{flex:1;min-width:0;max-width:80px}
.sv{min-width:32px;text-align:right;font-size:9px;font-family:monospace;color:var(--success);flex-shrink:0}
#coord-info{font-family:monospace;font-size:9px;padding:5px;background:var(--bg3);border-radius:3px;white-space:pre-line;line-height:1.4;color:var(--success)}
#help-btn{position:absolute;bottom:8px;right:8px;width:20px;height:20px;background:var(--bg3);border:1px solid var(--border);border-radius:50%;cursor:pointer;font-size:10px;color:var(--text2);display:flex;align-items:center;justify-content:center}
#help-btn:hover{background:var(--accent);color:#fff}
#help-popup{position:absolute;bottom:30px;right:8px;width:180px;background:var(--bg2);border:1px solid var(--border);border-radius:6px;padding:8px;font-size:9px;display:none;z-index:50;box-shadow:0 4px 12px rgba(0,0,0,.3)}
#help-popup.show{display:block}
#help-popup h4{color:var(--success);margin-bottom:6px;font-size:10px}
#help-popup p{color:var(--text2);line-height:1.5;margin-bottom:4px}
#help-popup a{color:var(--accent);text-decoration:none}
#help-popup .ver{color:var(--text2);font-size:8px;margin-top:6px;padding-top:6px;border-top:1px solid var(--border)}
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
</style>
</head>
<body>
<div id="progress-bar"></div>
<div id="toolbar">
  <div id="file-info">
    <span class="file-name" id="file-name">Loading...</span>
    <div class="file-detail" id="file-detail"></div>
  </div>
  <button class="btn btn-fit" id="btn-fit" title="Zoom to Fit">Fit</button>
  <button class="btn" id="btn-auto" title="Auto Contrast">Auto Contrast</button>
  <button class="btn" id="btn-reset" title="Reset View">Reset</button>
  <button class="btn" id="btn-crosshair" title="Toggle Crosshair">✛</button>
  <div class="tg"><label>W</label><input id="ww-slider" type="range" min="1" max="200" value="100"></div>
  <div class="tg"><label>L</label><input id="wl-slider" type="range" min="0" max="100" value="50"></div>
  <div class="tg"><label>Map</label><select id="colormap"><option value="gray">Gray</option><option value="hot">Hot</option><option value="cool">Cool</option><option value="jet">Jet</option><option value="viridis">Viridis</option><option value="inferno">Inferno</option></select></div>
</div>
<div id="main">
  <div id="views">
    <div class="vc" id="axial-c"><canvas id="axial"></canvas><span class="vl">Axial</span><span class="vi" id="axial-info"></span><button class="vb" data-view="axial">A</button><div class="ssc"><input id="axial-slider" type="range" min="0" max="100" value="50"></div><span class="dir-label dir-l">R</span><span class="dir-label dir-r">L</span><span class="dir-label dir-a">A</span><span class="dir-label dir-p">P</span><div class="crosshair"><div class="crosshair-h"></div><div class="crosshair-v"></div></div><div class="scale-bar"><span></span></div><div class="minimap hidden"><canvas class="minimap-canvas"></canvas><div class="minimap-rect"></div></div><span class="overlay-label" id="overlay-label-axial"></span><span class="sbs-label sbs-label-l" id="sbs-l-axial"></span><span class="sbs-label sbs-label-r" id="sbs-r-axial"></span></div>
    <div class="vc" id="coronal-c"><canvas id="coronal"></canvas><span class="vl">Coronal</span><span class="vi" id="coronal-info"></span><button class="vb" data-view="coronal">C</button><div class="ssc"><input id="coronal-slider" type="range" min="0" max="100" value="50"></div><span class="dir-label dir-l">R</span><span class="dir-label dir-r">L</span><span class="dir-label dir-a">S</span><span class="dir-label dir-p">I</span><div class="crosshair"><div class="crosshair-h"></div><div class="crosshair-v"></div></div><div class="scale-bar"><span></span></div><div class="minimap hidden"><canvas class="minimap-canvas"></canvas><div class="minimap-rect"></div></div><span class="overlay-label" id="overlay-label-coronal"></span><span class="sbs-label sbs-label-l" id="sbs-l-coronal"></span><span class="sbs-label sbs-label-r" id="sbs-r-coronal"></span></div>
    <div class="vc" id="sagittal-c"><canvas id="sagittal"></canvas><span class="vl">Sagittal</span><span class="vi" id="sagittal-info"></span><button class="vb" data-view="sagittal">S</button><div class="ssc"><input id="sagittal-slider" type="range" min="0" max="100" value="50"></div><span class="dir-label dir-l">A</span><span class="dir-label dir-r">P</span><span class="dir-label dir-a">S</span><span class="dir-label dir-p">I</span><div class="crosshair"><div class="crosshair-h"></div><div class="crosshair-v"></div></div><div class="scale-bar"><span></span></div><div class="minimap hidden"><canvas class="minimap-canvas"></canvas><div class="minimap-rect"></div></div><span class="overlay-label" id="overlay-label-sagittal"></span><span class="sbs-label sbs-label-l" id="sbs-l-sagittal"></span><span class="sbs-label sbs-label-r" id="sbs-r-sagittal"></span></div>
    <div class="vc" id="mip-c"><canvas id="mip"></canvas><span class="vl">3D MIP</span><span class="vi">Drag to rotate</span><button class="vb" data-view="mip">M</button></div>
  </div>
  <div id="sidebar">
    <div id="sidebar-resize"></div>
    <div class="ss">
      <h3>Slice Navigation</h3>
      <div class="sr"><label>Axial Z:</label><input id="axial-slider-side" type="range" min="0" max="100" value="50"><span class="sv" id="axial-val">0</span></div>
      <div class="sr"><label>Coronal Y:</label><input id="coronal-slider-side" type="range" min="0" max="100" value="50"><span class="sv" id="coronal-val">0</span></div>
      <div class="sr"><label>Sagittal X:</label><input id="sagittal-slider-side" type="range" min="0" max="100" value="50"><span class="sv" id="sagittal-val">0</span></div>
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
  </div>
  <div id="sidebar-toggle">◀</div>
</div>
<div id="help-btn">?</div>
<div id="help-popup">
  <h4>Controls</h4>
  <p><b>Scroll</b> Navigate slices</p>
  <p><b>Ctrl+Scroll</b> Zoom in/out</p>
  <p><b>Drag</b> Pan view</p>
  <p><b>Click</b> Set crosshair</p>
  <p><b>A/C/S/M</b> Maximize view</p>
  <p><b>Auto</b> Auto contrast</p>
  <p><b>Reset</b> Reset all views</p>
  <div class="ver">v1.0.1 | <a href="https://github.com/MaiwulanjiangMaiming/NiftiSpy">GitHub</a></div>
</div>
<div id="loading"><span id="loading-text">Initializing...</span><span id="loading-detail"></span></div>
<script>window.WORKER_URL="${workerUri}";</script>
<script src="${viewerUri}"></script>
</body>
</html>`;
  }
}
