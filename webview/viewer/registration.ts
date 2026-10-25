import { errorMessage } from '../../src/errors';
import type { NiiHeader } from '../../src/nifti/headerParser';
import type { TypedArray, VolumeImage } from './types';

interface RegProgressMessage {
  phase?: string;
  pct?: number;
}

interface RegResultMessage {
  alignM?: number[];
  cost?: number;
  costMode?: string;
  durationMs?: number;
  nx: number;
  ny: number;
  nz: number;
  dx: number;
  dy: number;
  dz: number;
  orientation?: NiiHeader['orientation'];
  srow_x: number[];
  srow_y: number[];
  srow_z: number[];
  tplData: ArrayBuffer;
  tplMax: number;
  tplMin: number;
  tplName: string;
}

interface RegLaunchOptions {
  mode: string;
  name?: string;
  bytes?: number;
}
interface RegInitMessage extends RegLaunchOptions {
  type: string;
  tplName?: string;
  template?: Uint8Array;
  moving?: {
    data: ArrayBuffer;
    datatype: number;
    littleEndian: boolean;
    slope: number;
    inter: number;
    dims: number[];
    srow_x: number[];
    srow_y: number[];
    srow_z: number[];
  };
  templateVolume?: {
    data: ArrayBuffer;
    dims: number[];
    srow_x: number[];
    srow_y: number[];
    srow_z: number[];
  };
}

export interface RegistrationHost {
  getImages(): VolumeImage[];
  getActiveIndex(): number;
  getHeader(): NiiHeader | null;
  getVolumeData(): TypedArray | null;
  isFullVolumeLoaded(): boolean;
  ensureFullVolume(): Promise<boolean>;
  ensureImage(index: number, priority: 'active' | 'background', reason: 'user' | 'auto'): Promise<void>;
  getComparedImage(which: 0 | 1): VolumeImage | null;
  getCompareIndices(): { a: number; b: number };
  setCompareIndices(a: number, b: number): void;
  enterCompareOverlayUI(): void;
  clearCompareCaches(): void;
  showToast(text: string): void;
  postMessage(message: Record<string, unknown>): void;
  getRegWorkerUrl(): string | undefined;
  getCachedRegWorkerUrl(): string | undefined;
  setCachedRegWorkerUrl(url: string): void;
}

/** Registration/align worker lifecycle and result application. */
export class RegistrationController {
  constructor(private readonly host: RegistrationHost) {}

  private regWorker: Worker | null = null;
  private regBusy = false;
  // Which flow produced the running registration: 'register' aligns the active
  // image to an MNI/custom template; 'align' aligns one compared image onto the
  // other (chosen reference). Indices captured at launch survive user switching.
  private regFlow: 'register' | 'align' = 'register';
  private regSourceIdx = -1; // image the transform will be attached to (moving)
  private regRefIdx = -1; // reference image index (align flow only)

  private async ensureRegWorkerUrl(): Promise<string> {
    const cached = this.host.getCachedRegWorkerUrl();
    if (cached) return cached;
    const resp = await fetch(this.host.getRegWorkerUrl()!);
    if (!resp.ok) throw new Error(`Reg worker fetch failed: ${resp.status}`);
    const src = await resp.text();
    const url = URL.createObjectURL(new Blob([src], { type: 'application/javascript' }));
    this.host.setCachedRegWorkerUrl(url);
    return url;
  }

  private setRegButtonsEnabled(enabled: boolean): void {
    for (const id of ['btn-reg-mni', 'btn-reg-custom', 'btn-align'] as const) {
      const b = document.getElementById(id) as HTMLButtonElement | null;
      if (b) b.disabled = !enabled;
    }
  }

