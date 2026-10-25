import type { NiiHeader } from '../nii-parser';

export interface MipResult {
  data: Float32Array;
  w: number;
  h: number;
}

// ── 3x3 row-major helpers for the MIP virtual trackball ──────────────────

export function rotAxisAngle(ax: number, ay: number, az: number, angle: number): number[] {
  const n = Math.hypot(ax, ay, az) || 1;
  const x = ax / n,
    y = ay / n,
    z = az / n;
  const c = Math.cos(angle),
    s = Math.sin(angle),
    t = 1 - c;
  return [
    t * x * x + c,
    t * x * y - s * z,
    t * x * z + s * y,
    t * x * y + s * z,
    t * y * y + c,
    t * y * z - s * x,
    t * x * z - s * y,
    t * y * z + s * x,
    t * z * z + c,
  ];
}

export function mul3(a: number[], b: number[]): number[] {
  const o = new Array<number>(9).fill(0);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      o[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
    }
  }
  return o;
}

type VolumeArray =
  | Int8Array
  | Uint8Array
  | Int16Array
  | Uint16Array
  | Int32Array
  | Uint32Array
  | Float32Array
  | Float64Array;

export interface MipView {
  header: NiiHeader;
  volumeData: VolumeArray;
  dataSlope: number;
  dataInter: number;
  globalMin: number;
}

export function computeMIP(rot: number[], interactive: boolean, view: MipView): MipResult {
  const { header, volumeData, dataSlope, dataInter, globalMin } = view;
  const { nx, ny, nz, dx, dy, dz } = header;

  // Half extents in world space (mm), volume centered at origin
  const hx = ((nx - 1) * dx) / 2;
  const hy = ((ny - 1) * dy) / 2;
  const hz = ((nz - 1) * dz) / 2;

  // View basis in world mm (columns of the accumulated rotation): right, up, depth
  const Ux = rot[0],
    Uy = rot[1],
    Uz = rot[2];
  const Vx = rot[3],
    Vy = rot[4],
    Vz = rot[5];
  const Wx = rot[6],
    Wy = rot[7],
    Wz = rot[8];

  // Screen (u,v) extents of the rotated box: project the 8 corners
  let uMin = Infinity,
    uMax = -Infinity,
    vMin = Infinity,
    vMax = -Infinity;
  for (let c = 0; c < 8; c++) {
    const px = c & 1 ? hx : -hx;
    const py = c & 2 ? hy : -hy;
    const pz = c & 4 ? hz : -hz;
    const u = px * Ux + py * Uy + pz * Uz;
    const v = px * Vx + py * Vy + pz * Vz;
    if (u < uMin) uMin = u;
    if (u > uMax) uMax = u;
    if (v < vMin) vMin = v;
    if (v > vMax) vMax = v;
  }

  // Square output pixels in mm so anisotropic volumes keep true proportions.
  // Interactive (drag) mode renders at reduced resolution and ray step count
  // — roughly 10x cheaper per frame — so dragging stays smooth; the final
  // full-quality MIP is recomputed once the drag ends.
  const minSp = Math.min(dx, dy, dz);
  let pix = minSp;
  const MAX_DIM = interactive ? 224 : 448;
  const maxExt = Math.max(uMax - uMin, vMax - vMin);
  if (maxExt / pix > MAX_DIM) pix = maxExt / MAX_DIM;

  const outW = Math.max(1, Math.ceil((uMax - uMin) / pix));
  const outH = Math.max(1, Math.ceil((vMax - vMin) / pix));
  const mip = new Float32Array(outW * outH);
  mip.fill(-Infinity);

  const nxy = ny * nx;
  const halfX = (nx - 1) / 2,
    halfY = (ny - 1) / 2,
    halfZ = (nz - 1) / 2;

  for (let j = 0; j < outH; j++) {
    const v = vMin + (j + 0.5) * pix;
    const rowOff = j * outW;
    for (let i = 0; i < outW; i++) {
      const u = uMin + (i + 0.5) * pix;

      // Ray origin: u*U + v*V; direction W. Slab test against the box.
      const ox = u * Ux + v * Vx;
      const oy = u * Uy + v * Vy;
      const oz = u * Uz + v * Vz;
      let t0 = -Infinity,
        t1 = Infinity,
        hit = true;
      const ob = [ox, oy, oz];
      const db = [Wx, Wy, Wz];
      const hb = [hx, hy, hz];
      for (let a = 0; a < 3; a++) {
        if (Math.abs(db[a]) < 1e-9) {
          if (Math.abs(ob[a]) > hb[a]) {
            hit = false;
            break;
          }
        } else {
          let ta = (-hb[a] - ob[a]) / db[a];
          let tb = (hb[a] - ob[a]) / db[a];
          if (ta > tb) {
            const tmp = ta;
            ta = tb;
            tb = tmp;
          }
          if (ta > t0) t0 = ta;
          if (tb < t1) t1 = tb;
        }
      }
      if (!hit || t0 > t1) continue;

      // Cast step: at least min spacing, capped per-ray to bound cost
      const span = t1 - t0;
      const castStep = Math.max(minSp, span / (interactive ? 96 : 256));

      for (let t = Math.max(t0, 0); t <= t1; t += castStep) {
        const wx = ox + t * Wx,
          wy = oy + t * Wy,
          wz = oz + t * Wz;
        let ix = Math.round(wx / dx + halfX);
        let iy = Math.round(wy / dy + halfY);
        let iz = Math.round(wz / dz + halfZ);
        if (ix < 0) ix = 0;
        else if (ix >= nx) ix = nx - 1;
        if (iy < 0) iy = 0;
        else if (iy >= ny) iy = ny - 1;
        if (iz < 0) iz = 0;
        else if (iz >= nz) iz = nz - 1;
        const val = volumeData[iz * nxy + iy * nx + ix] * dataSlope + dataInter;
        const idx = rowOff + i;
        if (val > mip[idx]) mip[idx] = val;
      }
    }
  }

  for (let k = 0; k < mip.length; k++) {
    if (mip[k] === -Infinity) mip[k] = globalMin;
  }

  return { data: mip, w: outW, h: outH };
}
