/**
 * Compare-mode slice rendering: overlay and side-by-side painters.
 *
 * The viewer owns mutable session state (active image, layout, window/level,
 * per-axis pan/zoom), so this module receives it through a narrow host
 * interface instead of reaching into viewer globals.
 */
import { COLORMAPS } from './colormaps';
import { voxelToWorld, worldToVoxel } from './geometry';
import { computeFlipsForHeader } from './orientation';
import type { Axis, VolumeImage } from './types';

type CompareAxis = Axis;

interface CompareViewState {
  zoom: number;
  panX: number;
  panY: number;
}

export interface CompareRendererHost {
  getImages(): VolumeImage[];
  getImage(which: 0 | 1): VolumeImage | null;
  getSliceIdx(): Record<Axis, number>;
  getLayout(): 'overlay' | 'sideBySide';
  getOverlayOpacity(): number;
  getCanvases(): Record<CompareAxis, HTMLCanvasElement>;
  getViewState(): Record<CompareAxis, CompareViewState>;
  getWindow(): { width: number; level: number };
  isCrosshairVisible(): boolean;
  isMipInitialized(): boolean;
  paintMIP(): void;
  updateAllInfo(): void;
  updateDirectionLabels(axis: string): void;
  updateCrosshair(
    axis: string,
    w: number,
    h: number,
    zoom: number,
    panX: number,
    panY: number,
    cw: number,
    ch: number,
  ): void;
  updateScaleBar(axis: string, pixelW: number, pixelH: number, zoom: number, cw: number): void;
  updateMinimap(
    axis: string,
    w: number,
    h: number,
    zoom: number,
    panX: number,
    panY: number,
    cw: number,
    ch: number,
    data: Float32Array,
  ): void;
  extractSliceFromImage(img: VolumeImage, axis: Axis, idx: number): Float32Array;
}

// ── Compare-mode slice canvas cache ──
// renderCompareViews re-runs the per-pixel normalize+colormap pass for BOTH
// images on every scroll frame (renderSliceToTempCanvas x2 per axis).
// Cache the rendered canvases keyed by image uid + axis + slice index +
// colormap + window/level so revisited slices blit instantly - the compare
// counterpart of the single-image sliceRenderCache.
const imageUidMap = new WeakMap<object, number>();
let nextImageUid = 1;
const compareSliceCanvasCache = new Map<string, { canvas: HTMLCanvasElement; timestamp: number }>();
const COMPARE_CANVAS_CACHE_MAX = 24;

// Overlay slice resample cache (img1 resampled onto img0's grid). Keyed by
// img1 uid + align transform + axis + slice; FIFO-evicted.
const overlayResampleCache = new Map<string, Float32Array>();
const OVERLAY_RESAMPLE_CACHE_MAX = 18;

function getImageUid(img: object): number {
  let uid = imageUidMap.get(img);
  if (uid === undefined) {
    uid = nextImageUid++;
    imageUidMap.set(img, uid);
  }
  return uid;
}

/**
 * World-plane display grid for an ALIGNED img1 slice. The slice plane is
 * img0's (reference) axis slice spanning img0's physical extent, but it is
 * sampled at the finer of the two images' in-plane voxel steps. The moving
 * image therefore keeps its native resolution on screen (ITK-SNAP-style
 * display-time resampling only - its data is never rewritten), while the
 * stored align transform supplies position/rotation/scale.
 */
