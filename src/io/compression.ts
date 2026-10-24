import * as http from 'http';
import { isWanRemote } from '../remoteEnv';
import * as https from 'https';
import * as fs from 'fs';
import * as stream from 'stream';
import * as zlib from 'zlib';
import { extractAxialSliceFromRange } from '../nifti/sliceExtractor';
import { parseNiiHeaderQuick, type NiiHeader } from '../nifti/headerParser';
import { getAgentForUrl } from './fileReader';

export function shouldCompress(req: http.IncomingMessage): boolean {
  const acceptEncoding = req.headers['accept-encoding'] || '';
  if (!acceptEncoding.split(',').some(part => /^\s*gzip\s*(?:;\s*q=(?!0(?:\.0*)?\s*$)[0-9.]+)?\s*$/i.test(part))) return false;
  // A localhost port forwarded by Remote-SSH still crosses the network.
  const host = req.headers['host'] || '';
  if (!isWanRemote() && /^(127\.0\.0\.1|localhost|\[::1\])(?::|$)/i.test(host)) return false;
  return true;
}

export function compressResponse(data: Buffer, req: http.IncomingMessage, res: http.ServerResponse, contentType: string, extraHeaders?: Record<string, string>): void {
  const headers: Record<string, string> = {
    'Content-Type': contentType,
    ...extraHeaders,
  };

  const queuedTiming = res.getHeader('Server-Timing');
  if (queuedTiming && extraHeaders?.['Server-Timing']) headers['Server-Timing'] = `${queuedTiming}, ${extraHeaders['Server-Timing']}`;
  const priorVary = res.getHeader('Vary');
  res.setHeader('Vary', priorVary ? `${String(priorVary)}, Accept-Encoding` : 'Accept-Encoding');
  const encodeStartedAt = performance.now();
  const send = (compressed?: Buffer) => {
    if (res.destroyed || res.writableEnded) return;
    const body = compressed && compressed.length < data.length ? compressed : data;
    if (body !== data) headers['Content-Encoding'] = 'gzip';
    headers['Content-Length'] = String(body.length);
    if (headers['Server-Timing']) headers['Server-Timing'] += `, encode;dur=${(performance.now() - encodeStartedAt).toFixed(2)}`;
    res.writeHead(200, headers);
    res.end(body);
  };
  if (data.length >= 1024 && shouldCompress(req)) {
    // Larger planes use libuv's zlib worker pool, leaving the extension host responsive.
    if (data.length < 64 * 1024) send(zlib.gzipSync(data, { level: 1 }));
    else zlib.gzip(data, { level: 1 }, (error, compressed) => send(error ? undefined : compressed));
  } else send();
}

export function gunzipAsync(data: Uint8Array, signal?: AbortSignal): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }
    zlib.gunzip(Buffer.from(data.buffer, data.byteOffset, data.byteLength), (err, result) => {
      if (signal?.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }
      if (err) reject(err);
      else resolve(new Uint8Array(result.buffer, result.byteOffset, result.byteLength));
    });
  });
}

