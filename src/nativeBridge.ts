import { createRequire } from 'module';

export interface NativePreviewResult {
  header: any;
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
  parseHeader?(buffer: Buffer): any | null;
  extractPreview?(buffer: Buffer): NativePreviewResult | null;
  extractSlice?(buffer: Buffer, header: any, axis: string, index: number, factor?: number): Float32Array | null;
  decompressGzip?(buffer: Buffer): Uint8Array | Buffer;
  mmapParseHeader?(path: string): { header: any; size: number } | null;
  mmapExtractSlice?(path: string, header: any, axis: string, index: number, factor?: number): Float32Array | null;
  mmapExtractPreview?(path: string): NativePreviewResult | null;
  fastDecompressGzip?(buffer: Buffer): Uint8Array | Buffer;
  fastDecompressGzipOneshot?(buffer: Buffer): Uint8Array | Buffer;
  fastDecompressGzipFileAsync?(path: string): Promise<Uint8Array | Buffer>;
  fastDecompressGzipParallelAsync?(path: string): Promise<Uint8Array | Buffer>;
  mmapExtractSliceBatch?(path: string, header: any, axis: string, indices: number[]): Float32Array[] | null;
  mmapGetVolumeStats?(path: string, header: any): VolumeStats | null;
  fastResampleSlice?(data: Float32Array, srcWidth: number, srcHeight: number, dstWidth: number, dstHeight: number): Float32Array | null;
  fastApplyWindowLevel?(data: Float32Array, windowLevel: number, windowWidth: number, globalMin: number, globalMax: number): Uint8Array | null;
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
  fastResampleSlice?(data: Float32Array, srcWidth: number, srcHeight: number, dstWidth: number, dstHeight: number): Buffer | null;
  fastApplyWindowLevel?(data: Float32Array, windowLevel: number, windowWidth: number, globalMin: number, globalMax: number): Buffer | null;
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
    fastDecompressGzipOneshot: raw.fastDecompressGzipOneshot?.bind(raw),
    fastDecompressGzipFileAsync: raw.fastDecompressGzipFileAsync?.bind(raw),
    fastDecompressGzipParallelAsync: raw.fastDecompressGzipParallelAsync?.bind(raw),
    mmapExtractSliceBatch(path: string, header: any, axis: string, indices: number[]) {
      const buffers = raw.mmapExtractSliceBatch?.(path, JSON.stringify(header), axis, indices);
      if (!buffers) return null;
      return buffers.map(b => bufferToFloat32Array(b));
    },
    mmapGetVolumeStats(path: string, header: any) {
      return raw.mmapGetVolumeStats?.(path, JSON.stringify(header)) ?? null;
    },
    fastResampleSlice(data: Float32Array, srcWidth: number, srcHeight: number, dstWidth: number, dstHeight: number) {
      const buf = raw.fastResampleSlice?.(data, srcWidth, srcHeight, dstWidth, dstHeight);
      return buf ? bufferToFloat32Array(buf) : null;
    },
    fastApplyWindowLevel(data: Float32Array, windowLevel: number, windowWidth: number, globalMin: number, globalMax: number) {
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
    //   niftispy_native.darwin-arm64.node  (macOS Apple Silicon)
    //   niftispy_native.darwin-x64.node    (macOS Intel)
    //   niftispy_native.linux-x64-gnu.node (Linux x86_64)
    //   niftispy_native.win32-x64-msvc.node(Windows x86_64)
    // Falls back to native/index.node (wasm-pack legacy build) if not found.
    const platformName = `${process.platform}-${process.arch}`;
    const candidates = [
      `../niftispy_native.${platformName}.node`,
      `../niftispy_native.${process.platform}-${process.arch}-gnu.node`,
      '../native/index.node',  // legacy fallback (wasm-pack, no parallel support)
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

export function fallbackResampleSlice(data: Float32Array, srcWidth: number, srcHeight: number, dstWidth: number, dstHeight: number): Float32Array {
  const out = new Float32Array(dstWidth * dstHeight);
  const xRatio = srcWidth / dstWidth;
  const yRatio = srcHeight / dstHeight;
  for (let y = 0; y < dstHeight; y++) {
    for (let x = 0; x < dstWidth; x++) {
      const srcX = x * xRatio;
      const srcY = y * yRatio;
      const x0 = Math.min(Math.floor(srcX), srcWidth - 1);
      const y0 = Math.min(Math.floor(srcY), srcHeight - 1);
      const x1 = Math.min(x0 + 1, srcWidth - 1);
      const y1 = Math.min(y0 + 1, srcHeight - 1);
      const xf = srcX - x0;
      const yf = srcY - y0;
      const v00 = data[y0 * srcWidth + x0];
      const v10 = data[y0 * srcWidth + x1];
      const v01 = data[y1 * srcWidth + x0];
      const v11 = data[y1 * srcWidth + x1];
      const v0 = v00 * (1 - xf) + v10 * xf;
      const v1 = v01 * (1 - xf) + v11 * xf;
      out[y * dstWidth + x] = v0 * (1 - yf) + v1 * yf;
    }
  }
  return out;
}

export function fallbackApplyWindowLevel(data: Float32Array, windowLevel: number, windowWidth: number, globalMin: number, globalMax: number): Uint8Array {
  const n = data.length;
  const out = new Uint8Array(n);
  const lo = windowLevel - windowWidth * 0.5;
  const range = windowWidth || 1;
  const dataRange = globalMax - globalMin || 1;
  for (let i = 0; i < n; i++) {
    const norm = (data[i] - globalMin) / dataRange;
    const t = Math.max(0, Math.min(1, (norm - lo) / range));
    out[i] = (t * 255 + 0.5) | 0;
  }
  return out;
}

export function fallbackGetVolumeStats(data: Float32Array): VolumeStats {
  const n = data.length;
  let min = Infinity, max = -Infinity;
  let mean = 0, m2 = 0;
  let count = 0;
  const sampleStep = Math.max(1, Math.floor(n / 200000));
  const samples: number[] = [];

  for (let i = 0; i < n; i += sampleStep) {
    const v = data[i];
    if (v < min) min = v;
    if (v > max) max = v;
    count++;
    const delta = v - mean;
    mean += delta / count;
    const delta2 = v - mean;
    m2 += delta * delta2;
    samples.push(v);
  }

  if (min === max) max = min + 1;
  const std = count > 1 ? Math.sqrt(m2 / (count - 1)) : 0;

  const histogram = new Array(256).fill(0) as number[];
  const range = max - min;
  for (const v of samples) {
    const bin = range > 0 ? Math.min(255, Math.floor((v - min) / range * 256)) : 0;
    histogram[bin]++;
  }

  samples.sort((a, b) => a - b);
  const p1 = samples[Math.floor(samples.length * 0.01)] ?? min;
  const p5 = samples[Math.floor(samples.length * 0.05)] ?? min;
  const p95 = samples[Math.floor(samples.length * 0.95)] ?? max;
  const p99 = samples[Math.floor(samples.length * 0.99)] ?? max;

  return { min, max, mean, std, p1, p5, p95, p99, histogram };
}