  /** kind 'idle' resets the box to neutral text; 'busy' shows the progress track. */
  private showRegStatus(kind: 'busy' | 'ok' | 'fail' | 'idle', text: string, pct?: number): void {
    const box = document.getElementById('reg-status');
    const txt = document.getElementById('reg-status-text');
    const fill = document.getElementById('reg-fill');
    if (!box || !txt || !fill) return;
    box.classList.remove('reg-hidden', 'busy', 'ok', 'fail');
    txt.textContent = text;
    if (kind === 'busy') {
      box.classList.add('busy');
      fill.style.width = `${Math.max(0, Math.min(100, Math.round((pct ?? 0) * 100)))}%`;
    } else if (kind !== 'idle') {
      box.classList.add(kind);
      fill.style.width = kind === 'ok' ? '100%' : '0%';
    }
    this.setRegButtonsEnabled(kind !== 'busy');
    const cancelBtn = document.getElementById('btn-reg-cancel') as HTMLButtonElement | null;
    if (cancelBtn) cancelBtn.style.display = kind === 'busy' ? 'inline-block' : 'none';
  }

  private terminateRegWorker(): void {
    if (this.regWorker) {
      this.regWorker.terminate();
      this.regWorker = null;
    }
    this.regBusy = false;
  }

  isBusy(): boolean {
    return this.regBusy;
  }

  handleTemplateData(m: RegLaunchOptions): void {
    if (!this.regBusy) return;
    void this.launchRegWorker(m);
  }

  startRegistration(mode: 'mni' | 'custom'): void {
    if (this.regBusy) return;
    void (async () => {
      const ok = await this.host.ensureFullVolume();
      if (!ok) {
        this.showRegStatus('fail', 'Could not load the full volume — registration needs all voxels.');
        return;
      }
      if (!this.host.getHeader() || !this.host.getVolumeData() || !this.host.isFullVolumeLoaded()) {
        this.showRegStatus('fail', 'Load the full volume first — registration needs all voxels.');
        return;
      }
      this.regBusy = true;
      this.regFlow = 'register';
      this.regSourceIdx = this.host.getActiveIndex();
      this.regRefIdx = -1;
      this.showRegStatus('busy', mode === 'mni' ? 'Resolving MNI template…' : 'Pick a template volume…', 0);
      this.host.postMessage({ type: 'getTemplate', mode });
    })();
  }

  async cancel(): Promise<void> {
    if (!this.regBusy) return;
    this.terminateRegWorker();
    this.showRegStatus('idle', 'Registration cancelled.');
  }

  private handleRegProgress(d: RegProgressMessage): void {
    if (!this.regBusy) return;
    this.showRegStatus('busy', d.phase ? `${d.phase}… ${Math.round((d.pct ?? 0) * 100)}%` : 'Registering…', d.pct);
  }

  handleHostFailure(message: string, cancelled: boolean): void {
    this.terminateRegWorker();
    if (cancelled) this.showRegStatus('idle', 'Registration cancelled.');
    else this.showRegStatus('fail', `Registration failed: ${message}`);
    console.error('[NiftiSpy] Registration:', message);
  }

