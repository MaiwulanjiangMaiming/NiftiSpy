use napi::bindgen_prelude::*;
use napi_derive::napi;
use serde::{Deserialize, Serialize};
use std::cmp::{max, min};
use std::convert::TryInto;

#[allow(non_snake_case)]
#[derive(Serialize, Deserialize, Clone)]
struct Header {
  version: u8,
  ndim: i32,
  nx: usize,
  ny: usize,
  nz: usize,
  nt: usize,
  nu: usize,
  dx: f64,
  dy: f64,
  dz: f64,
  dt: f64,
  datatype: i32,
  bitpix: i32,
  voxOffset: usize,
  scl_slope: f64,
  scl_inter: f64,
  littleEndian: bool,
  isGzip: bool,
  bytesPerVoxel: usize,
  totalVoxels3D: usize,
  sliceSizeXY: usize,
  volumeBytes: usize,
  qform_code: i32,
  sform_code: i32,
  quatern_b: f32,
  quatern_c: f32,
  quatern_d: f32,
  qoffset_x: f32,
  qoffset_y: f32,
  qoffset_z: f32,
  srow_x: Vec<f64>,
  srow_y: Vec<f64>,
  srow_z: Vec<f64>,
  descrip: String,
  xyzt_units: u8,
  orientation: String,
}

#[derive(Copy, Clone)]
enum Axis {
  Axial,
  Coronal,
  Sagittal,
}

fn detect_orientation(srow_x: &[f64], srow_y: &[f64], srow_z: &[f64]) -> String {
  let dx = [srow_x[0], srow_x[1], srow_x[2]];
  let dy = [srow_y[0], srow_y[1], srow_y[2]];
  let dz = [srow_z[0], srow_z[1], srow_z[2]];
  let dom_x = dominant_axis(&dx);
  let dom_y = dominant_axis(&dy);
  let dom_z = dominant_axis(&dz);
  let code = format!(
    "{}{}{}",
    axis_code(dom_x, dx[dom_x]),
    axis_code(dom_y, dy[dom_y]),
    axis_code(dom_z, dz[dom_z]),
  );
  match code.as_str() {
    "RAS" | "LAS" | "LPS" | "RPS" | "RSA" | "LSA" | "LIA" | "RIA" | "AIR" | "PIR" | "RIP" | "LIP" => code,
    _ => "unknown".to_string(),
  }
}

fn dominant_axis(values: &[f64; 3]) -> usize {
  if values[0].abs() >= values[1].abs() && values[0].abs() >= values[2].abs() {
    0
  } else if values[1].abs() >= values[0].abs() && values[1].abs() >= values[2].abs() {
    1
  } else {
    2
  }
}

fn axis_code(axis: usize, val: f64) -> &'static str {
  match (axis, val >= 0.0) {
    (0, true) => "R",
    (0, false) => "L",
    (1, true) => "A",
    (1, false) => "P",
    (2, true) => "S",
    (2, false) => "I",
    _ => "R",
  }
}

fn read_i16(data: &[u8], offset: usize, le: bool) -> i16 {
  let bytes: [u8; 2] = data[offset..offset + 2].try_into().unwrap();
  if le { i16::from_le_bytes(bytes) } else { i16::from_be_bytes(bytes) }
}

fn read_i32(data: &[u8], offset: usize, le: bool) -> i32 {
  let bytes: [u8; 4] = data[offset..offset + 4].try_into().unwrap();
  if le { i32::from_le_bytes(bytes) } else { i32::from_be_bytes(bytes) }
}

fn read_u32(data: &[u8], offset: usize, le: bool) -> u32 {
  let bytes: [u8; 4] = data[offset..offset + 4].try_into().unwrap();
  if le { u32::from_le_bytes(bytes) } else { u32::from_be_bytes(bytes) }
}

