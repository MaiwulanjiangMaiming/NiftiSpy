import * as fs from 'fs';
import { timepointByteOffset, type NiiHeader } from './headerParser';

export function decodeVoxel(bytes: Uint8Array, offset: number, header: NiiHeader, view?: DataView): number {
  const bpv = Math.max(1, header.bitpix / 8);
  if (offset + bpv > bytes.length) return 0;
  const dv = view ?? new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const le = header.littleEndian;
  const slope = header.scl_slope || 1;
  const inter = header.scl_inter || 0;
  let val: number;
  switch (header.datatype) {
    case 2:
      val = bytes[offset];
      break;
    case 4:
      val = dv.getInt16(offset, le);
      break;
    case 8:
      val = dv.getInt32(offset, le);
      break;
    case 16:
      val = dv.getFloat32(offset, le);
      break;
    case 64:
      val = dv.getFloat64(offset, le);
      break;
    case 256:
      val = (bytes[offset] << 24) >> 24;
      break;
    case 512:
      val = dv.getUint16(offset, le);
      break;
    case 768:
      val = dv.getUint32(offset, le);
      break;
    default:
      val = 0;
  }
  return val * slope + inter;
}

export function extractAxialSliceFromRange(sliceBytes: Uint8Array, header: NiiHeader): Float32Array {
  const { nx, ny, datatype, scl_slope, scl_inter, littleEndian } = header;
  const bpv = Math.max(1, header.bitpix / 8);
  const le = littleEndian;
  const slope = scl_slope || 1;
  const inter = scl_inter || 0;
  const n = nx * ny;
  const slice = new Float32Array(n);
  const view = new DataView(sliceBytes.buffer, sliceBytes.byteOffset, sliceBytes.byteLength);

  for (let i = 0; i < n; i++) {
    const off = i * bpv;
    let val: number;
    switch (datatype) {
      case 2:
        val = sliceBytes[off];
        break;
      case 4:
        val = view.getInt16(off, le);
        break;
      case 8:
        val = view.getInt32(off, le);
        break;
      case 16:
        val = view.getFloat32(off, le);
        break;
      case 64:
        val = view.getFloat64(off, le);
        break;
      case 256:
        val = (sliceBytes[off] << 24) >> 24;
        break;
      case 512:
        val = view.getUint16(off, le);
        break;
      case 768:
        val = view.getUint32(off, le);
        break;
      default:
        val = 0;
    }
    slice[i] = val * slope + inter;
  }
  return slice;
}

/** Little-endian typed view over the scratch buffer, or null for DataView. */
function leTypedView(
  scratch: Buffer,
  bytes: number,
  header: NiiHeader,
): Uint8Array | Int8Array | Int16Array | Uint16Array | Int32Array | Uint32Array | Float32Array | Float64Array | null {
  if (!header.littleEndian) return null;
  const bpv = Math.max(1, header.bitpix / 8);
  if (scratch.byteOffset % bpv !== 0) return null;
  switch (header.datatype) {
    case 2:
      return scratch;
    case 256:
      return new Int8Array(scratch.buffer, scratch.byteOffset, bytes);
    case 4:
      return new Int16Array(scratch.buffer, scratch.byteOffset, bytes / 2);
    case 512:
      return new Uint16Array(scratch.buffer, scratch.byteOffset, bytes / 2);
    case 8:
      return new Int32Array(scratch.buffer, scratch.byteOffset, bytes / 4);
    case 768:
      return new Uint32Array(scratch.buffer, scratch.byteOffset, bytes / 4);
    case 16:
      return new Float32Array(scratch.buffer, scratch.byteOffset, bytes / 4);
    case 64:
      return new Float64Array(scratch.buffer, scratch.byteOffset, bytes / 8);
    default:
      return null;
  }
}

