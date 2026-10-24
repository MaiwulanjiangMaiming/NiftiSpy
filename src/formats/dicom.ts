import * as fs from 'fs';
import {
  cross3, ensureLittleEndian, lpsToRas, makeNiftiHeader, normalize3,
  readFileBytes, readRange, sformFromDirections, toU8, writeTempVolume,
} from './header';
import type { ParseOptions, ParsedVolume, VolumeFormat } from './types';

/** Single-file DICOM (uncompressed). Multi-frame files become 3D volumes. */

const LONG_VRS = new Set([
  'OB', 'OD', 'OF', 'OL', 'OV', 'OW', 'SQ', 'SV', 'UC', 'UN', 'UR', 'UT', 'UV',
]);

const TAG = {
  transferSyntax: 0x00020010,
  rows: 0x00280010,
  columns: 0x00280011,
  samplesPerPixel: 0x00280002,
  photometric: 0x00280004,
  numberOfFrames: 0x00280008,
  bitsAllocated: 0x00280100,
  pixelRepresentation: 0x00280103,
  pixelSpacing: 0x00280030,
  rescaleIntercept: 0x00281053,
  rescaleSlope: 0x00281052,
  sliceThickness: 0x00180050,
  spacingBetweenSlices: 0x00180088,
  imagePosition: 0x00200032,
  imageOrientation: 0x00200037,
  floatPixelData: 0x7fe00008,
  doubleFloatPixelData: 0x7fe00009,
  pixelData: 0x7fe00010,
};

const NEEDED = new Set<number>([
  TAG.rows, TAG.columns, TAG.samplesPerPixel, TAG.photometric, TAG.numberOfFrames,
  TAG.bitsAllocated, TAG.pixelRepresentation, TAG.pixelSpacing, TAG.rescaleIntercept,
  TAG.rescaleSlope, TAG.sliceThickness, TAG.spacingBetweenSlices,
  TAG.imagePosition, TAG.imageOrientation,
]);

interface Syntax {
  explicit: boolean;
  littleEndian: boolean;
}

interface Scan {
  tags: Map<number, Uint8Array>;
  pixelOffset: number;
  pixelLength: number;
  /** NIfTI datatype when the pixel data element is float, else 0. */
  floatDatatype: number;
}

