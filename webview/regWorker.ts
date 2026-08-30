// ========================================================================
// File: regWorker.ts
// Project: NiftiSpy
// Author: Maiwulanjiang Maiming
// Email: mawlan.momin@gmail.com
// Created: 2026-08-26
// Description: Dedicated web worker for intensity-based volume registration.
//              Runs a multi-resolution 9-DOF affine search (translation +
//              rotation + anisotropic scale, no shear) of the moving volume
//              onto a template using joint-background-masked NCC or MI cost.
//              Transform-only output: posts the 4x4 world->moving-voxel
//              affine matrix so the viewer can sample the ORIGINAL moving
//              data at display time — the moving volume is never resampled
//              or rewritten. Posts throttled progress messages.
// ========================================================================

import { gunzipSync } from 'fflate';
import { parseNiiHeader, type NiiHeader } from './nii-parser';

interface MovingVolumeMsg {
  data: ArrayBuffer;             // raw voxel bytes, NIfTI order (x fastest)
  datatype: number;
  littleEndian: boolean;
  slope: number;
  inter: number;
  dims: [number, number, number];
  srow_x: number[];
  srow_y: number[];
  srow_z: number[];
}

interface TemplateVolumeMsg {
  data: ArrayBuffer;             // decoded float32 voxels, NIfTI order (x fastest)
  dims: [number, number, number];
  srow_x: number[];
  srow_y: number[];
  srow_z: number[];
}

interface InitRegMsg {
  type: 'initReg';
  mode: 'mni' | 'custom';
  tplName: string;
  moving: MovingVolumeMsg;
  template?: Uint8Array;         // raw NIfTI bytes (file-based template)
  templateVolume?: TemplateVolumeMsg; // pre-decoded reference (compare Align flow)
}

type RowMajor = Float64Array;    // 16 entries, row-major 4x4

// ── Linear algebra helpers ────────────────────────────────────────────────

function mulRow(a: RowMajor, b: RowMajor): RowMajor {
  const c = new Float64Array(16);
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[i * 4 + k] * b[k * 4 + j];
      c[i * 4 + j] = s;
    }
  }
  return c;
}

function translation(x: number, y: number, z: number): RowMajor {
  const m = new Float64Array(16);
  m[0] = 1; m[5] = 1; m[10] = 1; m[15] = 1;
  m[12] = x; m[13] = y; m[14] = z;
  return m;
}

function rotX(a: number): RowMajor {
  const c = Math.cos(a), s = Math.sin(a);
  const m = new Float64Array(16);
  m[0] = 1; m[5] = c; m[6] = -s; m[9] = s; m[10] = c; m[15] = 1;
  return m;
}

function rotY(a: number): RowMajor {
  const c = Math.cos(a), s = Math.sin(a);
  const m = new Float64Array(16);
  m[0] = c; m[2] = s; m[5] = 1; m[8] = -s; m[10] = c; m[15] = 1;
  return m;
}

function rotZ(a: number): RowMajor {
  const c = Math.cos(a), s = Math.sin(a);
  const m = new Float64Array(16);
  m[0] = c; m[1] = -s; m[4] = s; m[5] = c; m[10] = 1; m[15] = 1;
  return m;
}

function invertAffine(m: RowMajor): RowMajor {
  const inv = new Float64Array(16);
  const a00 = m[0], a01 = m[1], a02 = m[2];
  const a10 = m[4], a11 = m[5], a12 = m[6];
  const a20 = m[8], a21 = m[9], a22 = m[10];
  const det =
    a00 * (a11 * a22 - a12 * a21) -
    a01 * (a10 * a22 - a12 * a20) +
    a02 * (a10 * a21 - a11 * a20);
  if (!isFinite(det) || Math.abs(det) < 1e-12) return inv;
  const idet = 1 / det;
  inv[0] = (a11 * a22 - a12 * a21) * idet;
  inv[1] = (a02 * a21 - a01 * a22) * idet;
  inv[2] = (a01 * a12 - a02 * a11) * idet;
  inv[4] = (a12 * a20 - a10 * a22) * idet;
  inv[5] = (a00 * a22 - a02 * a20) * idet;
  inv[6] = (a02 * a10 - a00 * a12) * idet;
  inv[8] = (a10 * a21 - a11 * a20) * idet;
  inv[9] = (a01 * a20 - a00 * a21) * idet;
  inv[10] = (a00 * a11 - a01 * a10) * idet;
  for (let i = 0; i < 3; i++) {
    let s = 0;
    for (let j = 0; j < 3; j++) s += inv[i * 4 + j] * m[j * 4 + 3];
    inv[i * 4 + 3] = -s;
  }
  inv[15] = 1;
  return inv;
}

function applyAffine(m: RowMajor, x: number, y: number, z: number, out: Float64Array): void {
  out[0] = m[0] * x + m[1] * y + m[2] * z + m[3];
  out[1] = m[4] * x + m[5] * y + m[6] * z + m[7];
  out[2] = m[8] * x + m[9] * y + m[10] * z + m[11];
}

