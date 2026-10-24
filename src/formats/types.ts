/** Unified host-side volume parsing.
 *
 * Every non-NIfTI format is converted into the same NIfTI-shaped header the
 * existing cache / LOD / renderer pipeline already consumes. Parsers only
 * have to describe the voxel layout; they never touch the webview.
 */

export interface ParsedVolume {
  /** NIfTI-shaped header (fields consumed by the viewer + proxy). */
  header: any;
  /**
   * Voxel bytes held in memory. `header.voxOffset` is absolute within this
   * buffer. Mutually exclusive with `dataPath`.
   */
  rawData?: Uint8Array;
  /**
   * File that already contains the voxel bytes at `header.voxOffset`.
   * Used by Remote-SSH slice mode so slices are read on the remote disk
   * instead of transferring the whole volume.
   */
  dataPath?: string;
  /** Temporary files created while parsing (removed when the editor closes). */
  tempFiles?: string[];
}

export interface ParseOptions {
  /**
   * true  → return `rawData` (local fast path, whole volume in memory).
   * false → prefer `dataPath` so Remote-SSH can serve slices from disk.
   */
  memory: boolean;
}

export interface VolumeFormat {
  id: string;
  label: string;
  /** Lower-case extensions including the leading dot. */
  extensions: string[];
  parse(filePath: string, opts: ParseOptions): Promise<ParsedVolume>;
}

export function formatMatches(format: VolumeFormat, filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return format.extensions.some(ext => lower.endsWith(ext));
}
