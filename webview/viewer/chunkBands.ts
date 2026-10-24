/**
 * Chunked 3D textures are split along z. For coronal/sagittal slices the
 * viewer draws one horizontal band per chunk; this computes the z interval
 * and the texture-coordinate range each band must cover.
 *
 * Texture v=0 is the bottom vertex. With flipY the shader samples 1-v, so the
 * band's texture coords are mirrored while its on-screen position stays
 * anchored to the same z interval.
 */
export interface ChunkBand {
  zStart: number;
  chunkDepth: number;
  ty0: number;
  ty1: number;
}

export function computeChunkBands(nz: number, chunkZSize: number, flipY: boolean): ChunkBand[] {
  if (nz <= 0 || chunkZSize <= 0) return [];
  const bands: ChunkBand[] = [];
  for (let zStart = 0; zStart < nz; zStart += chunkZSize) {
    const zEnd = Math.min(zStart + chunkZSize, nz);
    const fy0 = zStart / nz;
    const fy1 = zEnd / nz;
    bands.push({
      zStart,
      chunkDepth: zEnd - zStart,
      ty0: flipY ? 1 - fy1 : fy0,
      ty1: flipY ? 1 - fy0 : fy1,
    });
  }
  return bands;
}
