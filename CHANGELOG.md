# Changelog

All notable changes to NiftiSpy will be documented in this file.

## Versioning Convention

- **Bug fixes / Optimizations**: z + 1 (e.g., 1.1.0 → 1.1.1)
- **New features**: y + 1, z = 0 (e.g., 1.1.1 → 1.2.0)
- **Major updates**: x + 1, y = z = 0 (e.g., 1.x.x → 2.0.0)

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
