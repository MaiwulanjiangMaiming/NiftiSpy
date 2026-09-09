import * as vscode from 'vscode';
import { SLICE_MODE_MIN_BYTES } from './volumePolicy';

export { SLICE_MODE_MIN_BYTES, LARGE_FILE_BYTES, shouldAutoloadFullVolume } from './volumePolicy';
export type { LinkQuality, FullVolumePolicy } from './volumePolicy';

/**
 * Where the extension host is running, from a *network* point of view.
 *
 * `vscode.env.remoteName` only means "not a local window". WSL and Dev
 * Containers are loopback-class (treat as local). SSH / Codespaces / Tunnels
 * go over a real network and must not pull whole volumes by default.
 */
export type RemoteKind = 'local' | 'localFast' | 'sshWan';

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