  private async launchRegWorker(m: RegLaunchOptions): Promise<void> {
    try {
      this.showRegStatus('busy', `Registering to ${m.name}…`, 0);
      const srcImg = this.host.getImages()[this.regSourceIdx];
      if (!srcImg?.data) throw new Error('Source volume missing');
      const h = srcImg.header;
      const src = srcImg.data;
      // Platform-ordered float copy of the leading sub-volume (4D inputs
      // contribute their first timepoint). Shipping decoded values instead of
      // raw bytes keeps endianness handling identical to what is on screen;
      // slope/inter are forwarded so the optimizer sees the shown intensities.
      const vox3d = h!.nx * h!.ny * h!.nz;
      const floats = new Float32Array(vox3d);
      const lim = Math.min(vox3d, src.length);
      for (let i = 0; i < lim; i++) floats[i] = src[i];

      const old = this.regWorker;
      this.regWorker = new Worker(await this.ensureRegWorkerUrl());
      old?.terminate();

      const w = this.regWorker;
      w.onmessage = (ev: MessageEvent) => {
        const d = ev.data;
        if (d?.type === 'regProgress') this.handleRegProgress(d);
        else if (d?.type === 'regResult') this.finishRegistration(d);
        else if (d?.type === 'regError') this.handleHostFailure(d.message || 'Registration failed', false);
      };
      w.onerror = () => this.handleHostFailure('Registration worker crashed', false);

      const msg: RegInitMessage = {
        type: 'initReg',
        mode: m.mode,
        tplName: m.name,
        moving: {
          data: floats.buffer,
          datatype: 16,
          littleEndian: true,
          slope: srcImg.slope || 1,
          inter: srcImg.inter || 0,
          dims: [h!.nx, h!.ny, h!.nz],
          srow_x: h!.srow_x,
          srow_y: h!.srow_y,
          srow_z: h!.srow_z,
        },
        template: new Uint8Array(m.bytes ?? 0),
      };
      // Compare-mode Align flow: the reference is another loaded image, shipped
      // as a pre-decoded volume instead of NIfTI bytes.
      if (this.regFlow === 'align') {
        const refImg = this.host.getImages()[this.regRefIdx];
        if (!refImg?.data) throw new Error('Reference volume missing');
        const rh = refImg.header;
        const rn = rh!.nx * rh!.ny * rh!.nz;
        const rFloats = new Float32Array(rn);
        const rlim = Math.min(rn, refImg.data.length);
        for (let i = 0; i < rlim; i++) rFloats[i] = refImg.data![i];
        msg.templateVolume = {
          data: rFloats.buffer,
          dims: [rh!.nx, rh!.ny, rh!.nz],
          srow_x: rh!.srow_x,
          srow_y: rh!.srow_y,
          srow_z: rh!.srow_z,
        };
        this.showRegStatus('busy', `Aligning ${srcImg.name} → ${refImg.name}…`, 0);
      }
      w.postMessage(msg);
    } catch (err) {
      this.handleHostFailure(errorMessage(err), false);
    }
  }

  /**
   * Compare-mode Align: register `refIdx`'s counterpart (the other compared
   * image) onto `refIdx` as reference. Stores only the transform on the moving
   * image — both volumes keep their native data untouched.
   */
  async startAlign(refIdx: number): Promise<void> {
    if (this.regBusy) {
      this.host.showToast('A registration is already running.');
      return;
    }
    const img0 = this.host.getComparedImage(0);
    const img1 = this.host.getComparedImage(1);
    if (!img0 || !img1) {
      this.host.showToast('Enter compare mode with two images first.');
      return;
    }
    const ref = this.host.getImages()[refIdx];
    if (
      !ref ||
      (this.host.getImages().indexOf(ref) !== this.host.getCompareIndices().a &&
        this.host.getImages().indexOf(ref) !== this.host.getCompareIndices().b)
    ) {
      this.host.showToast('Pick one of the two compared images as reference.');
      return;
    }
    const pair = this.host.getCompareIndices();
    const movIdx = this.host.getImages().indexOf(ref) === pair.a ? pair.b : pair.a;
    const mov = this.host.getImages()[movIdx];
    if (!ref || !mov || ref === mov) {
      this.host.showToast('Pick one of the two compared images as reference.');
      return;
    }
    try {
      const pair = this.host.getCompareIndices();
      await this.host.ensureImage(pair.a, 'active', 'user');
      await this.host.ensureImage(pair.b, 'active', 'user');
    } catch {
      this.host.showToast('Both images must be fully loaded before aligning.');
      return;
    }
    this.regBusy = true;
    this.regFlow = 'align';
    this.regSourceIdx = movIdx;
    this.regRefIdx = this.host.getImages().indexOf(ref);
    this.showRegStatus('busy', `Aligning ${mov.name} → ${ref.name}…`, 0);
    // Reuse the custom-template pipeline; launchRegWorker attaches the
    // reference volume payload for the align flow.
    void this.launchRegWorker({ mode: 'custom', name: ref.name });
  }