function srowToMat(r: number[], g: number[], b: number[]): RowMajor {
  const m = new Float64Array(16);
  m[0] = r[0]; m[1] = r[1]; m[2] = r[2]; m[3] = r[3];
  m[4] = g[0]; m[5] = g[1]; m[6] = g[2]; m[7] = g[3];
  m[8] = b[0]; m[9] = b[1]; m[10] = b[2]; m[11] = b[3];
  m[15] = 1;
  return m;
}

// ── Volume decode / pyramid helpers ───────────────────────────────────────

/** Decode raw NIfTI voxels into Float32 with scl_slope/scl_inter applied. */
function decodeVoxels(
  bytes: Uint8Array, datatype: number, le: boolean, offset: number,
  n: number, slope: number, inter: number
): Float32Array {
  const out = new Float32Array(n);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const base = bytes.byteOffset + offset;
  for (let i = 0; i < n; i++) {
    let v = 0;
    switch (datatype) {
      case 2: v = view.getUint8(base + i); break;
      case 4: v = view.getInt16(base + i * 2, le); break;
      case 8: v = view.getInt32(base + i * 4, le); break;
      case 16: v = view.getFloat32(base + i * 4, le); break;
      case 64: v = view.getFloat64(base + i * 8, le); break;
      case 256: v = view.getInt8(base + i); break;
      case 512: v = view.getUint16(base + i * 2, le); break;
      case 768: v = view.getUint32(base + i * 4, le); break;
      default: v = view.getFloat32(base + i * 4, le); break;
    }
    out[i] = v * slope + inter;
  }
  return out;
}

/**
 * Box-filter downsample so each axis lands near `targetMm` PHYSICAL voxel
 * size (per-axis, ITK-style). This is what keeps non-isotropic volumes
 * (e.g. 1x1x5 mm) from being over-shrunk along the thin-slice axis: a pure
 * voxel-count ratio would collapse 128 slices of 5 mm into ~12 mips.
 * Returns dims + data (layout x-fastest, same convention as NIfTI storage).
 */
function downsampleVolume(
  src: Float32Array, nx: number, ny: number, nz: number,
  spacing: [number, number, number], targetMm: number
): { dims: [number, number, number]; data: Float32Array } {
  const fovs = [nx * spacing[0], ny * spacing[1], nz * spacing[2]];
  const dims: [number, number, number] = [
    nx, ny, nz,
  ];
  for (let i = 0; i < 3; i++) {
    dims[i] = Math.max(2, Math.min(dims[i], Math.round(fovs[i] / targetMm)));
  }
  const dn = dims[0], dny = dims[1], dnz = dims[2];
  const out = new Float32Array(dn * dny * dnz);

  const starts = (dim: number, steps: number): Int32Array => {
    const arr = new Int32Array(steps + 1);
    for (let o = 0; o <= steps; o++) arr[o] = Math.min(dim, Math.floor(o * dim / steps));
    return arr;
  };
  const sx0 = starts(nx, dn), sy0 = starts(ny, dny), sz0 = starts(nz, dnz);

  for (let z = 0; z < dnz; z++) {
    const zk0 = sz0[z], zk1 = Math.max(zk0 + 1, sz0[z + 1]);
    for (let y = 0; y < dny; y++) {
      const yk0 = sy0[y], yk1 = Math.max(yk0 + 1, sy0[y + 1]);
      const rowBaseOut = (z * dny + y) * dn;
      for (let x = 0; x < dn; x++) {
        const xk0 = sx0[x], xk1 = Math.max(xk0 + 1, sx0[x + 1]);
        let acc = 0, count = 0;
        for (let zz = zk0; zz < zk1; zz++) {
          const plane = zz * nx * ny;
          for (let yy = yk0; yy < yk1; yy++) {
            const rowBase = plane + yy * nx;
            for (let xx = xk0; xx < xk1; xx++) {
              acc += src[rowBase + xx];
              count++;
            }
          }
        }
        out[rowBaseOut + x] = count > 0 ? acc / count : 0;
      }
    }
  }
  return { dims: [dn, dny, dnz], data: out };
}

interface VolStats { lo: number; hi: number; }

/** Robust 1%/99.7% range from strided sampling. */
function robustRange(v: Float32Array): VolStats {
  const step = Math.max(1, Math.floor(v.length / 60000));
  const samples: number[] = [];
  for (let i = 0; i < v.length; i += step) samples.push(v[i]);
  samples.sort((a, b) => a - b);
  const lo = samples[Math.floor(samples.length * 0.01)];
  const hi = samples[Math.min(samples.length - 1, Math.floor(samples.length * 0.997))];
  if (!(hi > lo)) return { lo, hi: lo + 1 };
  return { lo, hi };
}