/** A single file handle and an 8 MiB scratch budget, independent of volume depth. */
export async function extractLocalSlice(
  fsPath: string,
  header: NiiHeader,
  axis: string,
  idx: number,
  timeIdx = 0,
  factor = 1,
  signal?: AbortSignal,
): Promise<Float32Array | null> {
  const { nx, ny, nz, voxOffset } = header;
  const limit = axis === 'axial' ? nz : axis === 'coronal' ? ny : nx;
  if (!Number.isInteger(idx) || idx < 0 || idx >= limit) return null;
  const f = Math.max(1, Math.min(32, Math.floor(factor) || 1));
  const width = axis === 'sagittal' ? ny : nx;
  const height = axis === 'axial' ? ny : nz;
  const w = Math.max(1, Math.floor(width / f)),
    h = Math.max(1, Math.floor(height / f));
  const out = new Float32Array(w * h);
  const bpv = Math.max(1, header.bitpix / 8),
    rowBytes = nx * bpv;
  const slope = header.scl_slope || 1;
  const inter = header.scl_inter || 0;
  const base = voxOffset + timepointByteOffset(header, timeIdx);
  const fd = await fs.promises.open(fsPath, 'r');
  const scratch = Buffer.allocUnsafe(Math.min(8 * 1024 * 1024, axis === 'sagittal' ? rowBytes * ny : rowBytes));
  const read = async (position: number, bytes: number) => {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    let done = 0;
    while (done < bytes) {
      const r = await fd.read(scratch, done, bytes - done, position + done);
      if (!r.bytesRead) throw new Error('Truncated NIfTI voxel data');
      done += r.bytesRead;
    }
    return new DataView(scratch.buffer, scratch.byteOffset, bytes);
  };
  try {
    for (let oy = 0; oy < h; oy++) {
      if (axis !== 'sagittal') {
        const z = axis === 'axial' ? idx : oy * f;
        const y = axis === 'axial' ? oy * f : idx;
        // Rows larger than the scratch budget are read in tiles.
        for (let first = 0; first < w; ) {
          const count = Math.min(w - first, Math.max(1, Math.floor(scratch.length / (f * bpv))));
          const bytes = ((count - 1) * f + 1) * bpv;
          const view = await read(base + ((z * ny + y) * nx + first * f) * bpv, bytes);
          const typed = leTypedView(scratch, bytes, header);
          for (let x = 0; x < count; x++) {
            const i = x * f;
            out[oy * w + first + x] = typed ? typed[i] * slope + inter : decodeVoxel(scratch, i * bpv, header, view);
          }
          first += count;
        }
      } else {
        // Read bounded slabs within one axial plane, then select the column.
        const rowsPerSlab = Math.max(1, Math.floor(scratch.length / rowBytes));
        for (let firstY = 0; firstY < ny; firstY += rowsPerSlab) {
          const rows = Math.min(rowsPerSlab, ny - firstY);
          if (rowBytes > scratch.length) {
            // Extremely wide data: pread the selected voxel instead of a row.
            for (let y = firstY; y < firstY + rows; y++)
              if (y % f === 0 && y / f < w) {
                const view = await read(base + ((oy * f * ny + y) * nx + idx) * bpv, bpv);
                const typed = leTypedView(scratch, bpv, header);
                out[oy * w + y / f] = typed ? typed[0] * slope + inter : decodeVoxel(scratch, 0, header, view);
              }
          } else {
            const bytes = rows * rowBytes;
            const view = await read(base + (oy * f * ny + firstY) * rowBytes, bytes);
            const typed = leTypedView(scratch, bytes, header);
            for (let y = firstY; y < firstY + rows; y++)
              if (y % f === 0 && y / f < w) {
                const i = (y - firstY) * nx + idx;
                out[oy * w + y / f] = typed ? typed[i] * slope + inter : decodeVoxel(scratch, i * bpv, header, view);
              }
          }
        }
      }
    }
    return out;
  } finally {
    await fd.close();
  }
}

export interface RawLocalSlice {
  data: Uint8Array;
  width: number;
  height: number;
}

/**
 * Same traversal as extractLocalSlice but returns the native little-endian
 * voxel bytes (8/16-bit only). This halves the slice payload for the common
 * int16 MRI/CT case; the client applies scl_slope / scl_inter.
 */
