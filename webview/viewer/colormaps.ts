export type ColormapFn = (t: number) => [number, number, number];

export const COLORMAPS: Record<string, ColormapFn> = {
  gray: (t) => [t * 255, t * 255, t * 255],
  hot: (t) => {
    const r = Math.min(1, t * 3) * 255;
    const g = Math.max(0, Math.min(1, t * 3 - 1)) * 255;
    const b = Math.max(0, Math.min(1, t * 3 - 2)) * 255;
    return [r, g, b];
  },
  cool: (t) => [(1 - t) * 255, t * 255, 255],
  jet: (t) => {
    const r = Math.max(0, Math.min(1, 1.5 - Math.abs(t * 4 - 3))) * 255;
    const g = Math.max(0, Math.min(1, 1.5 - Math.abs(t * 4 - 2))) * 255;
    const b = Math.max(0, Math.min(1, 1.5 - Math.abs(t * 4 - 1))) * 255;
    return [r, g, b];
  },
  viridis: (t) => VIRIDIS_LUT[Math.max(0, Math.min(255, Math.floor(t * 255)))],
  inferno: (t) => INFERNO_LUT[Math.max(0, Math.min(255, Math.floor(t * 255)))],
};

function buildLUT(stops: [number, number, number, number][]): [number, number, number][] {
  const lut: [number, number, number][] = [];
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let s0 = stops[0], s1 = stops[1];
    for (let j = 0; j < stops.length - 1; j++) {
      if (t >= stops[j][0] && t <= stops[j + 1][0]) { s0 = stops[j]; s1 = stops[j + 1]; break; }
    }
    const f = s0[0] === s1[0] ? 0 : (t - s0[0]) / (s1[0] - s0[0]);
    lut.push([Math.round(s0[1] + (s1[1] - s0[1]) * f), Math.round(s0[2] + (s1[2] - s0[2]) * f), Math.round(s0[3] + (s1[3] - s0[3]) * f)]);
  }
  return lut;
}

const VIRIDIS_LUT = buildLUT([[0,68,1,84],[0.13,72,36,117],[0.25,65,68,135],[0.38,53,95,141],[0.5,42,120,142],[0.63,33,145,140],[0.75,34,168,132],[0.88,68,191,112],[1,253,231,37]]);
const INFERNO_LUT = buildLUT([[0,0,0,4],[0.13,40,11,84],[0.25,101,21,110],[0.38,159,42,99],[0.5,212,72,66],[0.63,245,125,21],[0.75,250,193,39],[0.88,234,247,132],[1,252,255,164]]);

