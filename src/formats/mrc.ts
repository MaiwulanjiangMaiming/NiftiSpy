import {
  readFileBytes, readRange, makeNiftiHeader, sformFromDirections, toU8,
} from './header';
import type { ParseOptions, ParsedVolume, VolumeFormat } from './types';

/** MRC / MRC2014 cryo-EM volumes (`.mrc`, `.mrcs`). */
export const mrcFormat: VolumeFormat = {
  id: 'mrc',
  label: 'MRC',
  extensions: ['.mrc', '.mrcs'],
  async parse(filePath: string, opts: ParseOptions): Promise<ParsedVolume> {
    const head = await readRange(filePath, 0, 1024);
    if (head.length < 1024) throw new Error('truncated MRC header');
    const view = new DataView(head.buffer, head.byteOffset, head.byteLength);

    const nx = view.getInt32(0, true);
    const ny = view.getInt32(4, true);
    let nz = view.getInt32(8, true);
    if (!(nx > 0 && ny > 0)) throw new Error('invalid MRC dimensions');
    if (!(nz > 0)) nz = 1;

    const mode = view.getInt32(12, true);
    const datatype = mrcDatatype(mode);
    const bytesPerVoxel = datatype === 2 || datatype === 256 ? 1 : datatype === 512 || datatype === 4 ? 2 : 4;

    const cellA = view.getFloat32(40, true);
    const cellB = view.getFloat32(44, true);
    const cellC = view.getFloat32(48, true);
    const dx = cellA > 0 ? cellA / nx : 1;
    const dy = cellB > 0 ? cellB / ny : 1;
    const dz = cellC > 0 ? cellC / nz : 1;

    const nsymbt = Math.max(0, view.getInt32(92, true));
    const voxOffset = 1024 + nsymbt;

    // mapc/mapr/maps describe how the stored columns/rows/sections map to
    // the three cell axes. Most files use the identity mapping.
    const axisMap = [view.getInt32(64, true), view.getInt32(68, true), view.getInt32(72, true)];
    let sform: number[][] | undefined;
    if (axisMap.every(v => v >= 1 && v <= 3) && new Set(axisMap).size === 3 &&
        !(axisMap[0] === 1 && axisMap[1] === 2 && axisMap[2] === 3)) {
      const directions = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
      axisMap.forEach((axis, column) => { directions[column][axis - 1] = 1; });
      sform = sformFromDirections(directions, [dx, dy, dz], [0, 0, 0]);
    }

    const header = makeNiftiHeader({
      nx, ny, nz, dx, dy, dz, datatype, voxOffset, sform,
      descrip: `MRC mode ${mode} (${nx}×${ny}×${nz})`,
    });

    if (opts.memory) {
      // Keep the whole file so header.voxOffset stays absolute (zero-copy).
      const source = toU8(await readFileBytes(filePath));
      if (source.length < voxOffset + nx * ny * nz * bytesPerVoxel) {
        throw new Error('truncated MRC voxel data');
      }
      return { header, rawData: source };
    }

    // Remote-SSH: slices are pread from the original .mrc/.mrcs file.
    return { header, dataPath: filePath };
  },
};

function mrcDatatype(mode: number): number {
  switch (mode) {
    case 0: return 256; // signed int8
    case 1: return 4;   // signed int16
    case 2: return 16;  // float32
    case 6: return 512; // unsigned int16
    default: throw new Error(`unsupported MRC mode ${mode} (complex/float16 not supported)`);
  }
}