function alignedSliceGrid(
  img0: VolumeImage,
  img1: VolumeImage,
  axis: CompareAxis,
): { outW: number; outH: number; stepU: number; stepV: number } {
  const h0 = img0.header;
  // img1's world-space voxel size implied by the stored transform M
  // (world mm -> moving voxels): one mm along world axis i maps to
  // |column i of M| voxels, so the voxel pitch along that axis is 1/|col i|.
  const m = img1.align!.m;
  const c0 = Math.hypot(m[0], m[4], m[8]);
  const c1 = Math.hypot(m[1], m[5], m[9]);
  const c2 = Math.hypot(m[2], m[6], m[10]);
  const s1 = [1 / (c0 || 1), 1 / (c1 || 1), 1 / (c2 || 1)];
  let stepW: number, stepH: number, extW: number, extH: number;
  if (axis === 'axial') {
    stepW = Math.min(h0!.dx, s1[0]);
    stepH = Math.min(h0!.dy, s1[1]);
    extW = h0!.nx * h0!.dx;
    extH = h0!.ny * h0!.dy;
  } else if (axis === 'coronal') {
    stepW = Math.min(h0!.dx, s1[0]);
    stepH = Math.min(h0!.dz, s1[2]);
    extW = h0!.nx * h0!.dx;
    extH = h0!.nz * h0!.dz;
  } else {
    stepW = Math.min(h0!.dy, s1[1]);
    stepH = Math.min(h0!.dz, s1[2]);
    extW = h0!.ny * h0!.dy;
    extH = h0!.nz * h0!.dz;
  }
  // Safety cap: never build a display grid denser than 4096 px per side.
  stepW = Math.max(stepW, extW / 4096);
  stepH = Math.max(stepH, extH / 4096);
  // Convert physical steps to fractional img0 voxel steps so the sampler can
  // walk the plane through voxelToWorld (exact even for a rotated sform).
  let stepU: number, stepV: number;
  if (axis === 'axial') {
    stepU = stepW / h0!.dx;
    stepV = stepH / h0!.dy;
  } else if (axis === 'coronal') {
    stepU = stepW / h0!.dx;
    stepV = stepH / h0!.dz;
  } else {
    stepU = stepW / h0!.dy;
    stepV = stepH / h0!.dz;
  }
  return {
    outW: Math.max(1, Math.round(extW / stepW)),
    outH: Math.max(1, Math.round(extH / stepH)),
    stepU,
    stepV,
  };
}

export class CompareRenderer {
  constructor(private readonly host: CompareRendererHost) {}

  /** Drop cached compare canvases and resampled slices (align/size changes). */
  clearCaches(): void {
    compareSliceCanvasCache.clear();
    overlayResampleCache.clear();
  }

  renderCompareViews(changedAxis?: CompareAxis): void {
    if (this.host.getImages().length < 2) return;
    const img0 = this.host.getImage(0);
    const img1 = this.host.getImage(1);
    if (!img0 || !img1) return;
    const h0 = img0.header;
    const h1 = img1.header;
    const sliceIdx = this.host.getSliceIdx();

    const [wx, wy, wz] = voxelToWorld(h0!, sliceIdx.sagittal, sliceIdx.coronal, sliceIdx.axial);
    const [vx1, vy1, vz1] = worldToVoxel(h1!, wx, wy, wz);
    const img1Idx = {
      axial: Math.max(0, Math.min(h1!.nz - 1, Math.round(vz1))),
      coronal: Math.max(0, Math.min(h1!.ny - 1, Math.round(vy1))),
      sagittal: Math.max(0, Math.min(h1!.nx - 1, Math.round(vx1))),
    };

    const axes: CompareAxis[] = changedAxis ? [changedAxis] : ['axial', 'coronal', 'sagittal'];
    for (const axis of axes) {
      const idx0 = axis === 'axial' ? sliceIdx.axial : axis === 'coronal' ? sliceIdx.coronal : sliceIdx.sagittal;
      // Base slice: fall back to the low-res preview while the full volume is
      // still loading (preview slices share the header's native slice dims).
      const slice0 = img0.data
        ? this.host.extractSliceFromImage(img0, axis, idx0)
        : (img0.preview?.[axis] ?? new Float32Array(0));
      // World-coordinate resampling is ONLY meaningful once img1 carries an
      // align transform (Align button). Unaligned overlay simply stacks img1's
      // native slice (like the SBS right half) - resampling an unregistered
      // pair through world space blanks most of the layer when the two scans'
      // origins/orientations differ.
      const resample1 = !!img1.align;
      const slice1r = resample1 && img1.data ? this.resampleOverlaySlice(img0, img1, axis, idx0) : null;
      // img1 not yet loaded: skip the layer entirely (overlay), or show its
      // native preview slice in the SBS right half.
      const slice1 = slice1r
        ? slice1r.data
        : img1.data
          ? this.host.extractSliceFromImage(img1, axis, img1Idx[axis])
          : (img1.preview?.[axis] ?? new Float32Array(0));
      const w0 = axis === 'sagittal' ? h0!.ny : h0!.nx;
      const h0_ = axis === 'axial' ? h0!.ny : h0!.nz;
      const pw0 = axis === 'sagittal' ? h0!.ny * h0!.dy : h0!.nx * h0!.dx;
      const ph0 = axis === 'axial' ? h0!.ny * h0!.dy : h0!.nz * h0!.dz;
      // A resampled img1 slice spans img0's physical extent; only its pixel
      // count differs from img0's grid when the aligned grid is finer.
      const w1 = slice1r ? slice1r.w : axis === 'sagittal' ? h1!.ny : h1!.nx;
      const h1_ = slice1r ? slice1r.h : axis === 'axial' ? h1!.ny : h1!.nz;
      const pw1 = slice1r ? pw0 : axis === 'sagittal' ? h1!.ny * h1!.dy : h1!.nx * h1!.dx;
      const ph1 = slice1r ? ph0 : axis === 'axial' ? h1!.ny * h1!.dy : h1!.nz * h1!.dz;

      if (this.host.getLayout() === 'sideBySide') {
        this.paintSideBySideSlice(
          axis,
          slice0,
          slice1,
          w0,
          h0_,
          w1,
          h1_,
          pw0,
          ph0,
          pw1,
          ph1,
          img0,
          img1,
          idx0,
          img1Idx[axis],
        );
      } else {
        this.paintOverlaySlice(
          axis,
          slice0,
          slice1,
          w0,
          h0_,
          w1,
          h1_,
          pw0,
          ph0,
          pw1,
          ph1,
          img0,
          img1,
          idx0,
          img1Idx[axis],
        );
      }

      const overlayLabel = document.getElementById(`overlay-label-${axis}`);
      if (overlayLabel) {
        overlayLabel.textContent = img1.name;
        overlayLabel.style.display = this.host.getLayout() === 'overlay' ? '' : 'none';
      }
      const sbsL = document.getElementById(`sbs-l-${axis}`);
      const sbsR = document.getElementById(`sbs-r-${axis}`);
      if (sbsL) {
        sbsL.textContent = img0.name;
        sbsL.style.display = this.host.getLayout() === 'sideBySide' ? '' : 'none';
      }
      if (sbsR) {
        sbsR.textContent = img1.name;
        sbsR.style.display = this.host.getLayout() === 'sideBySide' ? '' : 'none';
      }
    }
    if (!changedAxis) {
      if (this.host.isMipInitialized()) this.host.paintMIP();
      this.host.updateAllInfo();
    }
  }