/** In-place normalize into [0..1] using the robust range. */
function normalizeInto(v: Float32Array, st: VolStats): void {
  const inv = 1 / (st.hi - st.lo);
  for (let i = 0; i < v.length; i++) v[i] = (v[i] - st.lo) * inv;
}

/** Background-suppressed intensity centroid in continuous voxel coords. */
function weightedCentroid(v: Float32Array, dims: [number, number, number]): [number, number, number] {
  const [nx, ny, nz] = dims;
  let wsum = 0, cx = 0, cy = 0, cz = 0;
  const n = v.length;
  const step = Math.max(1, Math.floor(n / 200000));
  for (let idx = 0; idx < n; idx += step) {
    const val = v[idx];
    if (val < 0.08) continue;                        // suppress air / noise floor
    const w = (val - 0.08) * (val - 0.08) + 1e-3;
    const i = idx % nx;
    const j = ((idx - i) / nx) % ny;
    const k = Math.floor(idx / (nx * ny));
    wsum += w; cx += i * w; cy += j * w; cz += k * w;
  }
  if (!(wsum > 0)) return [(nx - 1) / 2, (ny - 1) / 2, (nz - 1) / 2];
  return [cx / wsum, cy / wsum, cz / wsum];
}

// ── Registration context ──────────────────────────────────────────────────

interface MovMip {
  dims: [number, number, number];
  data: Float32Array;               // normalized
  f: [number, number, number];      // mip->full continuous mapping factor
}

interface TplLevel {
  dims: [number, number, number];
  data: Float32Array;               // normalized
  f: [number, number, number];      // level voxel -> full-res template voxel factor
  movMip: MovMip;
}

interface RegContext {
  A_tpl: RowMajor;                  // template voxel -> world
  invA_mov: RowMajor;               // world -> moving voxel
  O_movWorld: [number, number, number];
  O_tplWorld: [number, number, number];
  levels: TplLevel[];
  costMode: 'ncc' | 'mi';
  evalCount: number;
  evalBudget: number;
  // Per-axis log-scale bounds relative to the FOV-ratio initialization.
  // Without them an MI search can collapse the moving volume onto a small
  // high-contrast patch ("shrink-to-peak" degeneracy).
  scaleLim: [number, number][];
}

/** Clamp the scale part of the parameter vector into ctx.scaleLim. */
function clampScales(ctx: RegContext, p: Float64Array): Float64Array {
  let clamped = false;
  const q = new Float64Array(9);
  for (let i = 0; i < 9; i++) q[i] = p[i];
  for (let i = 6; i < 9; i++) {
    const [lo, hi] = ctx.scaleLim[i - 6];
    if (p[i] < lo) { q[i] = lo; clamped = true; }
    else if (p[i] > hi) { q[i] = hi; clamped = true; }
  }
  return clamped ? q : p;
}

/** Forward transform F(params): moving-world -> template-world around COMs. */
function forwardMatrix(p: Float64Array, O_m: [number, number, number], O_t: [number, number, number]): RowMajor {
  const R = mulRow(mulRow(rotX(p[3]), rotY(p[4])), rotZ(p[5]));
  const S = new Float64Array(16);
  S[0] = Math.exp(p[6]); S[5] = Math.exp(p[7]); S[10] = Math.exp(p[8]); S[15] = 1;
  return mulRow(
    mulRow(mulRow(
      translation(O_t[0] + p[0], O_t[1] + p[1], O_t[2] + p[2]),
      R), S),
    translation(-O_m[0], -O_m[1], -O_m[2])
  );
}

/** Trilinear sample; NaN when fully outside. */
function trilinear(
  data: Float32Array, nx: number, ny: number, nz: number, x: number, y: number, z: number
): number {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  if (ix < 0 || ix > nx - 1 || iy < 0 || iy > ny - 1 || iz < 0 || iz > nz - 1) return NaN;
  const fx = x - ix, fy = y - iy, fz = z - iz;
  const jx = ix === nx - 1 ? ix : ix + 1;
  const jy = iy === ny - 1 ? iy : iy + 1;
  const jz = iz === nz - 1 ? iz : iz + 1;
  const b000 = data[(iz * ny + iy) * nx + ix];
  const b100 = data[(iz * ny + iy) * nx + jx];
  const b010 = data[(iz * ny + jy) * nx + ix];
  const b110 = data[(iz * ny + jy) * nx + jx];
  const b001 = data[(jz * ny + iy) * nx + ix];
  const b101 = data[(jz * ny + iy) * nx + jx];
  const b011 = data[(jz * ny + jy) * nx + ix];
  const b111 = data[(jz * ny + jy) * nx + jx];
  const c00 = b000 + (b100 - b000) * fx;
  const c10 = b010 + (b110 - b010) * fx;
  const c01 = b001 + (b101 - b001) * fx;
  const c11 = b011 + (b111 - b011) * fx;
  const c0 = c00 + (c10 - c00) * fy;
  const c1 = c01 + (c11 - c01) * fy;
  return c0 + (c1 - c0) * fz;
}

