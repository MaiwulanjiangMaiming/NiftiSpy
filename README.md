<div align="center">

<img src="Icon.png" width="180" alt="NiftiSpy Logo">

# NiftiSpy

**High-performance NIfTI viewer for VS Code**

[![VS Code Marketplace](https://img.shields.io/badge/VS%20Code%20Marketplace-NiftiSpy-007ACC?logo=visualstudiocode)](https://marketplace.visualstudio.com/items?itemName=MaiwulanjiangMaiming.niftispy)
[![Open VSX Version](https://img.shields.io/open-vsx/v/maiwulanjiangmaiming/niftispy?color=2C2255&label=Open%20VSX)](https://open-vsx.org/extension/maiwulanjiangmaiming/niftispy)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![GitHub](https://img.shields.io/badge/GitHub-NiftiSpy-181717?logo=github)](https://github.com/MaiwulanjiangMaiming/NiftiSpy)

</div>

Open `.nii`, `.nii.gz`, and `.hdr` volumes directly inside VS Code. The extension is optimized for both local files and VS Code Remote / SSH workflows, with fast preview-first loading, worker-based decoding, slice-on-demand fetches, and optional native acceleration.

## Highlights

- Fast initial preview for large volumes
- Axial, coronal, sagittal, and 3D MIP views
- Remote-friendly loading through a local proxy
- Debounced full-volume loading to avoid slowdowns during rapid switching
- Canvas-first rendering for broad compatibility, with WebGL and WebGPU fast paths
- HTTP/2 multiplexed proxy for concurrent slice requests
- IndexedDB disk cache for remote file slices
- Progressive LOD loading for .nii.gz files
- GZIP random-access index for on-demand slice extraction
- Zarr v2 format support
- Optional Rust native acceleration (mmap, fast decompress)
- Window/level, zoom, pan, crosshair, orientation labels, and compare mode

## Supported Files

- `.nii`
- `.nii.gz`
- `.hdr`
- `.zarr` (Zarr v2 format)

## Zarr Support

NiftiSpy supports reading Zarr v2 directories for volumetric image data.

- **Supported formats**: Zarr v2 directories (`.zarr`)
- **Supported compressors**: zlib/gzip, blosc, lz4
- **How to open**: Double-click a `.zarr` directory in the VS Code file explorer
- **Limitations**: Read-only — no write support for Zarr volumes

## Install

### Marketplace

Search for **NiftiSpy** in the VS Code Extensions view.

### Open VSX

Install from [Open VSX](https://open-vsx.org/extension/maiwulanjiangmaiming/niftispy).

### From Source

```bash
git clone https://github.com/MaiwulanjiangMaiming/NiftiSpy.git
cd NiftiSpy
npm install
npm run build
```

Press `F5` in VS Code to launch the Extension Development Host.

## Optional Native Acceleration

The extension works without any native module. If you want the optional Rust fast path for hotspot parsing / extraction:

```bash
npm run build:native
```

This builds the Rust crate and copies the resulting binding to `native/index.node`.

## Usage

1. Open a `.nii`, `.nii.gz`, or `.hdr` file.
2. The custom viewer opens automatically.
3. Scroll to change slices.
4. Use `Ctrl + Scroll` to zoom.
5. Drag to pan when zoomed in.
6. Click to set the crosshair.
7. Use `+ Add Image` for overlay or side-by-side comparison.

### Controls

| Action | Input |
| --- | --- |
| Scroll slices | Mouse wheel |
| Zoom | `Ctrl + Scroll` |
| Pan | Drag |
| Set crosshair | Click |
| Maximize a view | `A / C / S / M` buttons |
| Auto contrast | `Auto` |
| Reset view | `Reset` |

## Loading Pipeline

NiftiSpy uses a preview-first pipeline so large images become viewable quickly before the full volume is ready:

1. The extension host opens the custom editor and sends viewer config to the webview.
2. Local and remote files are normalized through `LocalFileProxy` for preview extraction, slice endpoints, and caching.
3. The webview shows an initial preview using direct binary slice payloads or HTTP preview fallback.
4. Full-volume loading runs in workers and is debounced during rapid image switching.
5. Slice requests, cached volumes, and cleanup logic reduce repeated decode and transfer cost.

## Architecture

```text
VS Code Extension Host
  ├── extension.ts
  ├── NiiEditorProvider.ts
  ├── VolumeCache.ts
  └── LocalFileProxy.ts
        ├── /header
        ├── /preview
        ├── /preview-bin
        ├── /slice
        └── /file

Webview
  ├── viewer.ts
  ├── worker.ts
  └── nii-parser.ts

Optional Native Path
  ├── native/src/lib.rs
  └── src/nativeBridge.ts
```

## Configuration

The extension contributes these settings:

| Setting | Default | Description |
| --- | --- | --- |
| `niftispy.proxyPort` | `0` | HTTP proxy port, `0` means auto-assign |
| `niftispy.defaultColormap` | `gray` | Initial colormap |
| `niftispy.enableLOD` | `true` | Enables preview / LOD flow for gzip volumes |
| `niftispy.previewMode` | `binary` | Preview transport format |
| `niftispy.renderBackend` | `auto` | Slice renderer, `auto` selects best available |
| `niftispy.fullVolumePolicy` | `debounced` | When full-volume loading is triggered |
| `niftispy.nativeAcceleration` | `auto` | Native module policy |

## Development

### Build

```bash
npm run build
```

### Watch

```bash
npm run watch
```

### Tests

```bash
npm test
```

### Benchmarks

```bash
npm run bench:load
npm run bench:multi
npm run bench:remote
```

### Package

```bash
npm run package
```

## Repo Hygiene

- `native/target/` and `native/index.node` are ignored to keep the repository clean
- `.vscodeignore` excludes development-only assets from the VSIX package
- Native acceleration is optional, so source builds remain usable without Rust

## Version

- Current release: `1.10.0`
- Status: release build prepared for GitHub push
- Focus: Config namespace migration, HTTP port conflict handling, native acceleration status bar

## Release Notes

### 1.9.2

- Migrates configuration namespace from `niiFastView.*` to `niftispy.*` with automatic migration of existing settings
- Adds `auto` option to `renderBackend` (now the default) for automatic best-backend selection
- Adds native acceleration status bar indicator (`$(bolt) NiftiSpy: Native` or `$(code) NiftiSpy: JS`)
- Adds HTTP proxy port conflict handling with automatic retry on EADDRINUSE
- Reads `niftispy.proxyPort` configuration for initial port selection
- Shows one-time information message when falling back to JavaScript

### 1.9.1

- VolumeProvider abstract class with standardized chunked volume access API
- ChunkLRUCache extracted into a reusable class
- ZarrVolumeProvider for read-only Zarr v2 format support (zlib/gzip, blosc, lz4 compressors)
- Zarr file type registration and custom editor integration
- Chunk loading progress status bar for large volumes

### 1.9.0

- WebGPU persistent uniform buffers eliminating per-frame GPU allocation overhead
- WebGPU colormap and flip support in vertex shader
- VolumeRaycaster `setConfig()` and `getTransferFunction()` methods
- Arcball rotation for gimbal-lock-free 3D interaction
- Rendering fallback fix when volume3D texture not yet ready

### 1.5.3

- Rendering backend auto-selection (WebGPU → WebGL2 3D → WebGL2 2D → Canvas 2D)
- Performance profile detection with MAX_3D_TEXTURE_SIZE probing
- Smart volume upload skipping 3D texture for volumes exceeding 1GB

### 1.5.1

- Overlay display fix using pre-registered data1 parameter
- SBS registration with unified physical extent for consistent anatomical scale
- Auto Contrast on load now defaults to [0, 1]; users must click "Auto Contrast"

### 1.5.0

- Volume Ray Marching renderer with GPU-based 3D rendering using WebGL2
- Front-to-back compositing with early ray termination
- Phong shading with on-the-fly gradient computation
- Transfer function with piecewise linear interpolation
- Interactive 3D viewing mode with mouse drag rotation and scroll zoom

### 1.4.1

- Rust mmap memory-mapped file I/O for zero-copy file access
- Rust fast GZIP decompression using flate2
- Native bridge extensions for mmap and decompression bindings

### 1.4.0

- Chunked Volume data model with 64³ chunk-based access and LRU eviction
- LOD Pyramid with progressive loading (LOD2 ~50ms, LOD1 ~200ms, LOD0 ~1000ms)

### 1.3.2

- Reorients all slice views (axial, coronal, sagittal) to match ITK-Snap display convention using sform matrix analysis
- Computes per-view flip flags from sform dominant direction to ensure correct anatomical orientation regardless of NIfTI encoding (RAS, LAS, LPS, etc.)
- Applies image flips in both Canvas 2D and WebGL render paths with crosshair, minimap, and click handler adjustments
- Uses fixed ITK-Snap standard orientation labels: Axial X:R/L Y:A/P, Coronal X:R/L Y:S/I, Sagittal X:A/P Y:S/I
- Fixes detectOrientation to use ITK-Snap's column-based ConvertDirectionMatrixToClosestRAICode algorithm

### 1.3.1

- Local uncompressed .nii axial slices use Range read via fs.createReadStream instead of loading entire file
- streamingGunzipPreview no longer caches full decompressed volume in memory for preview-only requests
- Remote preview returns 503 for files >200MB since vscode.workspace.fs.readFile lacks Range support

### 1.3.0

- Replaces single Worker with 3 per-axis Workers (axial/coronal/sagittal) for parallel slice extraction
- Routes fetchSlice requests to correct Worker by axis with independent sliceCache per Worker

### 1.2.0

- Upgrades to WebGL2 shaders with R32F float texture direct upload and GPU window/level computation
- Falls back to WebGL1 when WebGL2 is unavailable

### 1.1.0 – 1.1.4

- Extracts shared processRawVolume to eliminate 118 lines of Worker code duplication
- Removes duplicate globalSliceCache, unifies on entry.sliceCache
- Eliminates JSON serialization in preview paths (binary transfer, ~4x size reduction)
- Streams compressResponse via pipe instead of full-buffer gzip
- Tightens localResourceRoots to current directory only

### 1.0.2 – 1.0.4

- Fixes Worker needsConversion memory double-hold (releases references after conversion)
- Optimizes throwIfAborted from 65536 to 16 calls per slice
- Replaces gunzipSync with async gunzip for non-blocking Worker decompression

### 1.0.1

- Keeps `canvas` as the default slice renderer to avoid local rendering regressions on unsupported WebGL setups
- Reduces direct preview overhead by removing duplicated JSON slice payloads from webview messages
- Reduces preview memory churn by computing `min/max` without concatenating large temporary arrays
- Completes the optional native build flow so `npm run build:native` copies the compiled binding to `native/index.node`
- Cleans release hygiene for GitHub and VSIX packaging with updated ignore rules and clearer documentation


## Acknowledgments

This project was built upon and inspired by the following open-source projects. We are deeply grateful for their excellent work:

- **[ITK-SNAP](http://www.itksnap.org/)** — An open-source software application for segmenting structures in 3D medical images. Our orientation handling, coordinate mapping (`voxelToWorld` / `worldToVoxel`), and anatomical direction label logic are based on ITK-SNAP's `ImageCoordinateGeometry` and `GenericSliceModel` implementations. Licensed under GPL.

- **[niivue](https://github.com/niivue/niivue)** — A lightweight web-based NIfTI viewer. Our NIfTI parsing approach and webview rendering architecture were inspired by niivue's design. Licensed under BSD-2-Clause.

---

## License

[MIT](LICENSE) © Maiwulanjiang Maiming
