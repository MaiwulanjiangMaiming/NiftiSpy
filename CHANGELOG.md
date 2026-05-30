# Changelog

All notable changes to NiftiSpy will be documented in this file.

## Versioning Convention

- **Bug fixes / Optimizations**: z + 1 (e.g., 1.1.0 → 1.1.1)
- **New features**: y + 1, z = 0 (e.g., 1.1.1 → 1.2.0)
- **Major updates**: x + 1, y = z = 0 (e.g., 1.x.x → 2.0.0)

---

## [1.3.1] - 2026-05-30

### Added
- Multi-level cache architecture with hit/miss statistics: L1 (GPU texture, managed by WebGL/WebGPU renderer), L2 (in-memory LRU `sliceCache`), L3 (IndexedDB disk cache with LRU eviction, max 500MB), L4 (remote fetch).
- Cache statistics API (`webview/cache.ts`): `recordCacheHit()`, `recordCacheMiss()`, `recordL4Fetch()`, `getCacheStats()`, `resetCacheStats()`, `getCacheSize()` for monitoring cache effectiveness at each level.
- IndexedDB cache touch-on-read: `getCachedChunk()` now updates the `timestamp` field on read, improving LRU accuracy for frequently accessed slices.
- IndexedDB meta store: new `meta` object store for key-value metadata (e.g., ETag, Last-Modified headers for cache validation).
- Worker cache instrumentation: `fetchSlice` in `worker.ts` now records L3 hit/miss and L4 fetch events for cache statistics.

---

## [1.3.0] - 2026-05-30

### Added
- WebGPU rendering path (`webview/webgpuRenderer.ts`): new `WebGPURenderer` class that uses the WebGPU API for slice rendering when available. Automatically detects `navigator.gpu` adapter support and falls back to WebGL2 when WebGPU is not available.
- WebGPU 3D texture: volume data uploaded as `GPUTexture` (3D, `r32float` format) with WGSL fragment shader performing GPU-side slice extraction and window/level normalization.
- Compute Shader histogram: `WebGPURenderer.computeHistogram()` uses a WGSL compute pipeline to calculate a 256-bin intensity histogram from the 3D volume texture, enabling real-time histogram display without CPU involvement.
- WebGPU integration in `viewer.ts`: `paintSlice()` now checks for WebGPU availability first; if a WebGPU renderer is initialized and the 3D volume is uploaded, it uses the WebGPU path. The `tryUploadVolume3D()` function also uploads volume data to WebGPU renderers.
- `@webgpu/types` added as dev dependency for TypeScript type definitions.

---

## [1.2.2] - 2026-05-30

### Added
- HTTP/2 multiplexed proxy: `LocalFileProxy` server upgraded from HTTP/1.1 to `http2.createServer()`, enabling concurrent multiplexed requests. Fast scrolling no longer causes request queuing; multiple slice requests are served in parallel over a single connection.
- GZIP index for random access (`src/io/gzipIndex.ts`): zran-style GZIP index builder that scans the compressed stream once and records deflate block boundaries with 32KB sliding window snapshots. Subsequent slice requests for `.nii.gz` files use the index to decompress only the needed range, avoiding full-file decompression.
- Indexed GZIP integration in `LocalFileProxy.handleSlice()`: when a `.nii.gz` file's GZIP index is ready, axial/coronal/sagittal slice extraction uses `extractRangeFromGzipIndex()` for direct random access. Index is built lazily in the background on first slice request.

---

## [1.2.1] - 2026-05-30

### Added
- SharedArrayBuffer zero-copy communication: when the browser supports `SharedArrayBuffer` (requires COOP/COEP headers), volume data is placed in a `SharedArrayBuffer` and broadcast to all Web Workers. Workers can extract slices directly from shared memory without data copying or network requests.
- COOP/COEP headers: HTTP proxy server (`LocalFileProxy.ts`) sets `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` response headers to enable `SharedArrayBuffer` in the extension webview.
- COOP/COEP meta tags: `NiiEditorProvider.ts` adds `<meta http-equiv="Cross-Origin-Opener-Policy">` and `<meta http-equiv="Cross-Origin-Embedder-Policy">` tags as a fallback for environments where HTTP headers cannot be set.
- SAB-aware Worker slice extraction: when `sharedVolume` is available and `factor === 1`, the Worker extracts slices directly from the shared Float32Array buffer (axial/coronal/sagittal), bypassing network I/O entirely.