fn read_f32(data: &[u8], offset: usize, le: bool) -> f32 {
  let bytes: [u8; 4] = data[offset..offset + 4].try_into().unwrap();
  if le { f32::from_le_bytes(bytes) } else { f32::from_be_bytes(bytes) }
}

fn read_f64(data: &[u8], offset: usize, le: bool) -> f64 {
  let bytes: [u8; 8] = data[offset..offset + 8].try_into().unwrap();
  if le { f64::from_le_bytes(bytes) } else { f64::from_be_bytes(bytes) }
}

fn read_i64(data: &[u8], offset: usize, le: bool) -> i64 {
  let bytes: [u8; 8] = data[offset..offset + 8].try_into().unwrap();
  if le { i64::from_le_bytes(bytes) } else { i64::from_be_bytes(bytes) }
}

fn bytes_per_voxel(datatype: i32, bitpix: i32) -> usize {
  match datatype {
    2 | 256 => 1,
    4 | 512 => 2,
    8 | 16 | 768 => 4,
    64 | 1024 | 1280 => 8,
    128 => 3,
    4096 => 4,
    _ => max(1, (bitpix / 8) as usize),
  }
}

fn parse_header_impl(data: &[u8]) -> Option<Header> {
  if data.len() < 348 {
    return None;
  }
  let sizeof_hdr_le = read_i32(data, 0, true);
  let sizeof_hdr_be = read_i32(data, 0, false);
  let (version, le) = if sizeof_hdr_le == 348 {
    (1u8, true)
  } else if sizeof_hdr_be == 348 {
    (1u8, false)
  } else if sizeof_hdr_le == 540 {
    (2u8, true)
  } else if sizeof_hdr_be == 540 {
    (2u8, false)
  } else {
    return None;
  };

  if version == 1 {
    let ndim = read_i16(data, 40, le) as i32;
    let nx = max(1, read_i16(data, 42, le) as usize);
    let ny = max(1, read_i16(data, 44, le) as usize);
    let nz = max(1, read_i16(data, 46, le) as usize);
    let nt = max(1, read_i16(data, 48, le) as usize);
    let nu = max(1, read_i16(data, 50, le) as usize);
    let datatype = read_i16(data, 70, le) as i32;
    let bitpix = read_i16(data, 72, le) as i32;
    let dx = read_f32(data, 80, le).abs() as f64;
    let dy = read_f32(data, 84, le).abs() as f64;
    let dz = read_f32(data, 88, le).abs() as f64;
    let dt = read_f32(data, 92, le) as f64;
    let vox_offset = max(352, read_f32(data, 108, le) as usize);
    let scl_slope = {
      let v = read_f32(data, 112, le) as f64;
      if v == 0.0 { 1.0 } else { v }
    };
    let scl_inter = read_f32(data, 116, le) as f64;
    let qform_code = read_i16(data, 252, le) as i32;
    let sform_code = read_i16(data, 254, le) as i32;
    let quatern_b = read_f32(data, 256, le);
    let quatern_c = read_f32(data, 260, le);
    let quatern_d = read_f32(data, 264, le);
    let qoffset_x = read_f32(data, 268, le);
    let qoffset_y = read_f32(data, 272, le);
    let qoffset_z = read_f32(data, 276, le);
    let srow_x = vec![read_f32(data, 280, le) as f64, read_f32(data, 284, le) as f64, read_f32(data, 288, le) as f64, read_f32(data, 292, le) as f64];
    let srow_y = vec![read_f32(data, 296, le) as f64, read_f32(data, 300, le) as f64, read_f32(data, 304, le) as f64, read_f32(data, 308, le) as f64];
    let srow_z = vec![read_f32(data, 312, le) as f64, read_f32(data, 316, le) as f64, read_f32(data, 320, le) as f64, read_f32(data, 324, le) as f64];
    let orientation = if sform_code != 0 {
      detect_orientation(&srow_x, &srow_y, &srow_z)
    } else if qform_code != 0 {
      "RAS".to_string()
    } else {
      "unknown".to_string()
    };
    let descrip_bytes = &data[148..min(228, data.len())];
    let end = descrip_bytes.iter().position(|b| *b == 0).unwrap_or(descrip_bytes.len());
    let descrip = String::from_utf8_lossy(&descrip_bytes[..end]).to_string();
    let bpv = bytes_per_voxel(datatype, bitpix);
    Some(Header {
      version,
      ndim,
      nx,
      ny,
      nz,
      nt,
      nu,
      dx: if dx == 0.0 { 1.0 } else { dx },
      dy: if dy == 0.0 { 1.0 } else { dy },
      dz: if dz == 0.0 { 1.0 } else { dz },
      dt,
      datatype,
      bitpix,
      voxOffset: vox_offset,
      scl_slope,
      scl_inter,
      littleEndian: le,
      isGzip: false,
      bytesPerVoxel: bpv,
      totalVoxels3D: nx * ny * nz,
      sliceSizeXY: nx * ny,
      volumeBytes: nx * ny * nz * bpv,
      qform_code,
      sform_code,
      quatern_b,
      quatern_c,
      quatern_d,
      qoffset_x,
      qoffset_y,
      qoffset_z,
      srow_x,
      srow_y,
      srow_z,
      descrip,
      xyzt_units: data.get(123).copied().unwrap_or(0),
      orientation,
    })
  } else {
    let ndim = data.get(16).copied().unwrap_or(0) as i32;
    let nx = max(1, read_i64(data, 24, le) as usize);
    let ny = max(1, read_i64(data, 32, le) as usize);
    let nz = max(1, read_i64(data, 40, le) as usize);
    let nt = max(1, read_i64(data, 48, le) as usize);
    let nu = max(1, read_i64(data, 56, le) as usize);
    let datatype = read_i16(data, 12, le) as i32;
    let bitpix = read_i16(data, 14, le) as i32;
    let dx = read_f64(data, 104, le).abs();
    let dy = read_f64(data, 112, le).abs();
    let dz = read_f64(data, 120, le).abs();
    let dt = read_f64(data, 128, le);
    let vox_offset = max(544, read_i64(data, 168, le) as usize);
    let scl_slope = {
      let v = read_f64(data, 176, le);
      if v == 0.0 { 1.0 } else { v }
    };
    let scl_inter = read_f64(data, 184, le);
    let qform_code = read_i16(data, 196, le) as i32;
    let sform_code = read_i16(data, 198, le) as i32;
    let quatern_b = read_f32(data, 200, le);
    let quatern_c = read_f32(data, 204, le);
    let quatern_d = read_f32(data, 208, le);
    let qoffset_x = read_f32(data, 212, le);
    let qoffset_y = read_f32(data, 216, le);
    let qoffset_z = read_f32(data, 220, le);
    let srow_x = vec![read_f64(data, 224, le), read_f64(data, 232, le), read_f64(data, 240, le), read_f64(data, 248, le)];
    let srow_y = vec![read_f64(data, 256, le), read_f64(data, 264, le), read_f64(data, 272, le), read_f64(data, 280, le)];
    let srow_z = vec![read_f64(data, 288, le), read_f64(data, 296, le), read_f64(data, 304, le), read_f64(data, 312, le)];
    let orientation = if sform_code != 0 {
      detect_orientation(&srow_x, &srow_y, &srow_z)
    } else if qform_code != 0 {
      "RAS".to_string()
    } else {
      "unknown".to_string()
    };
    let bpv = bytes_per_voxel(datatype, bitpix);
    Some(Header {
      version,
      ndim,
      nx,
      ny,
      nz,
      nt,
      nu,
      dx: if dx == 0.0 { 1.0 } else { dx },
      dy: if dy == 0.0 { 1.0 } else { dy },
      dz: if dz == 0.0 { 1.0 } else { dz },
      dt,
      datatype,
      bitpix,
      voxOffset: vox_offset,
      scl_slope,
      scl_inter,
      littleEndian: le,
      isGzip: false,
      bytesPerVoxel: bpv,
      totalVoxels3D: nx * ny * nz,
      sliceSizeXY: nx * ny,
      volumeBytes: nx * ny * nz * bpv,
      qform_code,
      sform_code,
      quatern_b,
      quatern_c,
      quatern_d,
      qoffset_x,
      qoffset_y,
      qoffset_z,
      srow_x,
      srow_y,
      srow_z,
      descrip: String::new(),
      xyzt_units: 0,
      orientation,
    })
  }
}