export async function extractLocalSliceRaw(
  fsPath: string,
  header: NiiHeader,
  axis: string,
  idx: number,
  timeIdx = 0,
  factor = 1,
  signal?: AbortSignal,
): Promise<RawLocalSlice | null> {
  const { nx, ny, nz, voxOffset } = header;
  const limit = axis === 'axial' ? nz : axis === 'coronal' ? ny : nx;
  if (!Number.isInteger(idx) || idx < 0 || idx >= limit) return null;
  const bpv = Math.max(1, header.bitpix / 8);
  if (bpv > 2 || !header.littleEndian) return null;

  const f = Math.max(1, Math.min(32, Math.floor(factor) || 1));
  const width = axis === 'sagittal' ? ny : nx;
  const height = axis === 'axial' ? ny : nz;
  const w = Math.max(1, Math.floor(width / f)),
    h = Math.max(1, Math.floor(height / f));
  const out = new Uint8Array(w * h * bpv);
  const rowBytes = nx * bpv;
  const base = voxOffset + timepointByteOffset(header, timeIdx);
  const fd = await fs.promises.open(fsPath, 'r');
  const scratch = Buffer.allocUnsafe(Math.min(8 * 1024 * 1024, axis === 'sagittal' ? rowBytes * ny : rowBytes));

  const read = async (position: number, bytes: number) => {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    let done = 0;
    while (done < bytes) {
      const r = await fd.read(scratch, done, bytes - done, position + done);
      if (!r.bytesRead) throw new Error('Truncated NIfTI voxel data');
      done += r.bytesRead;
    }
  };
  const copyVoxel = (src: number, dstIndex: number) => {
    const dst = dstIndex * bpv;
    for (let b = 0; b < bpv; b++) out[dst + b] = scratch[src + b];
  };

  try {
    for (let oy = 0; oy < h; oy++) {
      if (axis !== 'sagittal') {
        const z = axis === 'axial' ? idx : oy * f;
        const y = axis === 'axial' ? oy * f : idx;
        for (let first = 0; first < w; ) {
          const count = Math.min(w - first, Math.max(1, Math.floor(scratch.length / (f * bpv))));
          const bytes = ((count - 1) * f + 1) * bpv;
          await read(base + ((z * ny + y) * nx + first * f) * bpv, bytes);
          if (f === 1) {
            out.set(scratch.subarray(0, count * bpv), (oy * w + first) * bpv);
          } else {
            for (let x = 0; x < count; x++) copyVoxel(x * f * bpv, oy * w + first + x);
          }
          first += count;
        }
      } else {
        const rowsPerSlab = Math.max(1, Math.floor(scratch.length / rowBytes));
        for (let firstY = 0; firstY < ny; firstY += rowsPerSlab) {
          const rows = Math.min(rowsPerSlab, ny - firstY);
          if (rowBytes > scratch.length) {
            for (let y = firstY; y < firstY + rows; y++)
              if (y % f === 0 && y / f < w) {
                await read(base + ((oy * f * ny + y) * nx + idx) * bpv, bpv);
                copyVoxel(0, oy * w + y / f);
              }
          } else {
            await read(base + (oy * f * ny + firstY) * rowBytes, rows * rowBytes);
            for (let y = firstY; y < firstY + rows; y++)
              if (y % f === 0 && y / f < w) {
                copyVoxel(((y - firstY) * nx + idx) * bpv, oy * w + y / f);
              }
          }
        }
      }
    }
    return { data: out, width: w, height: h };
  } finally {
    await fd.close();
  }
}

export async function extractCoronalSliceFromRange(
  fsPath: string,
  header: NiiHeader,
  idx: number,
  timeIdx = 0,
): Promise<Float32Array | null> {
  return extractLocalSlice(fsPath, header, 'coronal', idx, timeIdx);
}

export async function extractSagittalSliceFromRange(
  fsPath: string,
  header: NiiHeader,
  idx: number,
  timeIdx = 0,
): Promise<Float32Array | null> {
  return extractLocalSlice(fsPath, header, 'sagittal', idx, timeIdx);
}

export function sampleSlice(data: Float32Array, w: number, h: number, factor: number): Float32Array {
  if (factor <= 1) return data;
  const nw = Math.max(1, Math.floor(w / factor)),
    nh = Math.max(1, Math.floor(h / factor));
  const out = new Float32Array(nw * nh);
  for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) out[y * nw + x] = data[y * factor * w + x * factor];
  return out;
}