const MI_BINS = 32;
const histScratch = new Uint32Array(MI_BINS * MI_BINS);
const histRowSum = new Uint32Array(MI_BINS);
const histColSum = new Uint32Array(MI_BINS);

const worldScratch = new Float64Array(3);

interface PairAgg { r: number; mi: number; overlap: number; coverage: number; }

/** One similarity evaluation over a coarse level grid. */
function evaluateAtLevel(
  ctx: RegContext, lvl: TplLevel, params: Float64Array,
  O_m: [number, number, number], O_t: [number, number, number]
): { cost: number; agg: PairAgg } {
  ctx.evalCount++;
  const F = forwardMatrix(clampScales(ctx, params), O_m, O_t);
  const G = invertAffine(F);                 // template-world -> moving-world
  const A = ctx.A_tpl;
  const Ai = ctx.invA_mov;

  const tD = lvl.dims, tData = lvl.data, tf = lvl.f;
  const mD = lvl.movMip.dims, mData = lvl.movMip.data, mf = lvl.movMip.f;
  const totalGrid = tD[0] * tD[1] * tD[2];

  let sn = 0, sm = 0, snn = 0, smm = 0, snm = 0, cnt = 0;
  let valid = 0;
  const hist = histScratch; hist.fill(0);

  for (let kz = 0; kz < tD[2]; kz++) {
    const vz = (kz + 0.5) * tf[2] - 0.5;
    for (let ky = 0; ky < tD[1]; ky++) {
      const vy = (ky + 0.5) * tf[1] - 0.5;
      const rowBaseT = (kz * tD[1] + ky) * tD[0];
      for (let kx = 0; kx < tD[0]; kx++) {
        const vx = (kx + 0.5) * tf[0] - 0.5;

        // Template (full-res fractional) voxel -> world
        applyAffine(A, vx, vy, vz, worldScratch);
        // World --G--> moving world -> moving FULL-res fractional voxel
        const u0 = G[0] * worldScratch[0] + G[1] * worldScratch[1] + G[2] * worldScratch[2] + G[3];
        const u1 = G[4] * worldScratch[0] + G[5] * worldScratch[1] + G[6] * worldScratch[2] + G[7];
        const u2 = G[8] * worldScratch[0] + G[9] * worldScratch[1] + G[10] * worldScratch[2] + G[11];
        const vxm_full = Ai[0] * u0 + Ai[1] * u1 + Ai[2] * u2 + Ai[3];
        const vym_full = Ai[4] * u0 + Ai[5] * u1 + Ai[6] * u2 + Ai[7];
        const vzm_full = Ai[8] * u0 + Ai[9] * u1 + Ai[10] * u2 + Ai[11];

        // Sample the normalized moving mip in its own level space. Inverse of
        // the mip-center map: full-res voxel v sits between mips whose
        // centers are (j+0.5)*f-0.5, hence j = (v+0.5)/f - 0.5. (A multiplicative
        // map here threw most samples out of bounds and froze the optimizer.)
        const mxp = trilinear(mData, mD[0], mD[1], mD[2],
          (vxm_full + 0.5) / mf[0] - 0.5,
          (vym_full + 0.5) / mf[1] - 0.5,
          (vzm_full + 0.5) / mf[2] - 0.5);
        if (!isFinite(mxp)) continue;
        valid++;

        const tv = tData[rowBaseT + kx];   // already level-native + normalized
        if (tv < 0.02 || mxp < 0.02) continue;   // joint background rejection
        cnt++;
        sn += tv; sm += mxp;
        snn += tv * tv; smm += mxp * mxp;
        snm += tv * mxp;
        const tb = Math.min(MI_BINS - 1, tv * MI_BINS | 0);
        const mb = Math.min(MI_BINS - 1, mxp * MI_BINS | 0);
        hist[tb * MI_BINS + mb]++;
      }
    }
  }

  const agg: PairAgg = { r: -1, mi: 1, overlap: cnt / Math.max(1, valid), coverage: 0 };
  // Fraction of the template grid actually covered by the moving FOV. A
  // shrunken moving volume scores high MI on a small bright patch while
  // covering almost nothing — penalize low coverage to reject that family.
  agg.coverage = valid / Math.max(1, totalGrid);
  if (cnt < 64) return { cost: 5, agg };

  const num = cnt * snm - sn * sm;
  const den2 = (cnt * snn - sn * sn) * (cnt * smm - sm * sm);
  agg.r = den2 > 1e-12 ? num / Math.sqrt(den2) : 0;

  let miSum = 0, total = 0;
  histRowSum.fill(0); histColSum.fill(0);
  for (let a = 0; a < MI_BINS; a++) {
    for (let b = 0; b < MI_BINS; b++) {
      const h = hist[a * MI_BINS + b];
      histRowSum[a] += h; histColSum[b] += h; total += h;
    }
  }
  const eps = 1e-12;
  for (let a = 0; a < MI_BINS; a++) {
    for (let b = 0; b < MI_BINS; b++) {
      const h = hist[a * MI_BINS + b];
      if (h === 0) continue;
      const pxy = h / total;
      const px = histRowSum[a] / total;
      const py = histColSum[b] / total;
      miSum += pxy * Math.log(pxy / (px * py) + eps);
    }
  }
  agg.mi = miSum;

  const sim = ctx.costMode === 'ncc' ? agg.r : miSum;
  // 0.35 * (1 - coverage): near-zero for a healthy pose (~90% cover) but
  // large enough to outweigh the MI gain of a shrunken degenerate pose.
  const cost = -(sim + 1e-9) + 0.35 * (1 - agg.coverage);
  return { cost, agg };
}

