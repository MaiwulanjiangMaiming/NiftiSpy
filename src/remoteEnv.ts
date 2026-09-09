import * as vscode from 'vscode';

/**
 * Where the extension host is running, from a *network* point of view.
 *
 * `vscode.env.remoteName` only means "not a local window". WSL and Dev
 * Containers are loopback-class (treat as local). SSH / Codespaces / Tunnels
 * are WAN-class and must not pull whole volumes by default.
 */
export type RemoteKind = 'local' | 'localFast' | 'sshWan';

/** Files at or above this size use slice-on-demand on WAN remotes. */
export const SLICE_MODE_MIN_BYTES = 8 * 1024 * 1024;

export function classifyRemote(remoteName?: string | null): RemoteKind {
  if (!remoteName) return 'local';
  switch (remoteName) {
    case 'wsl':
    case 'dev-container':
    case 'attached-container':
      return 'localFast';
    default:
      return 'sshWan';
  }
}

export function isWanRemote(remoteName?: string | null): boolean {
  const name = remoteName === undefined ? vscode.env.remoteName : remoteName;
  return classifyRemote(name) === 'sshWan';
}

export function isLocalFastRemote(remoteName?: string | null): boolean {
  const name = remoteName === undefined ? vscode.env.remoteName : remoteName;
  return classifyRemote(name) === 'localFast';
}

export function shouldUseSliceMode(fileSize: number, remoteName?: string | null): boolean {
  if (!isWanRemote(remoteName)) return false;
  // Unknown size: be conservative and avoid a huge structured-clone / scp.
  return fileSize <= 0 || fileSize >= SLICE_MODE_MIN_BYTES;
}