  private renderSliceToTempCanvas(
    data: Float32Array,
    w: number,
    h: number,
    imgMin: number,
    imgMax: number,
    cmapName: string,
    useGlobalWindow?: boolean,
  ): HTMLCanvasElement {
    const tc = document.createElement('canvas');
    tc.width = w;
    tc.height = h;
    const tctx = tc.getContext('2d')!;
    const imgData = tctx.createImageData(w, h);
    const pixels = imgData.data;
    const cmapFn = COLORMAPS[cmapName] || COLORMAPS.gray;
    const dataRange = imgMax - imgMin || 1;
    const n = w * h;

    if (useGlobalWindow) {
      const { width, level } = this.host.getWindow();
      const lo = level - width * 0.5;
      const hi = level + width * 0.5;
      const range = hi - lo || 1;
      for (let i = 0; i < n; i++) {
        const norm = (data[i] - imgMin) / dataRange;
        const t = Math.max(0, Math.min(1, (norm - lo) / range));
        const [r, g, b] = cmapFn(t);
        const idx = i * 4;
        pixels[idx] = r;
        pixels[idx + 1] = g;
        pixels[idx + 2] = b;
        pixels[idx + 3] = 255;
      }
    } else {
      for (let i = 0; i < n; i++) {
        const norm = (data[i] - imgMin) / dataRange;
        const t = Math.max(0, Math.min(1, norm));
        const [r, g, b] = cmapFn(t);
        const idx = i * 4;
        pixels[idx] = r;
        pixels[idx + 1] = g;
        pixels[idx + 2] = b;
        pixels[idx + 3] = 255;
      }
    }
    tctx.putImageData(imgData, 0, 0);
    return tc;
  }

  private renderSliceToTempCanvasCached(
    img: VolumeImage,
    axis: string,
    sliceIndex: number,
    data: Float32Array,
    w: number,
    h: number,
    useGlobalWindow?: boolean,
  ): HTMLCanvasElement {
    const { width, level } = this.host.getWindow();
    const key =
      `${getImageUid(img)}:${axis}:${sliceIndex}:${img.colormap}:` +
      (useGlobalWindow ? `${width.toFixed(4)}:${level.toFixed(4)}` : 'auto');
    const hit = compareSliceCanvasCache.get(key);
    // Dimension guard: if the underlying volume data was replaced in place
    // (LOD upgrade / reload) the slice geometry changes - a stale canvas would
    // be blitted stretched. Evict and re-render instead.
    if (hit && hit.canvas.width === w && hit.canvas.height === h) {
      hit.timestamp = Date.now();
      return hit.canvas;
    }
    if (hit) compareSliceCanvasCache.delete(key);
    const tc = this.renderSliceToTempCanvas(data, w, h, img.min, img.max, img.colormap, useGlobalWindow);
    compareSliceCanvasCache.set(key, { canvas: tc, timestamp: Date.now() });
    if (compareSliceCanvasCache.size > COMPARE_CANVAS_CACHE_MAX) {
      const entries = [...compareSliceCanvasCache.entries()].sort((a, b) => a[1].timestamp - b[1].timestamp);
      for (let i = 0; i < entries.length - COMPARE_CANVAS_CACHE_MAX; i++) {
        compareSliceCanvasCache.delete(entries[i][0]);
      }
    }
    return tc;
  }

