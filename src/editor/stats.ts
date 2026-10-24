import { getNativeBindings } from '../nativeBridge';

/**
 * Sampled global min/max for a raw volume. Native mmap stats are used when
 * available; the JS path samples ~50k voxels and handles big-endian and
 * unaligned data via DataView.
 */
export function computeVoxelStats(rawData: Uint8Array, header: any, fsPath?: string): { min: number; max: number } {
  // Try native mmap_get_volume_stats for faster computation
  const native = getNativeBindings();
  if (native?.mmapGetVolumeStats && fsPath && !fsPath.endsWith('.gz')) {
    try {
      const stats = native.mmapGetVolumeStats(fsPath, header);
      if (stats) {
        return { min: stats.min, max: stats.max };
      }
    } catch {
      // Fall through to JS implementation
    }
  }

  const { nx, ny, nz, datatype, scl_slope, scl_inter, littleEndian, voxOffset } = header;
  const n = nx * ny * nz * Math.max(1, header.nt || 1);
  const slope = scl_slope || 1;
  const inter = scl_inter || 0;
  const elemSize = datatype === 64 ? 8 : datatype === 8 || datatype === 16 || datatype === 768 ? 4 : datatype === 4 || datatype === 512 ? 2 : 1;
  const le = littleEndian;
  let min = Infinity, max = -Infinity;
  const sampleStep = Math.max(1, Math.floor(n / 50000));
  const byteOff = rawData.byteOffset + voxOffset;
  const needsConversion = slope !== 1 || inter !== 0;

  // Fast path: use typed array views for little-endian data (common case)
  // Typed array access is 3-5x faster than DataView for sequential reads
  if (le && (byteOff % elemSize === 0) && (byteOff + n * elemSize <= rawData.buffer.byteLength)) {
    if (!needsConversion) {
      switch (datatype) {
        case 2: { const a = new Uint8Array(rawData.buffer, byteOff, n); for (let i = 0; i < n; i += sampleStep) { const v = a[i]; if (v < min) min = v; if (v > max) max = v; } break; }
        case 4: { const a = new Int16Array(rawData.buffer, byteOff, n); for (let i = 0; i < n; i += sampleStep) { const v = a[i]; if (v < min) min = v; if (v > max) max = v; } break; }
        case 8: { const a = new Int32Array(rawData.buffer, byteOff, n); for (let i = 0; i < n; i += sampleStep) { const v = a[i]; if (v < min) min = v; if (v > max) max = v; } break; }
        case 16: { const a = new Float32Array(rawData.buffer, byteOff, n); for (let i = 0; i < n; i += sampleStep) { const v = a[i]; if (v < min) min = v; if (v > max) max = v; } break; }
        case 64: { const a = new Float64Array(rawData.buffer, byteOff, n); for (let i = 0; i < n; i += sampleStep) { const v = a[i]; if (v < min) min = v; if (v > max) max = v; } break; }
        case 256: { const a = new Int8Array(rawData.buffer, byteOff, n); for (let i = 0; i < n; i += sampleStep) { const v = a[i]; if (v < min) min = v; if (v > max) max = v; } break; }
        case 512: { const a = new Uint16Array(rawData.buffer, byteOff, n); for (let i = 0; i < n; i += sampleStep) { const v = a[i]; if (v < min) min = v; if (v > max) max = v; } break; }
        case 768: { const a = new Uint32Array(rawData.buffer, byteOff, n); for (let i = 0; i < n; i += sampleStep) { const v = a[i]; if (v < min) min = v; if (v > max) max = v; } break; }
        default: { const a = new Float32Array(rawData.buffer, byteOff, n); for (let i = 0; i < n; i += sampleStep) { const v = a[i]; if (v < min) min = v; if (v > max) max = v; } break; }
      }
    } else {
      switch (datatype) {
        case 2: { const a = new Uint8Array(rawData.buffer, byteOff, n); for (let i = 0; i < n; i += sampleStep) { const v = a[i] * slope + inter; if (v < min) min = v; if (v > max) max = v; } break; }
        case 4: { const a = new Int16Array(rawData.buffer, byteOff, n); for (let i = 0; i < n; i += sampleStep) { const v = a[i] * slope + inter; if (v < min) min = v; if (v > max) max = v; } break; }
        case 8: { const a = new Int32Array(rawData.buffer, byteOff, n); for (let i = 0; i < n; i += sampleStep) { const v = a[i] * slope + inter; if (v < min) min = v; if (v > max) max = v; } break; }
        case 16: { const a = new Float32Array(rawData.buffer, byteOff, n); for (let i = 0; i < n; i += sampleStep) { const v = a[i] * slope + inter; if (v < min) min = v; if (v > max) max = v; } break; }
        case 64: { const a = new Float64Array(rawData.buffer, byteOff, n); for (let i = 0; i < n; i += sampleStep) { const v = a[i] * slope + inter; if (v < min) min = v; if (v > max) max = v; } break; }
        case 256: { const a = new Int8Array(rawData.buffer, byteOff, n); for (let i = 0; i < n; i += sampleStep) { const v = a[i] * slope + inter; if (v < min) min = v; if (v > max) max = v; } break; }
        case 512: { const a = new Uint16Array(rawData.buffer, byteOff, n); for (let i = 0; i < n; i += sampleStep) { const v = a[i] * slope + inter; if (v < min) min = v; if (v > max) max = v; } break; }
        case 768: { const a = new Uint32Array(rawData.buffer, byteOff, n); for (let i = 0; i < n; i += sampleStep) { const v = a[i] * slope + inter; if (v < min) min = v; if (v > max) max = v; } break; }
        default: { const a = new Float32Array(rawData.buffer, byteOff, n); for (let i = 0; i < n; i += sampleStep) { const v = a[i] * slope + inter; if (v < min) min = v; if (v > max) max = v; } break; }
      }
    }
  } else {
    // Fallback: DataView for big-endian or unaligned data
    const view = new DataView(rawData.buffer, byteOff, n * elemSize);
    for (let i = 0; i < n; i += sampleStep) {
      let val: number;
      switch (datatype) {
        case 2: val = view.getUint8(i * elemSize); break;
        case 4: val = view.getInt16(i * elemSize, le); break;
        case 8: val = view.getInt32(i * elemSize, le); break;
        case 16: val = view.getFloat32(i * elemSize, le); break;
        case 64: val = view.getFloat64(i * elemSize, le); break;
        case 256: val = view.getInt8(i * elemSize); break;
        case 512: val = view.getUint16(i * elemSize, le); break;
        case 768: val = view.getUint32(i * elemSize, le); break;
        default: val = view.getFloat32(i * elemSize, le); break;
      }
      val = val * slope + inter;
      if (val < min) min = val;
      if (val > max) max = val;
    }
  }
  if (min === max) max = min + 1;
  if (min > max || !isFinite(min) || !isFinite(max)) { min = 0; max = 1; }
  return { min, max };
}
