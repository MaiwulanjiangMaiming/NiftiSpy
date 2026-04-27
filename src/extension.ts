import * as vscode from 'vscode';
import { NiiEditorProvider } from './NiiEditorProvider';
import { VolumeCache } from './VolumeCache';

export function activate(context: vscode.ExtensionContext) {
  const volumeCache = new VolumeCache();
  const provider = new NiiEditorProvider(context, volumeCache);
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
}

export function deactivate() {}
