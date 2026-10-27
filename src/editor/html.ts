import * as vscode from 'vscode';

/** Static shell document for the custom editor; assets are loaded from dist. */
export function buildViewerHtml(webview: vscode.Webview, extensionUri: vscode.Uri, version: string): string {
  const viewerUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'viewer.js'));
  const workerUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'worker.js'));
  const regWorkerUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'regWorker.js'));

  return /* html */ `<!DOCTYPE html>
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
.reg-hidden{display:none}
#reg-status{margin-top:6px;font-size:10px;color:var(--text2)}
#reg-status-text{white-space:normal;word-break:break-word;line-height:1.4}
#reg-status.ok #reg-status-text{color:#4cd964}
#reg-status.fail #reg-status-text{color:var(--danger)}
#reg-status.busy #reg-status-text{color:var(--warning)}
.reg-track{height:3px;background:rgba(255,255,255,.12);border-radius:2px;margin-top:4px;overflow:hidden;display:none}
#reg-status.busy .reg-track{display:block}
#reg-fill{height:100%;width:0%;background:var(--accent);transition:width .18s ease}
#btn-reg-mni:disabled,#btn-reg-custom:disabled{opacity:.45;cursor:not-allowed}
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
      <div class="sr" id="time-slider-row" style="display:none"><label>Time T:</label><input id="time-slider-side" type="range" min="0" max="0" value="0" role="slider" aria-label="Time index" aria-valuemin="0" aria-valuemax="0" aria-valuenow="0"><span class="sv" id="time-val">0</span></div>
    </div>
    <div class="ss">
      <h3>Images</h3>
      <div id="image-list"></div>
      <button class="btn" id="btn-add-img" style="width:100%;margin-top:6px">+ Add Image</button>
      <button class="btn" id="btn-compare" style="width:100%;margin-top:4px">⊞ Compare</button>
      <div id="overlay-controls" style="display:none;margin-top:4px">
        <div class="sr"><label>Opacity:</label><input id="opacity-slider" type="range" min="0" max="100" value="50" style="flex:1"><span class="sv" id="opacity-val">50</span></div>
        <div class="sr"><label>Color:</label><select id="overlay-colormap" style="flex:1"><option value="hot">Hot</option><option value="jet">Jet</option><option value="cool">Cool</option><option value="viridis">Viridis</option><option value="inferno">Inferno</option><option value="gray">Gray</option></select></div>
        <button class="btn" id="btn-align" style="width:100%;margin-top:4px" title="Register the overlay image onto the base image (stores a transform only — original data is untouched)">⇄ Align…</button>
      </div>
    </div>
    <div class="ss">
      <h3>Registration</h3>
      <button class="btn" id="btn-reg-mni" style="width:100%" title="Register the current image to the MNI standard template (affine)">🧠 To MNI</button>
      <button class="btn" id="btn-reg-custom" style="width:100%;margin-top:4px" title="Register the current image to a user-selected template volume">📂 Custom Template…</button>
      <div id="reg-status" class="reg-hidden">
        <div id="reg-status-text"></div>
        <div class="reg-track"><div id="reg-fill"></div></div>
        <div class="reg-actions"><button class="btn" id="btn-reg-cancel" style="display:none">✕ Cancel</button></div>
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
    <div class="ver">v${version} | <a href="https://github.com/MaiwulanjiangMaiming/NiftiSpy">GitHub</a></div>
  </div>
</div>
<div id="a11y-announce" aria-live="polite" aria-atomic="true" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)"></div>
<div id="loading"><span id="loading-text">Initializing...</span><span id="loading-detail"></span></div>
<script>window.WORKER_URL="${workerUri}";</script>
<script>window.REG_WORKER_URL="${regWorkerUri}";</script>
<script src="${viewerUri}"></script>
</body>
</html>`;
}
