import { createRequire } from 'module';
import type { NiiHeader } from './nifti/headerParser';

export interface NativePreviewResult {
  header: NiiHeader;
  axial: Float32Array;
  coronal: Float32Array;
  sagittal: Float32Array;
  min: number;
  max: number;
}

export interface VolumeStats {
  min: number;
  max: number;
  mean: number;
  std: number;
  p1: number;
  p5: number;
  p95: number;
  p99: number;
  histogram: number[];
}

interface RawNativePreviewResult {
  header: string;
  axial: Buffer;
  coronal: Buffer;
  sagittal: Buffer;
  min: number;
  max: number;
}

interface RawVolumeStats {
  min: number;
  max: number;
  mean: number;
  std: number;
  p1: number;
  p5: number;
  p95: number;
  p99: number;
  histogram: number[];
}

interface NativeBindings {
  parseHeader?(buffer: Buffer): NiiHeader | null;
  extractPreview?(buffer: Buffer): NativePreviewResult | null;
  extractSlice?(buffer: Buffer, header: NiiHeader, axis: string, index: number, factor?: number): Float32Array | null;
  decompressGzip?(buffer: Buffer): Uint8Array | Buffer;
  mmapParseHeader?(path: string): { header: NiiHeader; size: number } | null;
  mmapExtractSlice?(path: string, header: NiiHeader, axis: string, index: number, factor?: number): Float32Array | null;
  mmapExtractPreview?(path: string): NativePreviewResult | null;
  fastDecompressGzip?(buffer: Buffer): Uint8Array | Buffer;
  fastDecompressGzipOneshot?(buffer: Buffer): Uint8Array | Buffer;
  fastDecompressGzipFileAsync?(path: string): Promise<Uint8Array | Buffer>;
  fastDecompressGzipParallelAsync?(path: string): Promise<Uint8Array | Buffer>;
  mmapExtractSliceBatch?(path: string, header: NiiHeader, axis: string, indices: number[]): Float32Array[] | null;
  mmapGetVolumeStats?(path: string, header: NiiHeader): VolumeStats | null;
  fastResampleSlice?(
    data: Float32Array,
    srcWidth: number,
    srcHeight: number,
    dstWidth: number,
    dstHeight: number,
  ): Float32Array | null;
  fastApplyWindowLevel?(
    data: Float32Array,
    windowLevel: number,
    windowWidth: number,
    globalMin: number,
    globalMax: number,
  ): Uint8Array | null;
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
  fastDecompressGzipOneshot?(buffer: Buffer): Uint8Array | Buffer;
  fastDecompressGzipFileAsync?(path: string): Promise<Uint8Array | Buffer>;
  fastDecompressGzipParallelAsync?(path: string): Promise<Uint8Array | Buffer>;
  mmapExtractSliceBatch?(path: string, headerJson: string, axis: string, indices: number[]): Buffer[] | null;
  mmapGetVolumeStats?(path: string, headerJson: string): RawVolumeStats | null;
  fastResampleSlice?(
    data: Float32Array,
    srcWidth: number,
    srcHeight: number,
    dstWidth: number,
    dstHeight: number,
  ): Buffer | null;
  fastApplyWindowLevel?(
    data: Float32Array,
    windowLevel: number,
    windowWidth: number,
    globalMin: number,
    globalMax: number,
  ): Buffer | null;
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
        header: JSON.parse(result.header) as NiiHeader,
        axial: bufferToFloat32Array(result.axial),
        coronal: bufferToFloat32Array(result.coronal),
        sagittal: bufferToFloat32Array(result.sagittal),
        min: result.min,
        max: result.max,
      };
    },
    extractSlice(buffer: Buffer, header: NiiHeader, axis: string, index: number, factor?: number) {
      const slice = raw.extractSlice?.(buffer, JSON.stringify(header), axis, index, factor);
      return slice ? bufferToFloat32Array(slice) : null;
    },
    decompressGzip: raw.decompressGzip?.bind(raw),
    mmapParseHeader(path: string) {
      const result = raw.mmapParseHeader?.(path);
      if (!result) return null;
      return { header: JSON.parse(result.header) as NiiHeader, size: result.size };
    },
    mmapExtractSlice(path: string, header: NiiHeader, axis: string, index: number, factor?: number) {
      const slice = raw.mmapExtractSlice?.(path, JSON.stringify(header), axis, index, factor);
      return slice ? bufferToFloat32Array(slice) : null;
    },
    mmapExtractPreview(path: string) {
      const result = raw.mmapExtractPreview?.(path);
      if (!result) return null;
      return {
        header: JSON.parse(result.header) as NiiHeader,
        axial: bufferToFloat32Array(result.axial),
        coronal: bufferToFloat32Array(result.coronal),
        sagittal: bufferToFloat32Array(result.sagittal),
        min: result.min,
        max: result.max,
      };
    },
    fastDecompressGzip: raw.fastDecompressGzip?.bind(raw),
    fastDecompressGzipOneshot: raw.fastDecompressGzipOneshot?.bind(raw),
    fastDecompressGzipFileAsync: raw.fastDecompressGzipFileAsync?.bind(raw),
    fastDecompressGzipParallelAsync: raw.fastDecompressGzipParallelAsync?.bind(raw),
    mmapExtractSliceBatch(path: string, header: NiiHeader, axis: string, indices: number[]) {
      const buffers = raw.mmapExtractSliceBatch?.(path, JSON.stringify(header), axis, indices);
      if (!buffers) return null;
      return buffers.map((b) => bufferToFloat32Array(b));
    },
    mmapGetVolumeStats(path: string, header: NiiHeader) {
      return raw.mmapGetVolumeStats?.(path, JSON.stringify(header)) ?? null;
    },
    fastResampleSlice(data: Float32Array, srcWidth: number, srcHeight: number, dstWidth: number, dstHeight: number) {
      const buf = raw.fastResampleSlice?.(data, srcWidth, srcHeight, dstWidth, dstHeight);
      return buf ? bufferToFloat32Array(buf) : null;
    },
    fastApplyWindowLevel(
      data: Float32Array,
      windowLevel: number,
      windowWidth: number,
      globalMin: number,
      globalMax: number,
    ) {
      const buf = raw.fastApplyWindowLevel?.(data, windowLevel, windowWidth, globalMin, globalMax);
      if (!buf) return null;
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    },
  };
}

