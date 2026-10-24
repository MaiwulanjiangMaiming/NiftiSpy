<div align="center">

<img src="Icon.png" width="180" alt="NiftiSpy Logo">

# NiftiSpy

**High-performance NIfTI viewer for VS Code**

[![VS Code Marketplace](https://img.shields.io/badge/VS%20Code%20Marketplace-NiftiSpy-007ACC?logo=visualstudiocode)](https://marketplace.visualstudio.com/items?itemName=MaiwulanjiangMaiming.niftispy)
[![Open VSX Version](https://img.shields.io/open-vsx/v/maiwulanjiangmaiming/niftispy?color=2C2255&label=Open%20VSX)](https://open-vsx.org/extension/maiwulanjiangmaiming/niftispy)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![GitHub](https://img.shields.io/badge/GitHub-NiftiSpy-181717?logo=github)](https://github.com/MaiwulanjiangMaiming/NiftiSpy)

</div>

Open NIfTI, NumPy, NRRD, MetaImage, MRC, DICOM and FreeSurfer volumes directly inside VS Code. The extension is optimized for both local files and VS Code Remote / SSH workflows, with fast preview-first loading, worker-based decoding, slice-on-demand fetches, and optional native acceleration.

## Highlights

- Fast initial preview for large volumes
- Axial, coronal, sagittal, and 3D MIP views (grab-to-rotate virtual trackball)
- Intensity-based image registration (To MNI / Align to reference) with resolution-preserving overlay & side-by-side compare
- Remote-friendly loading through a local proxy
- Debounced full-volume loading to avoid slowdowns during rapid switching
- Canvas-first rendering for broad compatibility, with WebGL fast paths
- HTTP/1.1 local proxy with concurrent range-request slice fetching
- IndexedDB disk cache for remote file slices
- Progressive LOD loading for .nii.gz files
- GZIP random-access index for on-demand slice extraction
- Zarr v2 metadata inspector (read-only; volume rendering not wired yet)
- Optional Rust native acceleration (mmap, fast decompress)
- Window/level, zoom, pan, crosshair, orientation labels, and compare mode

## Supported Files

- `.nii`
- `.nii.gz`
- `.hdr`
- `.npy`, `.npz` (NumPy arrays and archives, 1D–4D)
- `.nrrd`, `.nhdr` (raw, gzip, ASCII; attached or detached data)
- `.mha`, `.mhd` (MetaImage, attached or detached data)
- `.mrc`, `.mrcs` (MRC / MRC2014, modes 0/1/2/6)
- `.mgh`, `.mgz` (FreeSurfer, big-endian and gzip)
- `.dcm`, `.dicom`, `.ima` (uncompressed single-file DICOM, single- or multi-frame)
- `.zarr` (Zarr v2 metadata inspector; voxel rendering not yet enabled)

## NumPy Support

- **Formats**: `.npy` files (v1–v3 headers), C or Fortran order; `.npz` archives (stored or deflated members)
- **Dtypes**: uint8/int8/uint16/int16/uint32/int32/float16/float32/float64, 64-bit ints and bools
- **Layout**: 2D arrays open as an axial slice; 3D/4D arrays map to NIfTI x-fastest voxel order
- **How to open**: Double-click a `.npy` / `.npz` file; no conversion step or temporary files
- **Limitations**: complex/structured dtypes are rejected; no write support

## Other Volume Formats

Every non-NIfTI format is parsed in the extension host into the same NIfTI-shaped header the viewer already uses, so caching, LOD, statistics, rendering and registration behave identically.

- **Remote-SSH**: raw layouts (`.mrc`, `.npy`, raw NRRD, MetaImage) are sliced on the remote disk through the local proxy, so scrolling never transfers the whole volume. Large WAN volumes use slice mode; small files stream once through the forwarded proxy.
- **Compressed / big-endian**: `.npz`, `.mgz`, gzip NRRD, compressed MetaImage and big-endian data are materialized once into a little-endian temporary file, so each slice request is a random read instead of a re-inflation.
- **Detached headers**: `.nhdr` / `.mhd` resolve their external data file relative to the header and are read directly.
- **Orientation**: NRRD `space directions/origin`, MetaImage `TransformMatrix/Offset`, MRC `mapc/mapr/maps` and FreeSurfer `Mdc/Pxyz` are mapped to an sform when present.
- **Limitations**: read-only; complex/structured NumPy dtypes and MRC complex/float16 modes are rejected.

## DICOM Support

- **Layouts**: single-frame and multi-frame (enhanced) DICOM, explicit/implicit VR little endian and explicit VR big endian
- **Metadata**: PixelSpacing, slice spacing/thickness, and rescale slope/intercept are applied to the intensity scale
- **Orientation**: ImageOrientationPatient / ImagePositionPatient are converted from LPS to RAS and published as an sform
- **Remote-SSH**: uncompressed little-endian files are sliced straight from the remote disk; big-endian files are byte-swapped once
- **Limitations**: compressed transfer syntaxes (JPEG, JPEG-LS, JPEG 2000, RLE, deflated) and DICOM series folders are not supported; export an uncompressed copy or a NIfTI volume for those

## Zarr Metadata Preview

Double-clicking a `.zarr` directory opens a read-only metadata inspector. It validates `.zarray` and reports dimensions, chunk grid, dtype and compressor.

- **Supported metadata**: Zarr v2 directories (`.zarr`); zlib/gzip, blosc and lz4 chunk metadata
- **How to open**: Double-click a `.zarr` directory in the VS Code file explorer
- **Limitations**: volume rendering for Zarr is not wired into the viewer yet; convert the array to `.npy` / `.nii.gz` to visualize it. No write support.

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

### Multi-Core Parallel Gzip Decompression (v2.2.0)

For local `.nii.gz` files, NiftiSpy 2.2.0 ships a multi-core parallel decompression backend built on [`rusty-rapidgzip`](https://crates.io/crates/rusty-rapidgzip) (libdeflate-based). A 3-stage pipeline (speculative DEFLATE block-boundary scan → multi-core decode → ordered serialize) runs on all available CPU cores via a libuv worker thread, so the extension host stays responsive.

Benchmark on a 342MB compressed / 465MB decompressed MRI volume (Apple Silicon, 12 cores):

| Backend | Time | Throughput | Speedup |
| --- | --- | --- | --- |
| zlib streaming (Node.js) | ~1150 ms | ~400 MB/s | 1.0× |
| libdeflate single-core (v2.1.4) | ~830 ms | ~560 MB/s | 1.4× |
| **rusty-rapidgzip multi-core (v2.2.0)** | **~300 ms** | **~1550 MB/s** | **3.8×** |

The binary is keyed by platform and architecture (`niftispy_native.darwin-arm64.node`, `niftispy_native.linux-x64-gnu.node`, `niftispy_native.win32-x64-msvc.node`) and selected automatically at runtime. Platforms without a bundled binary use the JavaScript path. Byte-for-byte verified against the zlib reference.

## Usage

1. Open a `.nii`, `.nii.gz`, `.hdr`, or `.npy` file.
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

For Remote-SSH `.nii.gz` files, version 2.3.3 builds a seekable cache on the remote host in one streaming decompression pass. Later slices read from that cache; only the requested plane crosses the tunnel. Server-side downsampling reduces interactive slice payloads, and gzip transport compresses the Float32 values losslessly. Full-resolution source volumes retain their original data.

The first preview skips uniform background planes, then advances to the center plane and complete orthogonal views. Verified center previews and coarse volumes are persisted for repeat opens. Background previews stop changing the view after the user scrolls.

- `niftispy.remoteCacheBudgetMB`: remote disk budget, default **4096 MiB**; older entries are evicted by access time. Set **0** to keep the gzip-index fallback without an unpacked cache.
- `niftispy.remoteCacheDirectory`: optional directory on the extension host. The default is a managed directory under the host's temporary directory. Original images are never modified; read-only or space-limited hosts retain the index fallback.

Run `npm run bench:host -- 256 512` to profile a synthetic 256 MiB volume through the production host implementation. Reports include useful first preview, complete orthogonal preview, warm reopen, slice bytes, compression and server timings. These local measurements exclude actual SSH latency and bandwidth.


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
| `niftispy.volumeCacheBudgetMB` | `1024` | Host memory budget for fully decoded volumes (MiB); reload to apply |
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

- Current release: `2.3.2`

For release notes, see [CHANGELOG.md](CHANGELOG.md).

## Acknowledgments

This project was built upon and inspired by the following open-source projects. We are deeply grateful for their excellent work:

- **[ITK-SNAP](http://www.itksnap.org/)** — An open-source software application for segmenting structures in 3D medical images. Our orientation handling, coordinate mapping (`voxelToWorld` / `worldToVoxel`), and anatomical direction label logic are based on ITK-SNAP's `ImageCoordinateGeometry` and `GenericSliceModel` implementations. Licensed under GPL.

- **[niivue](https://github.com/niivue/niivue)** — A lightweight web-based NIfTI viewer. Our NIfTI parsing approach and webview rendering architecture were inspired by niivue's design. Licensed under BSD-2-Clause.

---

## License

[MIT](LICENSE) © Maiwulanjiang Maiming
