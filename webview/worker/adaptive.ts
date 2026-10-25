/**
 * Bandwidth-delay-product heuristics for the volume transfer engine.
 * Kept separate from worker.ts so the tuning logic is unit-testable.
 */

// Compute chunk size / concurrency using bandwidth-delay product (BDP).
// The goal is to keep enough bytes in flight to saturate the link without
// creating head-of-line blocking or excessive small requests.
//
// Callers should pass PROBE-MEASURED bandwidth/RTT (ground truth for the
// current link), falling back to session estimates. The pool is always
// launched after the probe measurement, so these values are fresh.
export function computeAdaptiveParams(
  estimatedBps: number,
  estimatedRttMs: number,
  isRemote: boolean,
  totalSize: number,
): { chunkSize: number; maxConcurrent: number } {
  const MAX_CHUNK = 64 * 1024 * 1024;
  const LOCAL_CHUNK = 32 * 1024 * 1024;
  const LOCAL_CONCURRENT = 8;

  if (!isRemote) {
    return {
      chunkSize: Math.min(LOCAL_CHUNK, totalSize),
      maxConcurrent: LOCAL_CONCURRENT,
    };
  }

  // Use caller estimates if available; otherwise fall back to conservative defaults.
  const bps = estimatedBps > 0 ? estimatedBps : 10 * 1024 * 1024;
  const rtt = estimatedRttMs > 0 ? estimatedRttMs : 80;
  const mbps = bps / (1024 * 1024);

  // On slow links (<2 Mbps) shrink the minimum chunk to 512KB: a 2MB floor
  // means 16-64s of wasted transfer on every failed-chunk retry. 512KB keeps
  // the retry granularity proportional to the link speed.
  const MIN_CHUNK = mbps < 2 ? 512 * 1024 : 2 * 1024 * 1024;

  // BDP in bytes (1 RTT worth of data). Multiply by 2 to keep the pipe full.
  const bdpBytes = Math.max(MIN_CHUNK, ((bps * (rtt / 1000)) / 8) * 2);

  // Choose a target concurrency based on link quality. On weak links we keep
  // concurrency low to avoid per-request RTT overhead and TCP congestion,
  // and so background full-volume traffic cannot starve interactive slice
  // and preview requests sharing the same tunnel.
  let targetConcurrent: number;
  if (mbps < 2 || rtt > 500) {
    targetConcurrent = 2;
  } else if (mbps < 10 || rtt > 200) {
    targetConcurrent = 4;
  } else if (mbps < 50) {
    targetConcurrent = 8;
  } else if (mbps < 100) {
    targetConcurrent = 16;
  } else {
    targetConcurrent = 24;
  }

  let chunkSize: number;
  if (totalSize <= bdpBytes) {
    // Small file relative to BDP: download in one chunk.
    chunkSize = totalSize;
  } else {
    // Each chunk should be at least the BDP so a single transfer keeps the
    // pipe full for one RTT. Also spread the file across the target concurrency.
    chunkSize = Math.max(bdpBytes, Math.ceil(totalSize / targetConcurrent));
    chunkSize = Math.min(MAX_CHUNK, chunkSize);
  }

  // Concurrency is limited by the number of chunks we actually created.
  const numChunks = Math.ceil(totalSize / chunkSize);
  const maxConcurrent = Math.max(1, Math.min(numChunks, targetConcurrent));

  return { chunkSize: Math.floor(chunkSize), maxConcurrent };
}

// Choose the initial range-probe size. The probe doubles as (a) the first
// preview data (header + first slices) and (b) the link measurement, so it
// must be small on slow links — a fixed 1MB probe costs 8-16s before the
// first image on a VPN. 256KB covers the NIfTI header plus 1-2 compressed
// slices of a typical 256^2 int16 volume; anything larger is fetched by the
// pool immediately after measurement. Only links KNOWN to be fast (session
// history) get the 1MB probe to save one extra range request.
export function computeProbeSize(estimatedBps: number, _estimatedRttMs: number): number {
  return estimatedBps >= 40 * 1024 * 1024 ? 1024 * 1024 : 256 * 1024;
}
