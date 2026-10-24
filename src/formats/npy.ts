import * as fs from 'fs';
import { npyHeaderFromLayout, parseNpyLayout, parseNpyVolume } from '../nifti/npyParser';
import { fileStamp, readFileBytes, readRange, tempFilesFor, writeTempVolume } from './header';
import type { ParseOptions, ParsedVolume, VolumeFormat } from './types';

/** NumPy `.npy` arrays (1D–4D). */
export const npyFormat: VolumeFormat = {
  id: 'npy',
  label: 'NumPy array',
  extensions: ['.npy'],
  async parse(filePath: string, opts: ParseOptions): Promise<ParsedVolume> {
    if (opts.memory) {
      return parseNpyVolume(await readFileBytes(filePath));
    }

    // Remote-SSH: read only the header and serve voxels from the original
    // file. f16 / 64-bit int / big-endian arrays still need one conversion.
    const stat = await fs.promises.stat(filePath);
    const head = await readRange(filePath, 0, Math.min(stat.size, 128 * 1024));
    const layout = parseNpyLayout(head, stat.size);
    if (!layout.needsTransform) {
      return { header: npyHeaderFromLayout(layout, layout.voxOffset), dataPath: filePath };
    }

    const parsed = parseNpyVolume(await readFileBytes(filePath));
    const data = parsed.rawData.subarray(parsed.header.voxOffset);
    const stamp = await fileStamp([filePath]);
    const tempPath = await writeTempVolume(data, stamp ? `npy:${stamp}:${layout.descr}` : undefined);
    return {
      header: { ...parsed.header, voxOffset: 0 },
      dataPath: tempPath,
      tempFiles: tempFilesFor(tempPath),
    };
  },
};
