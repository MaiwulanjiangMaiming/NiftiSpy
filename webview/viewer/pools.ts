export class BufferPool {
  private pools: Map<number, ArrayBuffer[]> = new Map();
  private maxSize: number;

  constructor(maxSize: number = 50) {
    this.maxSize = maxSize;
  }

  acquire(size: number): ArrayBuffer {
    const key = this.nearestPowerOf2(size);
    const pool = this.pools.get(key);
    if (pool && pool.length > 0) {
      return pool.pop()!;
    }
    return new ArrayBuffer(key);
  }

  release(buf: ArrayBuffer): void {
    const key = this.nearestPowerOf2(buf.byteLength);
    let pool = this.pools.get(key);
    if (!pool) {
      pool = [];
      this.pools.set(key, pool);
    }
    if (pool.length < this.maxSize) {
      pool.push(buf);
    }
  }

  private nearestPowerOf2(n: number): number {
    let p = 1;
    while (p < n) p <<= 1;
    return p;
  }

  clear(): void {
    this.pools.clear();
  }
}

export class Float32Pool {
  private pool: Float32Array[] = [];
  private maxSize: number;

  constructor(maxSize: number = 30) {
    this.maxSize = maxSize;
  }

  acquire(length: number): Float32Array {
    for (let i = 0; i < this.pool.length; i++) {
      if (this.pool[i].length >= length) {
        const arr = this.pool.splice(i, 1)[0];
        return arr.subarray(0, length);
      }
    }
    return new Float32Array(length);
  }

  release(arr: Float32Array): void {
    if (this.pool.length < this.maxSize) {
      this.pool.push(arr);
    }
  }

  clear(): void {
    this.pool = [];
  }
}

export class BandwidthEstimator {
  private samples: { bytes: number; durationMs: number }[] = [];
  private maxSamples = 10;
  private _estimatedBps: number = 10 * 1024 * 1024;
  private _estimatedRttMs: number = 50;
  private listeners: Array<() => void> = [];
  private lastQuality: 'high' | 'medium' | 'low' = 'medium';

  get estimatedBps(): number {
    return this._estimatedBps;
  }

  get estimatedRttMs(): number {
    return this._estimatedRttMs;
  }

  onQualityChange(fn: () => void): void {
    this.listeners.push(fn);
  }

  private emitIfQualityChanged(): void {
    const q = this.qualityLevel;
    if (q === this.lastQuality) return;
    this.lastQuality = q;
    for (const fn of this.listeners) fn();
  }

  addSample(bytes: number, durationMs: number): void {
    if (durationMs <= 0) return;
    this.samples.push({ bytes, durationMs });
    if (this.samples.length > this.maxSamples) {
      this.samples.shift();
    }
    let totalBytes = 0;
    let totalMs = 0;
    for (const s of this.samples) {
      totalBytes += s.bytes;
      totalMs += s.durationMs;
    }
    this._estimatedBps = (totalBytes / totalMs) * 1000 * 8;
    this.emitIfQualityChanged();
  }

  addRttSample(rttMs: number): void {
    if (rttMs <= 0) return;
    // Exponential moving average for RTT: smooth, responsive to regime changes.
    const alpha = 0.3;
    this._estimatedRttMs = this._estimatedRttMs * (1 - alpha) + rttMs * alpha;
    this.emitIfQualityChanged();
  }

  get qualityLevel(): 'high' | 'medium' | 'low' {
    const mbps = this._estimatedBps / (1024 * 1024);
    if (mbps < 2 || this._estimatedRttMs > 400) return 'low';
    if (mbps > 20) return 'high';
    return 'medium';
  }
}