// ── Pattern-search optimizer ──────────────────────────────────────────────

interface OptimizeResult { params: Float64Array; cost: number; exhausted: boolean; }

/**
 * Cyclic coordinate pattern search: try +/-step along every parameter,
 * keep improvements, shrink all steps by 0.55 when a full sweep improves
 * nothing. Budget-capped by evaluation count and wall-clock.
 */
function patternSearch(
  ctx: RegContext, lvl: TplLevel,
  startParams: Float64Array, steps: Float64Array,
  O_m: [number, number, number], O_t: [number, number, number],
  budgetLeftMs: number, report: (frac: number) => void
): OptimizeResult {
  const cur = startParams.slice();
  let curCost = evaluateAtLevel(ctx, lvl, cur, O_m, O_t).cost;
  const tStart = Date.now();
  const dirs = cur.length;
  while (Date.now() - tStart < budgetLeftMs) {
    const evalBefore = ctx.evalCount;
    let improved = false;
    for (let d = 0; d < dirs; d++) {
      const saved = cur[d];
      let bestVal = saved, bestCost = curCost;
      for (const sign of [1, -1]) {
        cur[d] = saved + sign * steps[d];
        const c = evaluateAtLevel(ctx, lvl, cur, O_m, O_t).cost;
        if (c < bestCost - 1e-6) { bestCost = c; bestVal = cur[d]; }
      }
      cur[d] = bestVal;
      if (bestCost < curCost - 1e-6) { curCost = bestCost; improved = true; }
      else cur[d] = saved;
      if (ctx.evalCount > ctx.evalBudget) {
        report(Math.min(1, (Date.now() - tStart) / Math.max(1, budgetLeftMs)));
        return { params: cur, cost: curCost, exhausted: true };
      }
    }
    if (!improved) {
      for (let d = 0; d < dirs; d++) steps[d] *= 0.55;
      const maxStep = Math.max(steps[0], steps[1], steps[2], steps[6], steps[7], steps[8]);
      if (maxStep < 1e-3) break;
    }
    report(Math.min(1, (Date.now() - tStart) / Math.max(1, budgetLeftMs)));
  }
  return { params: cur, cost: curCost, exhausted: false };
}

