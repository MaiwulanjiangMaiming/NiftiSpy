import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';

// High-performance keep-alive agents with generous socket pools.
// The proxy multiplexes many parallel range requests onto the remote;
// the default Node agent (maxSockets=Infinity but no keep-alive) is
// too slow because every request opens a new TCP+TLS connection.
export const httpAgent = new http.Agent({
  keepAlive: true,
  maxSockets: 64,
  maxFreeSockets: 32,
  timeout: 60000,
  scheduling: 'lifo',  // reuse most recent socket (warm cache)
});
export const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 64,
  maxFreeSockets: 32,
  timeout: 60000,
  scheduling: 'lifo',
});

/** Pick the right keep-alive agent for a URL. */
export function getAgentForUrl(url: string): http.Agent | https.Agent {
  return url.startsWith('https:') ? httpsAgent : httpAgent;
}

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
    if (signal) {
      const onAbort = () => { req.destroy(); reject(new DOMException('Aborted', 'AbortError')); };
      signal.addEventListener('abort', onAbort, { once: true });
    }
    req.end();
  });
}