  private resampleOverlaySlice(
    img0: VolumeImage,
    img1: VolumeImage,
    axis: CompareAxis,
    sliceIdx0: number,
  ): { data: Float32Array; w: number; h: number } {
    // Runs on every scroll frame; cache results per (image pair state, axis,
    // slice). Invalidate on align change via the explicit clear in
    // finishRegistration.
    const aligned = !!img1.align;
    // Key includes BOTH images' identity (the sample grid is img0's!) and the
    // data byte length so a preview->full-resolution upgrade naturally
    // invalidates stale slices.
    const cacheKey =
      `${getImageUid(img0)}:${getImageUid(img1)}:` +
      `${img1.align ? img1.align.m.join(',') : 'native'}:` +
      `${img1.data ? img1.data.byteLength : 0}:${axis}:${sliceIdx0}`;

    let outW: number, outH: number;
    let grid: { outW: number; outH: number; stepU: number; stepV: number } | null = null;
    if (aligned) {
      grid = alignedSliceGrid(img0, img1, axis);
      outW = grid.outW;
      outH = grid.outH;
    } else {
      const h0 = img0.header;
      if (axis === 'axial') {
        outW = h0!.nx;
        outH = h0!.ny;
      } else if (axis === 'coronal') {
        outW = h0!.nx;
        outH = h0!.nz;
      } else {
        outW = h0!.ny;
        outH = h0!.nz;
      }
    }

    const cached = overlayResampleCache.get(cacheKey);
    if (cached) return { data: cached, w: outW, h: outH };

    const h0 = img0.header;
    const h1 = img1.header;
    const d0 = img0.data;
    const d1 = img1.data;

    const result = new Float32Array(outW * outH);
    if (!d0 || !d1) return { data: result, w: outW, h: outH };

    const n1x = h1!.nx,
      n1y = h1!.ny,
      n1z = h1!.nz;
    const slope1 = img1.slope || 1;
    const inter1 = img1.inter || 0;

    const getVoxel1Lerp = (vx: number, vy: number, vz: number): number => {
      if (vx < -0.5 || vx > n1x - 0.5 || vy < -0.5 || vy > n1y - 0.5 || vz < -0.5 || vz > n1z - 0.5) return NaN;
      const x0 = Math.floor(vx),
        y0 = Math.floor(vy),
        z0 = Math.floor(vz);
      const x1 = Math.min(x0 + 1, n1x - 1),
        y1 = Math.min(y0 + 1, n1y - 1),
        z1 = Math.min(z0 + 1, n1z - 1);
      const fx = vx - x0,
        fy = vy - y0,
        fz = vz - z0;
      const cx0 = Math.max(0, x0),
        cy0 = Math.max(0, y0),
        cz0 = Math.max(0, z0);

      const v000 = d1[cz0 * n1y * n1x + cy0 * n1x + cx0] * slope1 + inter1;
      const v100 = d1[cz0 * n1y * n1x + cy0 * n1x + x1] * slope1 + inter1;
      const v010 = d1[cz0 * n1y * n1x + y1 * n1x + cx0] * slope1 + inter1;
      const v110 = d1[cz0 * n1y * n1x + y1 * n1x + x1] * slope1 + inter1;
      const v001 = d1[z1 * n1y * n1x + cy0 * n1x + cx0] * slope1 + inter1;
      const v101 = d1[z1 * n1y * n1x + cy0 * n1x + x1] * slope1 + inter1;
      const v011 = d1[z1 * n1y * n1x + y1 * n1x + cx0] * slope1 + inter1;
      const v111 = d1[z1 * n1y * n1x + y1 * n1x + x1] * slope1 + inter1;

      const c00 = v000 * (1 - fx) + v100 * fx;
      const c10 = v010 * (1 - fx) + v110 * fx;
      const c01 = v001 * (1 - fx) + v101 * fx;
      const c11 = v011 * (1 - fx) + v111 * fx;
      const c0 = c00 * (1 - fy) + c10 * fy;
      const c1 = c01 * (1 - fy) + c11 * fy;
      return c0 * (1 - fz) + c1 * fz;
    };

    for (let j = 0; j < outH; j++) {
      for (let i = 0; i < outW; i++) {
        let vx0: number, vy0: number, vz0: number;
        if (grid) {
          // Aligned display grid: fractional img0 voxel coords so consecutive
          // output pixels advance by a fixed PHYSICAL step (the finer of the
          // two images' in-plane voxel pitches). img1 is thus sampled at its
          // native resolution instead of being forced onto img0's grid.
          const u = i * grid.stepU;
          const v = j * grid.stepV;
          if (axis === 'axial') {
            vx0 = u;
            vy0 = v;
            vz0 = sliceIdx0;
          } else if (axis === 'coronal') {
            vx0 = u;
            vy0 = sliceIdx0;
            vz0 = v;
          } else {
            vx0 = sliceIdx0;
            vy0 = u;
            vz0 = v;
          }
        } else if (axis === 'axial') {
          vx0 = i;
          vy0 = j;
          vz0 = sliceIdx0;
        } else if (axis === 'coronal') {
          vx0 = i;
          vy0 = sliceIdx0;
          vz0 = j;
        } else {
          vx0 = sliceIdx0;
          vy0 = i;
          vz0 = j;
        }

        const [wx, wy, wz] = voxelToWorld(h0!, vx0, vy0, vz0);
        let vx1: number, vy1: number, vz1: number;
        if (img1.align) {
          // Aligned display: sample the ORIGINAL full-resolution moving data
          // through the stored world->moving-voxel transform (ITK-SNAP style).
          // The native header mapping is intentionally NOT applied on top.
          const m = img1.align.m;
          vx1 = m[0] * wx + m[1] * wy + m[2] * wz + m[3];
          vy1 = m[4] * wx + m[5] * wy + m[6] * wz + m[7];
          vz1 = m[8] * wx + m[9] * wy + m[10] * wz + m[11];
        } else {
          [vx1, vy1, vz1] = worldToVoxel(h1!, wx, wy, wz);
        }

        const val = getVoxel1Lerp(vx1, vy1, vz1);
        result[j * outW + i] = isNaN(val) ? 0 : val;
      }
    }

    if (overlayResampleCache.size >= OVERLAY_RESAMPLE_CACHE_MAX) {
      const firstKey = overlayResampleCache.keys().next().value as string;
      if (firstKey !== undefined) overlayResampleCache.delete(firstKey);
    }
    overlayResampleCache.set(cacheKey, result);
    return { data: result, w: outW, h: outH };
  }

