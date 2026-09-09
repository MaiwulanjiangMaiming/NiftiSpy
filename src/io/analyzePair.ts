import * as vscode from 'vscode';

export function isAnalyzeHeaderPath(p: string): boolean {
  return /\.hdr(\.gz)?$/i.test(p);
}

/** Sibling `.img` / `.IMG` candidates for an Analyze / NIfTI header file. */
export function companionImagePaths(headerPath: string): string[] {
  if (/\.hdr\.gz$/i.test(headerPath)) {
    return [
      headerPath.replace(/\.hdr\.gz$/i, '.img.gz'),
      headerPath.replace(/\.hdr\.gz$/i, '.IMG.gz'),
    ];
  }
  return [
    headerPath.replace(/\.hdr$/i, '.img'),
    headerPath.replace(/\.hdr$/i, '.IMG'),
  ];
}

function withFsPath(uri: vscode.Uri, fsPath: string): vscode.Uri {
  if (uri.scheme === 'file') return vscode.Uri.file(fsPath);
  const slash = uri.path.lastIndexOf('/');
  const name = fsPath.replace(/\\/g, '/').split('/').pop() || fsPath;
  const dir = slash >= 0 ? uri.path.slice(0, slash) : '';
  return uri.with({ path: `${dir}/${name}` });
}

export interface AnalyzePair {
  headerUri: vscode.Uri;
  dataUri: vscode.Uri;
  separateImg: boolean;
}

export async function resolveAnalyzePair(headerUri: vscode.Uri): Promise<AnalyzePair> {
  const headerPath = headerUri.fsPath || headerUri.path;
  if (!isAnalyzeHeaderPath(headerPath)) {
    return { headerUri, dataUri: headerUri, separateImg: false };
  }
  for (const imgPath of companionImagePaths(headerPath)) {
    const imgUri = withFsPath(headerUri, imgPath);
    try {
      await vscode.workspace.fs.stat(imgUri);
      return { headerUri, dataUri: imgUri, separateImg: true };
    } catch {
      // try the next candidate
    }
  }
  return { headerUri, dataUri: headerUri, separateImg: false };
}
