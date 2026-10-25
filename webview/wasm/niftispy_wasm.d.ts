/* tslint:disable */
/* eslint-disable */

export function wasm_apply_window_level(data: Float32Array, window_level: number, window_width: number, global_min: number, global_max: number): Uint8Array;

export function wasm_extract_preview(data: Uint8Array): string | undefined;

export function wasm_extract_slice(data: Uint8Array, header_json: string, axis: string, index: number): Uint8Array | undefined;

export function wasm_extract_slice_downsampled(data: Uint8Array, header_json: string, axis: string, index: number, factor: number): Uint8Array | undefined;

export function wasm_get_volume_stats(data: Uint8Array, header_json: string): string | undefined;

export function wasm_has_simd(): boolean;

export function wasm_parse_header(data: Uint8Array): string | undefined;

export function wasm_resample_slice(data: Float32Array, src_width: number, src_height: number, dst_width: number, dst_height: number): Uint8Array;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly wasm_apply_window_level: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number];
    readonly wasm_extract_preview: (a: number, b: number) => [number, number];
    readonly wasm_extract_slice: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number];
    readonly wasm_extract_slice_downsampled: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number];
    readonly wasm_get_volume_stats: (a: number, b: number, c: number, d: number) => [number, number];
    readonly wasm_has_simd: () => number;
    readonly wasm_parse_header: (a: number, b: number) => [number, number];
    readonly wasm_resample_slice: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number];
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
