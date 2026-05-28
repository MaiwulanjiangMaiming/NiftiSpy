import { readLocalFilePartial } from '../io/fileReader';

export function extractAxialSliceFromRange(sliceBytes: Uint8Array, header: any): Float32Array {
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
      case 2: val = sliceBytes[off]; break;
      case 4: val = view.getInt16(off, le); break;
      case 8: val = view.getInt32(off, le); break;
      case 16: val = view.getFloat32(off, le); break;
      case 64: val = view.getFloat64(off, le); break;
      case 256: val = (sliceBytes[off] << 24) >> 24; break;
      case 512: val = view.getUint16(off, le); break;
      case 768: val = view.getUint32(off, le); break;
      default: val = 0;
    }
    slice[i] = val * slope + inter;
  }
  return slice;
}

export async function extractCoronalSliceFromRange(fsPath: string, header: any, idx: number): Promise<Float32Array | null> {
  const { nx, ny, nz, datatype, scl_slope, scl_inter, littleEndian, voxOffset } = header;
  if (idx < 0 || idx >= ny) return null;
  const bpv = Math.max(1, header.bitpix / 8);
  const le = littleEndian;
  const slope = scl_slope || 1;
  const inter = scl_inter || 0;
  const slice = new Float32Array(nx * nz);

  const rowSize = nx * bpv;
  const promises: Promise<{ rowBytes: Uint8Array; z: number }>[] = [];
  for (let z = 0; z < nz; z++) {
    const rowOffset = voxOffset + (z * ny * nx + idx * nx) * bpv;
    promises.push(
      readLocalFilePartial(fsPath, rowOffset, rowOffset + rowSize - 1)
        .then(rowBytes => ({ rowBytes, z }))
    );
  }
  const rows = await Promise.all(promises);

  for (const { rowBytes, z } of rows) {
    const view = new DataView(rowBytes.buffer, rowBytes.byteOffset, rowBytes.byteLength);
    for (let x = 0; x < nx; x++) {
      const off = x * bpv;
      let val: number;
      switch (datatype) {
        case 2: val = rowBytes[off]; break;
        case 4: val = view.getInt16(off, le); break;
        case 8: val = view.getInt32(off, le); break;
        case 16: val = view.getFloat32(off, le); break;
        case 64: val = view.getFloat64(off, le); break;
        case 256: val = (rowBytes[off] << 24) >> 24; break;
        case 512: val = view.getUint16(off, le); break;
        case 768: val = view.getUint32(off, le); break;
        default: val = 0;
      }
      slice[z * nx + x] = val * slope + inter;
    }
  }
  return slice;
}

export async function extractSagittalSliceFromRange(fsPath: string, header: any, idx: number): Promise<Float32Array | null> {
  const { nx, ny, nz, datatype, scl_slope, scl_inter, littleEndian, voxOffset } = header;
  if (idx < 0 || idx >= nx) return null;
  const bpv = Math.max(1, header.bitpix / 8);
  const le = littleEndian;
  const slope = scl_slope || 1;
  const inter = scl_inter || 0;
  const slice = new Float32Array(ny * nz);

  const axialSize = nx * ny * bpv;
  const promises: Promise<{ axialBytes: Uint8Array; z: number }>[] = [];
  for (let z = 0; z < nz; z++) {
    const axialOffset = voxOffset + z * nx * ny * bpv;
    promises.push(
      readLocalFilePartial(fsPath, axialOffset, axialOffset + axialSize - 1)
        .then(axialBytes => ({ axialBytes, z }))
    );
  }
  const axialSlices = await Promise.all(promises);

  for (const { axialBytes, z } of axialSlices) {
    const view = new DataView(axialBytes.buffer, axialBytes.byteOffset, axialBytes.byteLength);
    for (let y = 0; y < ny; y++) {
      const off = (y * nx + idx) * bpv;
      let val: number;
      switch (datatype) {
        case 2: val = axialBytes[off]; break;
        case 4: val = view.getInt16(off, le); break;
        case 8: val = view.getInt32(off, le); break;
        case 16: val = view.getFloat32(off, le); break;
        case 64: val = view.getFloat64(off, le); break;
        case 256: val = (axialBytes[off] << 24) >> 24; break;
        case 512: val = view.getUint16(off, le); break;
        case 768: val = view.getUint32(off, le); break;
        default: val = 0;
      }
      slice[z * ny + y] = val * slope + inter;
    }
  }
  return slice;
}

export function extractPreviewSlices(rawData: Uint8Array, header: any): { axial: Float32Array; coronal: Float32Array; sagittal: Float32Array } | null {
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
      case 2: return rawData[off];
      case 4: return view.getInt16(off, le);
      case 8: return view.getInt32(off, le);
      case 16: return view.getFloat32(off, le);
      case 64: return view.getFloat64(off, le);
      case 256: return (rawData[off] << 24) >> 24;
      case 512: return view.getUint16(off, le);
      case 768: return view.getUint32(off, le);
      default: return 0;
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

export function extractSingleSlice(rawData: Uint8Array, header: any, axis: string, idx: number): Float32Array | null {
  const { nx, ny, nz, datatype, scl_slope, scl_inter, littleEndian, voxOffset } = header;
  const bpv = Math.max(1, header.bitpix / 8);
  const dataStart = voxOffset;
  const le = littleEndian;
  const slope = scl_slope || 1;
  const inter = scl_inter || 0;
  const view = new DataView(rawData.buffer, rawData.byteOffset, rawData.byteLength);

  function getVoxel(vidx: number): number {
    const off = dataStart + vidx * bpv;
    if (off + bpv > rawData.length) return 0;
    switch (datatype) {
      case 2: return rawData[off];
      case 4: return view.getInt16(off, le);
      case 8: return view.getInt32(off, le);
      case 16: return view.getFloat32(off, le);
      case 64: return view.getFloat64(off, le);
      case 256: return (rawData[off] << 24) >> 24;
      case 512: return view.getUint16(off, le);
      case 768: return view.getUint32(off, le);
      default: return 0;
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

export function downsampleSlice(data: Float32Array, w: number, h: number, factor: number): { data: Float32Array; w: number; h: number } {
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
