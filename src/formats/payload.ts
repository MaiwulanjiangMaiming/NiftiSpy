/** Normalize a host-parsed volume into the exact payload the webview caches.
 *
 * Host parsers may produce 4D arrays, Float64 values, or a voxel block that
 * starts on an unaligned byte. This is the single place that decides how many
 * voxels are published, so `nt` in the header always matches the bytes on the
 * wire.
 */

export interface PreparedPayload {
  header: any;
  payload: Uint8Array;
  totalVoxels: number;
  voxelBytes: number;
  /** Present only when Float64 was downcast to Float32. */
  min?: number;
  max?: number;
}

export function prepareParsedPayload(header: any, rawData: Uint8Array): PreparedPayload {
  const nx = Math.max(1, Math.floor(header.nx || 1));
  const ny = Math.max(1, Math.floor(header.ny || 1));
  const nz = Math.max(1, Math.floor(header.nz || 1));
  const nt = Math.max(1, Math.floor(header.nt || 1));
  const bpv = Math.max(1, Math.floor(header.bytesPerVoxel || 1));
  const totalVoxels = nx * ny * nz * nt;
  const voxelBytes = totalVoxels * bpv;

  header.nx = nx;
  header.ny = ny;
  header.nz = nz;
  header.nt = nt;
  header.bytesPerVoxel = bpv;
  header.totalVoxels3D = nx * ny * nz;

  if (rawData.length < header.voxOffset + voxelBytes) {
    throw new Error('truncated voxel data');
  }

  // Typed-array views require natural alignment. Text headers (NRRD /
  // MetaImage) can leave the voxels on an arbitrary byte.
  if ((rawData.byteOffset + header.voxOffset) % bpv !== 0) {
    const aligned = new Uint8Array(voxelBytes);
    aligned.set(rawData.subarray(header.voxOffset, header.voxOffset + voxelBytes));
    rawData = aligned;
    header.voxOffset = 0;
  }

  if (header.datatype === 64) {
    // Float64 → Float32: halves the transfer payload with no visible loss.
    const src = new Float64Array(
      rawData.buffer, rawData.byteOffset + header.voxOffset, totalVoxels,
    );
    const dst = new Float32Array(totalVoxels);
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < totalVoxels; i++) {
      const v = src[i];
      dst[i] = v;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    if (lo === hi) hi = lo + 1;
    if (!isFinite(lo) || !isFinite(hi)) { lo = 0; hi = 1; }
    header.datatype = 16;
    header.bitpix = 32;
    header.bytesPerVoxel = 4;
    header.voxOffset = 0;
    header.volumeBytes = totalVoxels * 4;
    return {
      header,
      payload: new Uint8Array(dst.buffer),
      totalVoxels,
      voxelBytes: totalVoxels * 4,
      min: lo,
      max: hi,
    };
  }

  header.volumeBytes = voxelBytes;
  return { header, payload: rawData, totalVoxels, voxelBytes };
}
