import { NiiHeader, DATATYPE_NAMES } from './nii-parser';

declare function acquireVsCodeApi(): any;
const vscode = acquireVsCodeApi();

interface VolumeImage {
  header: NiiHeader;
  data: Int8Array | Uint8Array | Int16Array | Uint16Array | Int32Array | Uint32Array | Float32Array | Float64Array;
  min: number;
  max: number;
  name: string;
  url: string;
  slope: number;
  inter: number;
}

const images: VolumeImage[] = [];
let activeImageIdx = 0;
let compareMode = false;

let header: NiiHeader | null = null;
let volumeData: Int8Array | Uint8Array | Int16Array | Uint16Array | Int32Array | Uint32Array | Float32Array | Float64Array | null = null;
let dataSlope = 1;
let dataInter = 0;
let globalMin = 0;
let globalMax = 1;
let initialWindowWidth = 1.0;
let initialWindowLevel = 0.5;

const sliceIdx = { axial: 0, coronal: 0, sagittal: 0 };
let windowWidth = 1.0;
let windowLevel = 0.5;
let overlayOpacity = 0.5;
let overlayColormap = 'hot';
type CompareLayout = 'overlay' | 'sideBySide';
let compareLayout: CompareLayout = 'overlay';
let colormap = 'gray';
let fileUrl = '';
let isGzip = false;
let fileName = '';
let crosshairVisible = true;

const viewState = {
  axial: { zoom: 1, panX: 0, panY: 0 },
  coronal: { zoom: 1, panX: 0, panY: 0 },
  sagittal: { zoom: 1, panX: 0, panY: 0 },
  mip: { rotationX: 0, rotationY: 0 },
};

let maximizedView: string | null = null;
let sidebarCollapsed = false;
let sidebarWidth = 180;

