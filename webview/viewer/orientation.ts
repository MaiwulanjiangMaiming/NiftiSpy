import type { NiiHeader } from '../nii-parser';

export function getAnatomicalAxisDir(srow: number[]): { axis: number; dir: number } {
  // Find which anatomical axis this direction vector is aligned with
  const abs0 = Math.abs(srow[0]),
    abs1 = Math.abs(srow[1]),
    abs2 = Math.abs(srow[2]);
  let domIdx = 0;
  if (abs1 > abs0) domIdx = 1;
  if (abs2 > abs0 && abs2 > abs1) domIdx = 2;

  // The sign: positive is R/A/S, negative is L/P/I
  const dir = srow[domIdx] >= 0 ? 1 : -1;

  // domIdx 0 = R/L axis, 1 = A/P axis, 2 = S/I axis
  return { axis: domIdx, dir };
}

// Compute orientation string from sform matrix (ITK-SNAP approach)
// Analyzes the direction cosines from the sform matrix to determine
// anatomical orientation (L/R, A/P, S/I) for each axis
export function computeOrientationFromSform(srow_x: number[], srow_y: number[], srow_z: number[]): string {
  // RAI codes: positive directions are R, A, S; negative are L, P, I
  const raiPositive = ['R', 'A', 'S'];
  const raiNegative = ['L', 'P', 'I'];

  // Build direction matrix (columns are the srow vectors)
  const directionMatrix = [
    [srow_x[0], srow_y[0], srow_z[0]],
    [srow_x[1], srow_y[1], srow_z[1]],
    [srow_x[2], srow_y[2], srow_z[2]],
  ];

  let result = '';
  for (let i = 0; i < 3; i++) {
    // Get the direction of the i-th voxel coordinate (column i)
    const dirI = [directionMatrix[0][i], directionMatrix[1][i], directionMatrix[2][i]];
    const absDir = [Math.abs(dirI[0]), Math.abs(dirI[1]), Math.abs(dirI[2])];
    const maxAbs = Math.max(absDir[0], absDir[1], absDir[2]);

    // ITK-SNAP trick: visit (i,i) first for tie-breaking
    let found = false;
    for (let off = 0; off < 3; off++) {
      const j = (i + off) % 3;
      if (Math.abs(dirI[j]) === maxAbs) {
        result += dirI[j] > 0 ? raiPositive[j] : raiNegative[j];
        found = true;
        break;
      }
    }
    if (!found) result += '?';
  }

  return result;
}

// Compute orientation from qform quaternion (ITK-SNAP/niivue approach)
// Reconstructs the rotation matrix from the quaternion (b, c, d) and
// derives the srow vectors, then uses the same column-based analysis
export function computeOrientationFromQform(
  h: Partial<Pick<NiiHeader, 'quatern_b' | 'quatern_c' | 'quatern_d' | 'dx' | 'dy' | 'dz'>>,
): string {
  const qb = h.quatern_b || 0;
  const qc = h.quatern_c || 0;
  const qd = h.quatern_d || 0;
  const qa = Math.sqrt(Math.max(0, 1.0 - qb * qb - qc * qc - qd * qd));

  // Quaternion rotation matrix
  const srow_x = [qa * qa + qb * qb - qc * qc - qd * qd, 2 * (qb * qc - qa * qd), 2 * (qb * qd + qa * qc)];
  const srow_y = [2 * (qb * qc + qa * qd), qa * qa - qb * qb + qc * qc - qd * qd, 2 * (qc * qd - qa * qb)];
  const srow_z = [2 * (qb * qd - qa * qc), 2 * (qc * qd + qa * qb), qa * qa - qb * qb - qc * qc + qd * qd];

  // Apply voxel sizes
  const dx = h.dx || 1,
    dy = h.dy || 1,
    dz = h.dz || 1;
  const scaled_x = srow_x.map((v, i) => v * [dx, dy, dz][i]);
  const scaled_y = srow_y.map((v, i) => v * [dx, dy, dz][i]);
  const scaled_z = srow_z.map((v, i) => v * [dx, dy, dz][i]);

  return computeOrientationFromSform(scaled_x, scaled_y, scaled_z);
}

export function computeFlipsForHeader(h: NiiHeader) {
  const srow_x = h.srow_x;
  const srow_y = h.srow_y;
  const srow_z = h.srow_z;

  const xDir = getAnatomicalAxisDir(srow_x);
  const yDir = getAnatomicalAxisDir(srow_y);
  const zDir = getAnatomicalAxisDir(srow_z);

  return {
    axial: { flipX: xDir.dir > 0, flipY: yDir.dir < 0 },
    coronal: { flipX: xDir.dir > 0, flipY: zDir.dir < 0 },
    sagittal: { flipX: yDir.dir > 0, flipY: zDir.dir < 0 },
  };
}