export function streamingGunzipPreview(fsPath: string, signal?: AbortSignal): Promise<{ header: NiiHeader | null; axialSlice: Float32Array; coronalSlice?: Float32Array; sagittalSlice?: Float32Array }> {
  return new Promise((resolve, reject) => {
    const gunzip = zlib.createGunzip();
    const chunks: Buffer[] = [];
    let totalSize = 0;
    let resolved = false;
    let header: NiiHeader | null = null;
    let firstSliceNeeded = Infinity;   // z=0 slice — instant preview

    const fileStream = fs.createReadStream(fsPath);
    fileStream.pipe(gunzip);

    const onAbort = () => {
      if (!resolved) {
        resolved = true;
        fileStream.destroy();
        gunzip.destroy();
        reject(new DOMException('Aborted', 'AbortError'));
      }
    };
    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }

    gunzip.on('data', (chunk: Buffer) => {
      if (resolved) return;
      if (signal?.aborted) { gunzip.destroy(); return; }
      chunks.push(chunk);
      totalSize += chunk.length;

      if (!header && totalSize >= 544) {
        const buf = Buffer.concat(chunks);
        header = parseNiiHeaderQuick(new Uint8Array(buf.buffer, buf.byteOffset, buf.length));
        if (header) {
          const { nx, ny, voxOffset, bytesPerVoxel } = header;
          // z=0 slice: right after header — available almost instantly
          firstSliceNeeded = voxOffset + nx * ny * bytesPerVoxel;
        }
      }

      // Send z=0 slice as instant preview, then stop — callers in slice
      // mode must not pay for a full sequential inflate of a 300MB gzip.
      if (header && totalSize >= firstSliceNeeded && !resolved) {
        const buf = Buffer.concat(chunks);
        const { nx, ny, voxOffset, bytesPerVoxel } = header;
        const sliceEnd = voxOffset + nx * ny * bytesPerVoxel;
        if (buf.length >= sliceEnd) {
          const sliceBytes = new Uint8Array(buf.buffer, buf.byteOffset + voxOffset, nx * ny * bytesPerVoxel);
          const axialSlice = extractAxialSliceFromRange(sliceBytes, header);
          resolved = true;
          fileStream.destroy();
          gunzip.destroy();
          resolve({ header, axialSlice });
        }
      }
    });

    gunzip.on('end', () => {
      if (signal) signal.removeEventListener('abort', onAbort);
      if (!resolved) {
        const buf = Buffer.concat(chunks);
        const rawData = new Uint8Array(buf.buffer, buf.byteOffset, buf.length);
        if (!header) {
          header = parseNiiHeaderQuick(rawData);
        }
        if (header) {
          const { nx, ny, nz, voxOffset, bytesPerVoxel } = header;
          // Try center slice first, fall back to z=0
          const axMid = Math.floor(nz / 2);
          let sliceStart = voxOffset + axMid * nx * ny * bytesPerVoxel;
          let sliceEnd = sliceStart + nx * ny * bytesPerVoxel;
          if (rawData.length < sliceEnd) {
            // Fall back to z=0
            sliceStart = voxOffset;
            sliceEnd = voxOffset + nx * ny * bytesPerVoxel;
          }
          let axialSlice: Float32Array;
          if (rawData.length >= sliceEnd) {
            const sliceBytes = new Uint8Array(rawData.buffer, rawData.byteOffset + sliceStart, nx * ny * bytesPerVoxel);
            axialSlice = extractAxialSliceFromRange(sliceBytes, header);
          } else {
            axialSlice = new Float32Array(nx * ny);
          }
          resolve({ header, axialSlice });
        } else {
          reject(new Error('Failed to parse NIfTI header from decompressed data'));
        }
      }
    });

    gunzip.on('error', (err) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      if (!resolved) {
        resolved = true;
        reject(err);
      }
    });

    fileStream.on('error', (err) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      if (!resolved) {
        resolved = true;
        reject(err);
      }
    });
  });
}

export function streamingHttpGunzipPreview(urlStr: string, signal?: AbortSignal): Promise<{ header: NiiHeader | null; axialSlice: Float32Array }> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const mod = url.protocol === 'https:' ? https : http;
    const gunzip = zlib.createGunzip();
    const chunks: Buffer[] = [];
    let totalSize = 0;
    let resolved = false;
    let header: NiiHeader | null = null;
    let firstSliceNeeded = Infinity;   // z=0 slice — instant preview

    const options: http.RequestOptions = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: 'GET',
      agent: getAgentForUrl(urlStr),  // reuse keep-alive connections
    };

    const req = mod.request(options, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      res.pipe(gunzip);

      const onAbort = () => {
        if (!resolved) {
          resolved = true;
          req.destroy();
          gunzip.destroy();
          reject(new DOMException('Aborted', 'AbortError'));
        }
      };
      if (signal) signal.addEventListener('abort', onAbort, { once: true });

      gunzip.on('data', (chunk: Buffer) => {
        if (resolved) return;
        if (signal?.aborted) { gunzip.destroy(); req.destroy(); return; }
        chunks.push(chunk);
        totalSize += chunk.length;

        if (!header && totalSize >= 544) {
          const buf = Buffer.concat(chunks);
          header = parseNiiHeaderQuick(new Uint8Array(buf.buffer, buf.byteOffset, buf.length));
          if (header) {
            const { nx, ny, voxOffset, bytesPerVoxel } = header;
            // z=0 slice: right after header — available almost instantly
            firstSliceNeeded = voxOffset + nx * ny * bytesPerVoxel;
          }
        }

        // Send z=0 slice as instant preview
        if (header && totalSize >= firstSliceNeeded && !resolved) {
          resolved = true;
          const buf = Buffer.concat(chunks);
          const rawData = new Uint8Array(buf.buffer, buf.byteOffset, buf.length);
          const { nx, ny, voxOffset, bytesPerVoxel } = header;
          const sliceEnd = voxOffset + nx * ny * bytesPerVoxel;
          if (rawData.length >= sliceEnd) {
            const sliceBytes = rawData.slice(voxOffset, sliceEnd);
            const axialSlice = extractAxialSliceFromRange(sliceBytes, header);
            req.destroy();
            gunzip.destroy();
            resolve({ header, axialSlice });
          }
        }
      });

      gunzip.on('end', () => {
        if (!resolved) {
          if (header) {
            const buf = Buffer.concat(chunks);
            const rawData = new Uint8Array(buf.buffer, buf.byteOffset, buf.length);
            const { nx, ny, nz, voxOffset, bytesPerVoxel } = header;
            // Try center slice first, fall back to z=0
            const axMid = Math.floor(nz / 2);
            let sliceStart = voxOffset + axMid * nx * ny * bytesPerVoxel;
            let sliceEnd = sliceStart + nx * ny * bytesPerVoxel;
            if (rawData.length < sliceEnd) {
              sliceStart = voxOffset;
              sliceEnd = voxOffset + nx * ny * bytesPerVoxel;
            }
            if (rawData.length >= sliceEnd) {
              const sliceBytes = rawData.slice(sliceStart, sliceEnd);
              const axialSlice = extractAxialSliceFromRange(sliceBytes, header);
              resolve({ header, axialSlice });
              return;
            }
          }
          reject(new Error('Failed to extract preview from remote gzip'));
        }
      });

      gunzip.on('error', (err: Error) => { if (!resolved) { resolved = true; reject(err); } });
    });

    req.on('error', (err: Error) => { if (!resolved) { resolved = true; reject(err); } });
    req.end();
  });
}

