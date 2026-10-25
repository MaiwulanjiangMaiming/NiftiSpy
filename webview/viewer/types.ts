import type { NiiHeader } from '../../src/nifti/headerParser';

export type TypedArray =
  | Int8Array
  | Uint8Array
  | Int16Array
  | Uint16Array
  | Int32Array
  | Uint32Array
  | Float32Array
  | Float64Array;

export type GpuTypedArray = Exclude<TypedArray, Float64Array>;

/** GPU textures accept every native integer/float type except 64-bit floats. */
export function toGpuTypedArray(data: TypedArray): GpuTypedArray {
  return data instanceof Float64Array ? Float32Array.from(data) : data;
}

export type Axis = 'axial' | 'coronal' | 'sagittal';

export interface VolumeImage {
  header: NiiHeader | null;
  data: TypedArray | null;
  min: number;
  max: number;
  name: string;
  url: string;
  directUrl: string;
  slope: number;
  inter: number;
  colormap: string;
  preview?: {
    axial: Float32Array;
    coronal: Float32Array;
    sagittal: Float32Array;
  };
  state: 'preview' | 'loading' | 'ready' | 'error';
  lastAccess: number;
  loadPromise?: Promise<void>;
  selected?: boolean;
  preParsedHeader?: NiiHeader;
  align?: { m: number[]; ref: string };
}