  private finishRegistration(d: RegResultMessage): void {
    try {
      this.terminateRegWorker();
      const srcImg = this.host.getImages()[this.regSourceIdx];
      if (!srcImg?.header) throw new Error('Source image missing');
      if (!Array.isArray(d.alignM) || d.alignM.length !== 16) throw new Error('Invalid transform returned');

      // ITK-SNAP style: attach the transform, keep the original volume data
      // and header completely untouched.
      srcImg.align = { m: d.alignM.map((v: number) => +v), ref: String(d.tplName) };
      this.host.clearCompareCaches();

      const secs = ((d.durationMs || 0) / 1000).toFixed(1);
      const cm = typeof d.cost === 'number' ? ` · cost ${d.cost.toFixed(3)} (${d.costMode})` : '';

      if (this.regFlow === 'align') {
        // Enter/refresh overlay compare: reference is the base (img0), moving
        // image (with the new transform) is the overlay (img1).
        const refIdx = this.regRefIdx;
        const movIdx = this.regSourceIdx;
        this.host.setCompareIndices(refIdx, movIdx);
        this.host.enterCompareOverlayUI();
        this.showRegStatus('ok', `Aligned in ${secs}s${cm} · transform stored, original data untouched`);
      } else {
        // Template-space registration: add the template volume next to the
        // source image, then show the aligned overlay (template as base).
        const hdrTpl: NiiHeader = JSON.parse(JSON.stringify(srcImg.header));
        hdrTpl.ndim = 3;
        hdrTpl.nt = 1;
        hdrTpl.nu = 1;
        hdrTpl.nx = d.nx;
        hdrTpl.ny = d.ny;
        hdrTpl.nz = d.nz;
        hdrTpl.dx = d.dx;
        hdrTpl.dy = d.dy;
        hdrTpl.dz = d.dz;
        hdrTpl.datatype = 16;
        hdrTpl.bitpix = 32;
        hdrTpl.bytesPerVoxel = 4;
        hdrTpl.scl_slope = 1;
        hdrTpl.scl_inter = 0;
        hdrTpl.isGzip = false;
        hdrTpl.totalVoxels3D = d.nx * d.ny * d.nz;
        hdrTpl.sliceSizeXY = d.nx * d.ny;
        hdrTpl.volumeBytes = d.nx * d.ny * d.nz * 4;
        hdrTpl.srow_x = [...d.srow_x];
        hdrTpl.srow_y = [...d.srow_y];
        hdrTpl.srow_z = [...d.srow_z];
        if (d.orientation) hdrTpl.orientation = d.orientation;

        const tplTag = String(d.tplName).replace(/\.nii(\.gz)?$/i, '');
        let tplIdx = this.host.getImages().findIndex((im) => im.name === tplTag);
        if (tplIdx < 0) {
          this.host.getImages().push({
            header: hdrTpl,
            data: new Float32Array(d.tplData),
            min: d.tplMin,
            max: d.tplMax,
            name: tplTag,
            url: '',
            directUrl: '',
            slope: 1,
            inter: 0,
            colormap: srcImg.colormap,
            state: 'ready',
            lastAccess: Date.now(),
          });
          tplIdx = this.host.getImages().length - 1;
        }
        const srcIdx = this.host.getImages().indexOf(srcImg);
        this.host.getImages()[srcIdx].selected = true;
        this.host.getImages()[tplIdx].selected = true;
        this.host.setCompareIndices(tplIdx, srcIdx);
        this.host.enterCompareOverlayUI();
        this.showRegStatus('ok', `Aligned to ${tplTag} in ${secs}s${cm} · original preserved, overlay shown`);
      }
    } catch (err) {
      this.handleHostFailure(errorMessage(err), false);
    }
  }

  /**
   * Enter overlay-compare UI using the current compareIdxA/B pair. Shared by
   * the Compare button, template registration, and the Align flow.
   */
}
