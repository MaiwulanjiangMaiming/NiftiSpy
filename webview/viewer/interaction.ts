import type { NiiHeader } from '../nii-parser';
import type { Axis, TypedArray, VolumeImage } from './types';
import type { Measurement } from './measure';
import type { RegistrationController } from './registration';
import type { CompareRenderer } from './compareRenderer';

export type CompareLayout = 'overlay' | 'sideBySide';

export interface SliceIndices {
  axial: number;
  coronal: number;
  sagittal: number;
}

export interface ViewTransform {
  zoom: number;
  panX: number;
  panY: number;
}

export interface InteractionViewState {
  axial: ViewTransform;
  coronal: ViewTransform;
  sagittal: ViewTransform;
  mip: { rot: number[] };
}

export interface SliceFrameView {
  data: Float32Array;
  width: number;
  height: number;
}

export interface FlipFlags {
  flipX: boolean;
  flipY: boolean;
}

export interface InteractionHost {
  // Live state: read through getters so handlers always see current values.
  readonly header: NiiHeader | null;
  readonly images: VolumeImage[];
  readonly sliceIdx: SliceIndices;
  readonly viewState: InteractionViewState;
  readonly measurements: Measurement[];
  readonly canvases: Record<Axis | 'mip', HTMLCanvasElement>;
  readonly viewFlips: Record<string, FlipFlags>;
  readonly currentSlices: Record<Axis, SliceFrameView | null>;
  readonly volumeData: TypedArray | null;
  readonly dataSlope: number;
  readonly dataInter: number;
  readonly perfProfile: { readonly tier: 'high' | 'medium' | 'low' };
  readonly sliceRenderCache: { clear(): void };
  readonly registration: RegistrationController;
  readonly compareRenderer: CompareRenderer;
  readonly maximizedView: string | null;
  readonly mipIdentity: number[];

  // Scalars the module assigns.
  interactionInitialized: boolean;
  windowWidth: number;
  windowLevel: number;
  colormap: string;
  compareMode: boolean;
  compareLayout: CompareLayout;
  compareIdxA: number;
  compareIdxB: number;
  overlayOpacity: number;
  crosshairVisible: boolean;
  measureMode: boolean;
  measureDragStart: { x: number; y: number; axis: Axis } | null;
  measureClickPending: { x: number; y: number; axis: Axis } | null;
  activeImageIdx: number;
  timeIdx: number;
  headerPanelVisible: boolean;
  sidebarCollapsed: boolean;
  sidebarWidth: number;
  highContrastPreferred: boolean;
  focusedCanvas: Axis | null;
  mipInitialized: boolean;
  activeLoadDebounceTimer: number | null;
  scheduledActiveIndex: number | null;

  // Viewer callbacks.
  postMessage(message: unknown): void;
  initTooltipSystem(): void;
  initWasmBindings(): Promise<{ hasSimd(): boolean } | null>;
  showToast(text: string): void;
  renderAllViews(): void;
  validateWindowLevel(ww: number, wl: number): { windowWidth: number; windowLevel: number };
  a11yAnnounce(text: string): void;
  renderColormapPreview(): void;
  autoContrast(): void;
  resetViews(): void;
  ensureImageData(index: number, priority?: 'active' | 'background'): Promise<void>;
  cmpImg(which: 0 | 1): VolumeImage | null;
  updateImagePicker(): void;
  updateFileInfo(): void;
  updateSliderValues(): void;
  applyImageState(img: VolumeImage, preserveSlices?: boolean): void;
  updateCoordInfoFromCenter(): void;
  clearMeasurements(): void;
  updateHeaderPanel(): void;
  toggleMaximize(view: string): void;
  validateSliceIndex(axis: Axis, idx: number): number;
  onUserScrollSlices(): void;
  scheduleSingleViewRender(axis: Axis): void;
  volumeHasTimepoint(t: number): boolean;
  refreshSlices(axes: Axis[], interactive?: boolean): Promise<void>;
  scheduleLODUpgrade(axis: Axis): void;
  computeRoiArea(axis: Axis, x1: number, y1: number, x2: number, y2: number): number;
  computeLineDistance(axis: Axis, x1: number, y1: number, x2: number, y2: number): number;
  updateSingleView(axis: Axis): void;
  getAxisGeometry(
    axis: Axis,
    hdr?: NiiHeader,
  ): {
    width: number;
    height: number;
    pixelW: number;
    pixelH: number;
    maxIndex: number;
  };
  paintMIP(interactive?: boolean): void;
  scheduleMIPRender(interactive: boolean): void;
  setupVolumeInteraction(): void;
  handleKeyboardAction(action: string): void;
  drawMeasurements(measurements: Measurement[], highContrast: boolean): void;
  computeFlipsForHeader(h: NiiHeader): {
    axial: FlipFlags;
    coronal: FlipFlags;
    sagittal: FlipFlags;
  };
  voxelToWorld(h: NiiHeader, vx: number, vy: number, vz: number): [number, number, number];
  worldToVoxel(h: NiiHeader, wx: number, wy: number, wz: number): [number, number, number];
  rotAxisAngle(ax: number, ay: number, az: number, angle: number): number[];
  mul3(a: number[], b: number[]): number[];
}

