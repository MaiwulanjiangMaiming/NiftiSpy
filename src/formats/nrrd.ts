import * as path from 'path';
import * as zlib from 'zlib';
import {
  DATATYPE_BYTES, ensureLittleEndian, fileStamp, lpsToRas, makeNiftiHeader, normalize3,
  readFileBytes, readTextHeader, sformFromDirections, tempFilesFor, toU8, typedToU8,
  writeTempVolume,
} from './header';
import type { ParseOptions, ParsedVolume, VolumeFormat } from './types';

/** NRRD / detached-header NRRD (`.nrrd`, `.nhdr`). */
export const nrrdFormat: VolumeFormat = {
  id: 'nrrd',
  label: 'NRRD',
  extensions: ['.nrrd', '.nhdr'],
  async parse(filePath: string, opts: ParseOptions): Promise<ParsedVolume> {
    const { text, dataStart } = await readTextHeader(filePath, /\r?\n\r?\n/);
    const fields = parseFields(text);

    const dimension = parseInt(fields.get('dimension') || '', 10);
    if (!(dimension >= 1 && dimension <= 4)) throw new Error('NRRD dimension must be 1–4');
    const sizes = (fields.get('sizes') || '').trim().split(/\s+/).map(Number);
    if (sizes.length !== dimension || sizes.some(v => !Number.isSafeInteger(v) || v <= 0)) {
      throw new Error('invalid NRRD sizes');
    }

    const nx = sizes[0];
    const ny = sizes[1] || 1;
    const nz = sizes[2] || 1;
    const nt = sizes[3] || 1;
    const datatype = nrrdDatatype(fields.get('type') || '');
    const bytesPerVoxel = DATATYPE_BYTES[datatype];
    const voxelCount = nx * ny * nz * nt;
    const expectedBytes = voxelCount * bytesPerVoxel;

    const encoding = (fields.get('encoding') || 'raw').toLowerCase();
    if (encoding !== 'raw' && encoding !== 'gzip' && encoding !== 'ascii') {
      throw new Error(`unsupported NRRD encoding "${encoding}"`);
    }

    const dataFile = (fields.get('data file') || '-').replace(/^"|"$/g, '');
    const detached = dataFile !== '-' && !dataFile.toLowerCase().startsWith('list');
    const dataPath = detached ? path.resolve(path.dirname(filePath), dataFile) : filePath;
    const baseOffset = detached ? 0 : dataStart;
    const dataOffset = parseInt(fields.get('data offset') || '0', 10) || 0;
    const lineSkip = parseInt(fields.get('line skip') || '0', 10) || 0;

    const geometry = nrrdGeometry(fields, dimension, nrrdSpacing(fields, dimension));
    const spacing = geometry.spacing;
    const sform = geometry.sform;
    const headerFor = (voxOffset: number, dtype = datatype) => makeNiftiHeader({
      nx, ny, nz, nt, dx: spacing[0], dy: spacing[1], dz: spacing[2],
      datatype: dtype, voxOffset, sform,
      descrip: `NRRD ${fields.get('type') || ''} (${sizes.join('×')})`,
    });

    if (encoding === 'ascii') {
      const raw = await readSource(dataPath);
      // The text header is part of an attached .nrrd; detached .nhdr data
      // starts at byte 0, so `baseOffset` is 0 there.
      const dataOnly = raw.subarray(baseOffset + dataOffset);
      const textData = Buffer.from(dataOnly.buffer, dataOnly.byteOffset, dataOnly.byteLength).toString('latin1');
      const body = lineSkip > 0 ? textData.split(/\r?\n/).slice(lineSkip).join('\n') : textData;
      const tokens = body.trim().split(/\s+/).filter(Boolean);
      if (tokens.length < voxelCount) throw new Error('truncated NRRD ASCII data');
      const out = datatype === 64 ? new Float64Array(voxelCount) : new Float32Array(voxelCount);
      for (let i = 0; i < voxelCount; i++) out[i] = Number(tokens[i]);
      const rawData = typedToU8(out);
      return {
        header: headerFor(0, datatype === 64 ? 64 : 16),
        rawData,
      };
    }

    const wantsBig = (fields.get('endian') || 'little').toLowerCase() === 'big';
    const needsSwap = wantsBig && bytesPerVoxel > 1;

    if (encoding === 'raw') {
      if (opts.memory) {
        const start = baseOffset + dataOffset;
        // Keep the whole file so header.voxOffset stays absolute (zero-copy).
        const source = toU8(await readSource(dataPath));
        if (source.length < start + expectedBytes) throw new Error('truncated NRRD voxel data');
        const finalData = needsSwap
          ? ensureLittleEndian(toU8(source.subarray(start, start + expectedBytes)), bytesPerVoxel)
          : source;
        return {
          header: headerFor(needsSwap ? 0 : start),
          rawData: finalData,
        };
      }

      // Remote-SSH: keep the original raw file and serve slices by offset.
      if (!needsSwap) {
        return {
          header: headerFor(baseOffset + dataOffset),
          dataPath,
        };
      }
    }

    // gzip / big-endian: one full read + inflate/swap, then a temp raw file
    // so /slice stays O(slab) instead of re-inflating the stream per request.
    const source = await readSource(dataPath);
    const payload = encoding === 'gzip'
      ? gunzip(source.subarray(baseOffset + dataOffset))
      : toU8(source.subarray(baseOffset + dataOffset));
    if (payload.length < expectedBytes) throw new Error('truncated NRRD voxel data');
    const little = needsSwap
      ? ensureLittleEndian(payload.subarray(0, expectedBytes), bytesPerVoxel)
      : payload.subarray(0, expectedBytes);
    const header = headerFor(0);
    if (opts.memory) return { header, rawData: little };
    const stamp = await fileStamp([filePath, dataPath]);
    const tempPath = await writeTempVolume(little, stamp ? `nrrd:${stamp}:${encoding}` : undefined);
    return { header, dataPath: tempPath, tempFiles: tempFilesFor(tempPath) };
  },
};