fn voxel_value(data: &[u8], header: &Header, idx: usize) -> f32 {
  let off = header.voxOffset + idx * header.bytesPerVoxel;
  if off + header.bytesPerVoxel > data.len() {
    return 0.0;
  }
  let le = header.littleEndian;
  let base = match header.datatype {
    2 => data[off] as f64,
    4 => read_i16(data, off, le) as f64,
    8 => read_i32(data, off, le) as f64,
    16 => read_f32(data, off, le) as f64,
    64 => read_f64(data, off, le),
    256 => data[off] as i8 as f64,
    512 => read_u32(data, off, le) as u16 as f64,
    768 => read_u32(data, off, le) as f64,
    _ => 0.0,
  };
  (base * header.scl_slope + header.scl_inter) as f32
}

fn extract_slice_impl(data: &[u8], header: &Header, axis: Axis, index: usize) -> Option<(Vec<f32>, usize, usize)> {
  if header.totalVoxels3D == 0 || data.len() < header.voxOffset {
    return None;
  }
  match axis {
    Axis::Axial => {
      if index >= header.nz { return None; }
      let mut out = vec![0.0f32; header.nx * header.ny];
      let base = index * header.ny * header.nx;
      for i in 0..(header.nx * header.ny) {
        out[i] = voxel_value(data, header, base + i);
      }
      Some((out, header.nx, header.ny))
    }
    Axis::Coronal => {
      if index >= header.ny { return None; }
      let mut out = vec![0.0f32; header.nx * header.nz];
      for z in 0..header.nz {
        let base = z * header.ny * header.nx + index * header.nx;
        for x in 0..header.nx {
          out[z * header.nx + x] = voxel_value(data, header, base + x);
        }
      }
      Some((out, header.nx, header.nz))
    }
    Axis::Sagittal => {
      if index >= header.nx { return None; }
      let mut out = vec![0.0f32; header.ny * header.nz];
      for z in 0..header.nz {
        let base = z * header.ny * header.nx;
        for y in 0..header.ny {
          out[z * header.ny + y] = voxel_value(data, header, base + y * header.nx + index);
        }
      }
      Some((out, header.ny, header.nz))
    }
  }
}

