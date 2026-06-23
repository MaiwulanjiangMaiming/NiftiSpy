import * as http from 'http';
import * as https from 'https';
import * as fs from 'fs';
import * as stream from 'stream';
import * as zlib from 'zlib';
import { extractAxialSliceFromRange } from '../nifti/sliceExtractor';
import { parseNiiHeaderQuick } from '../nifti/headerParser';
import { getAgentForUrl } from './fileReader';

export function shouldCompress(req: http.IncomingMessage): boolean {
  const acceptEncoding = req.headers['accept-encoding'] || '';
  if (!acceptEncoding.includes('gzip')) return false;
  // Skip compression for localhost — the data crosses a loopback
  // connection where bandwidth is effectively infinite and gzip
  // only adds CPU latency. This is critical for large volumes.
  const host = req.headers['host'] || '';
  if (host.startsWith('127.0.0.1') || host.startsWith('localhost')) return false;
  return true;
}

export function compressResponse(data: Buffer, req: http.IncomingMessage, res: http.ServerResponse, contentType: string, extraHeaders?: Record<string, string>): void {
  const headers: Record<string, string> = {
    'Content-Type': contentType,
    ...extraHeaders,
  };

  if (shouldCompress(req)) {
    if (data.length < 1024 * 1024) {
      // Small data: use synchronous gzip for lower latency
      const compressed = zlib.gzipSync(data, { level: 1 });
      headers['Content-Encoding'] = 'gzip';
      headers['Content-Length'] = String(compressed.length);
      res.writeHead(200, headers);
      res.end(compressed);
    } else {
      // Large data: stream to avoid blocking
      headers['Content-Encoding'] = 'gzip';
      res.writeHead(200, headers);
      stream.Readable.from(data, { highWaterMark: 1024 * 1024 }).pipe(zlib.createGzip({ level: 1 })).pipe(res);
    }
  } else {
    headers['Content-Length'] = String(data.length);
    res.writeHead(200, headers);
    res.end(data);
  }
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

export function streamingGunzipPreview(fsPath: string, signal?: AbortSignal): Promise<{ header: any; axialSlice: Float32Array; coronalSlice?: Float32Array; sagittalSlice?: Float32Array }> {
  return new Promise((resolve, reject) => {
    const gunzip = zlib.createGunzip();
    const chunks: Buffer[] = [];
    let totalSize = 0;
    let resolved = false;
    let header: any = null;
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

      // Send z=0 slice as instant preview
      if (header && totalSize >= firstSliceNeeded && !resolved) {
        const buf = Buffer.concat(chunks);
        const { nx, ny, voxOffset, bytesPerVoxel } = header;
        const sliceEnd = voxOffset + nx * ny * bytesPerVoxel;
        if (buf.length >= sliceEnd) {
          const sliceBytes = new Uint8Array(buf.buffer, buf.byteOffset + voxOffset, nx * ny * bytesPerVoxel);
          const axialSlice = extractAxialSliceFromRange(sliceBytes, header);
          // Resolve immediately with z=0 for instant display
          resolved = true;
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

export function streamingHttpGunzipPreview(urlStr: string, signal?: AbortSignal): Promise<{ header: any; axialSlice: Float32Array }> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const mod = url.protocol === 'https:' ? https : http;
    const gunzip = zlib.createGunzip();
    const chunks: Buffer[] = [];
    let totalSize = 0;
    let resolved = false;
    let header: any = null;
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
