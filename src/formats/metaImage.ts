import * as path from 'path';
import * as zlib from 'zlib';
import {
  DATATYPE_BYTES, ensureLittleEndian, makeNiftiHeader, readFileBytes,
  readTextHeader, toU8, writeTempVolume,
} from './header';
import type { ParseOptions, ParsedVolume, VolumeFormat } from './types';

/** ITK MetaImage (`.mha` attached, `.mhd` detached). */
export const metaImageFormat: VolumeFormat = {
  id: 'metaimage',
  label: 'MetaImage',
  extensions: ['.mha', '.mhd'],
  async parse(filePath: string, opts: ParseOptions): Promise<ParsedVolume> {
    const { text, dataStart } = await readTextHeader(
      filePath,
      /(?:^|\r?\n)ElementDataFile\s*=\s*[^\r\n]*(?:\r?\n|$)/i,
    );
    const fields = parseFields(text);

    const dims = (fields.get('dimsize') || '').trim().split(/\s+/).map(Number);
    if (dims.length < 2 || dims.length > 4 || dims.some(v => !Number.isSafeInteger(v) || v <= 0)) {
      throw new Error('invalid MetaImage DimSize');
    }
    const channels = parseInt(fields.get('elementnumberofchannels') || '1', 10) || 1;
    const nx = dims[0];
    const ny = dims[1];
    const nz = dims[2] || 1;
    const nt = dims[3] || channels;
    if (nt > 1 && dims.length < 4 && channels !== nt) throw new Error('unsupported MetaImage channel layout');

    const datatype = metaDatatype(fields.get('elementtype') || '');
    const bytesPerVoxel = DATATYPE_BYTES[datatype];
    const voxelCount = nx * ny * nz * nt;
    const expectedBytes = voxelCount * bytesPerVoxel;

    const spacingText = (fields.get('elementspacing') || '').trim().split(/\s+/).map(Number);
    const dx = spacingText[0] > 0 ? spacingText[0] : 1;
    const dy = spacingText[1] > 0 ? spacingText[1] : 1;
    const dz = spacingText[2] > 0 ? spacingText[2] : 1;

    const elementFile = (fields.get('elementdatafile') || 'LOCAL').trim();
    const detached = elementFile.toUpperCase() !== 'LOCAL';
    const dataPath = detached ? path.resolve(path.dirname(filePath), elementFile) : filePath;
    const baseOffset = detached ? 0 : dataStart;
    const compressed = (fields.get('compresseddata') || '').toLowerCase() === 'true';
    const msb = (fields.get('elementbyteordermsb') || '').toLowerCase() === 'true';
    const needsSwap = msb && bytesPerVoxel > 1;

    const headerFor = (voxOffset: number) => makeNiftiHeader({
      nx, ny, nz, nt, dx, dy, dz, datatype, voxOffset,
      descrip: `MetaImage ${fields.get('elementtype') || ''} (${dims.join('×')})`,
    });

    if (!compressed && !needsSwap) {
      if (opts.memory) {
        // Keep the whole file and the absolute voxOffset (zero-copy).
        const source = toU8(await readFileBytes(dataPath));
        if (source.length < baseOffset + expectedBytes) throw new Error('truncated MetaImage voxel data');
        return { header: headerFor(baseOffset), rawData: source };
      }
      return { header: headerFor(baseOffset), dataPath };
    }

    const source = await readFileBytes(dataPath);
    let payload = source.subarray(baseOffset);
    if (compressed) {
      const out = zlib.inflateSync(payload);
      payload = new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
    }
    if (payload.length < expectedBytes) throw new Error('truncated MetaImage voxel data');
    const little = needsSwap
      ? ensureLittleEndian(payload.subarray(0, expectedBytes), bytesPerVoxel)
      : payload.subarray(0, expectedBytes);
    const header = headerFor(0);
    if (opts.memory) return { header, rawData: little };
    const tempPath = await writeTempVolume(little);
    return { header, dataPath: tempPath, tempFiles: [tempPath] };
  },
};

function parseFields(text: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx <= 0) continue;
    fields.set(line.slice(0, idx).trim().toLowerCase(), line.slice(idx + 1).trim());
  }
  return fields;
}

function metaDatatype(type: string): number {
  switch (type.trim().toUpperCase()) {
    case 'MET_UCHAR': return 2;
    case 'MET_CHAR': return 256;
    case 'MET_USHORT': return 512;
    case 'MET_SHORT': return 4;
    case 'MET_UINT': return 768;
    case 'MET_INT': return 8;
    case 'MET_ULONG': case 'MET_ULONG_LONG': return 768;
    case 'MET_LONG': case 'MET_LONG_LONG': return 8;
    case 'MET_FLOAT': return 16;
    case 'MET_DOUBLE': return 64;
    default: throw new Error(`unsupported MetaImage ElementType "${type}"`);
  }
}