fn downsample(data: &[f32], width: usize, height: usize, factor: usize) -> (Vec<f32>, usize, usize) {
  if factor <= 1 {
    return (data.to_vec(), width, height);
  }
  let nw = max(1, width / factor);
  let nh = max(1, height / factor);
  let mut out = vec![0.0f32; nw * nh];
  for y in 0..nh {
    for x in 0..nw {
      let mut sum = 0.0f32;
      let mut count = 0usize;
      let sy0 = y * factor;
      let sx0 = x * factor;
      let sy1 = min(height, (y + 1) * factor);
      let sx1 = min(width, (x + 1) * factor);
      for sy in sy0..sy1 {
        for sx in sx0..sx1 {
          sum += data[sy * width + sx];
          count += 1;
        }
      }
      out[y * nw + x] = if count > 0 { sum / count as f32 } else { 0.0 };
    }
  }
  (out, nw, nh)
}

#[napi(object)]
pub struct PreviewResult {
  pub header: String,
  pub axial: Buffer,
  pub coronal: Buffer,
  pub sagittal: Buffer,
  pub min: f64,
  pub max: f64,
}

#[napi]
pub fn parse_header(buffer: Buffer) -> Option<String> {
  parse_header_impl(buffer.as_ref()).and_then(|header| serde_json::to_string(&header).ok())
}

