import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { NiiEditorProvider } from './NiiEditorProvider';
import { VolumeCache } from './VolumeCache';
import { ZarrVolumeProvider } from './nifti/volumeProvider';

const HEADER_PREFIX_BYTES = 64 * 1024;

/** Read only the leading text of a .nhdr/.mhd (they are header-only files). */
async function readHeaderText(uri: vscode.Uri): Promise<string | undefined> {
  const fsPath = uri.fsPath;
  if (fsPath && (uri.scheme === 'file' || uri.scheme.startsWith('vscode-remote'))) {
    try {
      const handle = await fs.promises.open(fsPath, 'r');
      try {
        const buf = Buffer.alloc(HEADER_PREFIX_BYTES);
        const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
        return buf.toString('latin1', 0, bytesRead);
      } finally {
        await handle.close();
      }
    } catch {
      // Fall through to the workspace file system.
    }
  }
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    return Buffer.from(bytes.subarray(0, HEADER_PREFIX_BYTES)).toString('latin1');
  } catch {
    return undefined;
  }
}

function referenceBasename(value: string): string {
  return value.trim().replace(/^"|"$/g, '').replace(/\\/g, '/').split('/').pop()!.toLowerCase();
}

function headerReferencesRaw(text: string, rawName: string): boolean {
  const target = rawName.toLowerCase();
  const nrrd = /^\s*data\s+file\s*:\s*(.+)$/im.exec(text);
  if (nrrd && referenceBasename(nrrd[1]) === target) return true;
  const meta = /^\s*ElementDataFile\s*=\s*(.+)$/im.exec(text);
  if (meta && meta[1].trim().toUpperCase() !== 'LOCAL' && referenceBasename(meta[1]) === target) {
    return true;
  }
  return false;
}

/**
 * A `.raw` payload is meaningless without a header. Find a sibling `.nhdr`
 * or `.mhd` whose `data file` / `ElementDataFile` points at it.
 */
async function findRawHeader(uri: vscode.Uri): Promise<vscode.Uri | undefined> {
  const rawName = path.basename(uri.fsPath || uri.path);
  if (!/\.raw$/i.test(rawName)) return undefined;

  const dir = uri.with({ path: path.posix.dirname(uri.path) });
  let entries: [string, vscode.FileType][];
  try {
    entries = await vscode.workspace.fs.readDirectory(dir);
  } catch {
    return undefined;
  }

  const candidates = entries
    .filter(([name, type]) => type === vscode.FileType.File && /\.(nhdr|mhd)$/i.test(name))
    .map(([name]) => vscode.Uri.joinPath(dir, name));
  if (!candidates.length) return undefined;

  const rawStem = rawName.toLowerCase().replace(/\.raw$/, '');
  candidates.sort((a, b) => {
    const aStem = path.basename(a.path).toLowerCase().replace(/\.(nhdr|mhd)$/, '');
    const bStem = path.basename(b.path).toLowerCase().replace(/\.(nhdr|mhd)$/, '');
    return Number(bStem === rawStem) - Number(aStem === rawStem);
  });

  for (const candidate of candidates) {
    const text = await readHeaderText(candidate);
    if (text && headerReferencesRaw(text, rawName)) return candidate;
  }
  return undefined;
}

function rawEditorHtml(title: string, message: string): string {
  const safeTitle = title.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
  const safeMessage = message.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
  return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<style>
body{background:#1a1a2e;color:#eaeaea;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.card{max-width:620px;padding:32px;text-align:center}
h1{color:#e94560;font-size:22px;margin:0 0 12px}
p{line-height:1.6;color:#c8c8d0;font-size:13px;margin:8px 0}
code{color:#00d9ff;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
</style>
</head>
<body><div class="card"><h1>${safeTitle}</h1><p>${safeMessage}</p></div></body>
</html>`;
}

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

          webview.options = { enableScripts: false };

          // Zarr is a metadata preview only: the viewer does not render
          // chunked Zarr volumes yet, so be explicit instead of implying it.
          let zarrInfo: string;
          try {
            const zarrProvider = new ZarrVolumeProvider(zarrPath);
            const info = await zarrProvider.getInfo();
            const dims = zarrProvider.getDimensions();
            const chunk = zarrProvider.getChunkSize();
            const voxel = zarrProvider.getVoxelSize();
            const totalChunks = zarrProvider.getTotalChunksCount();
            zarrInfo = `Zarr v2 dataset: ${dims.nx}×${dims.ny}×${dims.nz} · chunk ${chunk.cx}×${chunk.cy}×${chunk.cz} · ${totalChunks} chunks · dtype ${info.datatype} · spacing ${voxel.dx}×${voxel.dy}×${voxel.dz}`;
          } catch (err: any) {
            zarrInfo = `Error loading Zarr metadata: ${err?.message || err}`;
          }

          const version = context.extension.packageJSON.version;

          webview.html = /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>NiftiSpy – Zarr metadata</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#1a1a2e;color:#eaeaea;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;overflow:hidden}
.container{text-align:center;max-width:640px;padding:40px}
h1{color:#e94560;margin-bottom:16px;font-size:24px}
.info{background:#16213e;border:1px solid #2a3f5f;border-radius:8px;padding:20px;margin-top:16px;font-family:monospace;font-size:13px;line-height:1.6;color:#00d9ff;word-break:break-all}
.note{margin-top:16px;font-size:12px;line-height:1.6;color:#c8c8d0}
.version{margin-top:20px;font-size:11px;color:#a0a0a0}
</style>
</head>
<body>
<div class="container">
  <h1>Zarr Metadata</h1>
  <div class="info">${zarrInfo}</div>
  <div class="note">Volume rendering for Zarr is not wired into the viewer yet. Convert the array to <code>.npy</code> or <code>.nii.gz</code> to visualize it.</div>
  <div class="version">NiftiSpy v${version}</div>
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

  // Register the .raw helper. A raw payload cannot describe itself, so this
  // editor resolves a sibling .nhdr/.mhd and redirects to the normal viewer.
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      'niftispy.raw',
      {
        async openCustomDocument(uri: vscode.Uri): Promise<vscode.CustomDocument> {
          return { uri, dispose: () => {} };
        },
        async resolveCustomEditor(
          document: vscode.CustomDocument,
          webviewPanel: vscode.WebviewPanel,
        ): Promise<void> {
          const webview = webviewPanel.webview;
          webview.options = { enableScripts: false };
          const rawName = path.basename(document.uri.fsPath || document.uri.path);
          const header = await findRawHeader(document.uri);

          if (!header) {
            webview.html = rawEditorHtml(
              'Raw volume payload',
              `${rawName} has no companion .nhdr or .mhd header, so its dimensions and data type are unknown. ` +
              'Create a header next to it, or open the existing header file instead.',
            );
            return;
          }

          const headerName = path.basename(header.fsPath || header.path);
          webview.html = rawEditorHtml(
            'Opening volume',
            `Using header ${headerName} for ${rawName}…`,
          );
          try {
            await vscode.commands.executeCommand('vscode.openWith', header, 'niftispy.nifti');
            webviewPanel.dispose();
          } catch (err: any) {
            webview.html = rawEditorHtml('Cannot open volume', `${headerName}: ${err?.message || err}`);
          }
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
