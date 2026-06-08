# Changelog

All notable changes to NiftiSpy will be documented in this file.

## Versioning Convention

- **Bug fixes / Optimizations**: z + 1 (e.g., 1.1.0 → 1.1.1)
- **New features**: y + 1, z = 0 (e.g., 1.1.1 → 1.2.0)
- **Major updates**: x + 1, y = z = 0 (e.g., 1.x.x → 2.0.0)

---

## [2.0.1] - 2026-06-08

### Fixed
- **Header Info visibility**: Changed header panel layout from horizontal (key|val side-by-side) to vertical (key above, val below) so long values like sform matrices are fully visible in the 180px sidebar.
- **Orientation never shows "Unknown"**: Added `computeOrientationFromQform()` that reconstructs the rotation matrix from the qform quaternion (b, c, d) when sform is unavailable. Falls back to "RAS" (NIfTI default) only when both sform_code and qform_code are 0. The `orientation` field in `parseNiiHeaderFromBuffer` now defaults to empty string instead of `'unknown'`.
- **Tooltip system**: Implemented JavaScript-driven `data-tip` tooltip system (inspired by Project_Manager) replacing the broken CSS `::after` pseudo-element approach. Tooltips now work correctly in VS Code Webview with viewport clamping and 80ms hide delay.
- **Help popup font size**: Increased from 9px to 12px, width from 180px to 220px.
- **Sidebar font size**: Increased from 9px to 11px.
- **README Version section**: Simplified to show only current version number with link to CHANGELOG.

### Changed
- **Orientation computation**: Now uses a 3-tier fallback: sform → qform quaternion → RAS default. Based on ITK-SNAP's `ImageCoordinateGeometry` direction cosine analysis and niivue's quaternion-to-matrix reconstruction.

---

## [2.0.0] - 2026-06-08

### Added
- **Measurement Tools**: New 📏 toolbar button toggles measure mode. In measure mode, click two points to draw a line measurement (distance in mm using voxelToWorld), or click-and-drag to draw a rectangle ROI (area in mm²). Measurements persist until cleared with the 🗑️ button. Overlay drawn on per-axis measurement canvases.
- **Accessibility - ARIA Labels**: Added `role="application"` on main container, `aria-label` on all canvases (e.g., "Axial slice viewer"), sliders ("Window width", "Window level"), buttons, and sidebar. Range inputs have `role="slider"` with `aria-valuemin`, `aria-valuemax`, `aria-valuenow`.
- **Accessibility - Keyboard Navigation**: Tab key cycles through canvases (via `tabindex="0"`). Arrow keys scroll slices when a canvas has focus. Escape key exits measure mode.
- **Accessibility - High Contrast**: Detects `prefers-contrast: more` media query. When active, uses thicker crosshair lines and larger text labels.
- **Accessibility - Screen Reader**: `aria-live="polite"` region announces slice index changes, window/level changes, and measurement results.
- **Input Validation**: Slice indices validated before rendering. Window/level values checked for finite and positive. Volume data dimensions validated against header.
- **Error Recovery**: WebGL context loss triggers automatic renderer reinitialization. Worker crashes trigger automatic restart. Fetch failures retry with exponential backoff.
- **Cleanup on Dispose**: `NiiEditorProvider.dispose()` terminates abort controllers, cancels queued loads, stops proxy server, and disposes all status bar items.

---

## [1.10.1] - 2026-06-08

### Added
- **CI/CD Pipeline**: GitHub Actions workflows for automated build, type checking, native compilation across platforms, and VSIX packaging on push/PR to main and on version tags.
- **ESLint + Prettier**: Code quality tooling with `@typescript-eslint` parser, ESLint recommended config, and Prettier formatting. New npm scripts: `lint`, `format`, `format:check`.
- **WebGPU MIP Rendering Path**: New WebGPU compute-based ray marching path in `VolumeRaycaster` alongside the existing WebGL2 path. Includes `isWebGPUAvailable()` async check, `initWebGPU()` initialization with WGSL compute shader, `uploadVolumeWebGPU()` for 3D texture upload, and `renderWebGPU()` for compute-based rendering. The `render()` method automatically uses WebGPU when initialized, falling back to WebGL2.

### Fixed
- **Header Info Panel**: Added `max-height` and `overflow-y:auto` to the header panel and content container for proper scrolling with long content.
- **Orientation Labels**: Replaced hardcoded orientation labels with dynamic computation from the sform matrix using ITK-SNAP's direction cosine analysis. Labels now correctly reflect the actual anatomical orientation of each view axis, accounting for flip state.
- **Orientation in Header Panel**: When orientation is 'unknown', it is now computed from the sform matrix using the same ITK-SNAP column-based algorithm.