#[napi]
pub fn extract_preview(buffer: Buffer) -> Option<PreviewResult> {
  let header = parse_header_impl(buffer.as_ref())?;
  let axial_idx = header.nz / 2;
  let coronal_idx = header.ny / 2;
  let sagittal_idx = header.nx / 2;
  let (axial, _, _) = extract_slice_impl(buffer.as_ref(), &header, Axis::Axial, axial_idx)?;
  let (coronal, _, _) = extract_slice_impl(buffer.as_ref(), &header, Axis::Coronal, coronal_idx)?;
  let (sagittal, _, _) = extract_slice_impl(buffer.as_ref(), &header, Axis::Sagittal, sagittal_idx)?;
  let mut min_val = f32::INFINITY;
  let mut max_val = f32::NEG_INFINITY;
  for slice in [&axial, &coronal, &sagittal] {
    for value in slice.iter() {
      if *value < min_val { min_val = *value; }
      if *value > max_val { max_val = *value; }
    }
  }
  if min_val == max_val {
    max_val = min_val + 1.0;
  }
  Some(PreviewResult {
    header: serde_json::to_string(&header).ok()?,
    axial: Buffer::from(bytemuck(&axial)),
    coronal: Buffer::from(bytemuck(&coronal)),
    sagittal: Buffer::from(bytemuck(&sagittal)),
    min: min_val as f64,
    max: max_val as f64,
  })
}

#[napi]
pub fn extract_slice(buffer: Buffer, header_json: String, axis: String, index: u32, factor: Option<u32>) -> Option<Buffer> {
  let header: Header = serde_json::from_str(&header_json).ok()?;
  let axis = match axis.as_str() {
    "axial" => Axis::Axial,
    "coronal" => Axis::Coronal,
    "sagittal" => Axis::Sagittal,
    _ => return None,
  };
  let (slice, width, height) = extract_slice_impl(buffer.as_ref(), &header, axis, index as usize)?;
  let (downsampled, _, _) = downsample(&slice, width, height, max(1, factor.unwrap_or(1)) as usize);
  Some(Buffer::from(bytemuck(&downsampled)))
}

#[napi]
pub fn decompress_gzip(buffer: Buffer) -> Result<Buffer> {
  use flate2::read::GzDecoder;
  use std::io::Read;

  let mut decoder = GzDecoder::new(buffer.as_ref());
  let mut out = Vec::new();
  decoder.read_to_end(&mut out).map_err(|e| Error::from_reason(e.to_string()))?;
  Ok(Buffer::from(out))
}

fn bytemuck(data: &[f32]) -> Vec<u8> {
  let mut out = Vec::with_capacity(data.len() * 4);
  for value in data {
    out.extend_from_slice(&value.to_le_bytes());
  }
  out
}

#[napi(object)]
pub struct MmapInfo {
  pub header: String,
  pub size: f64,
}

#[napi]
pub fn mmap_parse_header(path: String) -> Option<MmapInfo> {
  let file = std::fs::File::open(&path).ok()?;
  let metadata = file.metadata().ok()?;
  let size = metadata.len();
  if size < 348 {
    return None;
  }
  let mmap = unsafe { memmap2::Mmap::map(&file).ok()? };
  let header = parse_header_impl(mmap.as_ref())?;
  Some(MmapInfo {
    header: serde_json::to_string(&header).ok()?,
    size: size as f64,
  })
}