export function setupInteraction(host: InteractionHost): void {
  if (!host.header) return;
  if (host.interactionInitialized) return;
  host.interactionInitialized = true;

  // Initialize tooltip system (data-tip based, like Project_Manager)
  host.initTooltipSystem();

  // Initialize WASM SIMD acceleration (async, non-blocking)
  host
    .initWasmBindings()
    .then((bindings) => {
      if (bindings?.hasSimd()) {
        console.log('[NiftiSpy] WASM SIMD128 acceleration active');
      }
    })
    .catch(() => {
      console.log('[NiftiSpy] WASM SIMD not available');
    });

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
    renderTimer = requestAnimationFrame(() => {
      host.renderAllViews();
      renderTimer = null;
    });
  };

  wwSlider?.addEventListener('input', () => {
    const v = host.validateWindowLevel(Number(wwSlider.value) / 100, host.windowLevel);
    host.windowWidth = v.windowWidth;
    scheduleRender();
    host.a11yAnnounce(`Window width: ${Math.round(host.windowWidth * 100)}`);
  });
  wlSlider?.addEventListener('input', () => {
    const v = host.validateWindowLevel(host.windowWidth, Number(wlSlider.value) / 100);
    host.windowLevel = v.windowLevel;
    scheduleRender();
    host.a11yAnnounce(`Window level: ${Math.round(host.windowLevel * 100)}`);
  });
  cmapSelect?.addEventListener('change', () => {
    const activeImg = host.images[host.activeImageIdx];
    if (activeImg) activeImg.colormap = cmapSelect.value;
    host.colormap = cmapSelect.value;
    host.sliceRenderCache.clear();
    host.renderColormapPreview();
    scheduleRender();
  });
  btnAuto?.addEventListener('click', host.autoContrast);
  btnReset?.addEventListener('click', host.resetViews);

  const btnFit = document.getElementById('btn-fit') as HTMLButtonElement;
  btnFit?.addEventListener('click', () => {
    host.viewState.axial = { zoom: 1, panX: 0, panY: 0 };
    host.viewState.coronal = { zoom: 1, panX: 0, panY: 0 };
    host.viewState.sagittal = { zoom: 1, panX: 0, panY: 0 };
    host.renderAllViews();
  });

  const btnCompare = document.getElementById('btn-compare') as HTMLButtonElement;
  btnCompare?.addEventListener('click', async () => {
    // Starting a fresh compare requires exactly two checkbox-selected images.
    if (!host.compareMode) {
      const checked = host.images.filter((im) => im.selected);
      if (checked.length > 2) {
        host.showToast('Cannot compare more than two images.');
        return;
      }
      if (checked.length < 2) {
        host.showToast('Please add another image to compare.');
        return;
      }
      const ia = host.images.indexOf(checked[0]);
      const ib = host.images.indexOf(checked[1]);
      if (ia < 0 || ib < 0 || ia === ib) {
        host.showToast('Please add another image to compare.');
        return;
      }
      host.compareIdxA = ia;
      host.compareIdxB = ib;
    }
    if (host.activeLoadDebounceTimer) {
      window.clearTimeout(host.activeLoadDebounceTimer);
      host.activeLoadDebounceTimer = null;
      host.scheduledActiveIndex = null;
    }
    if (!host.compareMode) {
      try {
        await host.ensureImageData(host.compareIdxA, 'active');
        await host.ensureImageData(host.compareIdxB, 'active');
      } catch (err) {
        console.error('Failed to prepare compare mode:', err);
        return;
      }
      host.compareMode = true;
      host.compareLayout = 'overlay';
    } else if (host.compareLayout === 'overlay') {
      host.compareLayout = 'sideBySide';
    } else {
      host.compareMode = false;
      host.compareLayout = 'overlay';
    }
    // Overlay and SBS have different fit geometry (full container vs half
    // container), so any zoom/pan left over from the single-image view (or
    // the other layout) would place the image off-center or entirely out of
    // view — one axis at a time if only it was zoomed before. Reset all
    // three on every mode/layout transition.
    host.viewState.axial = { zoom: 1, panX: 0, panY: 0 };
    host.viewState.coronal = { zoom: 1, panX: 0, panY: 0 };
    host.viewState.sagittal = { zoom: 1, panX: 0, panY: 0 };
    btnCompare.classList.toggle('active', host.compareMode);
    btnCompare.textContent = !host.compareMode ? '⊞ Compare' : host.compareLayout === 'overlay' ? '◑ Overlay' : '◫ SBS';
    const overlayControls = document.getElementById('overlay-controls');
    if (overlayControls) overlayControls.style.display = host.compareMode ? 'block' : 'none';
    if (host.compareMode) {
      const img0 = host.cmpImg(0);
      const img1 = host.cmpImg(1);
      if (!img0 || !img1) return;
      host.applyImageState(img0, true);
      host.activeImageIdx = host.images.indexOf(img0);
      if (cmapSelect && img0) {
        cmapSelect.value = img0.colormap;
        host.colormap = img0.colormap;
      }
      if (overlayCmapSelect && img1) {
        overlayCmapSelect.value = img1.colormap;
      }
      host.renderColormapPreview();
      host.sliceIdx.axial = Math.min(host.sliceIdx.axial, img0.header!.nz - 1);
      host.sliceIdx.coronal = Math.min(host.sliceIdx.coronal, img0.header!.ny - 1);
      host.sliceIdx.sagittal = Math.min(host.sliceIdx.sagittal, img0.header!.nx - 1);
      host.updateImagePicker();
      host.updateFileInfo();
      host.updateSliderValues();
    }
    host.renderAllViews();
  });

  // Align button (compare mode): pick which of the two compared images is the
  // reference, then register the other onto it. Transform-only — neither
  // volume's data is modified (ITK-SNAP style).
  const btnAlign = document.getElementById('btn-align') as HTMLButtonElement | null;
  btnAlign?.addEventListener('click', () => {
    if (!host.compareMode) {
      host.showToast('Enter compare mode first, then align.');
      return;
    }
    const a = host.cmpImg(0);
    const b = host.cmpImg(1);
    if (!a || !b) {
      host.showToast('Compare needs exactly two selected images.');
      return;
    }
    document.getElementById('align-ref-menu')?.remove();
    const rect = btnAlign.getBoundingClientRect();
    const menu = document.createElement('div');
    menu.id = 'align-ref-menu';
    menu.style.cssText =
      'position:fixed;z-index:10000;background:#2a2a2a;border:1px solid #444;' +
      'border-radius:6px;padding:4px;box-shadow:0 4px 12px rgba(0,0,0,0.4);min-width:200px;';
    const mkEntry = (img: VolumeImage, idx: number) => {
      const it = document.createElement('div');
      it.style.cssText =
        'padding:6px 10px;border-radius:4px;cursor:pointer;font-size:12px;color:#ddd;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
      it.textContent = `Reference: ${img.name}`;
      it.title = `Align ${img.name === a.name ? b.name : a.name} onto ${img.name}`;
      it.addEventListener('mouseenter', () => {
        it.style.background = '#3a3a3a';
      });
      it.addEventListener('mouseleave', () => {
        it.style.background = 'transparent';
      });
      it.addEventListener('click', () => {
        menu.remove();
        void host.registration.startAlign(idx);
      });
      menu.appendChild(it);
    };
    mkEntry(a, host.compareIdxA);
    mkEntry(b, host.compareIdxB);
    document.body.appendChild(menu);
    const mw = menu.offsetWidth;
    menu.style.left = Math.max(4, Math.min(rect.left, window.innerWidth - mw - 8)) + 'px';
    menu.style.top = rect.bottom + 4 + 'px';
    const close = (e: MouseEvent) => {
      if (!menu.contains(e.target as Node)) {
        menu.remove();
        document.removeEventListener('mousedown', close);
      }
    };
    window.setTimeout(() => document.addEventListener('mousedown', close), 0);
  });

  const opacitySlider = document.getElementById('opacity-slider') as HTMLInputElement;
  const opacityVal = document.getElementById('opacity-val');
  opacitySlider?.addEventListener('input', () => {
    host.overlayOpacity = parseInt(opacitySlider.value) / 100;
    if (opacityVal) opacityVal.textContent = opacitySlider.value;
    if (host.compareMode) host.renderAllViews();
  });

  const overlayCmapSelect = document.getElementById('overlay-colormap') as HTMLSelectElement;
  overlayCmapSelect?.addEventListener('change', () => {
    const overlayImg = host.cmpImg(1);
    if (overlayImg) overlayImg.colormap = overlayCmapSelect.value;
    if (host.compareMode) host.renderAllViews();
  });

  // Registration buttons — trigger the affine registration pipeline
  const btnRegMni = document.getElementById('btn-reg-mni') as HTMLButtonElement | null;
  btnRegMni?.addEventListener('click', () => host.registration.startRegistration('mni'));

  const btnRegCustom = document.getElementById('btn-reg-custom') as HTMLButtonElement | null;
  btnRegCustom?.addEventListener('click', () => host.registration.startRegistration('custom'));

  const btnRegCancel = document.getElementById('btn-reg-cancel') as HTMLButtonElement | null;
  btnRegCancel?.addEventListener('click', () => void host.registration.cancel());

  const btnAddImg = document.getElementById('btn-add-img') as HTMLButtonElement;
  btnAddImg?.addEventListener('click', () => {
    host.postMessage({ type: 'selectImage' });
  });

  const btnCrosshair = document.getElementById('btn-crosshair') as HTMLButtonElement;
  btnCrosshair?.addEventListener('click', () => {
    host.crosshairVisible = !host.crosshairVisible;
    btnCrosshair.classList.toggle('active', host.crosshairVisible);
    const coordEl = document.getElementById('coord-info');
    if (host.crosshairVisible) host.updateCoordInfoFromCenter();
    else if (coordEl) coordEl.textContent = 'Hover over image';
    host.renderAllViews();
  });
  if (host.crosshairVisible) btnCrosshair?.classList.add('active');

  // Measurement mode toggle
  const btnMeasure = document.getElementById('btn-measure') as HTMLButtonElement;
  btnMeasure?.addEventListener('click', () => {
    host.measureMode = !host.measureMode;
    btnMeasure.classList.toggle('active', host.measureMode);
    host.measureClickPending = null;
    host.measureDragStart = null;
    // Change cursor on canvases
    for (const axis of ['axial', 'coronal', 'sagittal'] as const) {
      host.canvases[axis].style.cursor = host.measureMode ? 'crosshair' : 'crosshair';
    }
    host.a11yAnnounce(host.measureMode ? 'Measure mode enabled' : 'Measure mode disabled');
  });

  // Clear measurements button
  const btnClearMeasure = document.getElementById('btn-clear-measure') as HTMLButtonElement;
  btnClearMeasure?.addEventListener('click', () => {
    host.clearMeasurements();
    host.a11yAnnounce('Measurements cleared');
  });

  const btnExport = document.getElementById('btn-export') as HTMLButtonElement;
  btnExport?.addEventListener('click', () => {
    if (!host.header) return;
    // Determine which axis to export (maximized or axial default)
    const exportAxis: Axis = (host.maximizedView as Axis) || 'axial';
    const canvas = host.canvases[exportAxis];
    if (!canvas) return;
    canvas.toBlob((blob) => {
      if (!blob) return;
      const reader = new FileReader();
      reader.onload = () => {
        const arrayBuffer = reader.result as ArrayBuffer;
        host.postMessage({
          type: 'exportSlice',
          axis: exportAxis,
          sliceIndex: host.sliceIdx[exportAxis],
          data: Array.from(new Uint8Array(arrayBuffer)),
        });
      };
      reader.readAsArrayBuffer(blob);
    }, 'image/png');
  });

  const btnHeader = document.getElementById('btn-header') as HTMLButtonElement;
  btnHeader?.addEventListener('click', () => {
    host.headerPanelVisible = !host.headerPanelVisible;
    const panel = document.getElementById('header-panel');
    if (panel) panel.style.display = host.headerPanelVisible ? 'block' : 'none';
    btnHeader.classList.toggle('active', host.headerPanelVisible);
    if (host.headerPanelVisible && host.header) host.updateHeaderPanel();
  });

  helpBtn?.addEventListener('click', () => helpPopup.classList.toggle('show'));
  document.addEventListener('click', (e) => {
    if (!helpBtn?.contains(e.target as Node) && !helpPopup?.contains(e.target as Node)) {
      helpPopup?.classList.remove('show');
    }
  });

  const btnIssue = document.getElementById('btn-issue') as HTMLButtonElement;
  btnIssue?.addEventListener('click', () => {
    // Ask the extension host to open the external URL. VS Code will show its
    // standard "open external website" confirmation and then launch the system
    // default browser.
    host.postMessage({ type: 'openExternal', url: 'https://github.com/MaiwulanjiangMaiming/NiftiSpy/issues' });
  });

  sidebarToggle?.addEventListener('click', () => {
    host.sidebarCollapsed = !host.sidebarCollapsed;
    if (host.sidebarCollapsed) {
      host.sidebarWidth = sidebar.offsetWidth;
      sidebar.style.width = '';
      sidebar.style.minWidth = '';
      sidebar.classList.add('collapsed');
      sidebarToggle.style.right = '0px';
    } else {
      sidebar.classList.remove('collapsed');
      sidebar.style.width = host.sidebarWidth + 'px';
      sidebar.style.minWidth = host.sidebarWidth + 'px';
      sidebarToggle.style.right = host.sidebarWidth + 'px';
    }
    sidebarToggle.textContent = host.sidebarCollapsed ? '◀' : '▶';
    host.renderAllViews();
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
    host.sidebarWidth = newWidth;
    sidebarToggle.style.right = newWidth + 'px';
  });

  document.addEventListener('mouseup', () => {
    if (isResizing) {
      isResizing = false;
      sidebar.style.transition = '';
      sidebarToggle.style.transition = '';
      document.body.style.cursor = '';
      host.renderAllViews();
    }
  });

  const bindSlider = (sliderId: string, sideSliderId: string, axis: 'axial' | 'coronal' | 'sagittal') => {
    const handler = (val: number) => {
      host.sliceIdx[axis] = host.validateSliceIndex(axis, val);
      host.a11yAnnounce(`${axis} slice ${host.sliceIdx[axis] + 1}`);
      host.onUserScrollSlices();
      // rAF-coalesced: slider 'input' fires per pixel of drag movement.
      if (host.volumeHasTimepoint(host.timeIdx)) host.scheduleSingleViewRender(axis);
      else {
        void host.refreshSlices([axis], true);
        host.scheduleLODUpgrade(axis);
      }
    };
    const sl = document.getElementById(sliderId) as HTMLInputElement;
    const ssl = document.getElementById(sideSliderId) as HTMLInputElement;
    sl?.addEventListener('input', () => handler(parseInt(sl.value)));
    ssl?.addEventListener('input', () => handler(parseInt(ssl.value)));
  };

  bindSlider('axial-slider', 'axial-slider-side', 'axial');
  bindSlider('coronal-slider', 'coronal-slider-side', 'coronal');
  bindSlider('sagittal-slider', 'sagittal-slider-side', 'sagittal');

  const timeSlider = document.getElementById('time-slider-side') as HTMLInputElement | null;
  timeSlider?.addEventListener('input', () => {
    if (!host.header) return;
    const nt = Math.max(1, host.header.nt || 1);
    host.timeIdx = Math.max(0, Math.min(nt - 1, parseInt(timeSlider.value, 10) || 0));
    host.a11yAnnounce(`time ${host.timeIdx + 1}`);
    host.onUserScrollSlices();
    host.updateSliderValues();
    if (host.volumeHasTimepoint(host.timeIdx)) scheduleRender();
    else void host.refreshSlices(['axial', 'coronal', 'sagittal'], true);
  });

  document.querySelectorAll('.vb').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const view = (e.target as HTMLElement).getAttribute('data-view');
      if (view) host.toggleMaximize(view);
    });
  });

  for (const axis of ['axial', 'coronal', 'sagittal'] as const) {
    const canvas = host.canvases[axis];

    let scrollAccumulator = 0;
    const SCROLL_THRESHOLD = host.perfProfile.tier === 'low' ? 30 : 15;
    let lastScrollTime = 0;

    canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        if (!host.header) return;

        if (e.ctrlKey || e.metaKey) {
          const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;
          host.viewState[axis].zoom = Math.max(0.5, Math.min(10, host.viewState[axis].zoom * zoomFactor));
          scheduleRender();
        } else {
          const now = Date.now();
          const timeDelta = now - lastScrollTime;
          lastScrollTime = now;

          const velocity = timeDelta > 0 ? Math.abs(e.deltaY) / timeDelta : 0;
          const adaptiveStep = velocity > 2 ? 2 : 1;

          scrollAccumulator += e.deltaY * (velocity > 2 ? 0.5 : 1);

          if (Math.abs(scrollAccumulator) >= SCROLL_THRESHOLD) {
            const delta = scrollAccumulator > 0 ? adaptiveStep : -adaptiveStep;
            scrollAccumulator = 0;
            const newIdx = host.validateSliceIndex(axis, host.sliceIdx[axis] + delta);
            if (newIdx !== host.sliceIdx[axis]) {
              host.sliceIdx[axis] = newIdx;
              host.onUserScrollSlices();
              // rAF-coalesced: fast trackpad scrolling fires wheel events
              // faster than the display refresh - paint at most once/frame.
              if (host.volumeHasTimepoint(host.timeIdx)) host.scheduleSingleViewRender(axis);
              else {
                void host.refreshSlices([axis], true);
                host.scheduleLODUpgrade(axis);
              }
            }
          }
        }
      },
      { passive: false },
    );

    let isDragging = false;
    let lastX = 0,
      lastY = 0;
    let dragStartX = 0,
      dragStartY = 0;
    let dragMoved = false;
    let suppressClickUntil = 0;
    let isPinching = false;
    let lastPinchDist = 0;

    canvas.addEventListener('mousedown', (e) => {
      if (e.button === 0) {
        // ROI measurement: click and drag
        if (host.measureMode) {
          const rect = canvas.getBoundingClientRect();
          host.measureDragStart = { x: e.clientX - rect.left, y: e.clientY - rect.top, axis };
          host.measureClickPending = null; // Cancel any pending line click
          return;
        }
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
        host.viewState[axis].panX += dx;
        host.viewState[axis].panY += dy;
        if (Math.abs(e.clientX - dragStartX) > 3 || Math.abs(e.clientY - dragStartY) > 3) {
          dragMoved = true;
        }
        lastX = e.clientX;
        lastY = e.clientY;
        host.updateSingleView(axis);
      }
    });

    document.addEventListener('mouseup', (e) => {
      // ROI measurement: complete drag
      if (host.measureMode && host.measureDragStart && host.measureDragStart.axis === axis) {
        const rect = canvas.getBoundingClientRect();
        const endX = e.clientX - rect.left;
        const endY = e.clientY - rect.top;
        const dx = Math.abs(endX - host.measureDragStart.x);
        const dy = Math.abs(endY - host.measureDragStart.y);
        if (dx > 5 || dy > 5) {
          const area = host.computeRoiArea(axis, host.measureDragStart.x, host.measureDragStart.y, endX, endY);
          host.measurements.push({
            type: 'roi',
            axis,
            x1: host.measureDragStart.x,
            y1: host.measureDragStart.y,
            x2: endX,
            y2: endY,
            area,
          });
          host.drawMeasurements(host.measurements, host.highContrastPreferred);
          host.a11yAnnounce(`ROI area: ${area.toFixed(2)} mm²`);
        }
        host.measureDragStart = null;
        return;
      }
      if (isDragging) {
        isDragging = false;
        canvas.style.cursor = 'crosshair';
        if (dragMoved) suppressClickUntil = Date.now() + 180;
      }
    });

    canvas.addEventListener(
      'touchstart',
      (e) => {
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
      },
      { passive: true },
    );

    canvas.addEventListener(
      'touchmove',
      (e) => {
        if (isPinching && e.touches.length === 2) {
          const dx = e.touches[0].clientX - e.touches[1].clientX;
          const dy = e.touches[0].clientY - e.touches[1].clientY;
          const dist = Math.sqrt(dx * dx + dy * dy);
          const scale = dist / lastPinchDist;
          host.viewState[axis].zoom = Math.max(0.5, Math.min(10, host.viewState[axis].zoom * scale));
          lastPinchDist = dist;
          host.updateSingleView(axis);
        } else if (isDragging && e.touches.length === 1) {
          const dx = e.touches[0].clientX - lastX;
          const dy = e.touches[0].clientY - lastY;
          host.viewState[axis].panX += dx;
          host.viewState[axis].panY += dy;
          if (Math.abs(e.touches[0].clientX - dragStartX) > 3 || Math.abs(e.touches[0].clientY - dragStartY) > 3) {
            dragMoved = true;
          }
          lastX = e.touches[0].clientX;
          lastY = e.touches[0].clientY;
          host.updateSingleView(axis);
        }
      },
      { passive: true },
    );

    canvas.addEventListener('touchend', () => {
      if (isDragging && dragMoved) suppressClickUntil = Date.now() + 180;
      isDragging = false;
      isPinching = false;
    });

    canvas.addEventListener('click', (e) => {
      if (Date.now() < suppressClickUntil) return;
      if (!host.header) return;
      const rect = canvas.getBoundingClientRect();
      const clickX = e.clientX - rect.left;
      const clickY = e.clientY - rect.top;

      // Measurement mode: line measurement (click two points)
      if (host.measureMode && !host.measureDragStart) {
        if (!host.measureClickPending) {
          host.measureClickPending = { x: clickX, y: clickY, axis };
        } else if (host.measureClickPending.axis === axis) {
          const distance = host.computeLineDistance(
            axis,
            host.measureClickPending.x,
            host.measureClickPending.y,
            clickX,
            clickY,
          );
          host.measurements.push({
            type: 'line',
            axis,
            x1: host.measureClickPending.x,
            y1: host.measureClickPending.y,
            x2: clickX,
            y2: clickY,
            distance,
          });
          host.measureClickPending = null;
          host.drawMeasurements(host.measurements, host.highContrastPreferred);
          host.a11yAnnounce(`Line measurement: ${distance.toFixed(2)} mm`);
        } else {
          host.measureClickPending = { x: clickX, y: clickY, axis };
        }
        return;
      }

      if (host.compareMode && host.compareLayout === 'sideBySide' && host.images.length >= 2) {
        const img0 = host.cmpImg(0);
        const img1 = host.cmpImg(1);
        if (!img0 || !img1) return;
        const h0 = img0.header;
        const h1 = img1.header;
        const halfW = rect.width / 2;
        const vs = host.viewState[axis];
        const isRight = clickX >= halfW;

        // When img1 is aligned its slice is drawn on img0's grid, so BOTH
        // halves map clicks through img0 geometry; the native-grid path only
        // applies to an unaligned right half.
        if (isRight && !img1.align) {
          // The painter stretches img1 into the UNIFIED physical-extent box
          // (max extent of both images, fit to the half container) — the
          // inverse click mapping must use the SAME box, not img1's own
          // aspect, or the picked voxel drifts whenever the two images'
          // aspects differ.
          const pw0m = axis === 'sagittal' ? h0!.ny * h0!.dy : h0!.nx * h0!.dx;
          const ph0m = axis === 'axial' ? h0!.ny * h0!.dy : h0!.nz * h0!.dz;
          const pw1 = axis === 'sagittal' ? h1!.ny * h1!.dy : h1!.nx * h1!.dx;
          const ph1 = axis === 'axial' ? h1!.ny * h1!.dy : h1!.nz * h1!.dz;
          const unifiedAR = Math.max(pw0m, pw1) / Math.max(ph0m, ph1);
          let cw1: number, ch1: number;
          if (halfW / rect.height > unifiedAR) {
            ch1 = rect.height;
            cw1 = ch1 * unifiedAR;
          } else {
            cw1 = halfW;
            ch1 = cw1 / unifiedAR;
          }
          cw1 *= vs.zoom;
          ch1 *= vs.zoom;
          const imgLeft1 = halfW + (halfW - cw1) / 2 + vs.panX;
          const imgTop1 = (rect.height - ch1) / 2 + vs.panY;
          if (clickX < imgLeft1 || clickX > imgLeft1 + cw1 || clickY < imgTop1 || clickY > imgTop1 + ch1) return;
          const nx_click = (clickX - imgLeft1) / cw1;
          const ny_click = (clickY - imgTop1) / ch1;
          const w1 = axis === 'sagittal' ? h1!.ny : h1!.nx;
          const h1_ = axis === 'axial' ? h1!.ny : h1!.nz;
          // The SBS painter draws img1 with ITS OWN orientation flips; the
          // click must be inverted through the same flips or the crosshair
          // lands mirrored (e.g. sagittal views of L-positive templates).
          const flips1 = host.computeFlipsForHeader(h1!)[axis as 'axial' | 'coronal' | 'sagittal'];
          const cx1n = flips1.flipX ? 1 - nx_click : nx_click;
          const cy1n = flips1.flipY ? ny_click : 1 - ny_click;
          let vx: number, vy: number, vz: number;
          // Third axis: sliceIdx is in img0's grid — it must be mapped
          // through world space into img1's grid before building the img1
          // voxel. Feeding img0's raw index to voxelToWorld(h1, ...) put the
          // world point on the wrong slice whenever the two volumes differ
          // in extent/origin (exactly the unaligned case), so the resulting
          // crosshair landed on unrelated anatomy.
          const [wx0, wy0, wz0] = host.voxelToWorld(
            h0!,
            host.sliceIdx.sagittal,
            host.sliceIdx.coronal,
            host.sliceIdx.axial,
          );
          const [tvx, tvy, tvz] = host.worldToVoxel(h1!, wx0, wy0, wz0);
          if (axis === 'axial') {
            vx = cx1n * w1;
            vy = cy1n * h1_;
            vz = tvz;
          } else if (axis === 'coronal') {
            vx = cx1n * w1;
            vy = tvy;
            vz = cy1n * h1_;
          } else {
            vx = tvx;
            vy = cx1n * w1;
            vz = cy1n * h1_;
          }
          const [wx, wy, wz] = host.voxelToWorld(h1!, vx, vy, vz);
          const [svx, svy, svz] = host.worldToVoxel(h0!, wx, wy, wz);
          host.sliceIdx.sagittal = Math.max(0, Math.min(h0!.nx - 1, Math.round(svx)));
          host.sliceIdx.coronal = Math.max(0, Math.min(h0!.ny - 1, Math.round(svy)));
          host.sliceIdx.axial = Math.max(0, Math.min(h0!.nz - 1, Math.round(svz)));
        } else {
          // img0-voxel mapping: the LEFT half always, AND the right half
          // when img1 is aligned — an aligned slice is drawn in img0's voxel
          // frame shifted by halfW (no world round-trip through img1 needed).
          // Previously an aligned right-half click fell through here with
          // the left-half geometry, so the out-of-bounds check rejected it
          // and the crosshair never moved.
          const pw0 = axis === 'sagittal' ? h0!.ny * h0!.dy : h0!.nx * h0!.dx;
          const ph0 = axis === 'axial' ? h0!.ny * h0!.dy : h0!.nz * h0!.dz;
          const ar0 = pw0 / ph0;
          let cw0: number, ch0: number;
          if (halfW / rect.height > ar0) {
            ch0 = rect.height;
            cw0 = ch0 * ar0;
          } else {
            cw0 = halfW;
            ch0 = cw0 / ar0;
          }
          cw0 *= vs.zoom;
          ch0 *= vs.zoom;
          const imgLeft0 = (isRight ? halfW : 0) + (halfW - cw0) / 2 + vs.panX;
          const imgTop0 = (rect.height - ch0) / 2 + vs.panY;
          if (clickX < imgLeft0 || clickX > imgLeft0 + cw0 || clickY < imgTop0 || clickY > imgTop0 + ch0) return;
          const nx_click = (clickX - imgLeft0) / cw0;
          const ny_click = (clickY - imgTop0) / ch0;
          const w0 = axis === 'sagittal' ? h0!.ny : h0!.nx;
          const h0_ = axis === 'axial' ? h0!.ny : h0!.nz;
          // Mirror the img0 flips used by the SBS painter (same rationale
          // as the img1 half above).
          const flips0 = host.computeFlipsForHeader(h0!)[axis as 'axial' | 'coronal' | 'sagittal'];
          const cx0n = flips0.flipX ? 1 - nx_click : nx_click;
          const cy0n = flips0.flipY ? ny_click : 1 - ny_click;
          if (axis === 'axial') {
            host.sliceIdx.sagittal = Math.max(0, Math.min(h0!.nx - 1, Math.floor(cx0n * w0)));
            host.sliceIdx.coronal = Math.max(0, Math.min(h0!.ny - 1, Math.floor(cy0n * h0_)));
          } else if (axis === 'coronal') {
            host.sliceIdx.sagittal = Math.max(0, Math.min(h0!.nx - 1, Math.floor(cx0n * w0)));
            host.sliceIdx.axial = Math.max(0, Math.min(h0!.nz - 1, Math.floor(cy0n * h0_)));
          } else {
            host.sliceIdx.coronal = Math.max(0, Math.min(h0!.ny - 1, Math.floor(cx0n * w0)));
            host.sliceIdx.axial = Math.max(0, Math.min(h0!.nz - 1, Math.floor(cy0n * h0_)));
          }
        }
        if (host.volumeHasTimepoint(host.timeIdx)) host.renderAllViews();
        else void host.refreshSlices(['axial', 'coronal', 'sagittal']);
        return;
      }

      // Overlay compare paints from the compare pair (img0), NOT the active
      // image — click mapping must use img0's header and orientation flips,
      // otherwise picking lands on the wrong voxel once the active image and
      // img0 diverge.
      const overlayImg =
        host.compareMode && host.compareLayout === 'overlay' && host.images.length >= 2 ? host.cmpImg(0) : null;
      const hpick = overlayImg ? overlayImg.header : host.header;
      if (!hpick) return;
      const { nx, ny, nz, dx, dy, dz } = hpick;
      const pixelW = axis === 'sagittal' ? ny * dy : nx * dx;
      const pixelH = axis === 'axial' ? ny * dy : nz * dz;
      const ar = pixelW / pixelH;
      const vs = host.viewState[axis];
      let cw: number, ch: number;
      if (rect.width / rect.height > ar) {
        ch = rect.height;
        cw = ch * ar;
      } else {
        cw = rect.width;
        ch = cw / ar;
      }
      cw *= vs.zoom;
      ch *= vs.zoom;

      const imgLeft = (rect.width - cw) / 2 + vs.panX;
      const imgTop = (rect.height - ch) / 2 + vs.panY;

      if (clickX < imgLeft || clickX > imgLeft + cw || clickY < imgTop || clickY > imgTop + ch) return;

      const flips = overlayImg
        ? host.computeFlipsForHeader(hpick)[axis as 'axial' | 'coronal' | 'sagittal']
        : host.viewFlips[axis] || { flipX: false, flipY: false };
      const nx_click = (clickX - imgLeft) / cw;
      const ny_click = (clickY - imgTop) / ch;
      // The renderer may flip the image horizontally/vertically based on
      // the sform orientation. Click coordinates must be transformed with
      // the same flip so that the crosshair jumps to the clicked voxel.
      const cx_norm = flips.flipX ? 1 - nx_click : nx_click;
      const cy_norm = flips.flipY ? ny_click : 1 - ny_click;

      if (axis === 'axial') {
        host.sliceIdx.sagittal = Math.max(0, Math.min(nx - 1, Math.floor(cx_norm * nx)));
        host.sliceIdx.coronal = Math.max(0, Math.min(ny - 1, Math.floor(cy_norm * ny)));
      } else if (axis === 'coronal') {
        host.sliceIdx.sagittal = Math.max(0, Math.min(nx - 1, Math.floor(cx_norm * nx)));
        host.sliceIdx.axial = Math.max(0, Math.min(nz - 1, Math.floor(cy_norm * nz)));
      } else {
        host.sliceIdx.coronal = Math.max(0, Math.min(ny - 1, Math.floor(cx_norm * ny)));
        host.sliceIdx.axial = Math.max(0, Math.min(nz - 1, Math.floor(cy_norm * nz)));
      }

      if (host.volumeHasTimepoint(host.timeIdx)) host.renderAllViews();
      else void host.refreshSlices(['axial', 'coronal', 'sagittal']);
    });

    canvas.addEventListener('mousemove', (e) => {
      if (!host.header) return;
      if (host.crosshairVisible) {
        host.updateCoordInfoFromCenter();
        return;
      }
      const rect = canvas.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;
      const coordEl = document.getElementById('coord-info');
      if (!coordEl) return;

      if (host.compareMode && host.images.length >= 2) {
        const img0 = host.cmpImg(0);
        const img1 = host.cmpImg(1);
        if (!img0?.data || !img1?.data) {
          coordEl.textContent = '';
          return;
        }
        const h0 = img0.header;
        const vs = host.viewState[axis];

        if (host.compareLayout === 'sideBySide') {
          const halfW = rect.width / 2;
          const isRight = mouseX >= halfW;
          // Coordinate mapping: an aligned right half is drawn on img0's
          // grid, so map through img0 geometry there as well.
          const img = isRight && img1.align ? img0 : isRight ? img1 : img0;
          const hi = img.header;
          const pw = axis === 'sagittal' ? hi!.ny * hi!.dy : hi!.nx * hi!.dx;
          const ph = axis === 'axial' ? hi!.ny * hi!.dy : hi!.nz * hi!.dz;
          const ar = pw / ph;
          let iw: number, ih: number;
          if (halfW / rect.height > ar) {
            ih = rect.height;
            iw = ih * ar;
          } else {
            iw = halfW;
            ih = iw / ar;
          }
          iw *= vs.zoom;
          ih *= vs.zoom;
          const il = (isRight ? halfW : 0) + (halfW - iw) / 2 + vs.panX;
          const it = (rect.height - ih) / 2 + vs.panY;
          if (mouseX < il || mouseX > il + iw || mouseY < it || mouseY > it + ih) {
            coordEl.textContent = '';
            return;
          }
          const nx_m = (mouseX - il) / iw;
          const ny_m = (mouseY - it) / ih;
          const w = axis === 'sagittal' ? hi!.ny : hi!.nx;
          const h_ = axis === 'axial' ? hi!.ny : hi!.nz;
          // Invert the per-side orientation flips used by the SBS painter.
          const mf = host.computeFlipsForHeader(hi!)[axis as 'axial' | 'coronal' | 'sagittal'];
          const cx_m = mf.flipX ? 1 - nx_m : nx_m;
          const cy_m = mf.flipY ? ny_m : 1 - ny_m;
          let px: number, py: number, pz: number;
          if (axis === 'axial') {
            px = Math.floor(cx_m * w);
            py = Math.floor(cy_m * h_);
            pz = host.sliceIdx.axial;
          } else if (axis === 'coronal') {
            px = Math.floor(cx_m * w);
            pz = Math.floor(cy_m * h_);
            py = host.sliceIdx.coronal;
          } else {
            py = Math.floor(cx_m * w);
            pz = Math.floor(cy_m * h_);
            px = host.sliceIdx.sagittal;
          }
          if (px >= 0 && px < hi!.nx && py >= 0 && py < hi!.ny && pz >= 0 && pz < hi!.nz) {
            const other = isRight ? img0 : img1;
            if (!img.data || !other.data) {
              coordEl.textContent = '';
              return;
            }
            const val = img.data[pz * hi!.ny * hi!.nx + py * hi!.nx + px] * img.slope + img.inter;
            const [wx, wy, wz] = host.voxelToWorld(hi!, px, py, pz);
            // Align-aware sampling for the counterpart value.
            const ov = host.compareRenderer.sampleImageAtWorld(other, wx, wy, wz);
            const otherVal: string = ov === null ? '---' : ov.toFixed(4);
            const name0 = isRight ? other.name : img.name;
            const name1 = isRight ? img.name : other.name;
            const v0 = isRight ? otherVal : val.toFixed(4);
            const v1 = isRight ? val.toFixed(4) : otherVal;
            coordEl.textContent = `${name0}: ${v0}\n${name1}: ${v1}`;
          }
        } else {
          const { nx, ny, nz, dx, dy, dz } = h0!;
          const pixelW = axis === 'sagittal' ? ny * dy : nx * dx;
          const pixelH = axis === 'axial' ? ny * dy : nz * dz;
          const ar = pixelW / pixelH;
          let imgW: number, imgH: number;
          if (rect.width / rect.height > ar) {
            imgH = rect.height;
            imgW = imgH * ar;
          } else {
            imgW = rect.width;
            imgH = imgW / ar;
          }
          imgW *= vs.zoom;
          imgH *= vs.zoom;
          const imgLeft = (rect.width - imgW) / 2 + vs.panX;
          const imgTop = (rect.height - imgH) / 2 + vs.panY;
          if (mouseX < imgLeft || mouseX > imgLeft + imgW || mouseY < imgTop || mouseY > imgTop + imgH) {
            coordEl.textContent = '';
            return;
          }
          const nx_mouse = (mouseX - imgLeft) / imgW;
          const ny_mouse = (mouseY - imgTop) / imgH;
          let px: number, py: number, pz: number;
          if (axis === 'axial') {
            px = Math.floor(nx_mouse * nx);
            py = Math.floor((1 - ny_mouse) * ny);
            pz = host.sliceIdx.axial;
          } else if (axis === 'coronal') {
            px = Math.floor(nx_mouse * nx);
            pz = Math.floor((1 - ny_mouse) * nz);
            py = host.sliceIdx.coronal;
          } else {
            py = Math.floor(nx_mouse * ny);
            pz = Math.floor((1 - ny_mouse) * nz);
            px = host.sliceIdx.sagittal;
          }
          if (px >= 0 && px < nx && py >= 0 && py < ny && pz >= 0 && pz < nz) {
            if (!img0.data || !img1.data) {
              coordEl.textContent = '';
              return;
            }
            const val0 = img0.data[pz * ny * nx + py * nx + px] * img0.slope + img0.inter;
            const [wx, wy, wz] = host.voxelToWorld(h0!, px, py, pz);
            const ov = host.compareRenderer.sampleImageAtWorld(img1, wx, wy, wz);
            const val1Str: string = ov === null ? '---' : ov.toFixed(4);
            coordEl.textContent = `${img0.name}: ${val0.toFixed(4)}\n${img1.name}: ${val1Str}`;
          }
        }
        return;
      }

      const { nx, ny, nz, dx, dy, dz } = host.header;
      const pixelW = axis === 'sagittal' ? ny * dy : nx * dx;
      const pixelH = axis === 'axial' ? ny * dy : nz * dz;
      const ar = pixelW / pixelH;
      const vs = host.viewState[axis];
      let imgW: number, imgH: number;
      if (rect.width / rect.height > ar) {
        imgH = rect.height;
        imgW = imgH * ar;
      } else {
        imgW = rect.width;
        imgH = imgW / ar;
      }
      imgW *= vs.zoom;
      imgH *= vs.zoom;

      const imgLeft = (rect.width - imgW) / 2 + vs.panX;
      const imgTop = (rect.height - imgH) / 2 + vs.panY;

      if (mouseX < imgLeft || mouseX > imgLeft + imgW || mouseY < imgTop || mouseY > imgTop + imgH) return;

      const flips = host.viewFlips[axis] || { flipX: false, flipY: false };
      const nx_mouse = (mouseX - imgLeft) / imgW;
      const ny_mouse = (mouseY - imgTop) / imgH;
      const cx_norm = flips.flipX ? 1 - nx_mouse : nx_mouse;
      const cy_norm = flips.flipY ? ny_mouse : 1 - ny_mouse;

      let px: number, py: number, pz: number;

      if (axis === 'axial') {
        px = Math.floor(cx_norm * nx);
        py = Math.floor(cy_norm * ny);
        pz = host.sliceIdx.axial;
      } else if (axis === 'coronal') {
        px = Math.floor(cx_norm * nx);
        pz = Math.floor(cy_norm * nz);
        py = host.sliceIdx.coronal;
      } else {
        py = Math.floor(cx_norm * ny);
        pz = Math.floor(cy_norm * nz);
        px = host.sliceIdx.sagittal;
      }

      if (px >= 0 && px < nx && py >= 0 && py < ny && pz >= 0 && pz < nz) {
        let val: number | null = null;
        if (host.volumeData) {
          val = host.volumeData[pz * ny * nx + py * nx + px] * host.dataSlope + host.dataInter;
        } else {
          const frame = host.currentSlices[axis];
          const geometry = host.getAxisGeometry(axis);
          if (frame) {
            const sx = Math.max(
              0,
              Math.min(
                frame.width - 1,
                Math.floor((px / Math.max(1, geometry.width - 1)) * Math.max(1, frame.width - 1)),
              ),
            );
            const syBase = axis === 'axial' ? py : pz;
            const sy = Math.max(
              0,
              Math.min(
                frame.height - 1,
                Math.floor((syBase / Math.max(1, geometry.height - 1)) * Math.max(1, frame.height - 1)),
              ),
            );
            val = frame.data[sy * frame.width + sx];
          }
        }
        if (val !== null) coordEl.textContent = `x=${px} y=${py} z=${pz}\nValue: ${val.toFixed(4)}`;
      }
    });

    const minimap = canvas.parentElement?.querySelector('.minimap') as HTMLDivElement;
    minimap?.addEventListener('click', (e) => {
      if (!host.header || host.viewState[axis].zoom <= 1.1) return;
      e.stopPropagation();
      const rect = minimap.getBoundingClientRect();
      const mx = (e.clientX - rect.left) / rect.width;
      const my = (e.clientY - rect.top) / rect.height;

      const zoom = host.viewState[axis].zoom;
      const container = canvas.parentElement!;
      const dw = container.clientWidth;
      const dh = container.clientHeight;

      // Compute displayed image size (same as paintSlice)
      const pixelW =
        axis === 'axial'
          ? host.header.nx * host.header.dx
          : axis === 'coronal'
            ? host.header.nx * host.header.dx
            : host.header.ny * host.header.dy;
      const pixelH =
        axis === 'axial'
          ? host.header.ny * host.header.dy
          : axis === 'coronal'
            ? host.header.nz * host.header.dz
            : host.header.nz * host.header.dz;
      const ar = pixelW / pixelH;
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

      // Pan limits match paintSlice exactly
      const maxPanX = Math.max(0, (cw - dw) / 2);
      const maxPanY = Math.max(0, (ch - dh) / 2);

      const effectiveMx = 1 - mx;
      const effectiveMy = 1 - my;
      host.viewState[axis].panX = (effectiveMx - 0.5) * 2 * maxPanX;
      host.viewState[axis].panY = (effectiveMy - 0.5) * 2 * maxPanY;

      host.updateSingleView(axis);
    });
  }

  const mipCanvas = host.canvases.mip;
  let mipDragging = false;
  // Pose captured at drag start: the rotation for the whole gesture is
  // recomputed from (dragStart, current pointer) each frame instead of
  // integrating tiny per-move steps. Step-wise integration mixed roll into
  // the trackball axes and the volume ended up wildly tilted after a few
  // gestures; gesture-relative composition keeps each drag a clean
  // rotation around the captured pose.
  let mipDragStartX = 0,
    mipDragStartY = 0;
  let mipDragStartRot: number[] = host.mipIdentity.slice();

  mipCanvas.addEventListener('mousedown', (e) => {
    mipDragging = true;
    mipDragStartX = e.clientX;
    mipDragStartY = e.clientY;
    mipDragStartRot = host.viewState.mip.rot.slice();
    if (!host.mipInitialized) {
      host.mipInitialized = true;
      host.paintMIP();
    }
    mipCanvas.style.cursor = 'grabbing';
  });

  document.addEventListener('mousemove', (e) => {
    if (mipDragging) {
      const dx = e.clientX - mipDragStartX;
      const dy = e.clientY - mipDragStartY;
      // Screen-space arcball: ONE rotation around the screen-plane axis
      // perpendicular to the drag direction, applied to the captured start
      // pose. Turntable-style orbit — the rotation direction is inverted
      // relative to grabbing semantics: drag down → top leans away from the
      // viewer; drag right → front surface moves left. Because the axis is
      // in the screen plane and the rotation is recomputed against the
      // gesture-start pose, no roll can accumulate across drags.
      const len = Math.hypot(dx, dy);
      if (len > 0) {
        const S = host.rotAxisAngle(-dy, dx, 0, len * 0.01);
        host.viewState.mip.rot = host.mul3(S, mipDragStartRot);
      }
      // A full CPU MIP takes tens-to-hundreds of ms; painting synchronously
      // per mousemove queued up events faster than frames and made dragging
      // stutter. Coalesce to one (reduced-quality) render per display frame
      // instead; the drag end handler schedules the full-quality pass.
      host.scheduleMIPRender(true);
    }
  });

  document.addEventListener('mouseup', () => {
    if (mipDragging) {
      mipDragging = false;
      mipCanvas.style.cursor = 'crosshair';
      host.scheduleMIPRender(false);
    }
  });

  let resizeTimer: ReturnType<typeof setTimeout> | null = null;
  window.addEventListener('resize', () => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => host.renderAllViews(), 150);
  });

  // Direct keyboard shortcuts in webview
  document.addEventListener('keydown', (e) => {
    if (e.altKey) {
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        host.handleKeyboardAction('scrollSliceUp');
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        host.handleKeyboardAction('scrollSliceDown');
      } else if (e.key === 'a') {
        e.preventDefault();
        host.handleKeyboardAction('setViewAxial');
      } else if (e.key === 'c') {
        e.preventDefault();
        host.handleKeyboardAction('setViewCoronal');
      } else if (e.key === 's') {
        e.preventDefault();
        host.handleKeyboardAction('setViewSagittal');
      } else if (e.key === 'r') {
        e.preventDefault();
        host.handleKeyboardAction('resetView');
      }
    }
    // Accessibility: Escape exits measure mode
    if (e.key === 'Escape' && host.measureMode) {
      host.measureMode = false;
      host.measureClickPending = null;
      host.measureDragStart = null;
      const btnM = document.getElementById('btn-measure') as HTMLButtonElement;
      if (btnM) btnM.classList.remove('active');
      host.a11yAnnounce('Measure mode disabled');
    }
  });

  // Accessibility: keyboard focus management for canvases
  for (const axis of ['axial', 'coronal', 'sagittal'] as const) {
    const canvas = host.canvases[axis];
    canvas.addEventListener('focus', () => {
      host.focusedCanvas = axis;
    });
    canvas.addEventListener('blur', () => {
      if (host.focusedCanvas === axis) host.focusedCanvas = null;
    });
    canvas.addEventListener('keydown', (e) => {
      if (!host.header) return;
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        const delta = e.key === 'ArrowUp' ? -1 : 1;
        const max =
          axis === 'axial' ? host.header.nz - 1 : axis === 'coronal' ? host.header.ny - 1 : host.header.nx - 1;
        const newIdx = Math.max(0, Math.min(max, host.sliceIdx[axis] + delta));
        if (newIdx !== host.sliceIdx[axis]) {
          host.sliceIdx[axis] = newIdx;
          if (host.volumeHasTimepoint(host.timeIdx)) host.updateSingleView(axis);
          else {
            void host.refreshSlices([axis], true);
            host.scheduleLODUpgrade(axis);
          }
          host.a11yAnnounce(`${axis} slice ${newIdx + 1} of ${max + 1}`);
        }
      }
    });
    // WebGL context loss is watched on the renderer's private GL canvas
    // (see WebGLRenderer.watchContextLoss) - the display canvas holds a 2D
    // context and never emits webglcontextlost.
  }

  // Volume-mode drag/zoom only matters when the raycaster is in use, but the
  // listeners are inert in slice mode and are registered exactly once here.
  host.setupVolumeInteraction();

  // High contrast media query listener
  try {
    window.matchMedia('(prefers-contrast: more)').addEventListener('change', (e) => {
      host.highContrastPreferred = e.matches;
      host.renderAllViews();
    });
  } catch {
    /* optional API unavailable */
  }
}
