import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';

// High-performance keep-alive agents with generous socket pools.
// The proxy multiplexes many parallel range requests onto the remote;
// the default Node agent (maxSockets=Infinity but no keep-alive) is
// too slow because every request opens a new TCP+TLS connection.
export const httpAgent = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: 5000,  // send keep-alive probe every 5s
  maxSockets: 64,
  maxFreeSockets: 32,
  timeout: 60000,
  scheduling: 'lifo',  // reuse most recent socket (warm cache)
});
export const httpsAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 5000,
  maxSockets: 64,
  maxFreeSockets: 32,
  timeout: 60000,
  scheduling: 'lifo',
});

/** Pick the right keep-alive agent for a URL. */
export function getAgentForUrl(url: string): http.Agent | https.Agent {
  return url.startsWith('https:') ? httpsAgent : httpAgent;
}

const HTTP_TIMEOUT_MS = 30_000;  // 30s request timeout — prevent infinite hangs

export function readLocalFilePartial(fsPath: string, start: number, end: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const stream = fs.createReadStream(fsPath, { start, end, highWaterMark: 4 * 1024 * 1024 });
    stream.on('data', (chunk) => { if (Buffer.isBuffer(chunk)) chunks.push(chunk); });
    stream.on('end', () => {
      const total = chunks.reduce((s, c) => s + c.length, 0);
      const result = Buffer.alloc(total);
      let offset = 0;
      for (const chunk of chunks) { chunk.copy(result, offset); offset += chunk.length; }
      resolve(new Uint8Array(result.buffer, result.byteOffset, result.byteLength));
    });
    stream.on('error', reject);
  });
}

export function readHttpPartial(urlStr: string, start: number, end: number, signal?: AbortSignal): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const isHttps = url.protocol === 'https:';
    const mod = isHttps ? https : http;
    const agent = isHttps ? httpsAgent : httpAgent;
    const options: http.RequestOptions = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: 'GET',
      headers: { Range: `bytes=${start}-${end}` },
      agent,
    };

    const req = mod.request(options, (res) => {
      if (res.statusCode === 206 || res.statusCode === 200) {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const total = chunks.reduce((s, c) => s + c.length, 0);
          const result = Buffer.alloc(total);
          let off = 0;
          for (const chunk of chunks) { chunk.copy(result, off); off += chunk.length; }
          resolve(new Uint8Array(result.buffer, result.byteOffset, result.byteLength));
        });
      } else {
        reject(new Error(`HTTP ${res.statusCode}`));
      }
    });
    req.on('error', reject);
    // Timeout — prevent infinite hangs on half-open connections
    req.setTimeout(HTTP_TIMEOUT_MS, () => {
      req.destroy(new Error(`HTTP request timeout after ${HTTP_TIMEOUT_MS}ms`));
    });
    if (signal) {
      const onAbort = () => { req.destroy(); reject(new DOMException('Aborted', 'AbortError')); };
      signal.addEventListener('abort', onAbort, { once: true });
    }
    req.end();
  });
}

/**
 * Fetch an HTTP byte-range and write it directly into a pre-allocated buffer
 * at the given offset. Avoids the intermediate Buffer[] + concat allocation
 * that readHttpPartial performs — critical when downloading many large
 * parallel chunks (each 8–32 MB) into a single contiguous volume buffer.
 *
 * Returns the number of bytes written.
 */
export function readHttpPartialInto(
  urlStr: string,
  start: number,
  end: number,
  target: Uint8Array,
  offset: number,
  signal?: AbortSignal,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const isHttps = url.protocol === 'https:';
    const mod = isHttps ? https : http;
    const agent = isHttps ? httpsAgent : httpAgent;
    const options: http.RequestOptions = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: 'GET',
      headers: { Range: `bytes=${start}-${end}` },
      agent,
    };

    let written = 0;
    const req = mod.request(options, (res) => {
      if (res.statusCode === 206 || res.statusCode === 200) {
        res.on('data', (chunk: Buffer) => {
          // Bounds check — prevent writing past target buffer if server
          // returns more data than expected (e.g. ignored Range header)
          const remaining = target.length - offset - written;
          if (remaining <= 0) return;
          const copyLen = Math.min(chunk.byteLength, remaining);
          if (copyLen === chunk.byteLength) {
            target.set(new Uint8Array(chunk.buffer, chunk.byteOffset, copyLen), offset + written);
          } else {
            // Partial copy — chunk exceeds remaining space
            target.set(new Uint8Array(chunk.buffer, chunk.byteOffset, copyLen), offset + written);
          }
          written += copyLen;
        });
        res.on('end', () => resolve(written));
      } else {
        reject(new Error(`HTTP ${res.statusCode}`));
      }
    });
    req.on('error', reject);
    // Timeout — prevent infinite hangs on half-open connections
    req.setTimeout(HTTP_TIMEOUT_MS, () => {
      req.destroy(new Error(`HTTP request timeout after ${HTTP_TIMEOUT_MS}ms`));
    });
    if (signal) {
      const onAbort = () => { req.destroy(); reject(new DOMException('Aborted', 'AbortError')); };
      signal.addEventListener('abort', onAbort, { once: true });
    }
    req.end();
  });
}