#[napi]
pub fn mmap_extract_slice(path: String, header_json: String, axis: String, index: u32, factor: Option<u32>) -> Option<Buffer> {
  let file = std::fs::File::open(&path).ok()?;
  let mmap = unsafe { memmap2::Mmap::map(&file).ok()? };
  let header: Header = serde_json::from_str(&header_json).ok()?;
  let axis_enum = match axis.as_str() {
    "axial" => Axis::Axial,
    "coronal" => Axis::Coronal,
    "sagittal" => Axis::Sagittal,
    _ => return None,
  };
  let (slice, width, height) = extract_slice_impl(mmap.as_ref(), &header, axis_enum, index as usize)?;
  let (downsampled, _, _) = downsample(&slice, width, height, std::cmp::max(1, factor.unwrap_or(1)) as usize);
  Some(Buffer::from(bytemuck(&downsampled)))
}

#[napi]
pub fn mmap_extract_preview(path: String) -> Option<PreviewResult> {
  let file = std::fs::File::open(&path).ok()?;
  let mmap = unsafe { memmap2::Mmap::map(&file).ok()? };
  let header = parse_header_impl(mmap.as_ref())?;
  let axial_idx = header.nz / 2;
  let coronal_idx = header.ny / 2;
  let sagittal_idx = header.nx / 2;
  let (axial, _, _) = extract_slice_impl(mmap.as_ref(), &header, Axis::Axial, axial_idx)?;
  let (coronal, _, _) = extract_slice_impl(mmap.as_ref(), &header, Axis::Coronal, coronal_idx)?;
  let (sagittal, _, _) = extract_slice_impl(mmap.as_ref(), &header, Axis::Sagittal, sagittal_idx)?;
  let mut min_val = f32::INFINITY;
  let mut max_val = f32::NEG_INFINITY;
  for slice in [&axial, &coronal, &sagittal] {
    for value in slice.iter() {
      if *value < min_val { min_val = *value; }
      if *value > max_val { max_val = *value; }
    }
  }
  if min_val == max_val {
    max_val = min_val + 1.0;
  }
  Some(PreviewResult {
    header: serde_json::to_string(&header).ok()?,
    axial: Buffer::from(bytemuck(&axial)),
    coronal: Buffer::from(bytemuck(&coronal)),
    sagittal: Buffer::from(bytemuck(&sagittal)),
    min: min_val as f64,
    max: max_val as f64,
  })
}

#[napi]
pub fn fast_decompress_gzip(buffer: Buffer) -> Result<Buffer> {
  use flate2::read::GzDecoder;
  use std::io::Read;

  let input = buffer.as_ref();
  let estimated_size = input.len() * 4;
  let mut decoder = GzDecoder::new(input);
  let mut out = Vec::with_capacity(estimated_size.min(512 * 1024 * 1024));
  decoder.read_to_end(&mut out).map_err(|e| Error::from_reason(e.to_string()))?;
  Ok(Buffer::from(out))
}