function parseFields(text: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    fields.set(line.slice(0, idx).trim().toLowerCase(), line.slice(idx + 1).trim());
  }
  return fields;
}

function nrrdDatatype(type: string): number {
  const t = type.trim().toLowerCase();
  switch (t) {
    case 'signed char': case 'int8': case 'int8_t': return 256;
    case 'uchar': case 'unsigned char': case 'uint8': case 'uint8_t': return 2;
    case 'short': case 'short int': case 'int16': case 'int16_t': return 4;
    case 'ushort': case 'unsigned short': case 'unsigned short int': case 'uint16': case 'uint16_t': return 512;
    case 'int': case 'int32': case 'int32_t': return 8;
    case 'uint': case 'unsigned int': case 'uint32': case 'uint32_t': return 768;
    case 'float': case 'float32': case 'single': return 16;
    case 'double': case 'float64': return 64;
    default: throw new Error(`unsupported NRRD type "${type}"`);
  }
}

function nrrdSpacing(fields: Map<string, string>, dimension: number): [number, number, number] {
  const out: [number, number, number] = [1, 1, 1];
  const spacings = (fields.get('spacings') || '').trim().split(/\s+/).map(Number);
  if (spacings.length === dimension) {
    for (let i = 0; i < Math.min(3, dimension); i++) {
      if (Number.isFinite(spacings[i]) && spacings[i] > 0) out[i] = spacings[i];
    }
    return out;
  }
  const directions = fields.get('space directions');
  if (directions) {
    const vectors = directions.match(/\(([^)]*)\)/g) || [];
    for (let i = 0; i < Math.min(3, vectors.length); i++) {
      const values = vectors[i].slice(1, -1).split(',').map(Number);
      if (values.every(Number.isFinite) && values.length <= 3) {
        const norm = Math.sqrt(values.reduce((a, b) => a + b * b, 0));
        if (norm > 0) out[i] = norm;
      }
    }
  }
  return out;
}

/**
 * NRRD `space directions` are axis vectors. Only build an sform when the
 * file declares its space (RAS/LPS); guessing would mislabel unknown data.
 */
function nrrdGeometry(
  fields: Map<string, string>,
  dimension: number,
  spacing: [number, number, number],
): { spacing: [number, number, number]; sform?: number[][] } {
  if (dimension < 3) return { spacing };
  const text = fields.get('space directions');
  if (!text) return { spacing };
  const vectors = [...text.matchAll(/\(([^)]*)\)/g)]
    .map(m => m[1].split(',').map(v => Number(v.trim())))
    .filter(v => v.length === 3 && v.every(Number.isFinite));
  if (vectors.length < 3) return { spacing };

  const space = (fields.get('space') || '').toLowerCase();
  const lps = space === 'left-posterior-superior' || space === 'lps';
  const ras = space === 'right-anterior-superior' || space === 'ras';
  if (!lps && !ras) return { spacing };

  const norms = vectors.slice(0, 3).map(v => Math.hypot(v[0], v[1], v[2]));
  const outSpacing: [number, number, number] = [
    norms[0] > 0 ? norms[0] : spacing[0],
    norms[1] > 0 ? norms[1] : spacing[1],
    norms[2] > 0 ? norms[2] : spacing[2],
  ];
  const directions = vectors.slice(0, 3).map(v => normalize3(lps ? lpsToRas(v) : v));

  let origin: [number, number, number] = [0, 0, 0];
  const originMatch = (fields.get('space origin') || '').match(/\(([^)]*)\)/);
  if (originMatch) {
    const p = originMatch[1].split(',').map(v => Number(v.trim()));
    if (p.length === 3 && p.every(Number.isFinite)) {
      origin = lps ? [-p[0], -p[1], p[2]] : [p[0], p[1], p[2]];
    }
  }
  return {
    spacing: outSpacing,
    sform: sformFromDirections(directions, outSpacing, origin),
  };
}

async function readSource(filePath: string): Promise<Uint8Array> {
  return readFileBytes(filePath);
}

function gunzip(data: Uint8Array): Uint8Array {
  try {
    const out = zlib.gunzipSync(data);
    return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
  } catch {
    try {
      const out = zlib.inflateSync(data);
      return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
    } catch {
      const out = zlib.inflateRawSync(data);
      return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
    }
  }
}