  /**
   * Nearest-voxel intensity of `img` at a world point, honoring a stored align
   * transform if present. Used by hover/coordinate readouts in compare mode.
   * Returns null when the point falls outside the volume.
   */
  sampleImageAtWorld(img: VolumeImage, wx: number, wy: number, wz: number): number | null {
    if (!img.data) return null;
    const h = img.header;
    let vx: number, vy: number, vz: number;
    if (img.align) {
      const m = img.align.m;
      vx = m[0] * wx + m[1] * wy + m[2] * wz + m[3];
      vy = m[4] * wx + m[5] * wy + m[6] * wz + m[7];
      vz = m[8] * wx + m[9] * wy + m[10] * wz + m[11];
    } else {
      [vx, vy, vz] = worldToVoxel(h!, wx, wy, wz);
    }
    const ix = Math.round(vx),
      iy = Math.round(vy),
      iz = Math.round(vz);
    if (ix < 0 || ix >= h!.nx || iy < 0 || iy >= h!.ny || iz < 0 || iz >= h!.nz) return null;
    return img.data[iz * h!.ny * h!.nx + iy * h!.nx + ix] * (img.slope || 1) + (img.inter || 0);
  }

  private paintOverlaySlice(
    axis: string,
    data0: Float32Array,
    data1: Float32Array,
    w0: number,
    h0_: number,
    w1: number,
    h1_: number,
    pw0: number,
    ph0: number,
    pw1: number,
    ph1: number,
    img0: VolumeImage,
    img1: VolumeImage,
    idx0: number,
    idx1: number,
  ): void {
    void pw1;
    void ph1;
    void idx1; // overlay draws both slices on img0's world plane
    const canvas = this.host.getCanvases()[axis as CompareAxis];
    if (!canvas || !data0 || data0.length === 0) return;

    const vs = this.host.getViewState()[axis as CompareAxis];
    const zoom = vs.zoom;
    const panX = vs.panX;
    const panY = vs.panY;
    const dpr = window.devicePixelRatio || 1;
    const container = canvas.parentElement!;
    const dw = container.clientWidth;
    const dh = container.clientHeight;
    if (dw === 0 || dh === 0) return;

    // Geometry identical to paintSlice: full-container canvas, image box sized
    // by physical aspect, centered + panned. This keeps left-drag panning and
    // click-to-position working exactly like the single-image views (previously
    // the overlay painter resized the canvas to the image and dropped pan,
    // so dragging only moved the crosshair, never the image).
    const ar = pw0 / ph0;
    let cw: number, ch: number;
    if (dw / dh > ar) {
      ch = dh;
      cw = Math.floor(dh * ar);
    } else {
      cw = dw;
      ch = Math.floor(dw / ar);
    }
    cw = Math.floor(cw * zoom);
    ch = Math.floor(ch * zoom);

    const newW = dw * dpr;
    const newH = dh * dpr;
    // CSS size MUST be synced every frame (the SBS painter already does this
    // unconditionally). Gating it on a buffer-size change left stale CSS
    // dimensions in place whenever the drawing buffer happened to be unchanged
    // while the layout had moved on - the painted image then appeared shifted
    // outside the container.
    canvas.style.width = dw + 'px';
    canvas.style.height = dh + 'px';
    if (canvas.width !== newW || canvas.height !== newH) {
      canvas.width = newW;
      canvas.height = newH;
    }

    const ctx = canvas.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Orientation flips MUST come from img0's own header - never from the
    // global viewFlips, which tracks the ACTIVE image and diverges from the
    // compare pair as soon as the user picks another image in the list (the
    // SBS painter already computes per-image flips for exactly this reason).
    const flips = computeFlipsForHeader(img0.header!)[axis as CompareAxis];
    const imgLeft = (dw - cw) / 2 + panX;
    const imgTop = (dh - ch) / 2 + panY;
    const scaleX = flips.flipX ? (-cw * dpr) / w0 : (cw * dpr) / w0;
    const scaleY = flips.flipY ? (ch * dpr) / h0_ : (-ch * dpr) / h0_;
    const offsetX = flips.flipX ? (imgLeft + cw) * dpr : imgLeft * dpr;
    const offsetY = flips.flipY ? imgTop * dpr : (imgTop + ch) * dpr;

    const tc0 = this.renderSliceToTempCanvasCached(img0, axis, idx0, data0, w0, h0_, true);

    ctx.save();
    ctx.translate(offsetX, offsetY);
    ctx.scale(scaleX, scaleY);
    ctx.globalAlpha = 1.0;
    ctx.drawImage(tc0, 0, 0);
    ctx.restore();

    // Overlay image (img1) - same screen rect as img0 (same physical extent)
    // but drawn with its own pixel dims. Flips follow the SBS painter's rule:
    // an ALIGNED slice was resampled in img0's voxel frame (use img0's flips);
    // a NATIVE slice is in img1's storage order (use img1's own flips).
    if (data1 && data1.length > 0) {
      const flips1 = img1.align ? flips : computeFlipsForHeader(img1.header!)[axis as CompareAxis];
      const tc1 = this.renderSliceToTempCanvasCached(img1, axis, idx0, data1, w1, h1_, true);
      const scaleX1 = flips1.flipX ? (-cw * dpr) / w1 : (cw * dpr) / w1;
      const scaleY1 = flips1.flipY ? (ch * dpr) / h1_ : (-ch * dpr) / h1_;

      ctx.save();
      ctx.translate(offsetX, offsetY);
      ctx.scale(scaleX1, scaleY1);
      ctx.globalAlpha = this.host.getOverlayOpacity();
      ctx.drawImage(tc1, 0, 0);
      ctx.restore();
    }

    ctx.globalAlpha = 1.0;

    this.host.updateDirectionLabels(axis);
    this.host.updateCrosshair(axis, w0, h0_, zoom, panX, panY, cw, ch);
    this.host.updateScaleBar(axis, pw0, ph0, zoom, cw);
    this.host.updateMinimap(axis, w0, h0_, zoom, panX, panY, cw, ch, data0);
  }

