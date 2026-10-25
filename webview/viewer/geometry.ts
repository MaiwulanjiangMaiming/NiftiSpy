import type { NiiHeader } from '../nii-parser';

export function voxelToWorld(h: NiiHeader, vx: number, vy: number, vz: number): [number, number, number] {
  if (h.sform_code !== 0) {
    const wx = h.srow_x[0] * vx + h.srow_x[1] * vy + h.srow_x[2] * vz + h.srow_x[3];
    const wy = h.srow_y[0] * vx + h.srow_y[1] * vy + h.srow_y[2] * vz + h.srow_y[3];
    const wz = h.srow_z[0] * vx + h.srow_z[1] * vy + h.srow_z[2] * vz + h.srow_z[3];
    return [wx, wy, wz];
  }
  if (h.qform_code !== 0) {
    const a = Math.sqrt(1.0 + h.quatern_b * h.quatern_b + h.quatern_c * h.quatern_c + h.quatern_d * h.quatern_d);
    const b = h.quatern_b / a,
      c = h.quatern_c / a,
      d = h.quatern_d / a;
    const R = [
      [a * a + b * b - c * c - d * d, 2 * b * c - 2 * a * d, 2 * b * d + 2 * a * c],
      [2 * b * c + 2 * a * d, a * a + c * c - b * b - d * d, 2 * c * d - 2 * a * b],
      [2 * b * d - 2 * a * c, 2 * c * d + 2 * a * b, a * a + d * d - b * b - c * c],
    ];
    const wx = h.dx * (R[0][0] * vx + R[0][1] * vy + R[0][2] * vz) + h.qoffset_x;
    const wy = h.dy * (R[1][0] * vx + R[1][1] * vy + R[1][2] * vz) + h.qoffset_y;
    const wz = h.dz * (R[2][0] * vx + R[2][1] * vy + R[2][2] * vz) + h.qoffset_z;
    return [wx, wy, wz];
  }
  return [vx * h.dx, vy * h.dy, vz * h.dz];
}

export function worldToVoxel(h: NiiHeader, wx: number, wy: number, wz: number): [number, number, number] {
  if (h.sform_code !== 0) {
    const m = [
      [h.srow_x[0], h.srow_x[1], h.srow_x[2]],
      [h.srow_y[0], h.srow_y[1], h.srow_y[2]],
      [h.srow_z[0], h.srow_z[1], h.srow_z[2]],
    ];
    const off = [wx - h.srow_x[3], wy - h.srow_y[3], wz - h.srow_z[3]];
    const det =
      m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
      m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
      m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
    if (Math.abs(det) > 1e-10) {
      const invDet = 1 / det;
      const vx =
        invDet *
        ((m[1][1] * m[2][2] - m[1][2] * m[2][1]) * off[0] -
          (m[0][1] * m[2][2] - m[0][2] * m[2][1]) * off[1] +
          (m[0][1] * m[1][2] - m[0][2] * m[1][1]) * off[2]);
      const vy =
        invDet *
        (-(m[1][0] * m[2][2] - m[1][2] * m[2][0]) * off[0] +
          (m[0][0] * m[2][2] - m[0][2] * m[2][0]) * off[1] -
          (m[0][0] * m[1][2] - m[0][2] * m[1][0]) * off[2]);
      const vz =
        invDet *
        ((m[1][0] * m[2][1] - m[1][1] * m[2][0]) * off[0] -
          (m[0][0] * m[2][1] - m[0][1] * m[2][0]) * off[1] +
          (m[0][0] * m[1][1] - m[0][1] * m[1][0]) * off[2]);
      return [vx, vy, vz];
    }
  }
  if (h.qform_code !== 0) {
    const a = Math.sqrt(1.0 + h.quatern_b * h.quatern_b + h.quatern_c * h.quatern_c + h.quatern_d * h.quatern_d);
    const b = h.quatern_b / a,
      c = h.quatern_c / a,
      d = h.quatern_d / a;
    const R = [
      [a * a + b * b - c * c - d * d, 2 * b * c - 2 * a * d, 2 * b * d + 2 * a * c],
      [2 * b * c + 2 * a * d, a * a + c * c - b * b - d * d, 2 * c * d - 2 * a * b],
      [2 * b * d - 2 * a * c, 2 * c * d + 2 * a * b, a * a + d * d - b * b - c * c],
    ];
    const qx = wx - h.qoffset_x;
    const qy = wy - h.qoffset_y;
    const qz = wz - h.qoffset_z;
    const det =
      R[0][0] * (R[1][1] * R[2][2] - R[1][2] * R[2][1]) -
      R[0][1] * (R[1][0] * R[2][2] - R[1][2] * R[2][0]) +
      R[0][2] * (R[1][0] * R[2][1] - R[1][1] * R[2][0]);
    if (Math.abs(det) > 1e-10) {
      const invDet = 1 / det;
      const rx =
        invDet *
        ((R[1][1] * R[2][2] - R[1][2] * R[2][1]) * qx -
          (R[0][1] * R[2][2] - R[0][2] * R[2][1]) * qy +
          (R[0][1] * R[1][2] - R[0][2] * R[1][1]) * qz);
      const ry =
        invDet *
        (-(R[1][0] * R[2][2] - R[1][2] * R[2][0]) * qx +
          (R[0][0] * R[2][2] - R[0][2] * R[2][0]) * qy -
          (R[0][0] * R[1][2] - R[0][2] * R[1][0]) * qz);
      const rz =
        invDet *
        ((R[1][0] * R[2][1] - R[1][1] * R[2][0]) * qx -
          (R[0][0] * R[2][1] - R[0][1] * R[2][0]) * qy +
          (R[0][0] * R[1][1] - R[0][1] * R[1][0]) * qz);
      return [rx / h.dx, ry / h.dy, rz / h.dz];
    }
  }
  return [wx / h.dx, wy / h.dy, wz / h.dz];
}
