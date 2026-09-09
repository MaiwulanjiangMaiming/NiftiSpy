/** Files at or above this size use on-demand slices on SSH remotes. */
export const SLICE_MODE_MIN_BYTES = 8 * 1024 * 1024;

/** Above this size, never auto-download the full volume on a remote link. */
export const LARGE_FILE_BYTES = 80 * 1024 * 1024;

export type LinkQuality = 'high' | 'medium' | 'low';
export type FullVolumePolicy = 'manual' | 'debounced' | 'eager' | 'adaptive';

/**
 * Whether the viewer should start a background full-volume `/file` load.
 *
 * `sliceMode` is the preview-first path (large SSH / HTTP remotes). Adaptive
 * still allows a background download for medium files on a healthy link.
 */
export function shouldAutoloadFullVolume(opts: {
  policy: FullVolumePolicy;
  fileSize: number;
  sliceMode: boolean;
  quality: LinkQuality;
}): boolean {
  const { policy, fileSize, sliceMode, quality } = opts;
  if (policy === 'manual') return false;
  if (policy === 'eager') return true;
  if (policy === 'debounced') return !sliceMode;

  const small = fileSize > 0 && fileSize <= SLICE_MODE_MIN_BYTES;
  const large = fileSize <= 0 || fileSize > LARGE_FILE_BYTES;
  if (small || !sliceMode) return true;
  if (large || quality === 'low') return false;
  return true;
}
