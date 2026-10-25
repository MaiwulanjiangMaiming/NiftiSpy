/** Versioned persistent slice envelope: dimensions must survive an IndexedDB hit. */
const MAGIC = 0x4e535332;
export function encodeSliceFrame(data: Float32Array, width: number, height: number, factor: number): ArrayBuffer {
  const buffer = new ArrayBuffer(16 + data.byteLength),
    view = new DataView(buffer);
  view.setUint32(0, MAGIC, true);
  view.setUint32(4, width, true);
  view.setUint32(8, height, true);
  view.setUint32(12, factor, true);
  new Float32Array(buffer, 16).set(data);
  return buffer;
}
/**
 * Decode a native little-endian 8/16-bit slice and apply scl_slope/inter.
 * The host sends these instead of Float32 to halve the WAN payload.
 */
export function decodeRawSlice(
  buffer: ArrayBuffer,
  dtype: number,
  slope: number,
  inter: number,
  width: number,
  height: number,
): Float32Array | null {
  const count = width * height;
  if (!count) return null;
  const bpv = dtype === 2 || dtype === 256 ? 1 : dtype === 4 || dtype === 512 ? 2 : 0;
  if (!bpv || buffer.byteLength !== count * bpv) return null;

  const mul = Number.isFinite(slope) && slope ? slope : 1;
  const add = Number.isFinite(inter) ? inter : 0;
  const out = new Float32Array(count);
  if (dtype === 2) {
    const a = new Uint8Array(buffer);
    for (let i = 0; i < count; i++) out[i] = a[i] * mul + add;
  } else if (dtype === 256) {
    const a = new Int8Array(buffer);
    for (let i = 0; i < count; i++) out[i] = a[i] * mul + add;
  } else if (dtype === 4) {
    const a = new Int16Array(buffer);
    for (let i = 0; i < count; i++) out[i] = a[i] * mul + add;
  } else {
    const a = new Uint16Array(buffer);
    for (let i = 0; i < count; i++) out[i] = a[i] * mul + add;
  }
  return out;
}

export function decodeSliceFrame(
  buffer: ArrayBuffer,
  factor: number,
): { data: Float32Array; width: number; height: number } | null {
  if (buffer.byteLength < 16 || buffer.byteLength % 4) return null;
  const view = new DataView(buffer);
  if (view.getUint32(0, true) !== MAGIC || view.getUint32(12, true) !== factor) return null;
  const width = view.getUint32(4, true),
    height = view.getUint32(8, true);
  if (!width || !height || width * height * 4 !== buffer.byteLength - 16) return null;
  return { data: new Float32Array(buffer, 16), width, height };
}
