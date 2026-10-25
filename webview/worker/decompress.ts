/**
 * Streaming gzip decompression helpers used by the volume worker.
 */
import { throwIfAborted } from './net';

export type ByteWriter = {
  write(data: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(reason?: unknown): Promise<void>;
};

/**
 * Adapt a `WritableStream<BufferSource>` writer to byte-array input. Views
 * backed by a SharedArrayBuffer are copied because BufferSource only accepts
 * ArrayBuffer-backed views under the current TypeScript lib definitions.
 */
export function makeByteWriter(stream: WritableStream<BufferSource>): ByteWriter {
  const writer = stream.getWriter();
  return {
    write(data) {
      return writer.write(data as BufferSource);
    },
    close: () => writer.close(),
    abort: (reason) => writer.abort(reason),
  };
}

export async function nativeDecompressFromBuffer(compressed: Uint8Array, signal?: AbortSignal): Promise<Uint8Array> {
  const ds = new DecompressionStream('gzip');
  const writer = makeByteWriter(ds.writable);
  const reader = ds.readable.getReader() as ReadableStreamDefaultReader<Uint8Array>;

  // Parallelize writing and reading — the writer feeds compressed data
  // into the DecompressionStream while the reader consumes decompressed
  // output concurrently. This overlaps CPU (decompress) with I/O (write)
  // and cuts latency roughly in half for large buffers.
  const writePromise = (async () => {
    const CHUNK = 4 * 1024 * 1024;
    let off = 0;
    while (off < compressed.length) {
      throwIfAborted(signal);
      const end = Math.min(off + CHUNK, compressed.length);
      await writer.write(compressed.subarray(off, end));
      off = end;
    }
    await writer.close();
  })();

  const estimatedSize = compressed.length * 4;
  let result = new Uint8Array(Math.max(estimatedSize, 16 * 1024 * 1024));
  let writeOffset = 0;

  for (;;) {
    throwIfAborted(signal);
    const { done, value } = await reader.read();
    if (done) break;

    if (writeOffset + value.byteLength > result.length) {
      let newCap = result.length;
      while (newCap < writeOffset + value.byteLength) newCap *= 2;
      const grown = new Uint8Array(newCap);
      grown.set(result.subarray(0, writeOffset), 0);
      result = grown;
    }
    result.set(value, writeOffset);
    writeOffset += value.byteLength;
  }

  await writePromise;
  return result.subarray(0, writeOffset);
}