function voxelToWorld(h: NiiHeader, vx: number, vy: number, vz: number): [number, number, number] {
  if (h.sform_code !== 0) {
    const wx = h.srow_x[0] * vx + h.srow_x[1] * vy + h.srow_x[2] * vz + h.srow_x[3];
    const wy = h.srow_y[0] * vx + h.srow_y[1] * vy + h.srow_y[2] * vz + h.srow_y[3];
    const wz = h.srow_z[0] * vx + h.srow_z[1] * vy + h.srow_z[2] * vz + h.srow_z[3];
    return [wx, wy, wz];
  }
  if (h.qform_code !== 0) {
    const a = Math.sqrt(1.0 + h.quatern_b * h.quatern_b + h.quatern_c * h.quatern_c + h.quatern_d * h.quatern_d);
    const b = h.quatern_b / a, c = h.quatern_c / a, d = h.quatern_d / a;
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

function worldToVoxel(h: NiiHeader, wx: number, wy: number, wz: number): [number, number, number] {
  if (h.sform_code !== 0) {
    const m = [
      [h.srow_x[0], h.srow_x[1], h.srow_x[2]],
      [h.srow_y[0], h.srow_y[1], h.srow_y[2]],
      [h.srow_z[0], h.srow_z[1], h.srow_z[2]],
    ];
    const off = [wx - h.srow_x[3], wy - h.srow_y[3], wz - h.srow_z[3]];
    const det = m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
              - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
              + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
    if (Math.abs(det) > 1e-10) {
      const invDet = 1 / det;
      const vx = invDet * ((m[1][1] * m[2][2] - m[1][2] * m[2][1]) * off[0] - (m[0][1] * m[2][2] - m[0][2] * m[2][1]) * off[1] + (m[0][1] * m[1][2] - m[0][2] * m[1][1]) * off[2]);
      const vy = invDet * (-(m[1][0] * m[2][2] - m[1][2] * m[2][0]) * off[0] + (m[0][0] * m[2][2] - m[0][2] * m[2][0]) * off[1] - (m[0][0] * m[1][2] - m[0][2] * m[1][0]) * off[2]);
      const vz = invDet * ((m[1][0] * m[2][1] - m[1][1] * m[2][0]) * off[0] - (m[0][0] * m[2][1] - m[0][1] * m[2][0]) * off[1] + (m[0][0] * m[1][1] - m[0][1] * m[1][0]) * off[2]);
      return [vx, vy, vz];
    }
  }
  return [wx / h.dx, wy / h.dy, wz / h.dz];
}

const loading = document.getElementById('loading') as HTMLDivElement;
const loadingText = document.getElementById('loading-text') as HTMLSpanElement;
const loadingDetail = document.getElementById('loading-detail') as HTMLSpanElement;
const progress = document.getElementById('progress-bar') as HTMLDivElement;

const canvases = {
  axial: document.getElementById('axial') as HTMLCanvasElement,
  coronal: document.getElementById('coronal') as HTMLCanvasElement,
  sagittal: document.getElementById('sagittal') as HTMLCanvasElement,
  mip: document.getElementById('mip') as HTMLCanvasElement,
};

const COLORMAPS: Record<string, (t: number) => [number, number, number]> = {
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

let cachedWorker: Worker | null = null;
let cachedBlobUrl: string | null = null;

async function getWorker(): Promise<Worker> {
  if (cachedWorker) return cachedWorker;
  if (cachedBlobUrl) {
    cachedWorker = new Worker(cachedBlobUrl);
    return cachedWorker;
  }
  const workerResp = await fetch((window as any).WORKER_URL);
  if (!workerResp.ok) throw new Error(`Worker fetch failed: ${workerResp.status}`);
  const workerSrc = await workerResp.text();
  const blob = new Blob([workerSrc], { type: 'application/javascript' });
  cachedBlobUrl = URL.createObjectURL(blob);
  cachedWorker = new Worker(cachedBlobUrl);
  return cachedWorker;
}

function extractSlice(axis: 'axial' | 'coronal' | 'sagittal', idx: number): Float32Array {
  if (!header || !volumeData) return new Float32Array(0);
  const { nx, ny, nz } = header;
  const src = volumeData;
  const s = dataSlope;
  const t = dataInter;
  const needScale = s !== 1 || t !== 0;

  if (axis === 'axial') {
    const slice = new Float32Array(nx * ny);
    const base = idx * ny * nx;
    if (needScale) {
      for (let i = 0; i < nx * ny; i++) slice[i] = src[base + i] * s + t;
    } else {
      for (let i = 0; i < nx * ny; i++) slice[i] = src[base + i];
    }
    return slice;
  } else if (axis === 'coronal') {
    const slice = new Float32Array(nx * nz);
    for (let z = 0; z < nz; z++) {
      const base = z * ny * nx + idx * nx;
      if (needScale) {
        for (let x = 0; x < nx; x++) slice[z * nx + x] = src[base + x] * s + t;
      } else {
        for (let x = 0; x < nx; x++) slice[z * nx + x] = src[base + x];
      }
    }
    return slice;
  } else {
    const slice = new Float32Array(ny * nz);
    for (let z = 0; z < nz; z++) {
      const base = z * ny * nx;
      if (needScale) {
        for (let y = 0; y < ny; y++) slice[z * ny + y] = src[base + y * nx + idx] * s + t;
      } else {
        for (let y = 0; y < ny; y++) slice[z * ny + y] = src[base + y * nx + idx];
      }
    }
    return slice;
  }
}

function computeMIP(rotX: number, rotY: number): Float32Array {
  if (!header || !volumeData) return new Float32Array(0);
  const { nx, ny, nz, dx, dy, dz } = header;
  const outW = nx;
  const outH = ny;
  const mip = new Float32Array(outW * outH);
  mip.fill(-Infinity);

  const cosX = Math.cos(rotX), sinX = Math.sin(rotX);
  const cosY = Math.cos(rotY), sinY = Math.sin(rotY);

  const aspectX = dx, aspectY = dy, aspectZ = dz;
  const maxAspect = Math.max(aspectX, aspectY, aspectZ);
  const sx = aspectX / maxAspect, sy = aspectY / maxAspect, sz = aspectZ / maxAspect;

  const step = Math.max(1, Math.floor(Math.min(nx, ny, nz) / 80));

  for (let z = 0; z < nz; z += step) {
    const zc = (z - nz / 2) * sz;
    for (let y = 0; y < ny; y += step) {
      const yc = (y - ny / 2) * sy;
      for (let x = 0; x < nx; x += step) {
        const xc = (x - nx / 2) * sx;

        const x1 = xc * cosY + zc * sinY;
        const z1 = -xc * sinY + zc * cosY;
        const y1 = yc * cosX - z1 * sinX;

        const px = Math.round(nx / 2 + x1 / sx);
        const py = Math.round(ny / 2 + y1 / sy);

        if (px >= 0 && px < outW && py >= 0 && py < outH) {
          const v = volumeData[z * ny * nx + y * nx + x] * dataSlope + dataInter;
          const idx = py * outW + px;
          if (v > mip[idx]) mip[idx] = v;
        }
      }
    }
  }

  for (let i = 0; i < mip.length; i++) {
    if (mip[i] === -Infinity) mip[i] = globalMin;
  }

  return mip;
}

const sliceImageDataCache: Record<string, ImageData> = {};

function paintSlice(axis: string, data: Float32Array, w: number, h: number, pixelW: number, pixelH: number) {
  const canvas = canvases[axis as keyof typeof canvases];
  if (!canvas || !data || data.length === 0) return;

  const vs = viewState[axis as keyof typeof viewState] as { zoom: number; panX: number; panY: number };
  const zoom = vs.zoom;
  const panX = vs.panX;
  const panY = vs.panY;

  const dpr = window.devicePixelRatio || 1;
  const container = canvas.parentElement!;
  const dw = container.clientWidth;
  const dh = container.clientHeight;
  if (dw === 0 || dh === 0) return;

  const ar = pixelW / pixelH;
  let cw: number, ch: number;
  if (dw / dh > ar) { ch = dh; cw = Math.floor(dh * ar); }
  else { cw = dw; ch = Math.floor(dw / ar); }

  cw = Math.floor(cw * zoom);
  ch = Math.floor(ch * zoom);

  canvas.style.width = dw + 'px';
  canvas.style.height = dh + 'px';
  canvas.width = dw * dpr;
  canvas.height = dh * dpr;

  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;

  const cacheKey = axis;
  let imgData = sliceImageDataCache[cacheKey];
  if (!imgData || imgData.width !== w || imgData.height !== h) {
    imgData = ctx.createImageData(w, h);
    sliceImageDataCache[cacheKey] = imgData;
  }
  const pixels = imgData.data;
  const cmapFn = COLORMAPS[colormap] || COLORMAPS.gray;
  const lo = windowLevel - windowWidth * 0.5;
  const hi = windowLevel + windowWidth * 0.5;
  const range = hi - lo || 1;
  const dataRange = globalMax - globalMin || 1;
  const n = w * h;

  for (let i = 0; i < n; i++) {
    const norm = (data[i] - globalMin) / dataRange;
    const t = Math.max(0, Math.min(1, (norm - lo) / range));
    const [r, g, b] = cmapFn(t);
    const idx = i * 4;
    pixels[idx] = r; pixels[idx + 1] = g; pixels[idx + 2] = b; pixels[idx + 3] = 255;
  }

  const tc = document.createElement('canvas');
  tc.width = w; tc.height = h;
  const tctx = tc.getContext('2d')!;
  tctx.putImageData(imgData, 0, 0);

  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const imgLeft = (dw - cw) / 2 + panX;
  const imgTop = (dh - ch) / 2 + panY;
  const offsetX = imgLeft * dpr;
  const offsetY = (imgTop + ch) * dpr;
  const scaleX = cw * dpr / w;
  const scaleY = -ch * dpr / h;

  ctx.save();
  ctx.translate(offsetX, offsetY);
  ctx.scale(scaleX, scaleY);
  ctx.drawImage(tc, 0, 0);
  ctx.restore();

  updateDirectionLabels(axis);
  updateCrosshair(axis, w, h, zoom, panX, panY, cw, ch);
  updateScaleBar(axis, pixelW, pixelH, zoom, cw);
  updateMinimap(axis, w, h, zoom, panX, panY, cw, ch);
}

function getCoordLabelX(axis: string): { left: string; right: string } {
  const ori = header?.orientation || 'RAS';
  if (axis === 'sagittal') {
    switch (ori) {
      case 'RAS': case 'RPS': case 'RSA': return { left: 'A', right: 'P' };
      case 'LAS': case 'LPS': case 'LSA': return { left: 'P', right: 'A' };
      default: return { left: 'A', right: 'P' };
    }
  }
  switch (ori) {
    case 'RAS': case 'RPS': case 'RSA': return { left: 'R', right: 'L' };
    case 'LAS': case 'LPS': case 'LSA': return { left: 'L', right: 'R' };
    default: return { left: 'R', right: 'L' };
  }
}

function getCoordLabelY(axis: string): { top: string; bottom: string } {
  const ori = header?.orientation || 'RAS';
  if (axis === 'sagittal') {
    switch (ori) {
      case 'RAS': case 'LAS': case 'RSA': case 'LSA': return { top: 'S', bottom: 'I' };
      case 'RPS': case 'LPS': return { top: 'I', bottom: 'S' };
      default: return { top: 'S', bottom: 'I' };
    }
  }
  if (axis === 'coronal') {
    switch (ori) {
      case 'RAS': case 'LAS': return { top: 'S', bottom: 'I' };
      case 'RPS': case 'LPS': return { top: 'I', bottom: 'S' };
      case 'RSA': case 'LSA': return { top: 'A', bottom: 'P' };
      default: return { top: 'S', bottom: 'I' };
    }
  }
  switch (ori) {
    case 'RAS': case 'LAS': return { top: 'A', bottom: 'P' };
    case 'RPS': case 'LPS': return { top: 'P', bottom: 'A' };
    case 'RSA': case 'LSA': return { top: 'P', bottom: 'A' };
    default: return { top: 'A', bottom: 'P' };
  }
}

function updateCrosshair(axis: string, w: number, h: number, zoom: number, panX: number, panY: number, cw: number, ch: number) {
  const container = canvases[axis as keyof typeof canvases]?.parentElement;
  if (!container) return;
  const crosshair = container.querySelector('.crosshair') as HTMLDivElement;
  const crosshairH = container.querySelector('.crosshair-h') as HTMLDivElement;
  const crosshairV = container.querySelector('.crosshair-v') as HTMLDivElement;
  if (!crosshair || !crosshairH || !crosshairV) return;

  crosshair.style.display = crosshairVisible ? 'block' : 'none';
  if (!crosshairVisible || !header) return;

  const { nx, ny, nz } = header;

  // Get cursor position in voxel coordinates (this is the 3D position all views share)
  const cursorX = sliceIdx.sagittal;
  const cursorY = sliceIdx.coronal;
  const cursorZ = sliceIdx.axial;

  // Map 3D voxel cursor to 2D slice coordinates based on slice orientation
  // This follows ITK-SNAP's DisplayToAnatomy transform approach
  let sliceX: number, sliceY: number;

  if (axis === 'axial') {
    // Axial: shows XY plane, Z = sliceIdx.axial
    // cursorX = sagittal index, cursorY = coronal index
    // Display X = cursorX, Display Y = cursorY (but Y is flipped in canvas)
    sliceX = cursorX;
    sliceY = cursorY;
  } else if (axis === 'coronal') {
    // Coronal: shows XZ plane, Y = sliceIdx.coronal
    // Display X = cursorX (sagittal), Display Y = cursorZ (axial)
    sliceX = cursorX;
    sliceY = cursorZ;
  } else {
    // Sagittal: shows YZ plane, X = sliceIdx.sagittal
    // Display X = cursorY (coronal), Display Y = cursorZ (axial)
    sliceX = cursorY;
    sliceY = cursorZ;
  }

  // Normalize to 0-1 range for this slice
  const nx_axis = axis === 'sagittal' ? ny : nx;
  const ny_axis = axis === 'sagittal' ? nz : (axis === 'coronal' ? nz : ny);
  const cx_norm = sliceX / (nx_axis - 1 || 1);
  const cy_norm = sliceY / (ny_axis - 1 || 1);

  // Get container dimensions
  const containerRect = container.getBoundingClientRect();

  // Image display area calculation (same as paintSlice)
  const pixelW = axis === 'axial' ? nx * header.dx : axis === 'coronal' ? nx * header.dx : ny * header.dy;
  const pixelH = axis === 'axial' ? ny * header.dy : axis === 'coronal' ? nz * header.dz : nz * header.dz;
  const ar = pixelW / pixelH;
  let imgW: number, imgH: number;
  if (containerRect.width / containerRect.height > ar) { imgH = containerRect.height; imgW = imgH * ar; }
  else { imgW = containerRect.width; imgH = imgW / ar; }
  imgW *= zoom;
  imgH *= zoom;

  // Image position in container (centered)
  const imgLeft = (containerRect.width - imgW) / 2 + panX;
  const imgTop = (containerRect.height - imgH) / 2 + panY;

  // Crosshair position in screen coordinates
  // Canvas Y is flipped relative to anatomical Y
  const screenX = imgLeft + cx_norm * imgW;
  const screenY = imgTop + (1 - cy_norm) * imgH;

  crosshairH.style.top = screenY + 'px';
  crosshairV.style.left = screenX + 'px';
}

function updateScaleBar(axis: string, pixelW: number, pixelH: number, zoom: number, cw: number) {
  if (!header) return;
  const container = canvases[axis as keyof typeof canvases]?.parentElement;
  if (!container) return;
  const scaleBar = container.querySelector('.scale-bar') as HTMLDivElement;
  if (!scaleBar || cw <= 0) return;

  // pixelW and pixelH are already physical dimensions (nx*dx, ny*dy) in mm
  // cw is canvas CSS width (already scaled by zoom)
  // mmPerScreenPixel = physical width / canvas pixel width (without zoom)
  // Since cw already includes zoom, we need: mmPerScreenPixel = (pixelW * zoom) / cw
  const mmPerScreenPixel = (pixelW * zoom) / cw;

  const targetWidth = Math.min(50, cw * 0.35);
  const niceValues = [1, 2, 5, 10, 20, 50, 100, 200];

  const maxMm = targetWidth * mmPerScreenPixel;

  let barMm = 1;
  for (const v of niceValues) {
    if (v <= maxMm) barMm = v;
    else break;
  }

  const barPixels = barMm / mmPerScreenPixel;

  scaleBar.style.width = barPixels + 'px';
  const label = scaleBar.querySelector('span');
  if (label) {
    label.textContent = `${barMm}mm`;
  }
}

function updateMinimap(axis: string, w: number, h: number, zoom: number, panX: number, panY: number, cw: number, ch: number) {
  const container = canvases[axis as keyof typeof canvases]?.parentElement;
  if (!container) return;
  const minimap = container.querySelector('.minimap') as HTMLDivElement;
  const minimapCanvas = minimap?.querySelector('.minimap-canvas') as HTMLCanvasElement;
  const rect = minimap?.querySelector('.minimap-rect') as HTMLDivElement;
  if (!minimap || !rect) return;

  if (zoom <= 1.1) {
    minimap.classList.add('hidden');
    return;
  }
  minimap.classList.remove('hidden');

  const mw = minimap.clientWidth;
  const mh = minimap.clientHeight;
  
  if (minimapCanvas && header) {
    const sliceData = extractSlice(axis as 'axial' | 'coronal' | 'sagittal', sliceIdx[axis as keyof typeof sliceIdx]);
    if (sliceData && sliceData.length > 0) {
      const mctx = minimapCanvas.getContext('2d');
      if (mctx) {
        minimapCanvas.width = mw;
        minimapCanvas.height = mh;

        const imgData = mctx.createImageData(mw, mh);
        const pixels = imgData.data;
        const cmapFn = COLORMAPS[colormap] || COLORMAPS.gray;
        const lo = windowLevel - windowWidth * 0.5;
        const hi = windowLevel + windowWidth * 0.5;
        const range = hi - lo || 1;
        const dataRange = globalMax - globalMin || 1;

        for (let my = 0; my < mh; my++) {
          for (let mx = 0; mx < mw; mx++) {
            const sx = Math.floor((mx / mw) * w);
            // Apply Y-flip: minimap top shows slice bottom (same as paintSlice)
            const sy = h - 1 - Math.floor((my / mh) * h);
            const v = sliceData[sy * w + sx];
            const norm = (v - globalMin) / dataRange;
            const t = Math.max(0, Math.min(1, (norm - lo) / range));
            const [r, g, b] = cmapFn(t);
            const idx = (my * mw + mx) * 4;
            pixels[idx] = r; pixels[idx + 1] = g; pixels[idx + 2] = b; pixels[idx + 3] = 255;
          }
        }
        mctx.putImageData(imgData, 0, 0);
      }
    }
  }

  const rw = mw / zoom;
  const rh = mh / zoom;
  
  const maxPanX = (cw * zoom - cw) / 2;
  const maxPanY = (ch * zoom - ch) / 2;
  
  const normPanX = maxPanX > 0 ? (panX + maxPanX) / (2 * maxPanX) : 0.5;
  const normPanY = maxPanY > 0 ? (panY + maxPanY) / (2 * maxPanY) : 0.5;
  
  const rx = Math.max(0, Math.min(mw - rw, normPanX * mw - rw / 2));
  const ry = Math.max(0, Math.min(mh - rh, normPanY * mh - rh / 2));

  rect.style.width = rw + 'px';
  rect.style.height = rh + 'px';
  rect.style.left = rx + 'px';
  rect.style.top = ry + 'px';
}

function updateDirectionLabels(axis: string) {
  const container = canvases[axis as keyof typeof canvases]?.parentElement;
  if (!container) return;

  const labels = container.querySelectorAll('.dir-label');
  const labelsX = getCoordLabelX(axis);
  const labelsY = getCoordLabelY(axis);

  labels.forEach(label => {
    const el = label as HTMLElement;
    const pos = el.className.split(' ').find(c => c.startsWith('dir-'));
    if (pos === 'dir-l') el.textContent = labelsX.left;
    else if (pos === 'dir-r') el.textContent = labelsX.right;
    else if (pos === 'dir-a') el.textContent = labelsY.top;
    else if (pos === 'dir-p') el.textContent = labelsY.bottom;
  });
}

function updateAllDirectionLabels() {
  updateDirectionLabels('axial');
  updateDirectionLabels('coronal');
  updateDirectionLabels('sagittal');
}

function renderAllViews() {
  if (!header || !volumeData) return;
  const { nx, ny, nz, dx, dy, dz } = header;

  if (!compareMode) {
    ['axial', 'coronal', 'sagittal'].forEach(axis => {
      const label = document.getElementById(`overlay-label-${axis}`);
      if (label) label.style.display = 'none';
      const sbsL = document.getElementById(`sbs-l-${axis}`);
      const sbsR = document.getElementById(`sbs-r-${axis}`);
      if (sbsL) sbsL.style.display = 'none';
      if (sbsR) sbsR.style.display = 'none';
    });
  }

  if (compareMode && images.length >= 2) {
    renderCompareViews();
    return;
  }

  const axialPixelW = nx * dx;
  const axialPixelH = ny * dy;
  paintSlice('axial', extractSlice('axial', sliceIdx.axial), nx, ny, axialPixelW, axialPixelH);

  const coronalPixelW = nx * dx;
  const coronalPixelH = nz * dz;
  paintSlice('coronal', extractSlice('coronal', sliceIdx.coronal), nx, nz, coronalPixelW, coronalPixelH);

  const sagittalPixelW = ny * dy;
  const sagittalPixelH = nz * dz;
  paintSlice('sagittal', extractSlice('sagittal', sliceIdx.sagittal), ny, nz, sagittalPixelW, sagittalPixelH);

  paintMIP();

  updateAllInfo();
  if (crosshairVisible) updateCoordInfoFromCenter();
}

function updateCoordInfoFromCenter() {
  const coordEl = document.getElementById('coord-info');
  if (!coordEl || !header || !volumeData) return;

  const cx = sliceIdx.sagittal;
  const cy = sliceIdx.coronal;
  const cz = sliceIdx.axial;

  if (compareMode && images.length >= 2) {
    const img0 = images[0];
    const img1 = images[1];
    const h0 = img0.header;
    const h1 = img1.header;
    if (cx < 0 || cx >= h0.nx || cy < 0 || cy >= h0.ny || cz < 0 || cz >= h0.nz) {
      coordEl.textContent = '';
      return;
    }
    const v0 = img0.data[cz * h0.ny * h0.nx + cy * h0.nx + cx] * img0.slope + img0.inter;
    const [wx, wy, wz] = voxelToWorld(h0, cx, cy, cz);
    const [vx1, vy1, vz1] = worldToVoxel(h1, wx, wy, wz);
    const ix1 = Math.round(vx1), iy1 = Math.round(vy1), iz1 = Math.round(vz1);
    let v1 = '---';
    if (ix1 >= 0 && ix1 < h1.nx && iy1 >= 0 && iy1 < h1.ny && iz1 >= 0 && iz1 < h1.nz) {
      v1 = (img1.data[iz1 * h1.ny * h1.nx + iy1 * h1.nx + ix1] * img1.slope + img1.inter).toFixed(4);
    }
    coordEl.textContent = `x=${cx} y=${cy} z=${cz}\n${img0.name}: ${v0.toFixed(4)}\n${img1.name}: ${v1}`;
    return;
  }

  if (cx < 0 || cx >= header.nx || cy < 0 || cy >= header.ny || cz < 0 || cz >= header.nz) {
    coordEl.textContent = '';
    return;
  }
  const val = volumeData[cz * header.ny * header.nx + cy * header.nx + cx] * dataSlope + dataInter;
  coordEl.textContent = `x=${cx} y=${cy} z=${cz}\nValue: ${val.toFixed(4)}`;
}

function extractSliceFromImage(img: VolumeImage, axis: 'axial' | 'coronal' | 'sagittal', idx: number): Float32Array {
  const savedHeader = header;
  const savedData = volumeData;
  const savedSlope = dataSlope;
  const savedInter = dataInter;
  header = img.header;
  volumeData = img.data;
  dataSlope = img.slope;
  dataInter = img.inter;
  const maxIdx = axis === 'axial' ? img.header.nz - 1 : axis === 'coronal' ? img.header.ny - 1 : img.header.nx - 1;
  const slice = extractSlice(axis, Math.max(0, Math.min(maxIdx, idx)));
  header = savedHeader;
  volumeData = savedData;
  dataSlope = savedSlope;
  dataInter = savedInter;
  return slice;
}

function renderCompareViews() {
  if (images.length < 2) return;
  const img0 = images[0];
  const img1 = images[1];
  const h0 = img0.header;
  const h1 = img1.header;

  const [wx, wy, wz] = voxelToWorld(h0, sliceIdx.sagittal, sliceIdx.coronal, sliceIdx.axial);
  const [vx1, vy1, vz1] = worldToVoxel(h1, wx, wy, wz);
  const img1Idx = {
    axial: Math.max(0, Math.min(h1.nz - 1, Math.round(vz1))),
    coronal: Math.max(0, Math.min(h1.ny - 1, Math.round(vy1))),
    sagittal: Math.max(0, Math.min(h1.nx - 1, Math.round(vx1))),
  };

  const axes: ('axial' | 'coronal' | 'sagittal')[] = ['axial', 'coronal', 'sagittal'];
  for (const axis of axes) {
    const idx0 = axis === 'axial' ? sliceIdx.axial : axis === 'coronal' ? sliceIdx.coronal : sliceIdx.sagittal;
    const slice0 = extractSliceFromImage(img0, axis, idx0);
    const slice1 = extractSliceFromImage(img1, axis, img1Idx[axis]);
    const w0 = axis === 'sagittal' ? h0.ny : h0.nx;
    const h0_ = axis === 'axial' ? h0.ny : h0.nz;
    const pw0 = axis === 'sagittal' ? h0.ny * h0.dy : h0.nx * h0.dx;
    const ph0 = axis === 'axial' ? h0.ny * h0.dy : h0.nz * h0.dz;
    const w1 = axis === 'sagittal' ? h1.ny : h1.nx;
    const h1_ = axis === 'axial' ? h1.ny : h1.nz;
    const pw1 = axis === 'sagittal' ? h1.ny * h1.dy : h1.nx * h1.dx;
    const ph1 = axis === 'axial' ? h1.ny * h1.dy : h1.nz * h1.dz;

    if (compareLayout === 'sideBySide') {
      paintSideBySideSlice(axis, slice0, slice1, w0, h0_, w1, h1_, pw0, ph0, pw1, ph1, img0, img1);
    } else {
      paintOverlaySlice(axis, slice0, slice1, w0, h0_, w1, h1_, pw0, ph0, pw1, ph1, img0, img1);
    }

    const overlayLabel = document.getElementById(`overlay-label-${axis}`);
    if (overlayLabel) {
      overlayLabel.textContent = img1.name;
      overlayLabel.style.display = compareLayout === 'overlay' ? '' : 'none';
    }
    const sbsL = document.getElementById(`sbs-l-${axis}`);
    const sbsR = document.getElementById(`sbs-r-${axis}`);
    if (sbsL) { sbsL.textContent = img0.name; sbsL.style.display = compareLayout === 'sideBySide' ? '' : 'none'; }
    if (sbsR) { sbsR.textContent = img1.name; sbsR.style.display = compareLayout === 'sideBySide' ? '' : 'none'; }
  }
  paintMIP();
  updateAllInfo();
}

function renderSliceToTempCanvas(data: Float32Array, w: number, h: number, imgMin: number, imgMax: number, cmapName: string): HTMLCanvasElement {
  const tc = document.createElement('canvas');
  tc.width = w; tc.height = h;
  const tctx = tc.getContext('2d')!;
  const imgData = tctx.createImageData(w, h);
  const pixels = imgData.data;
  const cmapFn = COLORMAPS[cmapName] || COLORMAPS.gray;
  const lo = windowLevel - windowWidth * 0.5;
  const hi = windowLevel + windowWidth * 0.5;
  const range = hi - lo || 1;
  const dataRange = imgMax - imgMin || 1;
  const n = w * h;
  for (let i = 0; i < n; i++) {
    const norm = (data[i] - imgMin) / dataRange;
    const t = Math.max(0, Math.min(1, (norm - lo) / range));
    const [r, g, b] = cmapFn(t);
    const idx = i * 4;
    pixels[idx] = r; pixels[idx + 1] = g; pixels[idx + 2] = b; pixels[idx + 3] = 255;
  }
  tctx.putImageData(imgData, 0, 0);
  return tc;
}

function paintOverlaySlice(axis: string, data0: Float32Array, data1: Float32Array,
  w0: number, h0_: number, w1: number, h1_: number,
  pw0: number, ph0: number, pw1: number, ph1: number,
  img0: VolumeImage, img1: VolumeImage) {
  const canvas = canvases[axis as keyof typeof canvases];
  if (!canvas || !data0 || !data1) return;

  const vs = viewState[axis as keyof typeof viewState] as { zoom: number; panX: number; panY: number };
  const zoom = vs.zoom;
  const dpr = window.devicePixelRatio || 1;
  const container = canvas.parentElement!;
  const dw = container.clientWidth;
  const dh = container.clientHeight;
  if (dw === 0 || dh === 0) return;

  const ar0 = pw0 / ph0;
  let cw: number, ch: number;
  if (dw / dh > ar0) { ch = dh; cw = Math.floor(dh * ar0); }
  else { cw = dw; ch = Math.floor(dw / ar0); }
  cw = Math.floor(cw * zoom);
  ch = Math.floor(ch * zoom);

  canvas.style.width = cw + 'px';
  canvas.style.height = ch + 'px';
  canvas.width = cw * dpr;
  canvas.height = ch * dpr;

  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;

  const tc0 = renderSliceToTempCanvas(data0, w0, h0_, img0.min, img0.max, colormap);
  const tc1 = renderSliceToTempCanvas(data1, w1, h1_, img1.min, img1.max, overlayColormap);

  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const offsetX = (canvas.width - cw * dpr) / 2;
  const offsetY = (canvas.height + ch * dpr) / 2;

  ctx.save();
  ctx.translate(offsetX, offsetY);
  ctx.scale(cw * dpr / w0, -ch * dpr / h0_);
  ctx.globalAlpha = 1.0;
  ctx.drawImage(tc0, 0, 0);
  ctx.restore();

  ctx.save();
  ctx.translate(offsetX, offsetY);
  ctx.scale(cw * dpr / w1, -ch * dpr / h1_);
  ctx.globalAlpha = overlayOpacity;
  ctx.drawImage(tc1, 0, 0);
  ctx.restore();

  ctx.globalAlpha = 1.0;

  updateDirectionLabels(axis);
  updateCrosshair(axis, w0, h0_, zoom, vs.panX, vs.panY, cw, ch);
  updateScaleBar(axis, pw0, ph0, zoom, cw);
  updateMinimap(axis, w0, h0_, zoom, vs.panX, vs.panY, cw, ch);
}

function paintSideBySideSlice(axis: string, data0: Float32Array, data1: Float32Array,
  w0: number, h0_: number, w1: number, h1_: number,
  pw0: number, ph0: number, pw1: number, ph1: number,
  img0: VolumeImage, img1: VolumeImage) {
  const canvas = canvases[axis as keyof typeof canvases];
  if (!canvas || !data0 || !data1) return;

  const vs = viewState[axis as keyof typeof viewState] as { zoom: number; panX: number; panY: number };
  const zoom = vs.zoom;
  const dpr = window.devicePixelRatio || 1;
  const container = canvas.parentElement!;
  const dw = container.clientWidth;
  const dh = container.clientHeight;
  if (dw === 0 || dh === 0) return;

  const halfW = Math.floor(dw / 2);

  const ar0 = pw0 / ph0;
  let cw0: number, ch0: number;
  if (halfW / dh > ar0) { ch0 = dh; cw0 = Math.floor(dh * ar0); }
  else { cw0 = halfW; ch0 = Math.floor(halfW / ar0); }
  cw0 = Math.floor(cw0 * zoom);
  ch0 = Math.floor(ch0 * zoom);

  const ar1 = pw1 / ph1;
  let cw1: number, ch1: number;
  if (halfW / dh > ar1) { ch1 = dh; cw1 = Math.floor(dh * ar1); }
  else { cw1 = halfW; ch1 = Math.floor(halfW / ar1); }
  cw1 = Math.floor(cw1 * zoom);
  ch1 = Math.floor(ch1 * zoom);

  canvas.style.width = dw + 'px';
  canvas.style.height = dh + 'px';
  canvas.width = dw * dpr;
  canvas.height = dh * dpr;

  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;

  const tc0 = renderSliceToTempCanvas(data0, w0, h0_, img0.min, img0.max, colormap);
  const tc1 = renderSliceToTempCanvas(data1, w1, h1_, img1.min, img1.max, overlayColormap);

  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const offsetX0 = (halfW * dpr - cw0 * dpr) / 2;
  const offsetY0 = (dh * dpr + ch0 * dpr) / 2;
  ctx.save();
  ctx.translate(offsetX0, offsetY0);
  ctx.scale(cw0 * dpr / w0, -ch0 * dpr / h0_);
  ctx.drawImage(tc0, 0, 0);
  ctx.restore();

  const offsetX1 = halfW * dpr + (halfW * dpr - cw1 * dpr) / 2;
  const offsetY1 = (dh * dpr + ch1 * dpr) / 2;
  ctx.save();
  ctx.translate(offsetX1, offsetY1);
  ctx.scale(cw1 * dpr / w1, -ch1 * dpr / h1_);
  ctx.drawImage(tc1, 0, 0);
  ctx.restore();

  ctx.strokeStyle = 'rgba(233,69,96,0.7)';
  ctx.lineWidth = 2 * dpr;
  ctx.beginPath();
  ctx.moveTo(halfW * dpr, 0);
  ctx.lineTo(halfW * dpr, dh * dpr);
  ctx.stroke();

  if (crosshairVisible && img0.header) {
    const h0 = img0.header;
    const cursorX = sliceIdx.sagittal;
    const cursorY = sliceIdx.coronal;
    const cursorZ = sliceIdx.axial;
    let sliceX0: number, sliceY0: number;
    if (axis === 'axial') { sliceX0 = cursorX; sliceY0 = cursorY; }
    else if (axis === 'coronal') { sliceX0 = cursorX; sliceY0 = cursorZ; }
    else { sliceX0 = cursorY; sliceY0 = cursorZ; }
    const nx0 = axis === 'sagittal' ? h0.ny : h0.nx;
    const ny0 = axis === 'sagittal' ? h0.nz : (axis === 'coronal' ? h0.nz : h0.ny);
    const cx0 = sliceX0 / (nx0 - 1 || 1);
    const cy0 = sliceY0 / (ny0 - 1 || 1);

    const imgLeft0 = (halfW - cw0) / 2 - vs.panX;
    const imgTop0 = (dh - ch0) / 2 - vs.panY;
    const sx0 = (imgLeft0 + cx0 * cw0) * dpr;
    const sy0 = (imgTop0 + (1 - cy0) * ch0) * dpr;

    ctx.strokeStyle = 'rgba(255,0,0,0.6)';
    ctx.lineWidth = 1 * dpr;
    ctx.beginPath();
    ctx.moveTo(0, sy0); ctx.lineTo(halfW * dpr, sy0);
    ctx.moveTo(sx0, 0); ctx.lineTo(sx0, dh * dpr);
    ctx.stroke();

    const h1 = img1.header;
    const [wx, wy, wz] = voxelToWorld(h0, cursorX, cursorY, cursorZ);
    const [vx1, vy1, vz1] = worldToVoxel(h1, wx, wy, wz);
    let sliceX1: number, sliceY1: number;
    if (axis === 'axial') { sliceX1 = Math.round(vx1); sliceY1 = Math.round(vy1); }
    else if (axis === 'coronal') { sliceX1 = Math.round(vx1); sliceY1 = Math.round(vz1); }
    else { sliceX1 = Math.round(vy1); sliceY1 = Math.round(vz1); }
    const nx1 = axis === 'sagittal' ? h1.ny : h1.nx;
    const ny1 = axis === 'sagittal' ? h1.nz : (axis === 'coronal' ? h1.nz : h1.ny);
    const cx1 = Math.max(0, Math.min(1, sliceX1 / (nx1 - 1 || 1)));
    const cy1 = Math.max(0, Math.min(1, sliceY1 / (ny1 - 1 || 1)));

    const imgLeft1 = halfW + (halfW - cw1) / 2 - vs.panX;
    const imgTop1 = (dh - ch1) / 2 - vs.panY;
    const sx1 = (imgLeft1 + cx1 * cw1) * dpr;
    const sy1 = (imgTop1 + (1 - cy1) * ch1) * dpr;

    ctx.strokeStyle = 'rgba(255,200,0,0.6)';
    ctx.lineWidth = 1 * dpr;
    ctx.beginPath();
    ctx.moveTo(halfW * dpr, sy1); ctx.lineTo(dw * dpr, sy1);
    ctx.moveTo(sx1, 0); ctx.lineTo(sx1, dh * dpr);
    ctx.stroke();
  }

  const vc = canvas.parentElement!;
  const htmlCrosshair = vc.querySelector('.crosshair') as HTMLDivElement;
  if (htmlCrosshair) htmlCrosshair.style.display = 'none';

  updateDirectionLabels(axis);
  updateScaleBar(axis, pw0, ph0, zoom, cw0);
  updateMinimap(axis, w0, h0_, zoom, vs.panX, vs.panY, cw0, ch0);
}

function paintMIP() {
  if (!header || !volumeData) return;
  const { nx, ny, nz, dx, dy, dz } = header;
  const mipData = computeMIP(viewState.mip.rotationX, viewState.mip.rotationY);

  // Apply same scale correction as scale bar for anisotropic voxels
  const scaleCorr = dz / Math.sqrt(dx * dy);
  const pixelW = nx * dx * scaleCorr;
  const pixelH = ny * dy;

  const canvas = canvases.mip;
  const dpr = window.devicePixelRatio || 1;
  const container = canvas.parentElement!;
  const dw = container.clientWidth;
  const dh = container.clientHeight;
  if (dw === 0 || dh === 0) return;

  const ar = pixelW / pixelH;
  let cw: number, ch: number;
  if (dw / dh > ar) { ch = dh; cw = Math.floor(dh * ar); }
  else { cw = dw; ch = Math.floor(dw / ar); }

  canvas.style.width = cw + 'px';
  canvas.style.height = ch + 'px';
  canvas.width = cw * dpr;
  canvas.height = ch * dpr;

  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;

  const imgData = ctx.createImageData(nx, ny);
  const pixels = imgData.data;
  const cmapFn = COLORMAPS[colormap] || COLORMAPS.gray;
  const lo = windowLevel - windowWidth * 0.5;
  const hi = windowLevel + windowWidth * 0.5;
  const range = hi - lo || 1;
  const dataRange = globalMax - globalMin || 1;

  for (let i = 0; i < nx * ny; i++) {
    const norm = (mipData[i] - globalMin) / dataRange;
    const t = Math.max(0, Math.min(1, (norm - lo) / range));
    const [r, g, b] = cmapFn(t);
    const idx = i * 4;
    pixels[idx] = r; pixels[idx + 1] = g; pixels[idx + 2] = b; pixels[idx + 3] = 255;
  }

  const tc = document.createElement('canvas');
  tc.width = nx; tc.height = ny;
  const tctx = tc.getContext('2d')!;
  tctx.putImageData(imgData, 0, 0);
  
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(tc, 0, 0, canvas.width, canvas.height);
}

function updateSingleView(axis: 'axial' | 'coronal' | 'sagittal') {
  if (!header || !volumeData) return;
  const { nx, ny, nz, dx, dy, dz } = header;

  if (axis === 'axial') {
    paintSlice('axial', extractSlice('axial', sliceIdx.axial), nx, ny, nx * dx, ny * dy);
  } else if (axis === 'coronal') {
    paintSlice('coronal', extractSlice('coronal', sliceIdx.coronal), nx, nz, nx * dx, nz * dz);
  } else {
    paintSlice('sagittal', extractSlice('sagittal', sliceIdx.sagittal), ny, nz, ny * dy, nz * dz);
  }

  updateSliceInfo(axis);
  updateSliderValues();
  if (crosshairVisible) updateCoordInfoFromCenter();
}

function updateAllInfo() {
  if (!header) return;
  updateSliceInfo('axial');
  updateSliceInfo('coronal');
  updateSliceInfo('sagittal');
  updateSliderValues();
}

function updateSliceInfo(axis: 'axial' | 'coronal' | 'sagittal') {
  if (!header) return;
  const el = document.getElementById(`${axis}-info`);
  if (!el) return;
  const max = axis === 'axial' ? header.nz : axis === 'coronal' ? header.ny : header.nx;
  el.textContent = `${sliceIdx[axis] + 1}/${max}`;
}

function updateSliderValues() {
  if (!header) return;

  const sliders = [
    { axis: 'axial', slider: 'axial-slider', sideSlider: 'axial-slider-side', val: 'axial-val', max: header.nz - 1 },
    { axis: 'coronal', slider: 'coronal-slider', sideSlider: 'coronal-slider-side', val: 'coronal-val', max: header.ny - 1 },
    { axis: 'sagittal', slider: 'sagittal-slider', sideSlider: 'sagittal-slider-side', val: 'sagittal-val', max: header.nx - 1 },
  ];

  for (const s of sliders) {
    const sl = document.getElementById(s.slider) as HTMLInputElement;
    const ssl = document.getElementById(s.sideSlider) as HTMLInputElement;
    const vl = document.getElementById(s.val) as HTMLSpanElement;
    if (sl) { sl.max = String(s.max); sl.value = String(sliceIdx[s.axis as keyof typeof sliceIdx]); }
    if (ssl) { ssl.max = String(s.max); ssl.value = String(sliceIdx[s.axis as keyof typeof sliceIdx]); }
    if (vl) vl.textContent = String(sliceIdx[s.axis as keyof typeof sliceIdx]);
  }
}

function updateFileInfo() {
  if (!header) return;
  const { nx, ny, nz, nt, dx, dy, dz, datatype, isGzip: gz } = header;
  const dtName = DATATYPE_NAMES[datatype] ?? `dt=${datatype}`;

  const fileNameEl = document.getElementById('file-name') as HTMLSpanElement;
  const fileDetailEl = document.getElementById('file-detail') as HTMLDivElement;

  if (fileNameEl) fileNameEl.textContent = fileName;
  if (fileDetailEl) {
    fileDetailEl.innerHTML = `
      <span>${nx}×${ny}×${nz}${nt > 1 ? `×${nt}` : ''}</span>
      <span>${dx.toFixed(2)}×${dy.toFixed(2)}×${dz.toFixed(2)}mm</span>
      <span>${dtName}${gz ? ' (gz)' : ''}</span>
    `;
  }
}

function autoContrast() {
  if (!volumeData || globalMin === globalMax) return;

  const n = volumeData.length;
  const sampleSize = Math.min(10000, n);
  const step = Math.max(1, Math.floor(n / sampleSize));
  const samples: number[] = [];

  for (let i = 0; i < n; i += step) {
    samples.push(volumeData[i]);
  }
  samples.sort((a, b) => a - b);

  const p1Idx = Math.floor(samples.length * 0.01);
  const p99Idx = Math.floor(samples.length * 0.99);
  const p1 = samples[p1Idx];
  const p99 = samples[p99Idx];

  const range = globalMax - globalMin || 1;
  windowLevel = ((p1 + p99) / 2 - globalMin) / range;
  windowWidth = (p99 - p1) / range;

  const wwSlider = document.getElementById('ww-slider') as HTMLInputElement;
  const wlSlider = document.getElementById('wl-slider') as HTMLInputElement;
  if (wwSlider) wwSlider.value = String(Math.round(windowWidth * 100));
  if (wlSlider) wlSlider.value = String(Math.round(windowLevel * 100));

  renderAllViews();
}

function resetViews() {
  sliceIdx.axial = Math.floor((header?.nz || 1) / 2);
  sliceIdx.coronal = Math.floor((header?.ny || 1) / 2);
  sliceIdx.sagittal = Math.floor((header?.nx || 1) / 2);

  viewState.axial = { zoom: 1, panX: 0, panY: 0 };
  viewState.coronal = { zoom: 1, panX: 0, panY: 0 };
  viewState.sagittal = { zoom: 1, panX: 0, panY: 0 };
  viewState.mip = { rotationX: 0, rotationY: 0 };

  windowWidth = initialWindowWidth;
  windowLevel = initialWindowLevel;

  const wwSlider = document.getElementById('ww-slider') as HTMLInputElement;
  const wlSlider = document.getElementById('wl-slider') as HTMLInputElement;
  if (wwSlider) wwSlider.value = String(Math.round(windowWidth * 100));
  if (wlSlider) wlSlider.value = String(Math.round(windowLevel * 100));

  renderAllViews();
}

function toggleMaximize(view: string) {
  if (compareMode && compareLayout === 'sideBySide') return;
  const viewsContainer = document.getElementById('views') as HTMLDivElement;
  const viewContainers = document.querySelectorAll('.vc');

  if (maximizedView === view) {
    maximizedView = null;
    viewsContainer.classList.remove('single-view');
    viewContainers.forEach(vc => vc.classList.remove('hidden'));
  } else {
    maximizedView = view;
    viewsContainer.classList.add('single-view');
    viewContainers.forEach(vc => {
      if (vc.id === `${view}-c`) {
        vc.classList.remove('hidden');
      } else {
        vc.classList.add('hidden');
      }
    });
  }

  requestAnimationFrame(() => renderAllViews());
}

window.addEventListener('DOMContentLoaded', () => {
  vscode.postMessage({ type: 'ready' });
});

window.addEventListener('message', async (e) => {
  const msg = e.data;

  if (msg.type === 'newImage') {
    // Load new image from file picker result
    loadNewImage(msg.fileUrl, msg.fileName, msg.isGzip);
    return;
  }

  if (msg.type !== 'config') return;

  fileUrl = msg.fileUrl;
  fileName = msg.fileName;
  isGzip = fileName.endsWith('.gz');
  colormap = msg.defaultColormap || 'gray';

  const cmapSelect = document.getElementById('colormap') as HTMLSelectElement;
  if (cmapSelect && msg.defaultColormap) cmapSelect.value = msg.defaultColormap;

  try {
    loadingText.textContent = 'Loading preview...';
    updateProgress(0.01, 'Fetching preview...', 'Preview');

    const worker = await getWorker();
    worker.onerror = (err) => { loadingText.textContent = 'Worker error: ' + (err.message || 'unknown'); };

    const previewUrl = fileUrl.replace('/file/', '/preview/');
    try {
      const previewResp = await fetch(previewUrl);
      if (previewResp.ok) {
        const previewData = await previewResp.json();
        if (previewData && previewData.header && previewData.slices) {
          header = previewData.header;
          globalMin = previewData.globalMin;
          globalMax = previewData.globalMax;
          dataSlope = previewData.slope || 1;
          dataInter = previewData.inter || 0;

          sliceIdx.axial = previewData.sliceIdx.axial;
          sliceIdx.coronal = previewData.sliceIdx.coronal;
          sliceIdx.sagittal = previewData.sliceIdx.sagittal;

          autoContrast();
          initialWindowWidth = windowWidth;
          initialWindowLevel = windowLevel;

          const h = header!;
          paintSlice('axial', new Float32Array(previewData.slices.axial), h.nx, h.ny, h.nx * h.dx, h.ny * h.dy);
          paintSlice('coronal', new Float32Array(previewData.slices.coronal), h.nx, h.nz, h.nx * h.dx, h.nz * h.dz);
          paintSlice('sagittal', new Float32Array(previewData.slices.sagittal), h.ny, h.nz, h.ny * h.dy, h.nz * h.dz);

          updateFileInfo();
          updateSliderValues();

          loading.style.display = 'none';
          updateProgress(0.5);
          setupInteraction();

          loadFullVolume(worker);
          return;
        }
      }
    } catch (_) {}

    loadFullVolume(worker);
  } catch (err: any) {
    loadingText.textContent = 'Error: ' + (err?.message ?? String(err));
  }
});

async function loadFullVolume(worker: Worker) {
  worker.onmessage = (ev) => {
    const d = ev.data;
    if (d.type === 'progress') {
      updateProgress(0.5 + d.value * 0.5, undefined, d.stage ? `${d.stage}...` : undefined);
      return;
    }
    if (d.type === 'error') {
      const loadingText = document.getElementById('loading-text');
      if (loadingText) loadingText.textContent = 'Error: ' + d.error;
      return;
    }
    if (d.type === 'preview') {
      if (!header) {
        header = d.header;
        globalMin = d.globalMin;
        globalMax = d.globalMax;
        dataSlope = d.slope || 1;
        dataInter = d.inter || 0;

        sliceIdx.axial = d.sliceIdx.axial;
        sliceIdx.coronal = d.sliceIdx.coronal;
        sliceIdx.sagittal = d.sliceIdx.sagittal;

        autoContrast();
        initialWindowWidth = windowWidth;
        initialWindowLevel = windowLevel;

        const h = d.header;
        paintSlice('axial', d.slices.axial, h.nx, h.ny, h.nx * h.dx, h.ny * h.dy);
        paintSlice('coronal', d.slices.coronal, h.nx, h.nz, h.nx * h.dx, h.nz * h.dz);
        paintSlice('sagittal', d.slices.sagittal, h.ny, h.nz, h.ny * h.dy, h.nz * h.dz);

        updateFileInfo();
        updateSliderValues();

        const loading = document.getElementById('loading');
        if (loading) loading.style.display = 'none';
        setupInteraction();
      }
      return;
    }
    if (d.type === 'volume') {
      volumeData = d.voxelData;

      images.length = 0;
      images.push({ header: d.header, data: d.voxelData, min: d.globalMin, max: d.globalMax, name: fileName, url: fileUrl, slope: d.slope || 1, inter: d.inter || 0 });
      activeImageIdx = 0;

      updateImagePicker();
      updateProgress(1.0);
      renderAllViews();
      return;
    }
  };

  worker.postMessage({ id: 0, type: 'loadVolume', url: fileUrl, isGzip });
}

function updateProgress(value: number, text?: string, detail?: string) {
  progress.style.width = `${Math.min(100, value * 100)}%`;
  if (text !== undefined) loadingText.textContent = text;
  if (detail !== undefined) loadingDetail.textContent = detail;
}

function switchToImage(idx: number) {
  if (idx < 0 || idx >= images.length) return;

  const prevHeader = header;
  const prevSliceIdx = { ...sliceIdx };

  activeImageIdx = idx;
  const img = images[idx];
  header = img.header;
  volumeData = img.data;
  dataSlope = img.slope;
  dataInter = img.inter;
  globalMin = img.min;
  globalMax = img.max;
  fileName = img.name;

  if (header) {
    if (prevHeader && images.length > 1) {
      const [wx, wy, wz] = voxelToWorld(prevHeader, prevSliceIdx.sagittal, prevSliceIdx.coronal, prevSliceIdx.axial);
      const [vx, vy, vz] = worldToVoxel(header, wx, wy, wz);
      sliceIdx.sagittal = Math.max(0, Math.min(header.nx - 1, Math.round(vx)));
      sliceIdx.coronal = Math.max(0, Math.min(header.ny - 1, Math.round(vy)));
      sliceIdx.axial = Math.max(0, Math.min(header.nz - 1, Math.round(vz)));
    } else {
      sliceIdx.axial = Math.min(sliceIdx.axial, header.nz - 1);
      sliceIdx.coronal = Math.min(sliceIdx.coronal, header.ny - 1);
      sliceIdx.sagittal = Math.min(sliceIdx.sagittal, header.nx - 1);
    }
  }
  viewState.axial = { zoom: 1, panX: 0, panY: 0 };
  viewState.coronal = { zoom: 1, panX: 0, panY: 0 };
  viewState.sagittal = { zoom: 1, panX: 0, panY: 0 };
  viewState.mip = { rotationX: 0, rotationY: 0 };

  autoContrast();
  initialWindowWidth = windowWidth;
  initialWindowLevel = windowLevel;

  updateFileInfo();
  updateSliderValues();
  updateImagePicker();
  renderAllViews();
}

function updateImagePicker() {
  const picker = document.getElementById('image-list');
  if (!picker) return;
  picker.innerHTML = '';
  images.forEach((img, idx) => {
    const item = document.createElement('div');
    item.className = 'image-item' + (idx === activeImageIdx ? ' active' : '');

    // Create thumbnail
    const thumb = document.createElement('div');
    thumb.className = 'image-item-thumb';
    const thumbCanvas = document.createElement('canvas');
    thumb.appendChild(thumbCanvas);
    item.appendChild(thumb);

    // Create name
    const name = document.createElement('span');
    name.className = 'image-item-name';
    name.textContent = img.name;
    name.title = img.name;
    item.appendChild(name);

    // Create remove button (only if more than 1 image)
    if (images.length > 1) {
      const remove = document.createElement('div');
      remove.className = 'image-item-remove';
      remove.textContent = '×';
      remove.title = 'Remove image';
      remove.addEventListener('click', (e) => {
        e.stopPropagation();
        if (images.length > 1) {
          images.splice(idx, 1);
          if (activeImageIdx >= images.length) activeImageIdx = images.length - 1;
          switchToImage(activeImageIdx);
        }
      });
      item.appendChild(remove);
    }

    item.addEventListener('click', () => switchToImage(idx));
    picker.appendChild(item);

    // Render thumbnail
    renderThumbnail(thumbCanvas, img);
  });
}

function renderThumbnail(canvas: HTMLCanvasElement, img: VolumeImage) {
  if (!img.header || !img.data) return;
  const { nx, ny, nz } = img.header;
  const sliceIdx = Math.floor(nz / 2);
  const slice = new Float32Array(nx * ny);
  const base = sliceIdx * nx * ny;
  const s = img.slope, t = img.inter;
  const needScale = s !== 1 || t !== 0;
  if (needScale) {
    for (let i = 0; i < nx * ny; i++) slice[i] = img.data[base + i] * s + t;
  } else {
    for (let i = 0; i < nx * ny; i++) slice[i] = img.data[base + i];
  }

  const dpr = 2;
  canvas.width = 32 * dpr;
  canvas.height = 32 * dpr;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;

  const w = nx, h = ny;
  const imgData = ctx.createImageData(w, h);
  const pixels = imgData.data;
  const cmapFn = COLORMAPS[colormap] || COLORMAPS.gray;
  const lo = windowLevel - windowWidth * 0.5;
  const hi = windowLevel + windowWidth * 0.5;
  const range = hi - lo || 1;
  const dataRange = img.max - img.min || 1;

  for (let i = 0; i < w * h; i++) {
    const norm = (slice[i] - img.min) / dataRange;
    const t = Math.max(0, Math.min(1, (norm - lo) / range));
    const [r, g, b] = cmapFn(t);
    const idx = i * 4;
    pixels[idx] = r; pixels[idx + 1] = g; pixels[idx + 2] = b; pixels[idx + 3] = 255;
  }

  const tc = document.createElement('canvas');
  tc.width = w; tc.height = h;
  const tctx = tc.getContext('2d')!;
  tctx.putImageData(imgData, 0, 0);

  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.save();
  ctx.translate(0, canvas.height);
  ctx.scale(32 * dpr / w, -32 * dpr / h);
  ctx.drawImage(tc, 0, 0);
  ctx.restore();
}

async function loadNewImage(url: string, name: string, gz: boolean) {
  try {
    const worker = await getWorker();

    worker.onmessage = (ev) => {
      const d = ev.data;
      if (d.type === 'progress') return;
      if (d.type === 'error') {
        console.error('Failed to load image:', d.error);
        return;
      }
      if (d.type === 'volume') {
        images.push({ header: d.header, data: d.voxelData, min: d.globalMin, max: d.globalMax, name, url, slope: d.slope || 1, inter: d.inter || 0 });
        switchToImage(images.length - 1);
      }
    };

    worker.postMessage({ id: images.length, type: 'loadVolume', url, isGzip: gz });
  } catch (err) {
    console.error('Failed to load image:', err);
  }
}

function setupInteraction() {
  if (!header) return;

  const wwSlider = document.getElementById('ww-slider') as HTMLInputElement;
  const wlSlider = document.getElementById('wl-slider') as HTMLInputElement;
  const cmapSelect = document.getElementById('colormap') as HTMLSelectElement;
  const btnAuto = document.getElementById('btn-auto') as HTMLButtonElement;
  const btnReset = document.getElementById('btn-reset') as HTMLButtonElement;
  const helpBtn = document.getElementById('help-btn') as HTMLDivElement;
  const helpPopup = document.getElementById('help-popup') as HTMLDivElement;
  const sidebarToggle = document.getElementById('sidebar-toggle') as HTMLDivElement;
  const sidebar = document.getElementById('sidebar') as HTMLDivElement;
  const sidebarResize = document.getElementById('sidebar-resize') as HTMLDivElement;

  let renderTimer: number | null = null;
  const scheduleRender = () => {
    if (renderTimer) cancelAnimationFrame(renderTimer);
    renderTimer = requestAnimationFrame(() => { renderAllViews(); renderTimer = null; });
  };

  wwSlider?.addEventListener('input', () => { windowWidth = Number(wwSlider.value) / 100; scheduleRender(); });
  wlSlider?.addEventListener('input', () => { windowLevel = Number(wlSlider.value) / 100; scheduleRender(); });
  cmapSelect?.addEventListener('change', () => { colormap = cmapSelect.value; scheduleRender(); });
  btnAuto?.addEventListener('click', autoContrast);
  btnReset?.addEventListener('click', resetViews);

  const btnFit = document.getElementById('btn-fit') as HTMLButtonElement;
  btnFit?.addEventListener('click', () => {
    viewState.axial = { zoom: 1, panX: 0, panY: 0 };
    viewState.coronal = { zoom: 1, panX: 0, panY: 0 };
    viewState.sagittal = { zoom: 1, panX: 0, panY: 0 };
    renderAllViews();
  });

  const btnCompare = document.getElementById('btn-compare') as HTMLButtonElement;
  btnCompare?.addEventListener('click', () => {
    if (images.length < 2) return;
    if (!compareMode) {
      compareMode = true;
      compareLayout = 'overlay';
    } else if (compareLayout === 'overlay') {
      compareLayout = 'sideBySide';
    } else {
      compareMode = false;
      compareLayout = 'overlay';
    }
    btnCompare.classList.toggle('active', compareMode);
    btnCompare.textContent = !compareMode ? '⊞ Compare' : compareLayout === 'overlay' ? '◑ Overlay' : '◫ SBS';
    const overlayControls = document.getElementById('overlay-controls');
    if (overlayControls) overlayControls.style.display = compareMode ? 'block' : 'none';
    if (compareMode) {
      const img0 = images[0];
      header = img0.header;
      volumeData = img0.data;
      dataSlope = img0.slope;
      dataInter = img0.inter;
      globalMin = img0.min;
      globalMax = img0.max;
      activeImageIdx = 0;
      sliceIdx.axial = Math.min(sliceIdx.axial, img0.header.nz - 1);
      sliceIdx.coronal = Math.min(sliceIdx.coronal, img0.header.ny - 1);
      sliceIdx.sagittal = Math.min(sliceIdx.sagittal, img0.header.nx - 1);
      updateImagePicker();
      updateFileInfo();
      updateSliderValues();
    }
    renderAllViews();
  });

  const opacitySlider = document.getElementById('opacity-slider') as HTMLInputElement;
  const opacityVal = document.getElementById('opacity-val');
  opacitySlider?.addEventListener('input', () => {
    overlayOpacity = parseInt(opacitySlider.value) / 100;
    if (opacityVal) opacityVal.textContent = opacitySlider.value;
    if (compareMode) renderAllViews();
  });

  const overlayCmapSelect = document.getElementById('overlay-colormap') as HTMLSelectElement;
  overlayCmapSelect?.addEventListener('change', () => {
    overlayColormap = overlayCmapSelect.value;
    if (compareMode) renderAllViews();
  });

  const btnAddImg = document.getElementById('btn-add-img') as HTMLButtonElement;
  btnAddImg?.addEventListener('click', () => {
    vscode.postMessage({ type: 'selectImage' });
  });

  const btnCrosshair = document.getElementById('btn-crosshair') as HTMLButtonElement;
  btnCrosshair?.addEventListener('click', () => {
    crosshairVisible = !crosshairVisible;
    btnCrosshair.classList.toggle('active', crosshairVisible);
    const coordEl = document.getElementById('coord-info');
    if (crosshairVisible) updateCoordInfoFromCenter();
    else if (coordEl) coordEl.textContent = 'Hover over image';
    renderAllViews();
  });
  if (crosshairVisible) btnCrosshair?.classList.add('active');

  helpBtn?.addEventListener('click', () => helpPopup.classList.toggle('show'));
  document.addEventListener('click', (e) => {
    if (!helpBtn?.contains(e.target as Node) && !helpPopup?.contains(e.target as Node)) {
      helpPopup?.classList.remove('show');
    }
  });

  sidebarToggle?.addEventListener('click', () => {
    sidebarCollapsed = !sidebarCollapsed;
    if (sidebarCollapsed) {
      sidebarWidth = sidebar.offsetWidth;
      sidebar.style.width = '';
      sidebar.style.minWidth = '';
      sidebar.classList.add('collapsed');
      sidebarToggle.style.right = '0px';
    } else {
      sidebar.classList.remove('collapsed');
      sidebar.style.width = sidebarWidth + 'px';
      sidebar.style.minWidth = sidebarWidth + 'px';
      sidebarToggle.style.right = sidebarWidth + 'px';
    }
    sidebarToggle.textContent = sidebarCollapsed ? '◀' : '▶';
    renderAllViews();
  });

  let isResizing = false;
  let startX = 0;
  let startWidth = 0;

  sidebarResize?.addEventListener('mousedown', (e) => {
    isResizing = true;
    startX = e.clientX;
    startWidth = sidebar.offsetWidth;
    sidebar.style.transition = 'none';
    sidebarToggle.style.transition = 'none';
    document.body.style.cursor = 'ew-resize';
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!isResizing) return;
    const newWidth = Math.max(120, Math.min(400, startWidth - (e.clientX - startX)));
    sidebar.style.width = newWidth + 'px';
    sidebar.style.minWidth = newWidth + 'px';
    sidebarWidth = newWidth;
    sidebarToggle.style.right = newWidth + 'px';
  });

  document.addEventListener('mouseup', () => {
    if (isResizing) {
      isResizing = false;
      sidebar.style.transition = '';
      sidebarToggle.style.transition = '';
      document.body.style.cursor = '';
      renderAllViews();
    }
  });

  const bindSlider = (sliderId: string, sideSliderId: string, axis: 'axial' | 'coronal' | 'sagittal') => {
    const handler = (val: number) => { sliceIdx[axis] = val; updateSingleView(axis); };
    const sl = document.getElementById(sliderId) as HTMLInputElement;
    const ssl = document.getElementById(sideSliderId) as HTMLInputElement;
    sl?.addEventListener('input', () => handler(parseInt(sl.value)));
    ssl?.addEventListener('input', () => handler(parseInt(ssl.value)));
  };

  bindSlider('axial-slider', 'axial-slider-side', 'axial');
  bindSlider('coronal-slider', 'coronal-slider-side', 'coronal');
  bindSlider('sagittal-slider', 'sagittal-slider-side', 'sagittal');

  document.querySelectorAll('.vb').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const view = (e.target as HTMLElement).getAttribute('data-view');
      if (view) toggleMaximize(view);
    });
  });

  for (const axis of ['axial', 'coronal', 'sagittal'] as const) {
    const canvas = canvases[axis];

    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (!header) return;
      
      if (e.ctrlKey || e.metaKey) {
        const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;
        viewState[axis].zoom = Math.max(0.5, Math.min(10, viewState[axis].zoom * zoomFactor));
        renderAllViews();
      } else {
        const delta = e.deltaY > 0 ? 1 : -1;
        const max = axis === 'axial' ? header.nz - 1 : axis === 'coronal' ? header.ny - 1 : header.nx - 1;
        const newIdx = Math.max(0, Math.min(max, sliceIdx[axis] + delta));
        if (newIdx !== sliceIdx[axis]) {
          sliceIdx[axis] = newIdx;
          renderAllViews();
        }
      }
    }, { passive: false });

    let isDragging = false;
    let lastX = 0, lastY = 0;
    let dragStartX = 0, dragStartY = 0;
    let dragMoved = false;
    let suppressClickUntil = 0;
    let isPinching = false;
    let lastPinchDist = 0;

    canvas.addEventListener('mousedown', (e) => {
      if (e.button === 0) {
        isDragging = true;
        lastX = e.clientX;
        lastY = e.clientY;
        dragStartX = e.clientX;
        dragStartY = e.clientY;
        dragMoved = false;
        canvas.style.cursor = 'grabbing';
      }
    });

    document.addEventListener('mousemove', (e) => {
      if (isDragging) {
        const dx = e.clientX - lastX;
        const dy = e.clientY - lastY;
        viewState[axis].panX += dx;
        viewState[axis].panY += dy;
        if (Math.abs(e.clientX - dragStartX) > 3 || Math.abs(e.clientY - dragStartY) > 3) {
          dragMoved = true;
        }
        lastX = e.clientX;
        lastY = e.clientY;
        updateSingleView(axis);
      }
    });

    document.addEventListener('mouseup', () => {
      if (isDragging) {
        isDragging = false;
        canvas.style.cursor = 'crosshair';
        if (dragMoved) suppressClickUntil = Date.now() + 180;
      }
    });

    canvas.addEventListener('touchstart', (e) => {
      if (e.touches.length === 2) {
        isPinching = true;
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        lastPinchDist = Math.sqrt(dx * dx + dy * dy);
      } else if (e.touches.length === 1) {
        isDragging = true;
        lastX = e.touches[0].clientX;
        lastY = e.touches[0].clientY;
        dragStartX = lastX;
        dragStartY = lastY;
        dragMoved = false;
      }
    }, { passive: true });

    canvas.addEventListener('touchmove', (e) => {
      if (isPinching && e.touches.length === 2) {
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const scale = dist / lastPinchDist;
        viewState[axis].zoom = Math.max(0.5, Math.min(10, viewState[axis].zoom * scale));
        lastPinchDist = dist;
        updateSingleView(axis);
      } else if (isDragging && e.touches.length === 1) {
        const dx = e.touches[0].clientX - lastX;
        const dy = e.touches[0].clientY - lastY;
        viewState[axis].panX += dx;
        viewState[axis].panY += dy;
        if (Math.abs(e.touches[0].clientX - dragStartX) > 3 || Math.abs(e.touches[0].clientY - dragStartY) > 3) {
          dragMoved = true;
        }
        lastX = e.touches[0].clientX;
        lastY = e.touches[0].clientY;
        updateSingleView(axis);
      }
    }, { passive: true });

    canvas.addEventListener('touchend', () => {
      if (isDragging && dragMoved) suppressClickUntil = Date.now() + 180;
      isDragging = false;
      isPinching = false;
    });

    canvas.addEventListener('click', (e) => {
      if (Date.now() < suppressClickUntil) return;
      if (!header) return;
      const rect = canvas.getBoundingClientRect();
      const clickX = e.clientX - rect.left;
      const clickY = e.clientY - rect.top;

      if (compareMode && compareLayout === 'sideBySide' && images.length >= 2) {
        const img0 = images[0];
        const img1 = images[1];
        const h0 = img0.header;
        const h1 = img1.header;
        const halfW = rect.width / 2;
        const vs = viewState[axis];
        const isRight = clickX >= halfW;

        if (isRight) {
          const pw1 = axis === 'sagittal' ? h1.ny * h1.dy : h1.nx * h1.dx;
          const ph1 = axis === 'axial' ? h1.ny * h1.dy : h1.nz * h1.dz;
          const ar1 = pw1 / ph1;
          let cw1: number, ch1: number;
          if (halfW / rect.height > ar1) { ch1 = rect.height; cw1 = ch1 * ar1; }
          else { cw1 = halfW; ch1 = cw1 / ar1; }
          cw1 *= vs.zoom; ch1 *= vs.zoom;
          const imgLeft1 = halfW + (halfW - cw1) / 2 + vs.panX;
          const imgTop1 = (rect.height - ch1) / 2 + vs.panY;
          if (clickX < imgLeft1 || clickX > imgLeft1 + cw1 || clickY < imgTop1 || clickY > imgTop1 + ch1) return;
          const nx_click = (clickX - imgLeft1) / cw1;
          const ny_click = (clickY - imgTop1) / ch1;
          const w1 = axis === 'sagittal' ? h1.ny : h1.nx;
          const h1_ = axis === 'axial' ? h1.ny : h1.nz;
          let vx: number, vy: number, vz: number;
          if (axis === 'axial') { vx = nx_click * w1; vy = (1 - ny_click) * h1_; vz = sliceIdx.axial; }
          else if (axis === 'coronal') { vx = nx_click * w1; vy = sliceIdx.coronal; vz = (1 - ny_click) * h1_; }
          else { vx = sliceIdx.sagittal; vy = nx_click * w1; vz = (1 - ny_click) * h1_; }
          const [wx, wy, wz] = voxelToWorld(h1, vx, vy, vz);
          const [svx, svy, svz] = worldToVoxel(h0, wx, wy, wz);
          sliceIdx.sagittal = Math.max(0, Math.min(h0.nx - 1, Math.round(svx)));
          sliceIdx.coronal = Math.max(0, Math.min(h0.ny - 1, Math.round(svy)));
          sliceIdx.axial = Math.max(0, Math.min(h0.nz - 1, Math.round(svz)));
        } else {
          const pw0 = axis === 'sagittal' ? h0.ny * h0.dy : h0.nx * h0.dx;
          const ph0 = axis === 'axial' ? h0.ny * h0.dy : h0.nz * h0.dz;
          const ar0 = pw0 / ph0;
          let cw0: number, ch0: number;
          if (halfW / rect.height > ar0) { ch0 = rect.height; cw0 = ch0 * ar0; }
          else { cw0 = halfW; ch0 = cw0 / ar0; }
          cw0 *= vs.zoom; ch0 *= vs.zoom;
          const imgLeft0 = (halfW - cw0) / 2 + vs.panX;
          const imgTop0 = (rect.height - ch0) / 2 + vs.panY;
          if (clickX < imgLeft0 || clickX > imgLeft0 + cw0 || clickY < imgTop0 || clickY > imgTop0 + ch0) return;
          const nx_click = (clickX - imgLeft0) / cw0;
          const ny_click = (clickY - imgTop0) / ch0;
          const w0 = axis === 'sagittal' ? h0.ny : h0.nx;
          const h0_ = axis === 'axial' ? h0.ny : h0.nz;
          if (axis === 'axial') {
            sliceIdx.sagittal = Math.max(0, Math.min(h0.nx - 1, Math.floor(nx_click * w0)));
            sliceIdx.coronal = Math.max(0, Math.min(h0.ny - 1, Math.floor((1 - ny_click) * h0_)));
          } else if (axis === 'coronal') {
            sliceIdx.sagittal = Math.max(0, Math.min(h0.nx - 1, Math.floor(nx_click * w0)));
            sliceIdx.axial = Math.max(0, Math.min(h0.nz - 1, Math.floor((1 - ny_click) * h0_)));
          } else {
            sliceIdx.coronal = Math.max(0, Math.min(h0.ny - 1, Math.floor(nx_click * w0)));
            sliceIdx.axial = Math.max(0, Math.min(h0.nz - 1, Math.floor((1 - ny_click) * h0_)));
          }
        }
        renderAllViews();
        return;
      }

      const { nx, ny, nz, dx, dy } = header;
      const pixelW = nx * dx;
      const pixelH = ny * dy;
      const ar = pixelW / pixelH;
      const vs = viewState[axis];
      let cw: number, ch: number;
      if (rect.width / rect.height > ar) { ch = rect.height; cw = ch * ar; }
      else { cw = rect.width; ch = cw / ar; }
      cw *= vs.zoom;
      ch *= vs.zoom;

      const imgLeft = (rect.width - cw) / 2 + vs.panX;
      const imgTop = (rect.height - ch) / 2 + vs.panY;

      if (clickX < imgLeft || clickX > imgLeft + cw ||
          clickY < imgTop || clickY > imgTop + ch) return;

      const nx_click = (clickX - imgLeft) / cw;
      const ny_click = (clickY - imgTop) / ch;

      if (axis === 'axial') {
        sliceIdx.sagittal = Math.max(0, Math.min(nx - 1, Math.floor(nx_click * nx)));
        sliceIdx.coronal = Math.max(0, Math.min(ny - 1, Math.floor((1 - ny_click) * ny)));
      } else if (axis === 'coronal') {
        sliceIdx.sagittal = Math.max(0, Math.min(nx - 1, Math.floor(nx_click * nx)));
        sliceIdx.axial = Math.max(0, Math.min(nz - 1, Math.floor((1 - ny_click) * nz)));
      } else {
        sliceIdx.coronal = Math.max(0, Math.min(ny - 1, Math.floor(nx_click * ny)));
        sliceIdx.axial = Math.max(0, Math.min(nz - 1, Math.floor((1 - ny_click) * nz)));
      }

      renderAllViews();
    });

    canvas.addEventListener('mousemove', (e) => {
      if (!header || !volumeData) return;
      if (crosshairVisible) {
        updateCoordInfoFromCenter();
        return;
      }
      const rect = canvas.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;
      const coordEl = document.getElementById('coord-info');
      if (!coordEl) return;

      if (compareMode && images.length >= 2) {
        const img0 = images[0];
        const img1 = images[1];
        const h0 = img0.header;
        const h1 = img1.header;
        const vs = viewState[axis];

        if (compareLayout === 'sideBySide') {
          const halfW = rect.width / 2;
          const isRight = mouseX >= halfW;
          const img = isRight ? img1 : img0;
          const hi = img.header;
          const pw = axis === 'sagittal' ? hi.ny * hi.dy : hi.nx * hi.dx;
          const ph = axis === 'axial' ? hi.ny * hi.dy : hi.nz * hi.dz;
          const ar = pw / ph;
          let iw: number, ih: number;
          if (halfW / rect.height > ar) { ih = rect.height; iw = ih * ar; }
          else { iw = halfW; ih = iw / ar; }
          iw *= vs.zoom; ih *= vs.zoom;
          const il = (isRight ? halfW : 0) + (halfW - iw) / 2 + vs.panX;
          const it = (rect.height - ih) / 2 + vs.panY;
          if (mouseX < il || mouseX > il + iw || mouseY < it || mouseY > it + ih) { coordEl.textContent = ''; return; }
          const nx_m = (mouseX - il) / iw;
          const ny_m = (mouseY - it) / ih;
          const w = axis === 'sagittal' ? hi.ny : hi.nx;
          const h_ = axis === 'axial' ? hi.ny : hi.nz;
          let px: number, py: number, pz: number;
          if (axis === 'axial') { px = Math.floor(nx_m * w); py = Math.floor((1 - ny_m) * h_); pz = sliceIdx.axial; }
          else if (axis === 'coronal') { px = Math.floor(nx_m * w); pz = Math.floor((1 - ny_m) * h_); py = sliceIdx.coronal; }
          else { py = Math.floor(nx_m * w); pz = Math.floor((1 - ny_m) * h_); px = sliceIdx.sagittal; }
          if (px >= 0 && px < hi.nx && py >= 0 && py < hi.ny && pz >= 0 && pz < hi.nz) {
            const val = img.data[pz * hi.ny * hi.nx + py * hi.nx + px] * img.slope + img.inter;
            const [wx, wy, wz] = voxelToWorld(hi, px, py, pz);
            const other = isRight ? img0 : img1;
            const oh = other.header;
            const [ox, oy, oz] = worldToVoxel(oh, wx, wy, wz);
            const oxi = Math.round(ox), oyi = Math.round(oy), ozi = Math.round(oz);
            let otherVal: string;
            if (oxi >= 0 && oxi < oh.nx && oyi >= 0 && oyi < oh.ny && ozi >= 0 && ozi < oh.nz) {
              const ov = other.data[ozi * oh.ny * oh.nx + oyi * oh.nx + oxi] * other.slope + other.inter;
              otherVal = ov.toFixed(4);
            } else { otherVal = '---'; }
            const name0 = isRight ? other.name : img.name;
            const name1 = isRight ? img.name : other.name;
            const v0 = isRight ? otherVal : val.toFixed(4);
            const v1 = isRight ? val.toFixed(4) : otherVal;
            coordEl.textContent = `${name0}: ${v0}\n${name1}: ${v1}`;
          }
        } else {
          const { nx, ny, nz, dx, dy } = h0;
          const pixelW = nx * dx;
          const pixelH = ny * dy;
          const ar = pixelW / pixelH;
          let imgW: number, imgH: number;
          if (rect.width / rect.height > ar) { imgH = rect.height; imgW = imgH * ar; }
          else { imgW = rect.width; imgH = imgW / ar; }
          imgW *= vs.zoom; imgH *= vs.zoom;
          const imgLeft = (rect.width - imgW) / 2 + vs.panX;
          const imgTop = (rect.height - imgH) / 2 + vs.panY;
          if (mouseX < imgLeft || mouseX > imgLeft + imgW || mouseY < imgTop || mouseY > imgTop + imgH) { coordEl.textContent = ''; return; }
          const nx_mouse = (mouseX - imgLeft) / imgW;
          const ny_mouse = (mouseY - imgTop) / imgH;
          let px: number, py: number, pz: number;
          if (axis === 'axial') { px = Math.floor(nx_mouse * nx); py = Math.floor((1 - ny_mouse) * ny); pz = sliceIdx.axial; }
          else if (axis === 'coronal') { px = Math.floor(nx_mouse * nx); pz = Math.floor((1 - ny_mouse) * nz); py = sliceIdx.coronal; }
          else { py = Math.floor(nx_mouse * ny); pz = Math.floor((1 - ny_mouse) * nz); px = sliceIdx.sagittal; }
          if (px >= 0 && px < nx && py >= 0 && py < ny && pz >= 0 && pz < nz) {
            const val0 = img0.data[pz * ny * nx + py * nx + px] * img0.slope + img0.inter;
            const [wx, wy, wz] = voxelToWorld(h0, px, py, pz);
            const [vx1, vy1, vz1] = worldToVoxel(h1, wx, wy, wz);
            const ix1 = Math.round(vx1), iy1 = Math.round(vy1), iz1 = Math.round(vz1);
            let val1Str: string;
            if (ix1 >= 0 && ix1 < h1.nx && iy1 >= 0 && iy1 < h1.ny && iz1 >= 0 && iz1 < h1.nz) {
              val1Str = (img1.data[iz1 * h1.ny * h1.nx + iy1 * h1.nx + ix1] * img1.slope + img1.inter).toFixed(4);
            } else { val1Str = '---'; }
            coordEl.textContent = `${img0.name}: ${val0.toFixed(4)}\n${img1.name}: ${val1Str}`;
          }
        }
        return;
      }

      const { nx, ny, nz, dx, dy } = header;
      const pixelW = nx * dx;
      const pixelH = ny * dy;
      const ar = pixelW / pixelH;
      const vs = viewState[axis];
      let imgW: number, imgH: number;
      if (rect.width / rect.height > ar) { imgH = rect.height; imgW = imgH * ar; }
      else { imgW = rect.width; imgH = imgW / ar; }
      imgW *= vs.zoom;
      imgH *= vs.zoom;

      const imgLeft = (rect.width - imgW) / 2 + vs.panX;
      const imgTop = (rect.height - imgH) / 2 + vs.panY;

      if (mouseX < imgLeft || mouseX > imgLeft + imgW ||
          mouseY < imgTop || mouseY > imgTop + imgH) return;

      const nx_mouse = (mouseX - imgLeft) / imgW;
      const ny_mouse = (mouseY - imgTop) / imgH;

      let px: number, py: number, pz: number;

      if (axis === 'axial') {
        px = Math.floor(nx_mouse * nx);
        py = Math.floor((1 - ny_mouse) * ny);
        pz = sliceIdx.axial;
      } else if (axis === 'coronal') {
        px = Math.floor(nx_mouse * nx);
        pz = Math.floor((1 - ny_mouse) * nz);
        py = sliceIdx.coronal;
      } else {
        py = Math.floor(nx_mouse * ny);
        pz = Math.floor((1 - ny_mouse) * nz);
        px = sliceIdx.sagittal;
      }

      if (px >= 0 && px < nx && py >= 0 && py < ny && pz >= 0 && pz < nz) {
        const val = volumeData[pz * ny * nx + py * nx + px];
        coordEl.textContent = `x=${px} y=${py} z=${pz}\nValue: ${val.toFixed(4)}`;
      }
    });

    const minimap = canvas.parentElement?.querySelector('.minimap') as HTMLDivElement;
    minimap?.addEventListener('click', (e) => {
      if (!header || viewState[axis].zoom <= 1.1) return;
      e.stopPropagation();
      const rect = minimap.getBoundingClientRect();
      const mx = (e.clientX - rect.left) / rect.width;
      const my = (e.clientY - rect.top) / rect.height;
      
      const { nx, ny, nz } = header;
      const zoom = viewState[axis].zoom;
      
      const maxPanX = (zoom - 1) * (axis === 'sagittal' ? ny : nx) / 2;
      const maxPanY = (zoom - 1) * (axis === 'axial' ? ny : nz) / 2;
      
      viewState[axis].panX = (mx - 0.5) * 2 * maxPanX;
      viewState[axis].panY = (my - 0.5) * 2 * maxPanY;
      
      updateSingleView(axis);
    });
  }

  const mipCanvas = canvases.mip;
  let mipDragging = false;
  let mipLastX = 0, mipLastY = 0;

  mipCanvas.addEventListener('mousedown', (e) => {
    mipDragging = true;
    mipLastX = e.clientX;
    mipLastY = e.clientY;
    mipCanvas.style.cursor = 'grabbing';
  });

  document.addEventListener('mousemove', (e) => {
    if (mipDragging) {
      const dx = e.clientX - mipLastX;
      const dy = e.clientY - mipLastY;
      viewState.mip.rotationY += dx * 0.01;
      viewState.mip.rotationX += dy * 0.01;
      mipLastX = e.clientX;
      mipLastY = e.clientY;
      paintMIP();
    }
  });

  document.addEventListener('mouseup', () => {
    if (mipDragging) {
      mipDragging = false;
      mipCanvas.style.cursor = 'crosshair';
    }
  });

  let resizeTimer: ReturnType<typeof setTimeout> | null = null;
  window.addEventListener('resize', () => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => renderAllViews(), 150);
  });
}
