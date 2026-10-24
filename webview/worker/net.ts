/** Retry, idle-watchdog and chunk-sizing helpers for worker transports. */
import { asError, isAbortError } from '../../src/errors';

export let volumeFetchPriority: 'user' | 'background' = 'background';
export function setVolumeFetchPriority(p: 'user' | 'background'): void {
  volumeFetchPriority = p;
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const err = new Error('Aborted');
    err.name = 'AbortError';
    throw err;
  }
}

export const MAX_RETRIES = 3;
export const CHUNK_SIZE = 16 * 1024 * 1024;
export const RETRY_DELAY_BASE = 500;
const LOCALHOST_CHUNK_SIZE = 128 * 1024 * 1024; // 128MB for loopback (no network latency)
const LOCALHOST_MAX_CONCURRENT = 16;
const REMOTE_MAX_CONCURRENT = 16;

export async function fetchWithRetry(
  url: string,
  options?: RequestInit,
  retries: number = MAX_RETRIES,
  signal?: AbortSignal,
): Promise<Response> {
  let lastErr: Error | null = null;
  const headers = new Headers(options?.headers || {});
  if (!headers.has('X-NiftiSpy-Priority')) {
    headers.set('X-NiftiSpy-Priority', volumeFetchPriority);
  }
  const opts: RequestInit = { ...options, headers };
  for (let attempt = 0; attempt < retries; attempt++) {
    throwIfAborted(signal);
    try {
      // Headers phase is watchdog-protected: a frozen VPN never rejects the
      // fetch promise, so without this every caller could hang at TTFB.
      // TimeoutError lands in the retry path below (it is not an AbortError).
      const resp = await fetchHeadersWatchdog(url, opts, DEFAULT_IDLE_TIMEOUT_MS, signal);
      if (resp.ok || resp.status === 206) return resp;
      const shouldRetryStatus = resp.status === 408 || resp.status === 425 || resp.status === 429 || resp.status >= 500;
      if (shouldRetryStatus && attempt < retries - 1) {
        await sleep(RETRY_DELAY_BASE * Math.pow(2, attempt));
        continue;
      }
      return resp;
    } catch (err) {
      lastErr = asError(err);
      if (isAbortError(err)) throw err;
      if (attempt < retries - 1) {
        await sleep(RETRY_DELAY_BASE * Math.pow(2, attempt));
      }
    }
  }
  throw lastErr || new Error('Fetch failed after retries');
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Idle watchdog (slow/stalled-link protection)
//
// A VPN that "freezes" (silent packet loss, tunnel renegotiation) never
// errors the fetch — it just stops delivering bytes, hanging a chunk fetch
// for 15+ minutes. A pure total-duration timeout cannot distinguish
// "slow but flowing" from "dead", so on slow links it would kill healthy
// transfers and trigger retry storms. The idle watchdog instead aborts only
// when NO bytes arrived for `idleMs` — a flowing transfer is never killed,
// a silent one dies within seconds.
// ---------------------------------------------------------------------------

export const DEFAULT_IDLE_TIMEOUT_MS = 20000;

export function clampIdleTimeout(rttMs: number): number {
  return Math.min(30000, Math.max(5000, rttMs * 8));
}

function makeIdleError(): DOMException {
  return new DOMException('idle timeout', 'TimeoutError');
}

/**
 * One reader.read() bounded by `idleMs` of silence. Rejects with
 * TimeoutError when the stream produces no chunk in time. Used by both
 * readBodyWithWatchdog (whole-body aggregation) and the streaming loaders
 * (incremental parse loops that cannot aggregate).
 */
export async function readStreamChunkWithWatchdog(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  idleMs: number,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(makeIdleError()), idleMs);
  });
  try {
    return await Promise.race([reader.read(), timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Read a Response body with a resettable idle watchdog: every successful
 * read() resets the timer. Rejects with TimeoutError when the stream goes
 * silent for `idleMs`. External AbortSignal still wins (AbortError).
 * `onProgress` receives the cumulative byte count after each chunk.
 */
export async function readBodyWithWatchdog(
  resp: Response,
  idleMs: number,
  signal?: AbortSignal,
  onProgress?: (received: number) => void,
): Promise<Uint8Array> {
  if (!resp.body) return new Uint8Array(await resp.arrayBuffer());
  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    throwIfAborted(signal);
    let result: ReadableStreamReadResult<Uint8Array>;
    try {
      result = await readStreamChunkWithWatchdog(reader, idleMs);
    } catch (err) {
      try {
        await reader.cancel();
      } catch {
        /* stream already gone */
      }
      throw err;
    }
    if (result.done) break;
    chunks.push(result.value);
    total += result.value.byteLength;
    onProgress?.(total);
  }
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

/**
 * Fetch with the HEADERS phase (TTFB) bounded by `idleMs` of silence.
 * Accepts a full RequestInit (method/headers/body all forwarded); any
 * signal inside init is superseded by the watchdog controller, which
 * itself bridges the external `signal`. Returns the raw Response — body
 * reading stays the caller's job (usually via readBodyWithWatchdog).
 * TimeoutError is thrown so callers can retry; AbortError propagates.
 * Needed because a frozen VPN never errors the fetch promise, it just
 * never resolves it.
 */
export async function fetchHeadersWatchdog(
  url: string,
  init: RequestInit,
  idleMs: number,
  signal?: AbortSignal,
): Promise<Response> {
  let timedOut = false;
  const ctrl = new AbortController();
  const onExternalAbort = () => ctrl.abort(signal!.reason);
  signal?.addEventListener('abort', onExternalAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort(makeIdleError());
  }, idleMs);

  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } catch (err) {
    if (timedOut) throw makeIdleError();
    throw err;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onExternalAbort);
  }
}

/**
 * Fetch one range with full idle-watchdog protection: the headers phase
 * (TTFB) and every body read are each bounded by `idleMs` of silence.
 * TimeoutError is thrown so callers can retry; AbortError propagates.
 */
async function fetchRangeWatchdog(
  url: string,
  headers: Record<string, string>,
  idleMs: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const resp = await fetchHeadersWatchdog(url, { headers }, idleMs, signal);

  if (!resp.ok) {
    try {
      await resp.body?.cancel();
    } catch {
      /* ignore */
    }
    throw new Error(`HTTP ${resp.status}`);
  }
  return readBodyWithWatchdog(resp, idleMs, signal);
}

/**
 * fetchRangeWatchdog + retry with backoff. TimeoutError and network errors
 * are retryable; AbortError (user cancel) propagates immediately.
 */
export async function fetchRangeBytesWithRetry(
  url: string,
  start: number,
  end: number,
  idleMs: number,
  signal?: AbortSignal,
  retries: number = MAX_RETRIES,
): Promise<Uint8Array> {
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < retries; attempt++) {
    throwIfAborted(signal);
    try {
      return await fetchRangeWatchdog(url, { Range: `bytes=${start}-${end}` }, idleMs, signal);
    } catch (err) {
      if (isAbortError(err)) throw err;
      lastErr = asError(err);
      if (attempt < retries - 1) {
        await sleep(RETRY_DELAY_BASE * Math.pow(2, attempt));
      }
    }
  }
  throw lastErr || new Error('Range fetch failed after retries');
}

export function getPreferredChunkSize(url: string): number {
  if (url.includes('127.0.0.1')) return LOCALHOST_CHUNK_SIZE;
  return CHUNK_SIZE;
}

export function getPreferredConcurrency(url: string): number {
  if (url.includes('127.0.0.1')) return LOCALHOST_MAX_CONCURRENT;
  return REMOTE_MAX_CONCURRENT;
}
