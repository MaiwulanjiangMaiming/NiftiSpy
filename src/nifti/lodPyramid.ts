import { VolumeProvider, VolumeInfo, ChunkKey } from './volumeProvider';

export type LODLevel = 0 | 1 | 2;

export interface LODConfig {
  lod0Delay: number;
  lod1Delay: number;
  lod2Delay: number;
}

const DEFAULT_LOD_CONFIG: LODConfig = {
  lod0Delay: 1000,
  lod1Delay: 200,
  lod2Delay: 50,
};

export class LODPyramid {
  private provider: VolumeProvider;
  private config: LODConfig;
  private currentLOD: LODLevel = 2;
  private targetLOD: LODLevel = 0;
  private lodTimers: Map<number, NodeJS.Timeout> = new Map();
  private onLODChange: ((lod: LODLevel) => void) | null = null;

  constructor(provider: VolumeProvider, config?: Partial<LODConfig>, onLODChange?: (lod: LODLevel) => void) {
    this.provider = provider;
    this.config = { ...DEFAULT_LOD_CONFIG, ...config };
    this.onLODChange = onLODChange || null;
  }

  async requestSlice(axis: 'axial' | 'coronal' | 'sagittal', sliceIndex: number): Promise<Float32Array | null> {
    for (const timer of this.lodTimers.values()) clearTimeout(timer);
    this.lodTimers.clear();

    const lod2Slice = this.provider.extractSliceFromChunks(axis, sliceIndex, 2);
    if (lod2Slice) {
      this.setCurrentLOD(2);
    }

    const lod1Timer = setTimeout(async () => {
      const keys = this.provider.getChunksForSlice(axis, sliceIndex, 1);
      await Promise.all(keys.map(k => this.provider.getOrLoadChunk(k)));
      const lod1Slice = this.provider.extractSliceFromChunks(axis, sliceIndex, 1);
      if (lod1Slice && this.currentLOD >= 1) {
        this.setCurrentLOD(1);
        this.onLODChange?.(1);
      }
    }, this.config.lod2Delay);
    this.lodTimers.set(1, lod1Timer);

    const lod0Timer = setTimeout(async () => {
      const keys = this.provider.getChunksForSlice(axis, sliceIndex, 0);
      await Promise.all(keys.map(k => this.provider.getOrLoadChunk(k)));
      const lod0Slice = this.provider.extractSliceFromChunks(axis, sliceIndex, 0);
      if (lod0Slice) {
        this.setCurrentLOD(0);
        this.onLODChange?.(0);
      }
    }, this.config.lod1Delay);
    this.lodTimers.set(0, lod0Timer);

    if (!lod2Slice) {
      const keys = this.provider.getChunksForSlice(axis, sliceIndex, 2);
      await Promise.all(keys.map(k => this.provider.getOrLoadChunk(k)));
      return this.provider.extractSliceFromChunks(axis, sliceIndex, 2);
    }

    return lod2Slice;
  }

  private setCurrentLOD(lod: LODLevel): void {
    if (lod < this.currentLOD) {
      this.currentLOD = lod;
    }
  }

  getCurrentLOD(): LODLevel {
    return this.currentLOD;
  }

  resetLOD(): void {
    this.currentLOD = 2;
    this.targetLOD = 0;
    for (const timer of this.lodTimers.values()) clearTimeout(timer);
    this.lodTimers.clear();
  }

  destroy(): void {
    for (const timer of this.lodTimers.values()) clearTimeout(timer);
    this.lodTimers.clear();
    this.provider.clearChunks();
  }
}