### Changed
- **Release Notes Migration**: Removed the "Release Notes" section from README.md; all version history now lives exclusively in CHANGELOG.md.

---

## [1.10.0] - 2026-06-08

### Added
- **Keyboard Shortcuts System**: New keybindings for common actions when the NiftiSpy editor is active:
  - `Alt+Up` / `Alt+Down`: Scroll slice up/down
  - `Alt+A` / `Alt+C` / `Alt+S`: Switch to Axial / Coronal / Sagittal view
  - `Alt+R`: Reset view (window/level and zoom)
  - Shortcuts work both from VS Code command system and directly in the webview
- **Slice Export PNG**: New 📷 button in the toolbar exports the current slice as a PNG image. The extension host shows a save dialog with the default filename `{originalName}_{axis}_{sliceIndex}.png`.
- **Header Metadata Panel**: New collapsible "Header Info" panel in the sidebar showing NIfTI header metadata (dimensions, voxel size, data type, scl_slope/scl_inter, qform/sform codes, sform matrix, qoffset, orientation). Each field supports click-to-copy. Toggle with the ℹ️ toolbar button.
- **Colormap Preview Strip**: Small gradient canvas (200×20) next to the colormap dropdown showing the current colormap gradient. Updates when colormap or window/level changes.
- **Zarr format indicator badge**: "ZARR" badge shown in the viewer header when a Zarr file is loaded.
- **Zarr Support documentation**: New "Zarr Support" section in README documenting supported formats, compressors, and limitations.

---

## [1.9.3] - 2026-06-08

### Changed
- **WebGL auto-detection**: `detectBestRenderBackend()` is now async and properly probes WebGPU via `navigator.gpu.requestAdapter()`, WebGL2 3D texture via `MAX_3D_TEXTURE_SIZE`, WebGL2 2D, and falls back to Canvas 2D. The `"auto"` config value triggers this detection; `"webgl"` and `"canvas"` still work as manual overrides.
- **VolumeCache strict LRU eviction**: Replaced timestamp-based eviction with a proper doubly-linked list + Map LRU implementation for O(1) lookup and reordering. Added `maxEntries` limit (default 5 volumes) and `getCacheInfo()` method.

### Added
- **Slice loading AbortController**: Per-axis `AbortController` in the viewer cancels stale slice requests when a new slice is requested, preventing wasted bandwidth and memory from outdated fetches. Worker `fetchSlice()` now accepts and propagates an `AbortSignal`.
- **Cache usage status bar**: New `$(database) NiftiSpy: X/Y vol, Z MB` status bar item showing current volume cache usage.
- **HTTP connection pooling**: Persistent `http.Agent` and `https.Agent` with keep-alive enabled for all Range requests in `readHttpPartial()`, reducing TCP connection overhead for remote file access.

---

## [1.9.2] - 2026-06-08

### Changed
- **Config namespace migration**: All configuration keys renamed from `niiFastView.*` to `niftispy.*`. Existing settings are automatically migrated on activation (global and workspace scopes).
- **Configuration title**: Changed from "NIfTI Fast View" to "NiftiSpy".
- **`renderBackend` default**: Changed from `"canvas"` to `"auto"`. New `"auto"` enum value selects the best available backend automatically.

### Added
- **Native acceleration status bar**: Shows `$(bolt) NiftiSpy: Native` (green) when native module is loaded, or `$(code) NiftiSpy: JS` (yellow) when using JavaScript fallback.
- **One-time fallback notification**: Shows an information message on first silent fallback to JavaScript: "NiftiSpy: Native acceleration unavailable, using JavaScript fallback. Performance may be reduced."
- **HTTP proxy port conflict handling**: `LocalFileProxy.start()` now retries up to 3 times with incrementing port numbers when the configured port is already in use (EADDRINUSE).
- **`niftispy.proxyPort` configuration**: The proxy port setting is now actually read and used as the initial port for the HTTP proxy server.
- **Server error logging**: Added `onError` handler to the proxy server that logs errors.

### Fixed
- Port 0 (auto-assign) now works correctly with the retry logic (no retries needed for auto-assign).

---

## [1.5.3] - 2026-06-03

