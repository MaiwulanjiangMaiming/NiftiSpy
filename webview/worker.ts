import { gunzipSync } from 'fflate';
import { parseNiiHeader } from './nii-parser';

self.onmessage = async (e: MessageEvent) => {
  const { id, type, url, isGzip } = e.data;
  try {
    if (type === 'loadVolume') {
      await handleLoadVolume(id, url, isGzip);
    }
  } catch (err: any) {
    self.postMessage({ id, type: 'error', error: String(err?.message ?? err) });
  }
};

async function nativeDecompress(resp: Response): Promise<Uint8Array> {
  const ds = new (self as any).DecompressionStream('gzip');
  const decompressedStream = resp.body!.pipeThrough(ds);
  const reader = decompressedStream.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const chunks: Uint8Array[] = [];
  let totalSize = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value!);
    totalSize += value!.byteLength;
  }
  const result = new Uint8Array(totalSize);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function handleLoadVolume(id: number, url: string, isGzip: boolean) {
  self.postMessage({ id, type: 'progress', value: 0.02, stage: 'downloading' });

  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`Fetch failed: ${resp.status}`);
  }

  const hasNativeDecompress = typeof (self as any).DecompressionStream !== 'undefined';
  let rawData: Uint8Array;

  if (isGzip && hasNativeDecompress && resp.body) {
    self.postMessage({ id, type: 'progress', value: 0.1, stage: 'decompressing (native)' });
    rawData = await nativeDecompress(resp);
    self.postMessage({ id, type: 'progress', value: 0.6, stage: 'parsing' });
  } else {
    const contentLength = Number(resp.headers.get('Content-Length') || 0);
    let compressedData: Uint8Array;

    if (contentLength > 0 && resp.body) {
      const reader = resp.body.getReader();
      const chunks: Uint8Array[] = [];
      let received = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.byteLength;
        self.postMessage({
          id, type: 'progress',
          value: 0.02 + (received / contentLength) * (isGzip ? 0.3 : 0.7),
          stage: 'downloading',
        });
      }

      const total = chunks.reduce((s, c) => s + c.byteLength, 0);
      compressedData = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        compressedData.set(chunk, offset);
        offset += chunk.byteLength;
      }
    } else {
      compressedData = new Uint8Array(await resp.arrayBuffer());
    }

    if (isGzip) {
      self.postMessage({ id, type: 'progress', value: 0.35, stage: 'decompressing' });
      rawData = gunzipSync(compressedData);
      self.postMessage({ id, type: 'progress', value: 0.6, stage: 'parsing' });
    } else {
      rawData = compressedData;
      self.postMessage({ id, type: 'progress', value: 0.7, stage: 'parsing' });
    }
  }

  const header = parseNiiHeader(rawData.buffer as ArrayBuffer, isGzip);

  const { nx, ny, nz, datatype, scl_slope, scl_inter, littleEndian, voxOffset } = header;
  const n = nx * ny * nz;
  const dataOffset = voxOffset;
  const byteOff = rawData.byteOffset + dataOffset;
  const le = littleEndian;
  const slope = scl_slope || 1;
  const inter = scl_inter || 0;
  const elemSize = datatype === 64 ? 8 : datatype === 8 || datatype === 16 || datatype === 768 ? 4 : datatype === 4 || datatype === 512 ? 2 : 1;
  const canUseTypedArray = (byteOff % elemSize === 0) && (byteOff + n * elemSize <= rawData.buffer.byteLength) && le;

  let nativeData: Int8Array | Uint8Array | Int16Array | Uint16Array | Int32Array | Uint32Array | Float32Array | Float64Array;

  switch (datatype) {
    case 2: nativeData = canUseTypedArray ? new Uint8Array(rawData.buffer, byteOff, n) : new Uint8Array(rawData.buffer, byteOff, n); break;
    case 4: nativeData = canUseTypedArray ? new Int16Array(rawData.buffer, byteOff, n) : new Int16Array(n); break;
    case 8: nativeData = canUseTypedArray ? new Int32Array(rawData.buffer, byteOff, n) : new Int32Array(n); break;
    case 16: nativeData = canUseTypedArray ? new Float32Array(rawData.buffer, byteOff, n) : new Float32Array(n); break;
    case 64: nativeData = canUseTypedArray ? new Float64Array(rawData.buffer, byteOff, n) : new Float64Array(n); break;
    case 256: nativeData = canUseTypedArray ? new Int8Array(rawData.buffer, byteOff, n) : new Int8Array(n); break;
    case 512: nativeData = canUseTypedArray ? new Uint16Array(rawData.buffer, byteOff, n) : new Uint16Array(n); break;
    case 768: nativeData = canUseTypedArray ? new Uint32Array(rawData.buffer, byteOff, n) : new Uint32Array(n); break;
    default: nativeData = new Float32Array(n); break;
  }

  if (!canUseTypedArray && datatype !== 2 && datatype !== 256) {
    const view = new DataView(rawData.buffer, byteOff, n * elemSize);
    switch (datatype) {
      case 4: { const a = nativeData as Int16Array; for (let i = 0; i < n; i++) a[i] = view.getInt16(i * 2, le); break; }
      case 8: { const a = nativeData as Int32Array; for (let i = 0; i < n; i++) a[i] = view.getInt32(i * 4, le); break; }
      case 16: { const a = nativeData as Float32Array; for (let i = 0; i < n; i++) a[i] = view.getFloat32(i * 4, le); break; }
      case 64: { const a = nativeData as Float64Array; for (let i = 0; i < n; i++) a[i] = view.getFloat64(i * 8, le); break; }
      case 512: { const a = nativeData as Uint16Array; for (let i = 0; i < n; i++) a[i] = view.getUint16(i * 2, le); break; }
      case 768: { const a = nativeData as Uint32Array; for (let i = 0; i < n; i++) a[i] = view.getUint32(i * 4, le); break; }
    }
  }

  self.postMessage({ id, type: 'progress', value: 0.7, stage: 'computing range' });

  let min = Infinity, max = -Infinity;
  const sampleStep = Math.max(1, Math.floor(n / 50000));
  for (let i = 0; i < n; i += sampleStep) {
    const v = (nativeData as any)[i] * slope + inter;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (min === max) max = min + 1;

  const needsConversion = slope !== 1 || inter !== 0;

  self.postMessage({ id, type: 'progress', value: 0.75, stage: 'preview' });

  const axMid = Math.floor(nz / 2);
  const coMid = Math.floor(ny / 2);
  const saMid = Math.floor(nx / 2);

  const previewSlices: { axial: Float32Array; coronal: Float32Array; sagittal: Float32Array } = {
    axial: new Float32Array(nx * ny),
    coronal: new Float32Array(nx * nz),
    sagittal: new Float32Array(ny * nz),
  };

  {
    const base = axMid * ny * nx;
    if (needsConversion) {
      for (let i = 0; i < nx * ny; i++) previewSlices.axial[i] = (nativeData as any)[base + i] * slope + inter;
    } else {
      for (let i = 0; i < nx * ny; i++) previewSlices.axial[i] = (nativeData as any)[base + i];
    }
  }
  {
    if (needsConversion) {
      for (let z = 0; z < nz; z++) { const base = z * ny * nx + coMid * nx; for (let x = 0; x < nx; x++) previewSlices.coronal[z * nx + x] = (nativeData as any)[base + x] * slope + inter; }
    } else {
      for (let z = 0; z < nz; z++) { const base = z * ny * nx + coMid * nx; for (let x = 0; x < nx; x++) previewSlices.coronal[z * nx + x] = (nativeData as any)[base + x]; }
    }
  }
  {
    if (needsConversion) {
      for (let z = 0; z < nz; z++) { const base = z * ny * nx; for (let y = 0; y < ny; y++) previewSlices.sagittal[z * ny + y] = (nativeData as any)[base + y * nx + saMid] * slope + inter; }
    } else {
      for (let z = 0; z < nz; z++) { const base = z * ny * nx; for (let y = 0; y < ny; y++) previewSlices.sagittal[z * ny + y] = (nativeData as any)[base + y * nx + saMid]; }
    }
  }

  self.postMessage({
    id, type: 'preview',
    header,
    slices: previewSlices,
    globalMin: min, globalMax: max,
    sliceIdx: { axial: axMid, coronal: coMid, sagittal: saMid },
    slope, inter,
  }, [previewSlices.axial.buffer, previewSlices.coronal.buffer, previewSlices.sagittal.buffer]);

  self.postMessage({ id, type: 'progress', value: 0.85, stage: 'transferring volume' });

  const voxelData = needsConversion ? (new Float32Array(n) as any) : nativeData;
  if (needsConversion) {
    for (let i = 0; i < n; i++) {
      voxelData[i] = (nativeData as any)[i] * slope + inter;
    }
  }

  self.postMessage({ id, type: 'progress', value: 1.0, stage: 'done' });

  self.postMessage(
    {
      id,
      type: 'volume',
      header,
      voxelData,
      globalMin: min,
      globalMax: max,
      datatype,
      slope,
      inter,
    },
    [voxelData.buffer]
  );
}
