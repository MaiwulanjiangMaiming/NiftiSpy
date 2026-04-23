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
let colormap = 'gray';
let fileUrl = '';
let isGzip = false;
let fileName = '';
let crosshairVisible = true;
let coordSystem = 'RAS';

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

  canvas.style.width = cw + 'px';
  canvas.style.height = ch + 'px';
  canvas.width = cw * dpr;
  canvas.height = ch * dpr;

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

  const offsetX = (canvas.width - cw * dpr) / 2;
  const offsetY = (canvas.height + ch * dpr) / 2;
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
  const imgLeft = (containerRect.width - imgW) / 2 - panX;
  const imgTop = (containerRect.height - imgH) / 2 - panY;

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
}

function paintCompareSlice(canvasId: string, containerId: string, data: Float32Array, w: number, h: number, pixelW: number, pixelH: number) {
  const canvas = document.getElementById(canvasId) as HTMLCanvasElement;
  const container = document.getElementById(containerId);
  if (!canvas || !container || !data || data.length === 0) return;

  const dpr = window.devicePixelRatio || 1;
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

  const imgData = ctx.createImageData(w, h);
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
  ctx.drawImage(tc, 0, 0, canvas.width, canvas.height);
}

function renderCompareViews() {
  if (images.length < 2) return;
  const img0 = images[0];
  const img1 = images[1];
  const h0 = img0.header;
  const h1 = img1.header;

  const savedHeader = header;
  const savedData = volumeData;
  const savedMin = globalMin;
  const savedMax = globalMax;
  const savedSlope = dataSlope;
  const savedInter = dataInter;

  const [wx, wy, wz] = voxelToWorld(h0, sliceIdx.sagittal, sliceIdx.coronal, sliceIdx.axial);
  const [vx1, vy1, vz1] = worldToVoxel(h1, wx, wy, wz);
  const ax1 = Math.max(0, Math.min(h1.nz - 1, Math.round(vz1)));
  const co1 = Math.max(0, Math.min(h1.ny - 1, Math.round(vy1)));
  const sa1 = Math.max(0, Math.min(h1.nx - 1, Math.round(vx1)));

  header = h0; volumeData = img0.data; globalMin = img0.min; globalMax = img0.max; dataSlope = img0.slope; dataInter = img0.inter;
  const axSlice0 = extractSlice('axial', Math.min(sliceIdx.axial, h0.nz - 1));
  const coSlice0 = extractSlice('coronal', Math.min(sliceIdx.coronal, h0.ny - 1));
  const saSlice0 = extractSlice('sagittal', Math.min(sliceIdx.sagittal, h0.nx - 1));

  header = h1; volumeData = img1.data; globalMin = img1.min; globalMax = img1.max; dataSlope = img1.slope; dataInter = img1.inter;
  const axSlice1 = extractSlice('axial', ax1);
  const coSlice1 = extractSlice('coronal', co1);
  const saSlice1 = extractSlice('sagittal', sa1);

  header = savedHeader; volumeData = savedData; globalMin = savedMin; globalMax = savedMax; dataSlope = savedSlope; dataInter = savedInter;

  globalMin = img0.min; globalMax = img0.max;
  paintCompareSlice('cmp-ax0', 'cmp-ax0-c', axSlice0, h0.nx, h0.ny, h0.nx * h0.dx, h0.ny * h0.dy);
  paintCompareSlice('cmp-co0', 'cmp-co0-c', coSlice0, h0.nx, h0.nz, h0.nx * h0.dx, h0.nz * h0.dz);
  paintCompareSlice('cmp-sa0', 'cmp-sa0-c', saSlice0, h0.ny, h0.nz, h0.ny * h0.dy, h0.nz * h0.dz);

  globalMin = img1.min; globalMax = img1.max;
  paintCompareSlice('cmp-ax1', 'cmp-ax1-c', axSlice1, h1.nx, h1.ny, h1.nx * h1.dx, h1.ny * h1.dy);
  paintCompareSlice('cmp-co1', 'cmp-co1-c', coSlice1, h1.nx, h1.nz, h1.nx * h1.dx, h1.nz * h1.dz);
  paintCompareSlice('cmp-sa1', 'cmp-sa1-c', saSlice1, h1.ny, h1.nz, h1.ny * h1.dy, h1.nz * h1.dz);
  globalMin = savedMin; globalMax = savedMax;

  const nameEl0 = document.getElementById('cmp-ax0-name');
  const nameEl1 = document.getElementById('cmp-ax1-name');
  if (nameEl0) nameEl0.textContent = img0.name;
  if (nameEl1) nameEl1.textContent = img1.name;
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
    compareMode = !compareMode;
    btnCompare.classList.toggle('active', compareMode);
    const main = document.getElementById('main');
    if (main) main.classList.toggle('compare-mode', compareMode);
    renderAllViews();
  });

  const btnAddImg = document.getElementById('btn-add-img') as HTMLButtonElement;
  btnAddImg?.addEventListener('click', () => {
    vscode.postMessage({ type: 'selectImage' });
  });

  const btnCrosshair = document.getElementById('btn-crosshair') as HTMLButtonElement;
  btnCrosshair?.addEventListener('click', () => {
    crosshairVisible = !crosshairVisible;
    btnCrosshair.classList.toggle('active', crosshairVisible);
    renderAllViews();
  });
  if (crosshairVisible) btnCrosshair?.classList.add('active');

  const coordSystemSelect = document.getElementById('coord-system') as HTMLSelectElement;
  coordSystemSelect?.addEventListener('change', () => {
    coordSystem = coordSystemSelect.value;
    updateAllDirectionLabels();
    renderAllViews();
  });

  helpBtn?.addEventListener('click', () => helpPopup.classList.toggle('show'));
  document.addEventListener('click', (e) => {
    if (!helpBtn?.contains(e.target as Node) && !helpPopup?.contains(e.target as Node)) {
      helpPopup?.classList.remove('show');
    }
  });

  sidebarToggle?.addEventListener('click', () => {
    if (compareMode) {
      compareMode = false;
      const btnCompare = document.getElementById('btn-compare');
      btnCompare?.classList.remove('active');
      const main = document.getElementById('main');
      main?.classList.remove('compare-mode');
      sidebarCollapsed = false;
      sidebar.classList.remove('collapsed');
      sidebar.style.width = sidebarWidth + 'px';
      sidebar.style.minWidth = sidebarWidth + 'px';
      sidebarToggle.style.right = sidebarWidth + 'px';
      sidebarToggle.textContent = '◀';
      renderAllViews();
      return;
    }
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
    let isPinching = false;
    let lastPinchDist = 0;

    canvas.addEventListener('mousedown', (e) => {
      if (e.button === 0) {
        isDragging = true;
        lastX = e.clientX;
        lastY = e.clientY;
        canvas.style.cursor = 'grabbing';
      }
    });

    document.addEventListener('mousemove', (e) => {
      if (isDragging) {
        const dx = e.clientX - lastX;
        const dy = e.clientY - lastY;
        viewState[axis].panX -= dx;
        viewState[axis].panY -= dy;
        lastX = e.clientX;
        lastY = e.clientY;
        updateSingleView(axis);
      }
    });

    document.addEventListener('mouseup', () => {
      if (isDragging) {
        isDragging = false;
        canvas.style.cursor = 'crosshair';
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
        viewState[axis].panX -= dx;
        viewState[axis].panY -= dy;
        lastX = e.touches[0].clientX;
        lastY = e.touches[0].clientY;
        updateSingleView(axis);
      }
    }, { passive: true });

    canvas.addEventListener('touchend', () => {
      isDragging = false;
      isPinching = false;
    });

    canvas.addEventListener('click', (e) => {
      if (Math.abs(e.clientX - lastX) > 5 || Math.abs(e.clientY - lastY) > 5) return;
      if (!header) return;
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const { nx, ny, nz, dx, dy } = header;

      // Calculate actual image display size and position (same as paintSlice)
      const pixelW = nx * dx;
      const pixelH = ny * dy;
      const ar = pixelW / pixelH;
      const vs = viewState[axis];
      let cw: number, ch: number;
      if (rect.width / rect.height > ar) { ch = rect.height; cw = ch * ar; }
      else { cw = rect.width; ch = cw / ar; }
      cw *= vs.zoom;
      ch *= vs.zoom;

      // Image offset in canvas (centered)
      const imgLeft = (rect.width - cw) / 2 - vs.panX;
      const imgTop = (rect.height - ch) / 2 - vs.panY;

      // Click position relative to image
      const clickX = e.clientX - rect.left;
      const clickY = e.clientY - rect.top;

      // Check if click is within image bounds
      if (clickX < imgLeft || clickX > imgLeft + cw ||
          clickY < imgTop || clickY > imgTop + ch) return;

      // Normalize to image coordinates (0-1)
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
      const rect = canvas.getBoundingClientRect();

      const { nx, ny, nz, dx, dy } = header;

      // Calculate actual image display size and position (same as paintSlice)
      const pixelW = nx * dx;
      const pixelH = ny * dy;
      const ar = pixelW / pixelH;
      const vs = viewState[axis];
      let imgW: number, imgH: number;
      if (rect.width / rect.height > ar) { imgH = rect.height; imgW = imgH * ar; }
      else { imgW = rect.width; imgH = imgW / ar; }
      imgW *= vs.zoom;
      imgH *= vs.zoom;

      // Image offset in canvas (centered)
      const imgLeft = (rect.width - imgW) / 2 - vs.panX;
      const imgTop = (rect.height - imgH) / 2 - vs.panY;

      // Mouse position relative to image
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;

      // Check if mouse is within image bounds
      if (mouseX < imgLeft || mouseX > imgLeft + imgW ||
          mouseY < imgTop || mouseY > imgTop + imgH) return;

      // Normalize to image coordinates (0-1)
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
        const coordEl = document.getElementById('coord-info');
        if (coordEl) {
          coordEl.textContent = `x=${px} y=${py} z=${pz}\nValue: ${val.toFixed(4)}`;
        }
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
