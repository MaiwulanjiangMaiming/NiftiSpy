import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { NiiEditorProvider } from './NiiEditorProvider';
import { VolumeCache } from './VolumeCache';
import { ZarrVolumeProvider } from './nifti/volumeProvider';

function isZarrDirectory(uri: vscode.Uri): boolean {
  const fsPath = uri.fsPath;
  if (!fsPath) return false;
  // Check if the path ends with .zarr or if it's a directory containing .zarray
  if (fsPath.endsWith('.zarr')) return true;
  try {
    if (fs.statSync(fsPath).isDirectory()) {
      return fs.existsSync(path.join(fsPath, '.zarray'));
    }
  } catch {
    // Not a directory or doesn't exist
  }
  return false;
}

export async function activate(context: vscode.ExtensionContext) {
  // Migrate old niiFastView.* settings to niftispy.*
  const oldConfig = vscode.workspace.getConfiguration('niiFastView');
  const newConfig = vscode.workspace.getConfiguration('niftispy');
  const migrationKeys = ['proxyPort', 'defaultColormap', 'enableLOD', 'previewMode', 'renderBackend', 'fullVolumePolicy', 'nativeAcceleration'];
  for (const key of migrationKeys) {
    const oldVal = oldConfig.inspect(key);
    if (oldVal?.globalValue !== undefined) {
      await newConfig.update(key, oldVal.globalValue, vscode.ConfigurationTarget.Global);
      await oldConfig.update(key, undefined, vscode.ConfigurationTarget.Global);
    }
    if (oldVal?.workspaceValue !== undefined) {
      await newConfig.update(key, oldVal.workspaceValue, vscode.ConfigurationTarget.Workspace);
      await oldConfig.update(key, undefined, vscode.ConfigurationTarget.Workspace);
    }
  }

  const volumeCache = new VolumeCache();
  const provider = new NiiEditorProvider(context, volumeCache);

  // Register keyboard shortcut commands
  const postToActiveWebview = (msg: Record<string, any>) => {
    for (const [, entry] of (provider as any).activeWebviews ?? []) {
      if (entry.panel.active) {
        entry.panel.webview.postMessage(msg);
        break;
      }
    }
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('niftispy.scrollSliceUp', () => postToActiveWebview({ type: 'keyboard', action: 'scrollSliceUp' })),
    vscode.commands.registerCommand('niftispy.scrollSliceDown', () => postToActiveWebview({ type: 'keyboard', action: 'scrollSliceDown' })),
    vscode.commands.registerCommand('niftispy.setViewAxial', () => postToActiveWebview({ type: 'keyboard', action: 'setViewAxial' })),
    vscode.commands.registerCommand('niftispy.setViewCoronal', () => postToActiveWebview({ type: 'keyboard', action: 'setViewCoronal' })),
    vscode.commands.registerCommand('niftispy.setViewSagittal', () => postToActiveWebview({ type: 'keyboard', action: 'setViewSagittal' })),
    vscode.commands.registerCommand('niftispy.resetView', () => postToActiveWebview({ type: 'keyboard', action: 'resetView' })),
    vscode.commands.registerCommand('niftispy.toggleDebugMode', () => provider.toggleDebugMode()),
  );

  // Register NIfTI editor
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      'niftispy.nifti',
      provider,
      {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: false,
      }
    )
  );

  // Register Zarr editor
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      'niftispy.zarr',
      {
        async openCustomDocument(uri: vscode.Uri, _openContext: vscode.CustomDocumentOpenContext, _token: vscode.CancellationToken): Promise<vscode.CustomDocument> {
          return { uri, dispose: () => {} };
        },
        async resolveCustomEditor(document: vscode.CustomDocument, webviewPanel: vscode.WebviewPanel, _token: vscode.CancellationToken): Promise<void> {
          const uri = document.uri;
          const webview = webviewPanel.webview;
          const zarrPath = uri.fsPath || uri.toString();

          webview.options = {
            enableScripts: true,
            localResourceRoots: [
              vscode.Uri.joinPath(context.extensionUri, 'dist'),
              vscode.Uri.joinPath(uri, '.'),
            ],
          };

          // Try to load Zarr metadata and show info
          let zarrInfo: string;
          try {
            const zarrProvider = new ZarrVolumeProvider(zarrPath);
            const info = await zarrProvider.getInfo();
            const dims = zarrProvider.getDimensions();
            const totalChunks = zarrProvider.getTotalChunksCount();
            zarrInfo = `Zarr v2 Volume: ${dims.nx}×${dims.ny}×${dims.nz}, ${totalChunks} chunks, dtype=${info.datatype}`;
          } catch (err: any) {
            zarrInfo = `Error loading Zarr: ${err?.message || err}`;
          }

          const viewerUri = webview.asWebviewUri(
            vscode.Uri.joinPath(context.extensionUri, 'dist', 'viewer.js')
          );

          webview.html = /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>NiftiSpy – Zarr</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#1a1a2e;color:#eaeaea;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;overflow:hidden}
.container{text-align:center;max-width:600px;padding:40px}
h1{color:#e94560;margin-bottom:16px;font-size:24px}
.info{background:#16213e;border:1px solid #2a3f5f;border-radius:8px;padding:20px;margin-top:16px;font-family:monospace;font-size:13px;line-height:1.6;color:#00d9ff;word-break:break-all}
.version{margin-top:20px;font-size:11px;color:#a0a0a0}
</style>
</head>
<body>
<div class="container">
  <h1>Zarr Volume</h1>
  <div class="info">${zarrInfo}</div>
  <div class="version">NiftiSpy v1.10.0</div>
</div>
</body>
</html>`;
        },
      },
      {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: false,
      }
    )
  );
}

export function deactivate() {}
