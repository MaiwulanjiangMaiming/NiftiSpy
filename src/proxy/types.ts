import type * as vscode from 'vscode';

/** One file exposed by the local proxy, plus lazily built caches. */
export interface FileEntry {
  uri: vscode.Uri;
  dataUri: vscode.Uri;
  separateImg: boolean;
  id: string;
  size?: number;
  dataCache?: Uint8Array;
  lastAccess?: number;
  headerCache?: any;
  /**
   * Header supplied by a host-side format parser (npy/npz/nrrd/...).
   * The proxy never tries to parse these files as NIfTI; it reuses this
   * header for /header, /slice, /preview and /lod.
   */
  hostHeader?: any;
  previewBinaryCache?: Buffer;
  sliceCache?: Map<string, { data: Buffer; timestamp: number; raw?: RawSliceMeta }>;
  lodCache?: Map<number, { header: any; data: Float32Array; timestamp: number }>;
  pendingLoad?: Promise<{ rawData: Uint8Array; header: any }>;
  gzipIndex?: import('../io/gzipIndex').GzipIndex;
  gzipScan?: import('../io/gzipScan').GzipScanSession;
  unpackPath?: string;
  sourceStamp?: string;
}

/** Wire metadata for native 8/16-bit slice payloads. */
export interface RawSliceMeta {
  dtype: number;
  slope: number;
  inter: number;
}