export const dicomFormat: VolumeFormat = {
  id: 'dicom',
  label: 'DICOM',
  extensions: ['.dcm', '.dicom', '.ima'],
  async parse(filePath: string, opts: ParseOptions): Promise<ParsedVolume> {
    const stat = await fs.promises.stat(filePath);
    const fileSize = stat.size;
    if (fileSize < 8) throw new Error('truncated DICOM file');

    let limit = Math.min(fileSize, 256 * 1024);
    let scan: Scan | null = null;
    let syntax: Syntax = { explicit: true, littleEndian: true };

    while (!scan) {
      const buf = await readRange(filePath, 0, limit);
      const meta = scanMeta(buf, fileSize);
      if (!meta) {
        if (limit >= fileSize) throw new Error('truncated DICOM metadata');
        limit = grow(limit, fileSize);
        continue;
      }
      syntax = meta.syntax;
      scan = scanDataset(buf, meta.datasetStart, fileSize, syntax);
      if (!scan) {
        if (limit >= fileSize) throw new Error('truncated DICOM metadata');
        limit = grow(limit, fileSize);
      }
    }

    const tags = scan.tags;
    const rows = readUS(tags.get(TAG.rows), syntax.littleEndian);
    const cols = readUS(tags.get(TAG.columns), syntax.littleEndian);
    if (!(rows > 0 && cols > 0)) throw new Error('DICOM is missing Rows/Columns');

    const samples = readUS(tags.get(TAG.samplesPerPixel), syntax.littleEndian) || 1;
    if (samples !== 1) throw new Error('color DICOM (SamplesPerPixel > 1) is not supported');

    const photometric = readString(tags.get(TAG.photometric));
    if (photometric && !photometric.startsWith('MONOCHROME')) {
      throw new Error(`DICOM photometric interpretation ${photometric} is not supported`);
    }

    let datatype = scan.floatDatatype;
    let bits = 32;
    if (scan.floatDatatype === 64) bits = 64;
    if (!datatype) {
      bits = readUS(tags.get(TAG.bitsAllocated), syntax.littleEndian);
      const signed = (readUS(tags.get(TAG.pixelRepresentation), syntax.littleEndian) || 0) === 1;
      if (bits === 8) datatype = signed ? 256 : 2;
      else if (bits === 16) datatype = signed ? 4 : 512;
      else if (bits === 32) datatype = signed ? 8 : 768;
      else throw new Error(`unsupported DICOM BitsAllocated ${bits}`);
    }
    const bpv = datatype === 2 || datatype === 256 ? 1
      : datatype === 4 || datatype === 512 ? 2
        : datatype === 64 ? 8 : 4;

    const frameBytes = rows * cols * bpv;
    const available = Math.floor(scan.pixelLength / frameBytes);
    if (available < 1) throw new Error('truncated DICOM pixel data');
    const declared = parseInt(readString(tags.get(TAG.numberOfFrames)), 10) || 0;
    const nz = Math.max(1, Math.min(declared || available, available));

    const spacing = readDS(tags.get(TAG.pixelSpacing));
    const dx = spacing[1] > 0 ? spacing[1] : 1;
    const dy = spacing[0] > 0 ? spacing[0] : 1;
    const between = readDS(tags.get(TAG.spacingBetweenSlices))[0];
    const thickness = readDS(tags.get(TAG.sliceThickness))[0];
    const dz = between > 0 ? between : thickness > 0 ? thickness : 1;

    const slope = readDS(tags.get(TAG.rescaleSlope))[0] || 1;
    const inter = readDS(tags.get(TAG.rescaleIntercept))[0] || 0;

    const voxelBytes = rows * cols * nz * bpv;
    if (scan.pixelOffset + voxelBytes > fileSize) {
      throw new Error('truncated DICOM pixel data');
    }

    // ImageOrientationPatient / ImagePositionPatient are in LPS; convert the
    // row/column directions and origin to RAS for the viewer's sform.
    const iop = readDS(tags.get(TAG.imageOrientation));
    const ipp = readDS(tags.get(TAG.imagePosition));
    let sform: number[][] | undefined;
    if (iop.length >= 6) {
      const row = normalize3(lpsToRas(iop.slice(0, 3)));
      const col = normalize3(lpsToRas(iop.slice(3, 6)));
      if (row.some(v => v !== 0) && col.some(v => v !== 0)) {
        const normal = cross3(row, col);
        const origin: [number, number, number] = ipp.length >= 3
          ? [-ipp[0], -ipp[1], ipp[2]]
          : [0, 0, 0];
        sform = sformFromDirections([row, col, normal], [dx, dy, dz], origin);
      }
    }

    const header = makeNiftiHeader({
      nx: cols, ny: rows, nz, dx, dy, dz, datatype, voxOffset: scan.pixelOffset,
      slope, inter, sform,
      descrip: `DICOM ${cols}×${rows}×${nz}`,
    });

    if (opts.memory) {
      // Keep the whole file so header.voxOffset stays absolute (zero-copy).
      const source = toU8(await readFileBytes(filePath));
      if (syntax.littleEndian) return { header, rawData: source };
      const swapped = ensureLittleEndian(
        source.subarray(scan.pixelOffset, scan.pixelOffset + voxelBytes), bpv
      );
      header.voxOffset = 0;
      return { header, rawData: swapped };
    }

    if (syntax.littleEndian) {
      // Remote-SSH: slices are pread from the original file.
      return { header, dataPath: filePath };
    }

    // Big-endian transfer syntax: swap once, then serve random slices.
    const raw = await readRange(filePath, scan.pixelOffset, scan.pixelOffset + voxelBytes);
    const swapped = ensureLittleEndian(raw, bpv);
    const temp = await writeTempVolume(swapped);
    header.voxOffset = 0;
    return { header, dataPath: temp, tempFiles: [temp] };
  },
};

function grow(limit: number, fileSize: number): number {
  return Math.min(fileSize, limit * 4);
}

