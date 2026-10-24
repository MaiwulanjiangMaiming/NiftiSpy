import * as path from 'path';
import * as zlib from 'zlib';
import { parseNpyVolume } from '../nifti/npyParser';
import { fileStamp, readFileBytes, tempFilesFor, writeTempVolume } from './header';
import type { ParseOptions, ParsedVolume, VolumeFormat } from './types';

/** Minimal ZIP reader for NumPy `.npz` archives (stored + deflate). */
export const npzFormat: VolumeFormat = {
  id: 'npz',
  label: 'NumPy archive',
  extensions: ['.npz'],
  async parse(filePath: string, opts: ParseOptions): Promise<ParsedVolume> {
    const archive = await readFileBytes(filePath);
    const member = extractNpyMember(archive, filePath);
    const parsed = parseNpyVolume(member);
    if (opts.memory) return parsed;

    // Remote-SSH slice mode: materialize the plain array once, then every
    // /slice request is a random read on the remote disk.
    const voxelBytes = parsed.header.nx * parsed.header.ny * parsed.header.nz
      * parsed.header.nt * parsed.header.bytesPerVoxel;
    const data = parsed.rawData!.subarray(
      parsed.header.voxOffset,
      parsed.header.voxOffset + voxelBytes,
    );
    const stamp = await fileStamp([filePath]);
    const dataPath = await writeTempVolume(data, stamp ? `npz:${stamp}` : undefined);
    return {
      header: { ...parsed.header, voxOffset: 0 },
      dataPath,
      tempFiles: tempFilesFor(dataPath),
    };
  },
};

function extractNpyMember(archive: Uint8Array, filePath: string): Uint8Array {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  const eocd = findEocd(view);
  if (eocd < 0) throw new Error('not a valid .npz archive (missing ZIP directory)');
  const entryCount = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const wanted = path.basename(filePath).replace(/\.npz$/i, '').toLowerCase();
  const candidates: Array<{ name: string; method: number; compressed: number; raw: number; local: number }> = [];

  for (let i = 0; i < entryCount; i++) {
    if (offset + 46 > archive.length || view.getUint32(offset, true) !== 0x02014b50) break;
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const compressed = view.getUint32(offset + 20, true);
    const raw = view.getUint32(offset + 24, true);
    const nameLen = view.getUint16(offset + 28, true);
    const extraLen = view.getUint16(offset + 30, true);
    const commentLen = view.getUint16(offset + 32, true);
    const local = view.getUint32(offset + 42, true);
    const nameBytes = archive.subarray(offset + 46, offset + 46 + nameLen);
    const name = (flags & 0x800)
      ? new TextDecoder().decode(nameBytes)
      : Buffer.from(nameBytes.buffer, nameBytes.byteOffset, nameBytes.byteLength).toString('latin1');
    if (/\.npy$/i.test(name) && !name.startsWith('__MACOSX/')) {
      if (method !== 0 && method !== 8) throw new Error(`unsupported .npz compression method ${method}`);
      if (compressed === 0xffffffff || raw === 0xffffffff) throw new Error('ZIP64 .npz archives are not supported');
      candidates.push({ name, method, compressed, raw, local });
    }
    offset += 46 + nameLen + extraLen + commentLen;
  }

  if (candidates.length === 0) throw new Error('no .npy array found inside .npz');
  const exact = candidates.find(c => path.posix.basename(c.name).replace(/\.npy$/i, '').toLowerCase() === wanted);
  const picked = exact || candidates[0];

  const localOffset = picked.local;
  if (localOffset + 30 > archive.length || view.getUint32(localOffset, true) !== 0x04034b50) {
    throw new Error('corrupt .npz member header');
  }
  const nameLen = view.getUint16(localOffset + 26, true);
  const extraLen = view.getUint16(localOffset + 28, true);
  const dataStart = localOffset + 30 + nameLen + extraLen;
  const compressed = archive.subarray(dataStart, Math.min(archive.length, dataStart + picked.compressed));

  if (picked.method === 0) {
    return compressed.length === picked.compressed ? compressed : new Uint8Array(compressed);
  }
  const maxOutputLength = picked.raw > 0 ? picked.raw : undefined;
  const inflated = zlib.inflateRawSync(compressed, maxOutputLength ? { maxOutputLength } : undefined);
  return new Uint8Array(inflated.buffer, inflated.byteOffset, inflated.byteLength);
}

function findEocd(view: DataView): number {
  const min = Math.max(0, view.byteLength - 22 - 65535);
  for (let i = view.byteLength - 22; i >= min; i--) {
    if (view.getUint32(i, true) === 0x06054b50) return i;
  }
  return -1;
}
