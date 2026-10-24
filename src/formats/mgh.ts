import * as zlib from 'zlib';
import {
  DATATYPE_BYTES, ensureLittleEndian, fileStamp, makeNiftiHeader, readFileBytes,
  tempFilesFor, writeTempVolume,
} from './header';
import type { ParseOptions, ParsedVolume, VolumeFormat } from './types';

const MGH_HEADER_SIZE = 284;

/** FreeSurfer MGH / MGZ surfaces + volumes (all big-endian). */
export const mghFormat: VolumeFormat = {
  id: 'mgh',
  label: 'FreeSurfer MGH/MGZ',
  extensions: ['.mgh', '.mgz'],
  async parse(filePath: string, opts: ParseOptions): Promise<ParsedVolume> {
    const source = await readFileBytes(filePath);
    // Detect gzip by magic, not by extension: virtual-FS materialization and
    // Remote-SSH paths can carry arbitrary names.
    const isGzip = source.length > 1 && source[0] === 0x1f && source[1] === 0x8b;
    const raw = isGzip ? gunzip(source) : source;
    if (raw.length < MGH_HEADER_SIZE) throw new Error('truncated MGH header');

    const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    const width = view.getInt32(4, false);
    const height = view.getInt32(8, false);
    const depth = view.getInt32(12, false);
    const nframes = view.getInt32(16, false);
    const type = view.getInt32(20, false);
    if (!(width > 0 && height > 0 && depth > 0)) throw new Error('invalid MGH dimensions');

    const datatype = mghDatatype(type);
    const bytesPerVoxel = DATATYPE_BYTES[datatype];
    const nx = width, ny = height, nz = depth, nt = Math.max(1, nframes);

    const dx = Math.abs(view.getFloat32(32, false)) || 1;
    const dy = Math.abs(view.getFloat32(36, false)) || 1;
    const dz = Math.abs(view.getFloat32(40, false)) || 1;
    const rasGood = view.getInt16(28, false) === 1;
    let sform: number[][] | undefined;
    if (rasGood) {
      const mdc = [
        [view.getFloat32(44, false), view.getFloat32(48, false), view.getFloat32(52, false)],
        [view.getFloat32(56, false), view.getFloat32(60, false), view.getFloat32(64, false)],
        [view.getFloat32(68, false), view.getFloat32(72, false), view.getFloat32(76, false)],
      ];
      const pxyz = [view.getFloat32(80, false), view.getFloat32(84, false), view.getFloat32(88, false)];
      const zoom = [dx, dy, dz];
      const a: number[][] = [0, 1, 2].map(r => [0, 1, 2].map(c => mdc[c][r] * zoom[c]));
      const origin = [0, 1, 2].map(r =>
        pxyz[r] - (a[r][0] * (nx / 2) + a[r][1] * (ny / 2) + a[r][2] * (nz / 2)),
      );
      sform = [0, 1, 2].map(r => [a[r][0], a[r][1], a[r][2], origin[r]]);
    }

    const payload = raw.subarray(MGH_HEADER_SIZE);
    const expected = nx * ny * nz * nt * bytesPerVoxel;
    if (payload.length < expected) throw new Error('truncated MGH voxel data');
    // MGH stores big-endian voxels; the renderer and GPU expect little-endian.
    const little = ensureLittleEndian(payload.subarray(0, expected), bytesPerVoxel);

    const header = makeNiftiHeader({
      nx, ny, nz, nt, dx, dy, dz, datatype, voxOffset: 0, sform,
      descrip: `FreeSurfer ${isGzip ? 'MGZ' : 'MGH'} type ${type}`,
      orientation: 'RAS',
    });
    if (opts.memory) return { header, rawData: little };
    const stamp = await fileStamp([filePath]);
    const tempPath = await writeTempVolume(little, stamp ? `mgh:${stamp}:${type}` : undefined);
    return { header, dataPath: tempPath, tempFiles: tempFilesFor(tempPath) };
  },
};

function mghDatatype(type: number): number {
  switch (type) {
    case 0: return 2;   // MRI_UCHAR
    case 1: return 8;   // MRI_INT (4-byte signed)
    case 2: return 8;   // MRI_LONG (4-byte on FreeSurfer platforms)
    case 3: return 16;  // MRI_FLOAT
    case 4: return 4;   // MRI_SHORT
    default: throw new Error(`unsupported MGH voxel type ${type}`);
  }
}

function gunzip(data: Uint8Array): Uint8Array {
  const out = zlib.gunzipSync(data);
  return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
}
