/**
 * Preview payload decoding shared by every load path in the viewer.
 *
 * These helpers are pure: they turn the various wire formats the extension
 * host/worker emits (binary preview frames, structured-cloned typed arrays,
 * plain number arrays) into Float32Array slices and voxel statistics.
 */
import type { NiiHeader } from '../../src/nifti/headerParser';

export type MessageSlices = Record<string, ArrayBuffer | ArrayBufferView | number[]>;

export interface SliceIdxMessage {
  axial: number;
  coronal: number;
  sagittal: number;
}

export interface PreviewData {
  header: NiiHeader;
  globalMin: number;
  globalMax: number;
  slope: number;
  inter: number;
  sliceIdx: SliceIdxMessage;
  slices?: MessageSlices;
  axialSlice?: ArrayBuffer | Float32Array;
  coronalSlice?: ArrayBuffer | Float32Array;
  sagittalSlice?: ArrayBuffer | Float32Array;
  partialPreview?: boolean;
  deferFullVolume?: boolean;
  remoteStreaming?: boolean;
  url?: string;
  validationToken?: string;
  preParsedHeader?: NiiHeader;
  loadId?: string;
  headerInfo?: NiiHeader;
  reason?: string;
  type?: string;
}

/** Preview slices arrive as Float32Array (binary) or number arrays (JSON). */
export function toPreviewSlice(value: unknown): Float32Array {
  if (value instanceof Float32Array) return value;
  if (value instanceof ArrayBuffer) return new Float32Array(value);
  if (ArrayBuffer.isView(value)) return new Float32Array(value.buffer, value.byteOffset, value.byteLength / 4);
  if (Array.isArray(value)) return new Float32Array(value);
  return new Float32Array(0);
}

export function decodePreviewBinary(buffer: ArrayBuffer): PreviewData {
  const view = new DataView(buffer);
  let offset = 0;
  const headerLen = view.getUint32(offset, true);
  offset += 4;
  const headerJson = new TextDecoder().decode(new Uint8Array(buffer, offset, headerLen));
  offset += headerLen;
  const header = JSON.parse(headerJson) as NiiHeader;
  const globalMin = view.getFloat32(offset, true);
  offset += 4;
  const globalMax = view.getFloat32(offset, true);
  offset += 4;
  const sliceIdxData = {
    axial: view.getUint32(offset, true),
    coronal: view.getUint32(offset + 4, true),
    sagittal: view.getUint32(offset + 8, true),
  };
  offset += 12;
  const axialLen = view.getUint32(offset, true);
  offset += 4;
  const axial = new Float32Array(buffer.slice(offset, offset + axialLen));
  offset += axialLen;
  const coronalLen = view.getUint32(offset, true);
  offset += 4;
  const coronal = new Float32Array(buffer.slice(offset, offset + coronalLen));
  offset += coronalLen;
  const sagittalLen = view.getUint32(offset, true);
  offset += 4;
  const sagittal = new Float32Array(buffer.slice(offset, offset + sagittalLen));
  return {
    header,
    globalMin,
    globalMax,
    sliceIdx: sliceIdxData,
    slope: header.scl_slope || 1,
    inter: header.scl_inter || 0,
    slices: { axial, coronal, sagittal },
  };
}

export function toFloat32Array(val: unknown, fallbackKey: string, msg: { slices?: MessageSlices }): Float32Array {
  if (val instanceof ArrayBuffer) return new Float32Array(val);
  if (ArrayBuffer.isView(val)) return new Float32Array(val.buffer, val.byteOffset, val.byteLength / 4);
  const arr = msg.slices?.[fallbackKey];
  if (arr instanceof ArrayBuffer) return new Float32Array(arr);
  if (ArrayBuffer.isView(arr)) return new Float32Array(arr.buffer, arr.byteOffset, arr.byteLength / 4);
  if (Array.isArray(arr)) return new Float32Array(arr);
  if (Array.isArray(val)) return new Float32Array(val);
  return new Float32Array(0);
}

export function sliceHasSignal(arr: Float32Array): boolean {
  if (!arr || arr.length === 0) return false;
  const step = Math.max(1, (arr.length / 64) | 0);
  for (let i = 0; i < arr.length; i += step) {
    if (arr[i] !== 0) return true;
  }
  return false;
}

