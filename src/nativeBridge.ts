import { createRequire } from 'module';

export interface NativePreviewResult {
  header: any;
  axial: Float32Array;
  coronal: Float32Array;
  sagittal: Float32Array;
  min: number;
  max: number;
}

interface RawNativePreviewResult {
  header: string;
  axial: Buffer;
  coronal: Buffer;
  sagittal: Buffer;
  min: number;
  max: number;
}

interface NativeBindings {
  parseHeader?(buffer: Buffer): any | null;
  extractPreview?(buffer: Buffer): NativePreviewResult | null;
  extractSlice?(buffer: Buffer, header: any, axis: string, index: number, factor?: number): Float32Array | null;
  decompressGzip?(buffer: Buffer): Uint8Array | Buffer;
  mmapParseHeader?(path: string): { header: any; size: number } | null;
  mmapExtractSlice?(path: string, header: any, axis: string, index: number, factor?: number): Float32Array | null;
  mmapExtractPreview?(path: string): NativePreviewResult | null;
  fastDecompressGzip?(buffer: Buffer): Uint8Array | Buffer;
}

interface RawNativeBindings {
  parseHeader?(buffer: Buffer): string | null;
  extractPreview?(buffer: Buffer): RawNativePreviewResult | null;
  extractSlice?(buffer: Buffer, headerJson: string, axis: string, index: number, factor?: number): Buffer | null;
  decompressGzip?(buffer: Buffer): Uint8Array | Buffer;
  mmapParseHeader?(path: string): { header: string; size: number } | null;
  mmapExtractSlice?(path: string, headerJson: string, axis: string, index: number, factor?: number): Buffer | null;
  mmapExtractPreview?(path: string): RawNativePreviewResult | null;
  fastDecompressGzip?(buffer: Buffer): Uint8Array | Buffer;
}

let cachedBindings: NativeBindings | null | undefined;

function bufferToFloat32Array(buffer: Buffer): Float32Array {
  const start = buffer.byteOffset;
  const end = start + buffer.byteLength;
  return new Float32Array(buffer.buffer.slice(start, end));
}

function wrapBindings(raw: RawNativeBindings): NativeBindings {
  return {
    parseHeader(buffer: Buffer) {
      const headerJson = raw.parseHeader?.(buffer);
      return headerJson ? JSON.parse(headerJson) : null;
    },
    extractPreview(buffer: Buffer) {
      const result = raw.extractPreview?.(buffer);
      if (!result) return null;
      return {
        header: JSON.parse(result.header),
        axial: bufferToFloat32Array(result.axial),
        coronal: bufferToFloat32Array(result.coronal),
        sagittal: bufferToFloat32Array(result.sagittal),
        min: result.min,
        max: result.max,
      };
    },
    extractSlice(buffer: Buffer, header: any, axis: string, index: number, factor?: number) {
      const slice = raw.extractSlice?.(buffer, JSON.stringify(header), axis, index, factor);
      return slice ? bufferToFloat32Array(slice) : null;
    },
    decompressGzip: raw.decompressGzip?.bind(raw),
    mmapParseHeader(path: string) {
      const result = raw.mmapParseHeader?.(path);
      if (!result) return null;
      return { header: JSON.parse(result.header), size: result.size };
    },
    mmapExtractSlice(path: string, header: any, axis: string, index: number, factor?: number) {
      const slice = raw.mmapExtractSlice?.(path, JSON.stringify(header), axis, index, factor);
      return slice ? bufferToFloat32Array(slice) : null;
    },
    mmapExtractPreview(path: string) {
      const result = raw.mmapExtractPreview?.(path);
      if (!result) return null;
      return {
        header: JSON.parse(result.header),
        axial: bufferToFloat32Array(result.axial),
        coronal: bufferToFloat32Array(result.coronal),
        sagittal: bufferToFloat32Array(result.sagittal),
        min: result.min,
        max: result.max,
      };
    },
    fastDecompressGzip: raw.fastDecompressGzip?.bind(raw),
  };
}

function loadBindings(): NativeBindings | null {
  if (cachedBindings !== undefined) return cachedBindings;
  try {
    const dynamicRequire = createRequire(__filename);
    const rawBindings = dynamicRequire('../native/index.node') as RawNativeBindings;
    cachedBindings = wrapBindings(rawBindings);
  } catch {
    cachedBindings = null;
  }
  return cachedBindings;
}

export function getNativeBindings(): NativeBindings | null {
  return loadBindings();
}