---

## [1.2.0] - 2026-05-28

### Added
- GPU 3D texture rendering: when volume data is fully loaded, upload entire volume as `TEXTURE_3D` (R32F) to GPU. Slice scrolling becomes pure uniform update (`u_sliceIndex`), achieving 60fps+ with zero CPU data transfer.
- 3D texture shader: `sampler3D` with `u_axis` (0=axial, 1=coronal, 2=sagittal) and `u_sliceIndex` for GPU-side slice extraction in any orientation.
- Automatic GPU memory detection and fallback: checks `MAX_3D_TEXTURE_SIZE` and estimated memory before upload. Large volumes (>1GB) that exceed GPU limits automatically fall back to 2D texture mode.
- `tryUploadVolume3D()`: automatically uploads volume data to GPU 3D texture when `volumeData` is set, shared across all three axis renderers.

---

## [1.1.2] - 2026-05-28

### Added
- IndexedDB disk cache (`webview/cache.ts`): remote file slices are cached to IndexedDB with LRU eviction (max 500MB). Repeated access to remote files loads from disk cache instead of re-downloading.
- OffscreenCanvas support: WebGL2 renderer now attempts to use `transferControlToOffscreen()` first, moving GL context to OffscreenCanvas for reduced main thread blocking. Falls back to regular canvas context if unavailable.

---

## [1.1.1] - 2026-05-28

### Changed
- GPU-side window/level: WebGL2 shader now receives raw `u_windowLevel` and `u_windowWidth` uniforms and computes normalization entirely on GPU, eliminating CPU-side min/max normalization step. W/L adjustment now runs at full GPU speed with zero CPU involvement.

### Added
- Predictive prefetch engine (`PredictivePrefetcher`): tracks scroll velocity per axis using exponential moving average, dynamically adjusts prefetch range (up to 15 slices forward at high velocity vs. default PRELOAD_RANGE at rest), and prioritizes forward-direction prefetching based on scroll direction.

---

## [1.1.0] - 2026-05-28

### Added
- Worker pool for parallel slice extraction (`SliceWorkerPool`) with dynamic scaling up to `min(hardwareConcurrency, 6)` workers
- HTTP Range request support for remote NIfTI files (`readHttpPartial`)
- Streaming HTTP gzip preview for remote `.nii.gz` files (`streamingHttpGunzipPreview`)
- Coronal/sagittal slice extraction via Range reads for local uncompressed `.nii` files
- SOLID architecture: split `LocalFileProxy.ts` into 5 focused modules
  - `src/nifti/headerParser.ts` — NIfTI header parsing
  - `src/nifti/sliceExtractor.ts` — Slice extraction (axial/coronal/sagittal + Range versions)
  - `src/nifti/previewEncoder.ts` — Preview binary encoding + min/max computation
  - `src/io/fileReader.ts` — File I/O abstraction (local Range + HTTP Range)
  - `src/io/compression.ts` — Gzip compression/decompression + streaming preview

### Fixed
- Worker memory double-holding: in-place Float32Array conversion when `scl_slope≠1` or `scl_inter≠0`, reducing peak memory from 2x to 1x for Float32 volumes
- Minimap coordinate inversion: fixed indicator position and click handler mapping to correctly reflect viewport position regardless of flip state

---

## [1.0.4] - 2026-05-2x

### Fixed
- Replace blocking `gunzipSync` with async `gunzip` in Worker to prevent main thread freeze

---

## [1.0.3] - 2026-05-2x

### Fixed
- Optimize `throwIfAborted` call frequency in tight loops (every 4096 iterations instead of every pixel)

---

## [1.0.2] - 2026-05-2x

### Fixed
- Worker `needsConversion` memory double-hold bug: release `rawData` reference after conversion

---

## [1.0.1] - 2026-05-2x

### Changed
- Documentation updates: Marketplace/VSX links, badges, icon sizing

---

## [1.0.0] - 2026-05-2x

### Added
- Initial release of NiftiSpy
- Side-by-side compare mode with dual crosshairs
- Pointer info for both images
- File icons for `.nii` / `.nii.gz` files
- README banner and documentation