/** Concatenate an array of Uint8Array chunks into one contiguous buffer. */
export function concatUint8Chunks(chunks: Uint8Array[], totalLen?: number): Uint8Array {
  const total = totalLen ?? chunks.reduce((s, c) => s + c.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

/**
 * Compute volume min/max with typed-array fast path + sampling.
 * Mirrors the extension host's computeVoxelStats so display stats match.
 */
export function computeVolumeStatsWebview(rawData: Uint8Array, header: NiiHeader): { min: number; max: number } {
  const { nx, ny, nz, datatype, scl_slope, scl_inter, littleEndian, voxOffset } = header;
  const n = nx * ny * nz;
  const slope = scl_slope || 1;
  const inter = scl_inter || 0;
  const le = littleEndian;
  const elemSize =
    datatype === 64
      ? 8
      : datatype === 8 || datatype === 16 || datatype === 768
        ? 4
        : datatype === 4 || datatype === 512
          ? 2
          : 1;
  const byteOff = rawData.byteOffset + voxOffset;
  const needsConversion = slope !== 1 || inter !== 0;
  let min = Infinity,
    max = -Infinity;
  const sampleStep = Math.max(1, Math.floor(n / 50000));

  // Fast path: typed-array views for little-endian, aligned, in-range data
  if (le && byteOff % elemSize === 0 && byteOff + n * elemSize <= rawData.buffer.byteLength) {
    if (!needsConversion) {
      switch (datatype) {
        case 2: {
          const a = new Uint8Array(rawData.buffer, byteOff, n);
          for (let i = 0; i < n; i += sampleStep) {
            const v = a[i];
            if (v < min) min = v;
            if (v > max) max = v;
          }
          break;
        }
        case 4: {
          const a = new Int16Array(rawData.buffer, byteOff, n);
          for (let i = 0; i < n; i += sampleStep) {
            const v = a[i];
            if (v < min) min = v;
            if (v > max) max = v;
          }
          break;
        }
        case 8: {
          const a = new Int32Array(rawData.buffer, byteOff, n);
          for (let i = 0; i < n; i += sampleStep) {
            const v = a[i];
            if (v < min) min = v;
            if (v > max) max = v;
          }
          break;
        }
        case 16: {
          const a = new Float32Array(rawData.buffer, byteOff, n);
          for (let i = 0; i < n; i += sampleStep) {
            const v = a[i];
            if (v < min) min = v;
            if (v > max) max = v;
          }
          break;
        }
        case 64: {
          const a = new Float64Array(rawData.buffer, byteOff, n);
          for (let i = 0; i < n; i += sampleStep) {
            const v = a[i];
            if (v < min) min = v;
            if (v > max) max = v;
          }
          break;
        }
        case 256: {
          const a = new Int8Array(rawData.buffer, byteOff, n);
          for (let i = 0; i < n; i += sampleStep) {
            const v = a[i];
            if (v < min) min = v;
            if (v > max) max = v;
          }
          break;
        }
        case 512: {
          const a = new Uint16Array(rawData.buffer, byteOff, n);
          for (let i = 0; i < n; i += sampleStep) {
            const v = a[i];
            if (v < min) min = v;
            if (v > max) max = v;
          }
          break;
        }
        case 768: {
          const a = new Uint32Array(rawData.buffer, byteOff, n);
          for (let i = 0; i < n; i += sampleStep) {
            const v = a[i];
            if (v < min) min = v;
            if (v > max) max = v;
          }
          break;
        }
      }
    } else {
      switch (datatype) {
        case 2: {
          const a = new Uint8Array(rawData.buffer, byteOff, n);
          for (let i = 0; i < n; i += sampleStep) {
            const v = a[i] * slope + inter;
            if (v < min) min = v;
            if (v > max) max = v;
          }
          break;
        }
        case 4: {
          const a = new Int16Array(rawData.buffer, byteOff, n);
          for (let i = 0; i < n; i += sampleStep) {
            const v = a[i] * slope + inter;
            if (v < min) min = v;
            if (v > max) max = v;
          }
          break;
        }
        case 8: {
          const a = new Int32Array(rawData.buffer, byteOff, n);
          for (let i = 0; i < n; i += sampleStep) {
            const v = a[i] * slope + inter;
            if (v < min) min = v;
            if (v > max) max = v;
          }
          break;
        }
        case 16: {
          const a = new Float32Array(rawData.buffer, byteOff, n);
          for (let i = 0; i < n; i += sampleStep) {
            const v = a[i] * slope + inter;
            if (v < min) min = v;
            if (v > max) max = v;
          }
          break;
        }
        case 64: {
          const a = new Float64Array(rawData.buffer, byteOff, n);
          for (let i = 0; i < n; i += sampleStep) {
            const v = a[i] * slope + inter;
            if (v < min) min = v;
            if (v > max) max = v;
          }
          break;
        }
        case 256: {
          const a = new Int8Array(rawData.buffer, byteOff, n);
          for (let i = 0; i < n; i += sampleStep) {
            const v = a[i] * slope + inter;
            if (v < min) min = v;
            if (v > max) max = v;
          }
          break;
        }
        case 512: {
          const a = new Uint16Array(rawData.buffer, byteOff, n);
          for (let i = 0; i < n; i += sampleStep) {
            const v = a[i] * slope + inter;
            if (v < min) min = v;
            if (v > max) max = v;
          }
          break;
        }
        case 768: {
          const a = new Uint32Array(rawData.buffer, byteOff, n);
          for (let i = 0; i < n; i += sampleStep) {
            const v = a[i] * slope + inter;
            if (v < min) min = v;
            if (v > max) max = v;
          }
          break;
        }
      }
    }
  }

  if (min === Infinity || max === -Infinity) {
    min = 0;
    max = 1;
  }
  if (min === max) max = min + 1;
  if (!isFinite(min) || !isFinite(max)) {
    min = 0;
    max = 1;
  }
  return { min, max };
}