/// One-shot gzip decompression using libdeflate.
///
/// ~2x faster than `fast_decompress_gzip` (which uses flate2/zlib-ng) on
/// Apple Silicon because libdeflate uses more aggressive SIMD inflate
/// (NEON on ARM64, AVX2 on x86_64) and avoids streaming/event-loop overhead.
///
/// Requires the gzip footer (last 8 bytes = CRC32 + ISIZE) to be intact
/// so we can pre-allocate the exact output buffer. If ISIZE is 0 or the
/// decompressed size exceeds 4 GB (ISIZE wraps at 2^32), returns an error
/// and the caller should fall back to streaming.
///
/// Trade-off: no early preview (z=0 slice during decompression) since
/// libdeflate is one-shot. The caller gets the full buffer at once.
#[napi]
pub fn fast_decompress_gzip_oneshot(buffer: Buffer) -> Result<Buffer> {
  use libdeflater::Decompressor;

  let input = buffer.as_ref();

  // Read gzip footer (RFC 1952): last 8 bytes = CRC32 (4) + ISIZE (4, LE u32).
  // ISIZE = uncompressed size mod 2^32. For files < 4 GB this is exact.
  if input.len() < 18 {
    return Err(Error::from_reason("Input too small for a valid gzip stream"));
  }
  let tail = &input[input.len() - 8..];
  let isize = u32::from_le_bytes([tail[4], tail[5], tail[6], tail[7]]) as usize;

  // Sanity: ISIZE must be non-zero. If 0, the file is either empty or a
  // multi-stream gzip (concatenated members) where ISIZE only reflects the
  // last member — we can't trust it for pre-allocation.
  if isize == 0 {
    return Err(Error::from_reason("ISIZE is 0 (possibly multi-stream gzip); fall back to streaming"));
  }
  // Cap at 2 GB to avoid pathological allocations on corrupt input.
  if isize > 2 * 1024 * 1024 * 1024 {
    return Err(Error::from_reason("ISIZE > 2GB; refusing to pre-allocate"));
  }

  // Pre-allocate exact output buffer (zero-initialized for safety).
  let mut out = vec![0u8; isize];

  let mut decompressor = Decompressor::new();
  let actual_size = decompressor
    .gzip_decompress(input, &mut out)
    .map_err(|e| Error::from_reason(format!("libdeflate decompress error: {:?}", e)))?;

  // Truncate to actual decompressed size. For well-formed single-member gzip
  // files, actual_size == isize. If they differ (e.g., trailing garbage),
  // trust libdeflate's reported size.
  if actual_size != isize {
    out.truncate(actual_size);
  }

  Ok(Buffer::from(out))
}

// ── v1.9.0: Batch slice extraction ──────────────────────────────────────

#[napi]
pub fn mmap_extract_slice_batch(path: String, header_json: String, axis: String, indices: Vec<u32>) -> Option<Vec<Buffer>> {
  let file = std::fs::File::open(&path).ok()?;
  let mmap = unsafe { memmap2::Mmap::map(&file).ok()? };
  let header: Header = serde_json::from_str(&header_json).ok()?;
  let axis_enum = match axis.as_str() {
    "axial" => Axis::Axial,
    "coronal" => Axis::Coronal,
    "sagittal" => Axis::Sagittal,
    _ => return None,
  };
  let mut results = Vec::with_capacity(indices.len());
  for &idx in &indices {
    let (slice, _w, _h) = extract_slice_impl(mmap.as_ref(), &header, axis_enum, idx as usize)?;
    results.push(Buffer::from(bytemuck(&slice)));
  }
  Some(results)
}

// ── v1.9.0: Volume statistics via streaming ─────────────────────────────

#[napi(object)]
pub struct VolumeStats {
  pub min: f64,
  pub max: f64,
  pub mean: f64,
  pub std: f64,
  pub p1: f64,
  pub p5: f64,
  pub p95: f64,
  pub p99: f64,
  pub histogram: Vec<u32>,
}