/** File meta information is always explicit VR little endian. */
function scanMeta(
  buf: Uint8Array,
  fileSize: number,
): { datasetStart: number; syntax: Syntax } | null {
  const start = buf.length >= 132
    && buf[128] === 0x44 && buf[129] === 0x49 && buf[130] === 0x43 && buf[131] === 0x4d
    ? 132 : 0;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let pos = start;
  let uid = '';
  let sawMeta = false;

  while (pos + 8 <= fileSize) {
    if (pos + 8 > buf.length) return null;
    const group = view.getUint16(pos, true);
    if (group !== 0x0002) break;
    sawMeta = true;
    const element = view.getUint16(pos + 2, true);
    const vr = String.fromCharCode(buf[pos + 4], buf[pos + 5]);
    let hdr = 8;
    let len = view.getUint16(pos + 6, true);
    if (LONG_VRS.has(vr)) {
      if (pos + 12 > buf.length) return null;
      hdr = 12;
      len = view.getUint32(pos + 8, true);
    }
    if (len === 0xFFFFFFFF) throw new Error('unsupported DICOM meta encoding');
    if (pos + hdr + len > fileSize) throw new Error('truncated DICOM meta information');
    if (((group << 16) | element) === TAG.transferSyntax) {
      if (pos + hdr + len > buf.length) return null;
      uid = String.fromCharCode(...buf.subarray(pos + hdr, pos + hdr + len)).replace(/\0+$/, '');
    }
    pos += hdr + len;
  }

  const syntax = uid ? syntaxForUid(uid) : guessSyntax(buf, pos);
  if (!sawMeta && pos + 8 > buf.length) return null;
  return { datasetStart: pos, syntax };
}

function guessSyntax(buf: Uint8Array, pos: number): Syntax {
  if (pos + 8 > buf.length) return { explicit: true, littleEndian: true };
  const vr = [buf[pos + 4], buf[pos + 5]];
  const explicit = vr.every(b => b >= 0x41 && b <= 0x5a);
  return { explicit, littleEndian: true };
}

function syntaxForUid(uid: string): Syntax {
  switch (uid) {
    case '1.2.840.10008.1.2':
      return { explicit: false, littleEndian: true };
    case '1.2.840.10008.1.2.1':
      return { explicit: true, littleEndian: true };
    case '1.2.840.10008.1.2.2':
      return { explicit: true, littleEndian: false };
    case '1.2.840.10008.1.2.1.99':
      throw new Error('deflated DICOM is not supported');
    default:
      if (uid.startsWith('1.2.840.10008.1.2.4') || uid === '1.2.840.10008.1.2.5') {
        throw new Error('compressed DICOM is not supported; export an uncompressed copy or NIfTI');
      }
      return { explicit: true, littleEndian: true };
  }
}

/** Walk elements until PixelData. Returns null when a re-read with more bytes is needed. */
function scanDataset(
  buf: Uint8Array,
  start: number,
  fileSize: number,
  syntax: Syntax,
): Scan | null {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const le = syntax.littleEndian;
  const tags = new Map<number, Uint8Array>();
  let pos = start;

  while (pos + 8 <= fileSize) {
    if (pos + 8 > buf.length) return null;
    const group = view.getUint16(pos, le);
    const element = view.getUint16(pos + 2, le);
    const header = elementHeader(buf, pos, syntax);
    if (!header) return null;
    const { hdr, len } = header;
    const key = (group << 16) | element;

    if (len === 0xFFFFFFFF) {
      if (group === 0x7fe0) throw new Error('compressed DICOM is not supported');
      const next = skipUndefinedSequence(buf, pos + hdr, fileSize, syntax);
      if (next === null) return null;
      pos = next;
      continue;
    }
    if (pos + hdr + len > fileSize) throw new Error('truncated DICOM element');

    if (key === TAG.pixelData || key === TAG.floatPixelData || key === TAG.doubleFloatPixelData) {
      return {
        tags,
        pixelOffset: pos + hdr,
        pixelLength: len,
        floatDatatype: key === TAG.floatPixelData ? 16 : key === TAG.doubleFloatPixelData ? 64 : 0,
      };
    }
    if (NEEDED.has(key)) {
      if (pos + hdr + len > buf.length) return null;
      tags.set(key, buf.slice(pos + hdr, pos + hdr + len));
    }
    pos += hdr + len;
  }
  if (pos < fileSize) return null;
  throw new Error('DICOM has no pixel data');
}