### Added
- **Rendering backend auto-selection**: New `detectBestRenderBackend()` function that probes WebGPU → WebGL2 3D texture → WebGL2 2D → Canvas 2D in priority order. The detected `renderBackend` is stored globally and used in `paintSlice()` to skip unnecessary capability checks on every frame.
- **Performance profile detection**: `detectPerformance()` now also probes `MAX_3D_TEXTURE_SIZE` from the WebGL2 context and stores it in the `PerformanceProfile` object. This is used to decide whether 3D texture upload is feasible on the current GPU.
- **Smart volume upload**: `tryUploadVolume3D()` now checks estimated volume size (nx × ny × nz × 4 bytes) before uploading to GPU. Volumes exceeding 1GB skip 3D texture upload entirely, preventing GPU out-of-memory crashes on large datasets.

### Changed
- **paintSlice() rendering dispatch**: The rendering path selection now uses the pre-detected `renderBackend` variable instead of re-checking WebGPU availability every frame. WebGPU renderer initialization is only attempted when `renderBackend === 'webgpu'`. The 2D WebGL2 fallback path (`renderer.renderSlice()`) is always attempted for non-canvas2d backends regardless of zoom/pan state, since `renderSlice()` handles transforms via the canvas context.

---

## [1.9.1] - 2026-06-03

### Added
- **VolumeProvider abstract class v1.9.1 API**: New public methods on the `VolumeProvider` abstract class for standardized chunked volume access:
  - `getDimensions()`: Returns `{ nx, ny, nz }` of the volume.
  - `getVoxelSize()`: Returns `{ dx, dy, dz }` voxel spacing.
  - `getChunkSize()`: Returns `{ cx, cy, cz }` chunk dimensions (default 64³).
  - `getChunk(chunkX, chunkY, chunkZ)`: Load and return a single chunk's data as `Float32Array`.
  - `getChunksForSlice(axis, sliceIndex)`: Return chunk keys needed for a given slice.
  - `extractSlice(axis, sliceIndex)`: Assemble a full slice from loaded chunks.
  - `isChunkLoaded(chunkX, chunkY, chunkZ)`: Check if a chunk is in the LRU cache.
  - `getLoadedChunksCount()`: Number of currently loaded chunks.
  - `getTotalChunksCount()`: Total number of chunks in the volume.
  - `evictChunk(chunkX, chunkY, chunkZ)`: Evict a specific chunk from the cache.
- **ChunkLRUCache**: Extracted the LRU chunk cache into a reusable `ChunkLRUCache` class with `has()`, `touch()`, `setPending()`, `deletePending()` methods. Shared by all provider implementations.
- **NiftiVolumeProvider**: Renamed from `LocalVolumeProvider` (backward-compatible alias preserved). Wraps existing NIfTI loading with 64³ chunk-based access and LRU cache (max 512 chunks). On first access to a chunk, loads it from the full volume data. Supports both local files and mmap-based access.
- **ZarrVolumeProvider**: New `ZarrVolumeProvider` for read-only Zarr v2 format support:
  - Reads `.zarray` metadata file to get dimensions, dtype, chunk shape, and compressor.
  - Supports zlib/gzip, blosc, and lz4 compressors.
  - Each chunk is stored as a separate file: `data/0.0.0`, `data/0.0.1`, etc.
  - Loads chunks on demand via HTTP or local file system.
  - Same LRU cache as `NiftiVolumeProvider`.
  - Maps Zarr chunk grid to the internal 64³ chunk grid for uniform access.
- **Zarr file type registration**: New custom editor `niftispy.zarr` registered in `package.json` for `.zarr` directories. Zarr language definition added with icon support.
- **Chunk loading progress**: Status bar item showing chunk loading progress for large volumes (e.g., "Chunks: 128/256 (50%)").
- **Zarr editor integration**: `extension.ts` registers a `niftispy.zarr` custom editor provider that reads Zarr metadata and displays volume info.

---

## [1.9.0] - 2026-06-03

### Changed
- **WebGPU persistent uniform buffers**: `renderSlice3D()` and `computeHistogram()` no longer create and destroy a uniform buffer every frame. Persistent buffers are created during pipeline setup and updated via `device.queue.writeBuffer()`, eliminating per-frame GPU allocation overhead.
- **WebGPU colormap & flip support**: The `_colormap`, `_flipX`, `_flipY` parameters in `renderSlice3D()` are now fully implemented. Flip is applied in the vertex shader via UV coordinate inversion; colormap LUT textures are generated from the shared `COLORMAPS` table and uploaded to GPU on change.

