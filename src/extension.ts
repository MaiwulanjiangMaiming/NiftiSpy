import * as vscode from 'vscode';
import { NiiEditorProvider } from './NiiEditorProvider';

export function activate(context: vscode.ExtensionContext) {
  const provider = new NiiEditorProvider(context);
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
