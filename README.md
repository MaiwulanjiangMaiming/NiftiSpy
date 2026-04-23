# NiftiSpy

A high-performance NIfTI medical image viewer for VS Code, with fast local and remote file browsing, multi-planar reconstruction, and side-by-side comparison.

## Features

- **Fast Loading** — Native `DecompressionStream` API for gzip, server-side preview extraction, progressive rendering
- **Multi-Planar Views** — Axial, Coronal, Sagittal + 3D MIP with drag-to-rotate
- **Side-by-Side Comparison** — Spatial coordinate mapping via sform/qform for cross-image alignment
- **Orientation Labels** — Anatomical direction labels (R/L, A/P, S/I) derived from NIfTI header
- **Window/Level** — Interactive contrast adjustment with auto-contrast
- **Colormaps** — gray, hot, cool, viridis, jet, inferno
- **Remote File Support** — Works with files on remote SSH servers via VS Code Remote

## Usage

1. Open any `.nii`, `.nii.gz`, or `.hdr` file in VS Code
2. The viewer opens automatically as a custom editor
3. Use mouse wheel to scroll slices, drag to pan, Ctrl+drag for window/level
4. Click the maximize button on any view to expand it

## Build

```bash
npm install
npm run build
```

## Acknowledgments

This project was built upon and inspired by the following open-source projects. We are deeply grateful for their excellent work:

- **[ITK-SNAP](http://www.itksnap.org/)** — An open-source software application for segmenting structures in 3D medical images. Our orientation handling, coordinate mapping (voxelToWorld/worldToVoxel), and anatomical direction label logic are based on ITK-SNAP's `ImageCoordinateGeometry` and `GenericSliceModel` implementations. Licensed under GPL.

- **[nii-vue](https://github.com/nii-vue/nii-vue)** / **[niivue](https://github.com/niivue/niivue)** — A lightweight web-based NIfTI viewer. Our NIfTI parsing approach and webview rendering architecture were inspired by niivue's design. Licensed under BSD-2-Clause.

## License

MIT