### Added
- **VolumeRaycaster `setConfig()`**: New method to update ray marching parameters (step size, max steps, lighting) without recreating the renderer.
- **VolumeRaycaster `getTransferFunction()`**: New method that returns a copy of the current transfer function control points.
- **Arcball rotation**: Volume 3D rotation now uses proper arcball rotation instead of simple Euler angles. Mouse drag is mapped onto a virtual sphere to compute rotation quaternions, providing intuitive and gimbal-lock-free 3D interaction.

### Fixed
- **Rendering fallback when volume3D not ready**: `paintSlice()` now gracefully falls back to 2D rendering when the 3D volume texture is not yet uploaded (e.g., still loading), instead of skipping the 2D WebGL2 path. The zoom/pan restriction on the 2D WebGL2 fallback has been removed.

---

## [1.5.1] - 2026-06-01

### Fixed
- **Overlay display**: `paintOverlaySlice()` now correctly uses the pre-registered `data1` parameter instead of re-extracting slices via `resampleOverlaySlice()`, ensuring both images display simultaneously with proper spatial registration.
- **SBS registration**: `paintSideBySideSlice()` now uses unified physical extent (`max(pw0, pw1)`, `max(ph0, ph1)`) for both images, ensuring consistent anatomical scale and correct crosshair alignment when comparing volumes with different resolutions or slice thickness.
- **Auto Contrast on load**: Removed automatic data-driven window/level calculation in `handleCachedVolume()`. W/L now defaults to `[0, 1]` on initial load; users must click "Auto Contrast" to apply data-driven W/L.

---

## [1.5.0] - 2026-05-30

### Added
- Volume Ray Marching renderer (`webview/volumeRaycaster.ts`): `VolumeRaycaster` class implementing GPU-based 3D volume rendering using WebGL2 ray marching. Features include:
  - Ray-box intersection for bounding volume traversal
  - Front-to-back compositing with early ray termination (alpha > 0.95)
  - On-the-fly gradient computation for Phong shading (ambient + diffuse + specular)
  - Transfer function with piecewise linear interpolation between control points
  - Configurable step size, max steps, and lighting parameters
- 3D rendering mode in `viewer.ts`: new `renderMode` state (`'slice'` | `'volume'`) with mouse drag rotation and scroll zoom for interactive 3D viewing. When `renderMode === 'volume'`, the axial canvas displays the ray-marched 3D volume instead of 2D slices.
- Volume raycaster integration: `tryUploadVolume3D()` automatically uploads volume data to the `VolumeRaycaster`; `paintSlice()` dispatches to `renderVolume3D()` when in volume mode.
- Default transfer function: 6-point piecewise linear TF with black→blue→red→yellow→white color ramp and increasing opacity.

---

## [1.4.1] - 2026-05-30

### Added
- Rust mmap memory-mapped file I/O (`native/src/lib.rs`): `mmap_parse_header()`, `mmap_extract_slice()`, `mmap_extract_preview()` functions use `memmap2` for zero-copy file access. Memory-mapped files avoid explicit `readFile()` calls, reducing memory pressure for large NIfTI volumes.
- Rust fast GZIP decompression (`native/src/lib.rs`): `fast_decompress_gzip()` function using `flate2::GzDecoder` with pre-allocated output buffer, providing faster decompression than Node.js `zlib.gunzipSync()`.
- Native bridge extensions (`src/nativeBridge.ts`): new `mmapParseHeader()`, `mmapExtractSlice()`, `mmapExtractPreview()`, `fastDecompressGzip()` bindings exposed through the native bridge with automatic JSON serialization/deserialization.
- `memmap2` dependency added to `native/Cargo.toml`.

---

## [1.4.0] - 2026-05-30

### Added
- Chunked Volume data model (`src/nifti/volumeProvider.ts`): abstract `VolumeProvider` class with 64³ chunk-based volume access. Supports `getChunksForSlice()` to identify which chunks are needed for a given slice, `extractSliceFromChunks()` to assemble slices from loaded chunks, and automatic LRU chunk eviction (max 512 chunks). `LocalVolumeProvider` extends this for local `.nii` files with on-demand chunk loading.
- LOD Pyramid (`src/nifti/lodPyramid.ts`): `LODPyramid` class implementing progressive LOD loading strategy. LOD2 (1/4 resolution) loads in ~50ms, LOD1 (1/2 resolution) in ~200ms, LOD0 (full resolution) in ~1000ms. Each level triggers a callback for progressive rendering, providing a smooth loading experience from low-res preview to full quality.

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