/** Deterministic jitter RNG so multi-start sets are reproducible. */
function makeLcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (1664525 * s + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// ── Main pipeline ─────────────────────────────────────────────────────────

async function runRegistration(msg: InitRegMsg): Promise<void> {
  const tAll = performance.now();
  const mv = msg.moving;
  const postProgress = (pct: number, phase: string) =>
    self.postMessage({ type: 'regProgress', pct, phase });

  postProgress(0.02, 'Decoding volumes');

  // 1) Template source -> header + float volume -----------------------------
  // Two sources: raw NIfTI bytes (file-based template) or a pre-decoded
  // volume (compare-mode Align flow, where the reference is a loaded image).
  let hdr: NiiHeader;
  let tplDataFull: Float32Array;
  if (msg.templateVolume) {
    const tv = msg.templateVolume;
    const tn0 = tv.dims[0] * tv.dims[1] * tv.dims[2];
    if (tn0 < 64 || tn0 > 80_000_000) {
      throw new Error(`Reference size ${tv.dims[0]}x${tv.dims[1]}x${tv.dims[2]} out of supported range`);
    }
    hdr = synthHeaderFromVolume(tv);
    tplDataFull = new Float32Array(tv.data);
  } else {
    let tplBytes: Uint8Array = msg.template ?? new Uint8Array(0);
    if (tplBytes.length > 2 && tplBytes[0] === 0x1f && tplBytes[1] === 0x8b) {
      tplBytes = gunzipSync(tplBytes);
    }
    const ab: ArrayBuffer = tplBytes.buffer.slice(
      tplBytes.byteOffset, tplBytes.byteOffset + tplBytes.byteLength
    ) as ArrayBuffer;
    try {
      hdr = parseNiiHeader(ab, false);
    } catch {
      throw new Error('Template header parse failed — not a valid NIfTI file');
    }
    const tn = hdr.nx * hdr.ny * hdr.nz;
    if (tn < 64 || tn > 80_000_000) {
      throw new Error(`Template size ${hdr.nx}x${hdr.ny}x${hdr.nz} out of supported range`);
    }
    tplDataFull = decodeVoxels(
      new Uint8Array(ab), hdr.datatype, hdr.littleEndian, hdr.voxOffset, tn,
      hdr.scl_slope || 1, hdr.scl_inter || 0
    );
  }
  const tn = hdr.nx * hdr.ny * hdr.nz;

  // Actual intensity range of the template — shipped to the host so the
  // template can be added to the image list alongside the result.
  let tplMin = Infinity, tplMax = -Infinity;
  for (let i = 0; i < tn; i++) {
    const v = tplDataFull[i];
    if (v < tplMin) tplMin = v;
    if (v > tplMax) tplMax = v;
  }
  if (!isFinite(tplMin)) { tplMin = 0; tplMax = 1; }
  if (tplMin === tplMax) tplMax = tplMin + 1;

  // 2) Moving voxels -> float ----------------------------------------------
  const mn = mv.dims[0] * mv.dims[1] * mv.dims[2];
  if (mn < 64) throw new Error('Current image is too small to register');
  const movFull = decodeVoxels(new Uint8Array(mv.data), mv.datatype, mv.littleEndian, 0, mn, mv.slope || 1, mv.inter || 0);

  postProgress(0.05, 'Building pyramids');

  // 3) Per-level pyramids ---------------------------------------------------
  // Each optimization level owns BOTH sides' mips so sampled resolution stays
  // comparable under any transform. Levels are defined by a PHYSICAL target
  // voxel size (mm, ITK-style) instead of a voxel count, so non-isotropic
  // inputs keep sane sampling along the thin-slice axis.
  const schedule = [
    { targetMm: 8, mm: 12, deg: 13, sc: 0.20 },
    { targetMm: 5, mm: 5, deg: 5, sc: 0.09 },
    { targetMm: 3.5, mm: 2.5, deg: 2.2, sc: 0.04 },
  ];

  const A_tpl = srowToMat(hdr.srow_x, hdr.srow_y, hdr.srow_z);
  const A_mov = srowToMat(mv.srow_x, mv.srow_y, mv.srow_z);
  const invA_mov = invertAffine(A_mov);

  const tplDims: [number, number, number] = [hdr.nx, hdr.ny, hdr.nz];
  const tplSpacing: [number, number, number] = [hdr.dx, hdr.dy, hdr.dz];
  const movSpacing: [number, number, number] = [
    pixdimFromSrowLen(mv.srow_x),
    pixdimFromSrowLen(mv.srow_y),
    pixdimFromSrowLen(mv.srow_z),
  ];

  const levels: TplLevel[] = schedule.map((sch) => {
    const tds = downsampleVolume(tplDataFull, hdr.nx, hdr.ny, hdr.nz, tplSpacing, sch.targetMm);
    const tst = robustRange(tds.data);
    normalizeInto(tds.data, tst);
    return {
      dims: tds.dims,
      data: tds.data,
      f: [hdr.nx / tds.dims[0], hdr.ny / tds.dims[1], hdr.nz / tds.dims[2]] as [number, number, number],
      movMip: null as unknown as MovMip,
    };
  });

  schedule.forEach((sch, li) => {
    // Same physical target size on the moving side keeps the two mips at
    // comparable sampling density regardless of each volume's anisotropy.
    const mds = downsampleVolume(movFull, mv.dims[0], mv.dims[1], mv.dims[2], movSpacing, sch.targetMm);
    const mst = robustRange(mds.data);
    normalizeInto(mds.data, mst);
    levels[li].movMip = {
      dims: mds.dims,
      data: mds.data,
      f: [mv.dims[0] / mds.dims[0], mv.dims[1] / mds.dims[1], mv.dims[2] / mds.dims[2]],
    };
  });

  const ctx: RegContext = {
    A_tpl, invA_mov,
    O_movWorld: [0, 0, 0],
    O_tplWorld: [0, 0, 0],
    levels,
    costMode: 'ncc',
    evalCount: 0,
    evalBudget: 24000,
    scaleLim: [[-Infinity, Infinity], [-Infinity, Infinity], [-Infinity, Infinity]],
  };

  // 4) Initial alignment: COM-to-COM + world-extent-ratio scales ------------
  postProgress(0.08, 'Initial alignment');
  const midIdx = 1;
  const comTplVox = weightedCentroid(levels[midIdx].data, levels[midIdx].dims);
  const fMid = levels[midIdx].f;
  // Level-voxel center -> full-res voxel: (j+0.5)*f - 0.5 = j*f + 0.5*(f-1).
  const comTplFull: [number, number, number] = [
    comTplVox[0] * fMid[0] + 0.5 * (fMid[0] - 1),
    comTplVox[1] * fMid[1] + 0.5 * (fMid[1] - 1),
    comTplVox[2] * fMid[2] + 0.5 * (fMid[2] - 1),
  ];
  const movMipMid = levels[midIdx].movMip;
  const comMovMip = weightedCentroid(movMipMid.data, movMipMid.dims);
  const fmMid = movMipMid.f;
  const comMovFull: [number, number, number] = [
    comMovMip[0] * fmMid[0] + 0.5 * (fmMid[0] - 1),
    comMovMip[1] * fmMid[1] + 0.5 * (fmMid[1] - 1),
    comMovMip[2] * fmMid[2] + 0.5 * (fmMid[2] - 1),
  ];

  const wt = applyAffineNew(A_tpl, comTplFull);
  const wm = applyAffineNew(A_mov, comMovFull);
  ctx.O_tplWorld = wt;
  ctx.O_movWorld = wm;

  // Initial scale along each WORLD axis ~ physical extent ratio. Extents are
  // measured through the sform directions, so oblique/anisotropic acquisitions
  // (storage axes not aligned with physical axes) start correctly.
  const initP = new Float64Array([0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const extT = worldExtents(A_tpl, tplDims);
  const extM = worldExtents(A_mov, mv.dims);
  for (let i = 0; i < 3; i++) {
    initP[6 + i] = Math.log(Math.min(1.8, Math.max(0.55, extM[i] / Math.max(1e-3, extT[i]))));
    // Search may deviate from the FOV-ratio init by at most 1.8x / 0.55x
    // per axis — wide enough for real anatomy, tight enough to exclude the
    // shrink-to-peak MI degeneracy.
    ctx.scaleLim[i] = [initP[6 + i] + Math.log(0.55), initP[6 + i] + Math.log(1.8)];
  }

  // 5) Auto-select similarity metric at the initial pose --------------------
  const probe = evaluateAtLevel(ctx, levels[midIdx], initP, wm, wt);
  ctx.costMode = Math.abs(probe.agg.r) >= 0.45 ? 'ncc' : 'mi';

  // 6) Coarse multi-start then refine through the pyramid -------------------
  postProgress(0.1, 'Coarse alignment');
  const rng = makeLcg((0xA53F9D1 ^ mn) >>> 0);
  const jitterSets: Float64Array[] = [initP.slice()];
  for (let s = 0; s < 4; s++) {
    const jp = initP.slice();
    jp[0] += (rng() - 0.5) * 24; jp[1] += (rng() - 0.5) * 24; jp[2] += (rng() - 0.5) * 18;
    jp[3] += (rng() - 0.5) * 0.45; jp[4] += (rng() - 0.5) * 0.45; jp[5] += (rng() - 0.5) * 0.35;
    jp[6] += (rng() - 0.5) * 0.24; jp[7] += (rng() - 0.5) * 0.24; jp[8] += (rng() - 0.5) * 0.18;
    jitterSets.push(jp);
  }

  const levelWeights = [0.42, 0.34, 0.24];
  let cum = 0.1;
  let bestParams: Float64Array = initP.slice();
  let bestCost = Infinity;

  for (let li = 0; li < levels.length; li++) {
    const lvl = levels[li];
    const starts = li === 0 ? jitterSets : [bestParams.slice()];
    let lvBestP: Float64Array = starts[0].slice();
    let lvBestC = Infinity;
    for (let si = 0; si < starts.length; si++) {
      const sch = schedule[li];
      const steps = new Float64Array([
        sch.mm, sch.mm, sch.mm,
        sch.deg * Math.PI / 180, sch.deg * Math.PI / 180, sch.deg * Math.PI / 180,
        sch.sc, sch.sc, sch.sc,
      ]);
      const res = patternSearch(ctx, lvl, starts[si], steps, wm, wt, li === 0 ? 5000 : 12000,
        (frac) => {
          // Progress within this restart attempt; mapped into its share of the
          // current level's weight across restarts.
          self.postMessage({
            type: 'regProgress',
            pct: Math.min(0.95, cum + levelWeights[li] * ((si + frac) / starts.length)),
            phase: li === 0 ? 'Coarse alignment' : li === 1 ? 'Refining' : 'Fine tuning',
            mode: ctx.costMode,
          });
        });
      if (res.cost < lvBestC) { lvBestC = res.cost; lvBestP = res.params; }
      if (res.exhausted) break;
    }
    bestParams = lvBestP;
    bestCost = lvBestC;
    cum += levelWeights[li];
    postProgress(Math.min(0.92, cum), li === 2 ? 'Converged' : 'Aligned');
    if (performance.now() - tAll > 55000) break;   // hard wall-clock guard
  }

  // 7) Emit the transform only (ITK-SNAP style) -----------------------------
  // The moving volume is NEVER resampled here. The host stores the composed
  // world->moving-voxel affine and samples the ORIGINAL full-resolution data
  // at display time, so no resolution or intensity information is destroyed.
  postProgress(0.95, 'Finalizing');
  // patternSearch keeps raw trial values; the cost it recorded corresponds to
  // the clamped scales, so apply the same clamp before reporting.
  bestParams = clampScales(ctx, bestParams);
  const F = forwardMatrix(bestParams, wm, wt);
  const G = invertAffine(F);                // template-world -> moving-world
  const M = mulRow(invA_mov, G);            // template-world -> moving voxel

  const dur = Math.round(performance.now() - tAll);
  self.postMessage({
    type: 'regResult',
    mode: msg.mode,
    alignM: Array.from(M),
    // Template grid geometry — used by the host for the template image entry.
    nx: hdr.nx, ny: hdr.ny, nz: hdr.nz,
    dx: hdr.dx, dy: hdr.dy, dz: hdr.dz,
    srow_x: hdr.srow_x, srow_y: hdr.srow_y, srow_z: hdr.srow_z,
    orientation: hdr.orientation,
    tplName: msg.tplName,
    cost: bestCost, costMode: ctx.costMode,
    durationMs: dur, evals: ctx.evalCount,
    tplData: tplDataFull.buffer,
    tplMin, tplMax,
    summary: {
      trans: [+bestParams[0].toFixed(1), +bestParams[1].toFixed(1), +bestParams[2].toFixed(1)],
      rotDeg: [+(bestParams[3] * 180 / Math.PI).toFixed(1), +(bestParams[4] * 180 / Math.PI).toFixed(1), +(bestParams[5] * 180 / Math.PI).toFixed(1)],
      scale: [+Math.exp(bestParams[6]).toFixed(3), +Math.exp(bestParams[7]).toFixed(3), +Math.exp(bestParams[8]).toFixed(3)],
    },
  }, [tplDataFull.buffer]);
}

// Small utilities used by the pipeline ---------------------------------------

/**
 * Minimal NiiHeader for a pre-decoded reference volume (compare Align flow).
 * Geometry comes from the volume's sform rows; intensity scaling is already
 * baked into the float data.
 */
function synthHeaderFromVolume(tv: TemplateVolumeMsg): NiiHeader {
  const tn = tv.dims[0] * tv.dims[1] * tv.dims[2];
  return {
    version: 1,
    ndim: 3, nt: 1, nu: 1,
    nx: tv.dims[0], ny: tv.dims[1], nz: tv.dims[2],
    dx: pixdimFromSrowLen(tv.srow_x),
    dy: pixdimFromSrowLen(tv.srow_y),
    dz: pixdimFromSrowLen(tv.srow_z),
    dt: 0, datatype: 16, bitpix: 32,
    voxOffset: 0,
    scl_slope: 1, scl_inter: 0,
    littleEndian: true, isGzip: false,
    bytesPerVoxel: 4,
    totalVoxels3D: tn,
    sliceSizeXY: tv.dims[0] * tv.dims[1],
    volumeBytes: tn * 4,
    qform_code: 0, sform_code: 2,
    quatern_b: 0, quatern_c: 0, quatern_d: 0,
    qoffset_x: tv.srow_x[3], qoffset_y: tv.srow_y[3], qoffset_z: tv.srow_z[3],
    srow_x: [...tv.srow_x], srow_y: [...tv.srow_y], srow_z: [...tv.srow_z],
    descrip: '', xyzt_units: 10,
    orientation: 'unknown',
  };
}

function applyAffineNew(m: RowMajor, v: [number, number, number]): [number, number, number] {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2] + m[3],
    m[4] * v[0] + m[5] * v[1] + m[6] * v[2] + m[7],
    m[8] * v[0] + m[9] * v[1] + m[10] * v[2] + m[11],
  ];
}

function pixdimFromSrowLen(row: number[]): number {
  return Math.hypot(row[0], row[1], row[2]) || 1;
}

/**
 * Physical extent of the volume along each WORLD axis, measured through the
 * sform directions (ITK physical-bounding-box analogue). Unlike
 * dims[i]*spacing[i], this stays correct when storage axes are swapped or
 * oblique relative to physical axes.
 */
function worldExtents(A: RowMajor, dims: [number, number, number]): [number, number, number] {
  const ext: [number, number, number] = [0, 0, 0];
  for (let j = 0; j < 3; j++) {
    let s = 0;
    for (let i = 0; i < 3; i++) s += Math.abs(A[j * 4 + i]) * (dims[i] - 1);
    ext[j] = s;
  }
  return ext;
}

self.onmessage = (ev: MessageEvent) => {
  const msg = ev.data as InitRegMsg;
  if (!msg || msg.type !== 'initReg') return;
  runRegistration(msg).catch((err: unknown) => {
    self.postMessage({
      type: 'regError',
      mode: (msg as InitRegMsg).mode,
      message: err instanceof Error ? err.message : String(err),
    });
  });
};