  private paintSideBySideSlice(
    axis: string,
    data0: Float32Array,
    data1: Float32Array,
    w0: number,
    h0_: number,
    w1: number,
    h1_: number,
    pw0: number,
    ph0: number,
    pw1: number,
    ph1: number,
    img0: VolumeImage,
    img1: VolumeImage,
    _idx0: number,
    _idx1: number,
  ): void {
    const canvas = this.host.getCanvases()[axis as CompareAxis];
    // The right half may be absent while img1 is still loading - draw img0 only.
    if (!canvas || !data0 || data0.length === 0) return;

    const vs = this.host.getViewState()[axis as CompareAxis];
    const zoom = vs.zoom;
    const dpr = window.devicePixelRatio || 1;
    const container = canvas.parentElement!;
    const dw = container.clientWidth;
    const dh = container.clientHeight;
    if (dw === 0 || dh === 0) return;

    const halfW = Math.floor(dw / 2);

    // Unified physical extent for consistent registration display
    const unifiedPW = Math.max(pw0, pw1);
    const unifiedPH = Math.max(ph0, ph1);
    const unifiedAR = unifiedPW / unifiedPH;

    // Both images use the same display size based on unified physical extent
    let cw: number, ch: number;
    if (halfW / dh > unifiedAR) {
      ch = dh;
      cw = Math.floor(dh * unifiedAR);
    } else {
      cw = halfW;
      ch = Math.floor(halfW / unifiedAR);
    }
    cw = Math.floor(cw * zoom);
    ch = Math.floor(ch * zoom);

    canvas.style.width = dw + 'px';
    canvas.style.height = dh + 'px';
    canvas.width = dw * dpr;
    canvas.height = dh * dpr;

    const ctx = canvas.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;

    const tc0 = this.renderSliceToTempCanvas(data0, w0, h0_, img0.min, img0.max, img0.colormap, true);
    const tc1 =
      data1 && data1.length > 0
        ? this.renderSliceToTempCanvas(data1, w1, h1_, img1.min, img1.max, img1.colormap, true)
        : null;

    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const flips0 = img0.header
      ? computeFlipsForHeader(img0.header!)[axis as CompareAxis]
      : { flipX: false, flipY: false };
    const flips1 = img1.header
      ? computeFlipsForHeader(img1.header!)[axis as CompareAxis]
      : { flipX: false, flipY: false };

    // Each half is clipped to its own rectangle so zooming/panning one image
    // does not draw over the other image.
    const imgLeft0 = (halfW - cw) / 2 + vs.panX;
    const imgTop0 = (dh - ch) / 2 + vs.panY;
    const offsetX0 = imgLeft0 * dpr;
    const offsetY0 = (imgTop0 + ch) * dpr;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, halfW * dpr, dh * dpr);
    ctx.clip();
    ctx.translate(offsetX0, offsetY0);
    ctx.scale(flips0.flipX ? (-cw * dpr) / w0 : (cw * dpr) / w0, flips0.flipY ? (ch * dpr) / h0_ : (-ch * dpr) / h0_);
    if (flips0.flipX) ctx.translate(-w0, 0);
    if (flips0.flipY) ctx.translate(0, -h0_);
    ctx.drawImage(tc0, 0, 0);
    ctx.restore();