function elementHeader(
  buf: Uint8Array,
  pos: number,
  syntax: Syntax,
): { hdr: number; len: number } | null {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (!syntax.explicit) {
    if (pos + 8 > buf.length) return null;
    return { hdr: 8, len: view.getUint32(pos + 4, syntax.littleEndian) };
  }
  if (pos + 8 > buf.length) return null;
  const vr = String.fromCharCode(buf[pos + 4], buf[pos + 5]);
  if (!LONG_VRS.has(vr)) {
    return { hdr: 8, len: view.getUint16(pos + 6, syntax.littleEndian) };
  }
  if (pos + 12 > buf.length) return null;
  return { hdr: 12, len: view.getUint32(pos + 8, syntax.littleEndian) };
}

/** Skip an undefined-length sequence (items + delimiters). */
function skipUndefinedSequence(
  buf: Uint8Array,
  pos: number,
  fileSize: number,
  syntax: Syntax,
): number | null {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const le = syntax.littleEndian;
  while (pos + 8 <= fileSize) {
    if (pos + 8 > buf.length) return null;
    const group = view.getUint16(pos, le);
    const element = view.getUint16(pos + 2, le);
    if (group === 0xFFFE) {
      const len = view.getUint32(pos + 4, le);
      if (element === 0xE0DD) return pos + 8;
      if (element === 0xE000) {
        if (len === 0xFFFFFFFF) {
          const next = skipUndefinedItem(buf, pos + 8, fileSize, syntax);
          if (next === null) return null;
          pos = next;
        } else {
          pos += 8 + len;
        }
        continue;
      }
      pos += 8 + (len === 0xFFFFFFFF ? 0 : len);
      continue;
    }
    const next = skipElement(buf, pos, fileSize, syntax);
    if (next === null) return null;
    pos = next;
  }
  return null;
}

/** Skip an undefined-length item until its item delimiter. */
function skipUndefinedItem(
  buf: Uint8Array,
  pos: number,
  fileSize: number,
  syntax: Syntax,
): number | null {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const le = syntax.littleEndian;
  while (pos + 8 <= fileSize) {
    if (pos + 8 > buf.length) return null;
    const group = view.getUint16(pos, le);
    const element = view.getUint16(pos + 2, le);
    if (group === 0xFFFE) {
      const len = view.getUint32(pos + 4, le);
      if (element === 0xE00D || element === 0xE0DD) return pos + 8;
      if (element === 0xE000) {
        if (len === 0xFFFFFFFF) {
          const next = skipUndefinedItem(buf, pos + 8, fileSize, syntax);
          if (next === null) return null;
          pos = next;
        } else {
          pos += 8 + len;
        }
        continue;
      }
      pos += 8 + (len === 0xFFFFFFFF ? 0 : len);
      continue;
    }
    const next = skipElement(buf, pos, fileSize, syntax);
    if (next === null) return null;
    pos = next;
  }
  return null;
}

function skipElement(
  buf: Uint8Array,
  pos: number,
  fileSize: number,
  syntax: Syntax,
): number | null {
  const header = elementHeader(buf, pos, syntax);
  if (!header) return null;
  if (header.len === 0xFFFFFFFF) {
    return skipUndefinedSequence(buf, pos + header.hdr, fileSize, syntax);
  }
  const next = pos + header.hdr + header.len;
  return next <= fileSize ? next : null;
}

function readUS(value: Uint8Array | undefined, le: boolean): number {
  if (!value || value.length < 2) return 0;
  const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
  return view.getUint16(0, le);
}

function readString(value: Uint8Array | undefined): string {
  if (!value) return '';
  return String.fromCharCode(...value).replace(/[\0 ]+$/, '').trim();
}

function readDS(value: Uint8Array | undefined): number[] {
  const text = readString(value);
  if (!text) return [];
  return text.split('\\').map(part => parseFloat(part)).filter(v => !Number.isNaN(v));
}
