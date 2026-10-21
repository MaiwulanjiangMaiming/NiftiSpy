/** Versioned persistent slice envelope: dimensions must survive an IndexedDB hit. */
const MAGIC = 0x4e535332;
export function encodeSliceFrame(data: Float32Array, width: number, height: number, factor: number): ArrayBuffer {
  const buffer = new ArrayBuffer(16 + data.byteLength), view = new DataView(buffer);
  view.setUint32(0, MAGIC, true);
  view.setUint32(4, width, true);
  view.setUint32(8, height, true);
  view.setUint32(12, factor, true);
  new Float32Array(buffer, 16).set(data);
  return buffer;
}
export function decodeSliceFrame(buffer: ArrayBuffer, factor: number): { data: Float32Array; width: number; height: number } | null {
  if (buffer.byteLength < 16 || buffer.byteLength % 4) return null;
  const view = new DataView(buffer);
  if (view.getUint32(0, true) !== MAGIC || view.getUint32(12, true) !== factor) return null;
  const width = view.getUint32(4, true), height = view.getUint32(8, true);
  if (!width || !height || width * height * 4 !== buffer.byteLength - 16) return null;
  return { data: new Float32Array(buffer, 16), width, height };
}