export interface VolumePreviewResult {
  header: NiiHeader;
  volume: Float32Array;
  min: number;
  max: number;
  outNx: number;
  outNy: number;
  outNz: number;
}

/**
 * Stream-download + decompress a .nii.gz file and extract a strided
 * sub-sampled volume, resolving as soon as all needed z-slices have been
 * decompressed — WITHOUT waiting for the full file to download.
 *
 * Subsampling reduces output bytes and voxel conversion work. Gzip still
 * requires sequential inflation through the last sampled z (near EOF).
 */
export function streamingGunzipPreviewVolume(
  source: { type: 'file'; path: string } | { type: 'http'; url: string },
  factor: number,
  signal?: AbortSignal,
): Promise<VolumePreviewResult> {
  return new Promise((resolve, reject) => {
    // Clamp must match the proxy's slow-link tiering (up to 32 on VPN links):
    // an inner [2,8] cap silently downgrades factor=16/32 requests back to 8,
    // which re-downloads 4x more of the gzip stream than the caller intended.
    const f = Math.max(2, Math.min(32, Math.floor(factor) || 4));
    const gunzip = zlib.createGunzip();
    const chunks: Buffer[] = [];
    let totalSize = 0;
    let resolved = false;
    let header: NiiHeader | null = null;
    let output: Float32Array | null = null;
    let outNx = 0, outNy = 0, outNz = 0;
    let nextNeededZ = 0;
    let min = Infinity, max = -Infinity;
    let sourceStream: stream.Readable | null = null;
    let req: http.ClientRequest | null = null;

    const cleanup = (): void => {
      try { gunzip.destroy(); } catch { /* best-effort cleanup */ }
      try { (sourceStream as { destroy?: () => void })?.destroy?.(); } catch { /* best-effort cleanup */ }
      try { req?.destroy(); } catch { /* best-effort cleanup */ }
    };

    const onAbort = (): void => {
      if (!resolved) {
        resolved = true;
        cleanup();
        reject(new DOMException('Aborted', 'AbortError'));
      }
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    const tryExtractSlices = (): void => {
      if (!header || !output) return;
      const h = header;
      const nx: number = h.nx, ny: number = h.ny;
      const voxOffset: number = h.voxOffset;
      const bpv: number = Math.max(1, h.bytesPerVoxel);
      const datatype: number = h.datatype;
      const slope: number = h.scl_slope || 1;
      const inter: number = h.scl_inter || 0;
      const le: boolean = h.littleEndian;
      const sliceByteSize = nx * ny * bpv;

      // Quick guard: do we have enough decompressed data for the next
      // needed slice?  This avoids O(n) Buffer.concat on every chunk.
      const nextSliceEnd = voxOffset + (nextNeededZ * f) * sliceByteSize + sliceByteSize;
      if (totalSize < nextSliceEnd) return;

      const buf = Buffer.concat(chunks);

      while (nextNeededZ < outNz) {
        const srcZ = nextNeededZ * f;
        const sliceStart = voxOffset + srcZ * sliceByteSize;
        const sliceEnd = sliceStart + sliceByteSize;
        if (buf.length < sliceEnd) break;

        const sliceBytes = buf.subarray(sliceStart, sliceEnd);
        const view = new DataView(sliceBytes.buffer, sliceBytes.byteOffset, sliceBytes.byteLength);
        const outSliceBase = nextNeededZ * outNy * outNx;

        for (let outY = 0; outY < outNy; outY++) {
          const srcY = outY * f;
          const rowBase = srcY * nx;
          const outRowBase = outSliceBase + outY * outNx;
          for (let outX = 0; outX < outNx; outX++) {
            const srcX = outX * f;
            const off = (rowBase + srcX) * bpv;
            let val: number;
            switch (datatype) {
              case 2: val = sliceBytes[off]; break;
              case 4: val = view.getInt16(off, le); break;
              case 8: val = view.getInt32(off, le); break;
              case 16: val = view.getFloat32(off, le); break;
              case 64: val = view.getFloat64(off, le); break;
              case 256: val = (sliceBytes[off] << 24) >> 24; break;
              case 512: val = view.getUint16(off, le); break;
              case 768: val = view.getUint32(off, le); break;
              default: val = 0;
            }
            const scaled = val * slope + inter;
            output[outRowBase + outX] = scaled;
            if (scaled < min) min = scaled;
            if (scaled > max) max = scaled;
          }
        }
        nextNeededZ++;
      }

      if (nextNeededZ >= outNz && !resolved) {
        resolved = true;
        if (min === max) max = min + 1;
        if (signal) signal.removeEventListener('abort', onAbort);
        cleanup();
        resolve({ header, volume: output, min, max, outNx, outNy, outNz });
      }
    };

    gunzip.on('data', (chunk: Buffer) => {
      if (resolved) return;
      if (signal?.aborted) { cleanup(); return; }
      chunks.push(chunk);
      totalSize += chunk.length;

      if (!header && totalSize >= 544) {
        const buf = Buffer.concat(chunks);
        header = parseNiiHeaderQuick(new Uint8Array(buf.buffer, buf.byteOffset, buf.length));
        if (header) {
          outNx = Math.max(1, Math.floor(header.nx / f));
          outNy = Math.max(1, Math.floor(header.ny / f));
          outNz = Math.max(1, Math.floor(header.nz / f));
          output = new Float32Array(outNx * outNy * outNz);
        }
      }

      if (header && output) {
        tryExtractSlices();
      }
    });

    gunzip.on('end', () => {
      if (!resolved) {
        // Stream ended — if we got at least some slices, resolve with
        // what we have (remaining voxels stay zero).  Otherwise reject.
        if (header && output && nextNeededZ > 0) {
          resolved = true;
          if (min === max) max = min + 1;
          if (signal) signal.removeEventListener('abort', onAbort);
          resolve({ header, volume: output, min, max, outNx, outNy, outNz });
        } else if (!resolved) {
          resolved = true;
          if (signal) signal.removeEventListener('abort', onAbort);
          reject(new Error('Stream ended before enough data for preview volume'));
        }
      }
    });

    gunzip.on('error', (err: Error) => {
      if (!resolved) {
        resolved = true;
        if (signal) signal.removeEventListener('abort', onAbort);
        reject(err);
      }
    });

    // Create source stream and pipe through gunzip
    if (source.type === 'file') {
      sourceStream = fs.createReadStream(source.path);
      sourceStream.on('error', (err: Error) => {
        if (!resolved) {
          resolved = true;
          if (signal) signal.removeEventListener('abort', onAbort);
          reject(err);
        }
      });
      sourceStream.pipe(gunzip);
    } else {
      const url = new URL(source.url);
      const mod = url.protocol === 'https:' ? https : http;
      const options: http.RequestOptions = {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method: 'GET',
        agent: getAgentForUrl(source.url),
      };
      req = mod.request(options, (res) => {
        if (res.statusCode !== 200) {
          if (!resolved) {
            resolved = true;
            if (signal) signal.removeEventListener('abort', onAbort);
            reject(new Error(`HTTP ${res.statusCode}`));
          }
          return;
        }
        sourceStream = res;
        res.pipe(gunzip);
      });
      req.on('error', (err: Error) => {
        if (!resolved) {
          resolved = true;
          if (signal) signal.removeEventListener('abort', onAbort);
          reject(err);
        }
      });
      req.end();
    }
  });
}

