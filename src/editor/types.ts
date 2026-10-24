import type { NiiHeader } from '../nifti/headerParser';

/** Timing samples are forwarded to the webview perf panel as-is. */
export type Timing = Record<string, number | string | boolean | undefined>;

/** Result shared by every whole-file gzip transport. */
export interface GzipLoadResult {
  rawData: Uint8Array;
  header: NiiHeader;
  stats: { min: number; max: number } | null;
  timing: Timing;
}