    // Right half: img1 with unified scale (same physical size as img0)
    // When img1 carries an align transform its slice was resampled into img0's
    // storage order, so it must be drawn with img0's flips, not its own.
    if (tc1) {
      const drawFlips1 = img1.align ? flips0 : flips1;
      const imgLeft1 = halfW + (halfW - cw) / 2 + vs.panX;
      const imgTop1 = (dh - ch) / 2 + vs.panY;
      const offsetX1 = imgLeft1 * dpr;
      const offsetY1 = (imgTop1 + ch) * dpr;
      ctx.save();
      ctx.beginPath();
      ctx.rect(halfW * dpr, 0, (dw - halfW) * dpr, dh * dpr);
      ctx.clip();
      ctx.translate(offsetX1, offsetY1);
      ctx.scale(
        drawFlips1.flipX ? (-cw * dpr) / w1 : (cw * dpr) / w1,
        drawFlips1.flipY ? (ch * dpr) / h1_ : (-ch * dpr) / h1_,
      );
      if (drawFlips1.flipX) ctx.translate(-w1, 0);
      if (drawFlips1.flipY) ctx.translate(0, -h1_);
      ctx.drawImage(tc1, 0, 0);
      ctx.restore();
    }

    ctx.strokeStyle = 'rgba(233,69,96,0.7)';
    ctx.lineWidth = 2 * dpr;
    ctx.beginPath();
    ctx.moveTo(halfW * dpr, 0);
    ctx.lineTo(halfW * dpr, dh * dpr);
    ctx.stroke();