function loadBindings(): NativeBindings | null {
  if (cachedBindings !== undefined) return cachedBindings;
  try {
    const dynamicRequire = createRequire(__filename);
    // Prefer platform-specific napi-rs binary (rusty-rapidgzip parallel build):
    //   niftispy_native.darwin-arm64.node      (macOS Apple Silicon)
    //   niftispy_native.darwin-x64.node        (macOS Intel)
    //   niftispy_native.linux-x64-gnu.node     (Linux x86_64, glibc)
    //   niftispy_native.linux-arm64-gnu.node   (Linux ARM64, glibc)
    //   niftispy_native.win32-x64-msvc.node    (Windows x86_64, MSVC)
    // Falls back to native/index.node (wasm-pack legacy build) if not found.
    const platform = process.platform;
    const arch = process.arch;
    // libc suffix: linux→gnu, win32→msvc, darwin→(none, macOS has one libc)
    const libc = platform === 'linux' ? 'gnu' : platform === 'win32' ? 'msvc' : '';
    // Candidates ordered most-specific → least-specific:
    //   linux-x64-gnu  →  linux-x64  (in case a binary was built without libc suffix)
    //   win32-x64-msvc →  win32-x64
    //   darwin-arm64   (no libc variant needed)
    const platformVariants = libc ? [`${platform}-${arch}-${libc}`, `${platform}-${arch}`] : [`${platform}-${arch}`];
    const candidates = [
      ...platformVariants.map((v) => `../niftispy_native.${v}.node`),
      '../native/index.node', // legacy fallback (wasm-pack, no parallel support)
    ];
    let rawBindings: RawNativeBindings | null = null;
    for (const candidate of candidates) {
      try {
        rawBindings = dynamicRequire(candidate) as RawNativeBindings;
        break;
      } catch {
        // try next candidate
      }
    }
    if (!rawBindings) {
      throw new Error('no native binary found');
    }
    cachedBindings = wrapBindings(rawBindings);
  } catch {
    cachedBindings = null;
  }
  return cachedBindings;
}

export function getNativeBindings(): NativeBindings | null {
  return loadBindings();
}

// ── Fallback implementations (pure JS) when native module is unavailable ──
