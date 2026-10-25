import { dicomFormat } from './dicom';
import { metaImageFormat } from './metaImage';
import { mghFormat } from './mgh';
import { mrcFormat } from './mrc';
import { npyFormat } from './npy';
import { npzFormat } from './npz';
import { nrrdFormat } from './nrrd';
import { formatMatches, type ParsedVolume, type VolumeFormat } from './types';

/** Single source of truth for host-parsed formats (open + select dialogs). */
export const VOLUME_FORMATS: VolumeFormat[] = [
  npyFormat,
  npzFormat,
  nrrdFormat,
  metaImageFormat,
  mrcFormat,
  mghFormat,
  dicomFormat,
];

export { prepareParsedPayload } from './payload';

export const VOLUME_EXTENSIONS = VOLUME_FORMATS.flatMap((f) => f.extensions);

export function findVolumeFormat(filePath: string): VolumeFormat | undefined {
  return VOLUME_FORMATS.find((f) => formatMatches(f, filePath));
}

export async function parseVolumeFile(
  filePath: string,
  opts: { memory: boolean },
): Promise<{ format: VolumeFormat; parsed: ParsedVolume }> {
  const format = findVolumeFormat(filePath);
  if (!format) throw new Error(`unsupported format: ${filePath}`);
  return { format, parsed: await format.parse(filePath, opts) };
}