export function extractPreviewSlices(
  rawData: Uint8Array,
  header: NiiHeader,
): { axial: Float32Array; coronal: Float32Array; sagittal: Float32Array } | null {
  const { nx, ny, nz, datatype, scl_slope, scl_inter, littleEndian, voxOffset } = header;
  const n = nx * ny * nz;
  const bpv = Math.max(1, header.bitpix / 8);
  const dataStart = voxOffset;
  const dataEnd = dataStart + n * bpv;
  if (rawData.length < dataEnd) return null;

  const le = littleEndian;
  const slope = scl_slope || 1;
  const inter = scl_inter || 0;
  const view = new DataView(rawData.buffer, rawData.byteOffset, rawData.byteLength);

  function getVoxel(idx: number): number {
    const off = dataStart + idx * bpv;
    switch (datatype) {
      case 2:
        return rawData[off];
      case 4:
        return view.getInt16(off, le);
      case 8:
        return view.getInt32(off, le);
      case 16:
        return view.getFloat32(off, le);
      case 64:
        return view.getFloat64(off, le);
      case 256:
        return (rawData[off] << 24) >> 24;
      case 512:
        return view.getUint16(off, le);
      case 768:
        return view.getUint32(off, le);
      default:
        return 0;
    }
  }

  const axMid = Math.floor(nz / 2);
  const coMid = Math.floor(ny / 2);
  const saMid = Math.floor(nx / 2);

  const axial = new Float32Array(nx * ny);
  const coronal = new Float32Array(nx * nz);
  const sagittal = new Float32Array(ny * nz);

  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) {
      axial[y * nx + x] = getVoxel(axMid * ny * nx + y * nx + x) * slope + inter;
    }
  }
  for (let z = 0; z < nz; z++) {
    for (let x = 0; x < nx; x++) {
      coronal[z * nx + x] = getVoxel(z * ny * nx + coMid * nx + x) * slope + inter;
    }
  }
  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      sagittal[z * ny + y] = getVoxel(z * ny * nx + y * nx + saMid) * slope + inter;
    }
  }

  return { axial, coronal, sagittal };
}

export function extractSingleSlice(
  rawData: Uint8Array,
  header: NiiHeader,
  axis: string,
  idx: number,
  timeIdx = 0,
): Float32Array | null {
  const { nx, ny, nz, datatype, scl_slope, scl_inter, littleEndian, voxOffset } = header;
  const bpv = Math.max(1, header.bitpix / 8);
  const tOff = timepointByteOffset(header, timeIdx);
  const dataStart = voxOffset + tOff;
  const le = littleEndian;
  const slope = scl_slope || 1;
  const inter = scl_inter || 0;
  const view = new DataView(rawData.buffer, rawData.byteOffset, rawData.byteLength);

  function getVoxel(vidx: number): number {
    const off = dataStart + vidx * bpv;
    if (off + bpv > rawData.length) return 0;
    switch (datatype) {
      case 2:
        return rawData[off];
      case 4:
        return view.getInt16(off, le);
      case 8:
        return view.getInt32(off, le);
      case 16:
        return view.getFloat32(off, le);
      case 64:
        return view.getFloat64(off, le);
      case 256:
        return (rawData[off] << 24) >> 24;
      case 512:
        return view.getUint16(off, le);
      case 768:
        return view.getUint32(off, le);
      default:
        return 0;
    }
  }

  if (axis === 'axial') {
    if (idx < 0 || idx >= nz) return null;
    const slice = new Float32Array(nx * ny);
    const base = idx * ny * nx;
    for (let i = 0; i < nx * ny; i++) {
      slice[i] = getVoxel(base + i) * slope + inter;
    }
    return slice;
  } else if (axis === 'coronal') {
    if (idx < 0 || idx >= ny) return null;
    const slice = new Float32Array(nx * nz);
    for (let z = 0; z < nz; z++) {
      const base = z * ny * nx + idx * nx;
      for (let x = 0; x < nx; x++) {
        slice[z * nx + x] = getVoxel(base + x) * slope + inter;
      }
    }
    return slice;
  } else if (axis === 'sagittal') {
    if (idx < 0 || idx >= nx) return null;
    const slice = new Float32Array(ny * nz);
    for (let z = 0; z < nz; z++) {
      const base = z * ny * nx;
      for (let y = 0; y < ny; y++) {
        slice[z * ny + y] = getVoxel(base + y * nx + idx) * slope + inter;
      }
    }
    return slice;
  }
  return null;
}

export function downsampleSlice(
  data: Float32Array,
  w: number,
  h: number,
  factor: number,
): { data: Float32Array; w: number; h: number } {
  const nw = Math.max(1, Math.floor(w / factor));
  const nh = Math.max(1, Math.floor(h / factor));
  const out = new Float32Array(nw * nh);
  for (let y = 0; y < nh; y++) {
    for (let x = 0; x < nw; x++) {
      let sum = 0;
      let count = 0;
      const sy0 = y * factor;
      const sx0 = x * factor;
      const sy1 = Math.min(h, (y + 1) * factor);
      const sx1 = Math.min(w, (x + 1) * factor);
      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0; sx < sx1; sx++) {
          sum += data[sy * w + sx];
          count++;
        }
      }
      out[y * nw + x] = count > 0 ? sum / count : 0;
    }
  }
  return { data: out, w: nw, h: nh };
}