    if (this.host.isCrosshairVisible() && img0.header) {
      const h0 = img0.header;
      const sliceIdx = this.host.getSliceIdx();
      const cursorX = sliceIdx.sagittal;
      const cursorY = sliceIdx.coronal;
      const cursorZ = sliceIdx.axial;
      let sliceX0: number, sliceY0: number;
      if (axis === 'axial') {
        sliceX0 = cursorX;
        sliceY0 = cursorY;
      } else if (axis === 'coronal') {
        sliceX0 = cursorX;
        sliceY0 = cursorZ;
      } else {
        sliceX0 = cursorY;
        sliceY0 = cursorZ;
      }
      const nx0 = axis === 'sagittal' ? h0.ny : h0.nx;
      const ny0 = axis === 'sagittal' ? h0.nz : axis === 'coronal' ? h0.nz : h0.ny;
      const cx0 = sliceX0 / (nx0 - 1 || 1);
      const cy0 = sliceY0 / (ny0 - 1 || 1);

      // Use unified cw/ch for crosshair positioning (same pan as rendering)
      const imgLeft0 = (halfW - cw) / 2 + vs.panX;
      const imgTop0 = (dh - ch) / 2 + vs.panY;
      const cx0_screen = flips0.flipX ? 1 - cx0 : cx0;
      const cy0_screen = flips0.flipY ? cy0 : 1 - cy0;
      const sx0 = (imgLeft0 + cx0_screen * cw) * dpr;
      const sy0 = (imgTop0 + cy0_screen * ch) * dpr;

      ctx.strokeStyle = 'rgba(255,0,0,0.6)';
      ctx.lineWidth = 1 * dpr;
      ctx.beginPath();
      ctx.moveTo(0, sy0);
      ctx.lineTo(halfW * dpr, sy0);
      ctx.moveTo(sx0, 0);
      ctx.lineTo(sx0, dh * dpr);
      ctx.stroke();

      const h1 = img1.header;
      // Aligned right half: the displayed slice was resampled in img0's voxel
      // frame, so its crosshair fraction is identical to the left half's.
      // Unaligned right half: map the crosshair world position into img1's
      // native voxel frame.
      let cx1: number, cy1: number, flipX1: boolean, flipY1: boolean;
      if (img1.align) {
        cx1 = cx0;
        cy1 = cy0;
        flipX1 = flips0.flipX;
        flipY1 = flips0.flipY;
      } else {
        const [wx, wy, wz] = voxelToWorld(h0!, cursorX, cursorY, cursorZ);
        const [vx1, vy1, vz1] = worldToVoxel(h1!, wx, wy, wz);
        let sliceX1: number, sliceY1: number;
        if (axis === 'axial') {
          sliceX1 = Math.round(vx1);
          sliceY1 = Math.round(vy1);
        } else if (axis === 'coronal') {
          sliceX1 = Math.round(vx1);
          sliceY1 = Math.round(vz1);
        } else {
          sliceX1 = Math.round(vy1);
          sliceY1 = Math.round(vz1);
        }
        const nx1 = axis === 'sagittal' ? h1!.ny : h1!.nx;
        const ny1 = axis === 'sagittal' ? h1!.nz : axis === 'coronal' ? h1!.nz : h1!.ny;
        cx1 = Math.max(0, Math.min(1, sliceX1 / (nx1 - 1 || 1)));
        cy1 = Math.max(0, Math.min(1, sliceY1 / (ny1 - 1 || 1)));
        flipX1 = flips1.flipX;
        flipY1 = flips1.flipY;
      }

      // Use unified cw/ch for crosshair positioning (same pan as rendering)
      const imgLeft1 = halfW + (halfW - cw) / 2 + vs.panX;
      const imgTop1 = (dh - ch) / 2 + vs.panY;
      const cx1_screen = flipX1 ? 1 - cx1 : cx1;
      const cy1_screen = flipY1 ? cy1 : 1 - cy1;
      const sx1 = (imgLeft1 + cx1_screen * cw) * dpr;
      const sy1 = (imgTop1 + cy1_screen * ch) * dpr;

      ctx.strokeStyle = 'rgba(255,200,0,0.6)';
      ctx.lineWidth = 1 * dpr;
      ctx.beginPath();
      ctx.moveTo(halfW * dpr, sy1);
      ctx.lineTo(dw * dpr, sy1);
      ctx.moveTo(sx1, 0);
      ctx.lineTo(sx1, dh * dpr);
      ctx.stroke();
    }

    const vc = canvas.parentElement!;
    const htmlCrosshair = vc.querySelector('.crosshair') as HTMLDivElement;
    if (htmlCrosshair) htmlCrosshair.style.display = 'none';

    this.host.updateDirectionLabels(axis);
    this.host.updateScaleBar(axis, pw0, ph0, zoom, cw);
    this.host.updateMinimap(axis, w0, h0_, zoom, vs.panX, vs.panY, cw, ch, data0);
  }
}