#[napi]
pub fn mmap_get_volume_stats(path: String, header_json: String) -> Option<VolumeStats> {
  let file = std::fs::File::open(&path).ok()?;
  let mmap = unsafe { memmap2::Mmap::map(&file).ok()? };
  let header: Header = serde_json::from_str(&header_json).ok()?;
  let n = header.totalVoxels3D;
  if n == 0 { return None; }

  // Streaming pass: compute min, max, mean (Welford), and build histogram
  let num_bins: usize = 256;
  let mut histogram = vec![0u32; num_bins];
  let mut min_val = f64::INFINITY;
  let mut max_val = f64::NEG_INFINITY;
  let mut mean = 0.0f64;
  let mut m2 = 0.0f64; // Welford's online variance

  // First pass: find min/max and compute mean/std with Welford
  let sample_step = std::cmp::max(1, n / 200000); // sample up to ~200k voxels
  let mut count = 0usize;
  for i in (0..n).step_by(sample_step) {
    let v = voxel_value(mmap.as_ref(), &header, i) as f64;
    if v < min_val { min_val = v; }
    if v > max_val { max_val = v; }
    count += 1;
    let delta = v - mean;
    mean += delta / count as f64;
    let delta2 = v - mean;
    m2 += delta * delta2;
  }

  if count == 0 || min_val == max_val {
    max_val = min_val + 1.0;
  }

  let variance = if count > 1 { m2 / (count - 1) as f64 } else { 0.0 };
  let std_val = variance.sqrt();

  // Second pass: build histogram and collect samples for percentiles
  let range = max_val - min_val;
  let mut samples = Vec::with_capacity(count);
  for i in (0..n).step_by(sample_step) {
    let v = voxel_value(mmap.as_ref(), &header, i) as f64;
    let bin = if range > 0.0 {
      std::cmp::min(num_bins - 1, ((v - min_val) / range * num_bins as f64) as usize)
    } else {
      0
    };
    histogram[bin] += 1;
    samples.push(v);
  }

  // Compute percentiles from samples
  samples.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
  let p1 = samples[samples.len() / 100].min(max_val).max(min_val);
  let p5 = samples[samples.len() / 20].min(max_val).max(min_val);
  let p95 = samples[samples.len() * 19 / 20].min(max_val).max(min_val);
  let p99 = samples[samples.len() * 99 / 100].min(max_val).max(min_val);

  Some(VolumeStats {
    min: min_val,
    max: max_val,
    mean,
    std: std_val,
    p1,
    p5,
    p95,
    p99,
    histogram,
  })
}

// ── v1.9.0: Bilinear resampling ─────────────────────────────────────────

#[napi]
pub fn fast_resample_slice(data: Float32Array, src_width: u32, src_height: u32, dst_width: u32, dst_height: u32) -> Buffer {
  let src = data.as_ref();
  let sw = src_width as usize;
  let sh = src_height as usize;
  let dw = dst_width as usize;
  let dh = dst_height as usize;
  let mut out = vec![0.0f32; dw * dh];

  let x_ratio = if dw > 0 && sw > 0 { sw as f32 / dw as f32 } else { 1.0 };
  let y_ratio = if dh > 0 && sh > 0 { sh as f32 / dh as f32 } else { 1.0 };

  for y in 0..dh {
    for x in 0..dw {
      let src_x = x as f32 * x_ratio;
      let src_y = y as f32 * y_ratio;
      let x0 = (src_x as usize).min(sw - 1);
      let y0 = (src_y as usize).min(sh - 1);
      let x1 = (x0 + 1).min(sw - 1);
      let y1 = (y0 + 1).min(sh - 1);
      let xf = src_x - x0 as f32;
      let yf = src_y - y0 as f32;

      let v00 = src[y0 * sw + x0];
      let v10 = src[y0 * sw + x1];
      let v01 = src[y1 * sw + x0];
      let v11 = src[y1 * sw + x1];

      let v0 = v00 * (1.0 - xf) + v10 * xf;
      let v1 = v01 * (1.0 - xf) + v11 * xf;
      out[y * dw + x] = v0 * (1.0 - yf) + v1 * yf;
    }
  }

  Buffer::from(bytemuck(&out))
}

// ── v1.9.0: Window/Level normalization ──────────────────────────────────

#[napi]
pub fn fast_apply_window_level(data: Float32Array, window_level: f64, window_width: f64, global_min: f64, global_max: f64) -> Buffer {
  let src = data.as_ref();
  let n = src.len();
  let mut out = vec![0u8; n];

  let lo = window_level - window_width * 0.5;
  let range = window_width;
  let data_range = global_max - global_min;
  if data_range == 0.0 || range == 0.0 {
    return Buffer::from(out);
  }

  for i in 0..n {
    let norm = (src[i] as f64 - global_min) / data_range;
    let t = ((norm - lo) / range).clamp(0.0, 1.0);
    out[i] = (t * 255.0 + 0.5) as u8;
  }

  Buffer::from(out)
}
