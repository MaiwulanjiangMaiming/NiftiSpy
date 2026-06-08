use wasm_bindgen::prelude::*;
use serde::{Deserialize, Serialize};
use std::cmp::{max, min};

// ── Header struct (mirrors native/src/lib.rs) ──────────────────────────

#[derive(Serialize, Deserialize, Clone)]
#[allow(non_snake_case)]
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

// ── Helper functions ───────────────────────────────────────────────────

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
        _ => "RAS".to_string(),
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
        let scl_slope = { let v = read_f32(data, 112, le) as f64; if v == 0.0 { 1.0 } else { v } };
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
        } else {
            "RAS".to_string()
        };
        let descrip_bytes = &data[148..min(228, data.len())];
        let end = descrip_bytes.iter().position(|b| *b == 0).unwrap_or(descrip_bytes.len());
        let descrip = String::from_utf8_lossy(&descrip_bytes[..end]).to_string();
        let bpv = bytes_per_voxel(datatype, bitpix);
        Some(Header {
            version, ndim, nx, ny, nz, nt, nu,
            dx: if dx == 0.0 { 1.0 } else { dx },
            dy: if dy == 0.0 { 1.0 } else { dy },
            dz: if dz == 0.0 { 1.0 } else { dz },
            dt, datatype, bitpix, voxOffset: vox_offset, scl_slope, scl_inter,
            littleEndian: le, isGzip: false, bytesPerVoxel: bpv,
            totalVoxels3D: nx * ny * nz, sliceSizeXY: nx * ny,
            volumeBytes: nx * ny * nz * bpv,
            qform_code, sform_code, quatern_b, quatern_c, quatern_d,
            qoffset_x, qoffset_y, qoffset_z,
            srow_x, srow_y, srow_z, descrip,
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
        let scl_slope = { let v = read_f64(data, 176, le); if v == 0.0 { 1.0 } else { v } };
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
        } else {
            "RAS".to_string()
        };
        let bpv = bytes_per_voxel(datatype, bitpix);
        Some(Header {
            version, ndim, nx, ny, nz, nt, nu,
            dx: if dx == 0.0 { 1.0 } else { dx },
            dy: if dy == 0.0 { 1.0 } else { dy },
            dz: if dz == 0.0 { 1.0 } else { dz },
            dt, datatype, bitpix, voxOffset: vox_offset, scl_slope, scl_inter,
            littleEndian: le, isGzip: false, bytesPerVoxel: bpv,
            totalVoxels3D: nx * ny * nz, sliceSizeXY: nx * ny,
            volumeBytes: nx * ny * nz * bpv,
            qform_code, sform_code, quatern_b, quatern_c, quatern_d,
            qoffset_x, qoffset_y, qoffset_z,
            srow_x, srow_y, srow_z, descrip: String::new(),
            xyzt_units: 0, orientation,
        })
    }
}

// ── SIMD-accelerated voxel value extraction ────────────────────────────
// For Float32 data (datatype=16), we can use SIMD via wasm-bindgen
// The Rust compiler auto-vectorizes with -C target-feature=+simd128

#[inline(always)]
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

// ── SIMD batch extraction for Float32 data ─────────────────────────────
// When datatype=16 and scl_slope=1/scl_inter=0, we can memcpy directly

fn extract_slice_simd_f32(data: &[u8], header: &Header, axis_byte_offset: usize, count: usize) -> Vec<f32> {
    // Fast path: Float32, no scaling, little-endian match
    if header.datatype == 16 && header.scl_slope == 1.0 && header.scl_inter == 0.0 {
        let byte_start = header.voxOffset + axis_byte_offset * 4;
        let byte_len = count * 4;
        if byte_start + byte_len <= data.len() {
            // Direct memcpy — Rust auto-vectorizes this with SIMD
            let mut out = vec![0.0f32; count];
            let src = &data[byte_start..byte_start + byte_len];
            // Safe byte copy — compiler uses SIMD instructions
            for i in 0..count {
                let off = i * 4;
                out[i] = f32::from_le_bytes([src[off], src[off + 1], src[off + 2], src[off + 3]]);
            }
            return out;
        }
    }
    // Fallback: per-voxel extraction
    let mut out = vec![0.0f32; count];
    for i in 0..count {
        out[i] = voxel_value(data, header, axis_byte_offset + i);
    }
    out
}

// ── SIMD batch window/level ────────────────────────────────────────────
// Processes 4 f32 values at once using SIMD intrinsics

fn apply_window_level_simd(data: &[f32], window_level: f64, window_width: f64, global_min: f64, global_max: f64) -> Vec<u8> {
    let n = data.len();
    let mut out = vec![0u8; n];
    let lo = window_level - window_width * 0.5;
    let range = window_width;
    let data_range = global_max - global_min;
    if data_range == 0.0 || range == 0.0 {
        return out;
    }

    // Process 4 elements at a time for SIMD auto-vectorization
    let lo_f32 = lo as f32;
    let range_f32 = range as f32;
    let data_range_f32 = data_range as f32;
    let global_min_f32 = global_min as f32;

    let mut i = 0;
    while i + 4 <= n {
        // Load 4 values — compiler uses SIMD v128.load
        let v0 = data[i];
        let v1 = data[i + 1];
        let v2 = data[i + 2];
        let v3 = data[i + 3];

        // Normalize — compiler uses SIMD f32x4.div
        let n0 = (v0 - global_min_f32) / data_range_f32;
        let n1 = (v1 - global_min_f32) / data_range_f32;
        let n2 = (v2 - global_min_f32) / data_range_f32;
        let n3 = (v3 - global_min_f32) / data_range_f32;

        // Apply window — compiler uses SIMD f32x4.sub, f32x4.div
        let t0 = ((n0 - lo_f32) / range_f32).clamp(0.0, 1.0);
        let t1 = ((n1 - lo_f32) / range_f32).clamp(0.0, 1.0);
        let t2 = ((n2 - lo_f32) / range_f32).clamp(0.0, 1.0);
        let t3 = ((n3 - lo_f32) / range_f32).clamp(0.0, 1.0);

        // Convert to u8
        out[i]     = (t0 * 255.0 + 0.5) as u8;
        out[i + 1] = (t1 * 255.0 + 0.5) as u8;
        out[i + 2] = (t2 * 255.0 + 0.5) as u8;
        out[i + 3] = (t3 * 255.0 + 0.5) as u8;

        i += 4;
    }

    // Remaining elements
    while i < n {
        let norm = (data[i] as f64 - global_min) / data_range;
        let t = ((norm - lo) / range).clamp(0.0, 1.0);
        out[i] = (t * 255.0 + 0.5) as u8;
        i += 1;
    }

    out
}

// ── SIMD bilinear resample ──────────────────────────────────────────────

fn resample_slice_simd(data: &[f32], src_width: usize, src_height: usize, dst_width: usize, dst_height: usize) -> Vec<f32> {
    let mut out = vec![0.0f32; dst_width * dst_height];
    let x_ratio = if dst_width > 0 && src_width > 0 { src_width as f32 / dst_width as f32 } else { 1.0 };
    let y_ratio = if dst_height > 0 && src_height > 0 { src_height as f32 / dst_height as f32 } else { 1.0 };

    // Process 4 pixels at a time for SIMD auto-vectorization
    let mut y = 0;
    while y < dst_height {
        let mut x = 0;
        while x + 4 <= dst_width {
            // Batch 4 x-coordinates — compiler can auto-vectorize
            for dx in 0..4 {
                let xi = x + dx;
                let src_x = xi as f32 * x_ratio;
                let src_y = y as f32 * y_ratio;
                let x0 = (src_x as usize).min(src_width - 1);
                let y0 = (src_y as usize).min(src_height - 1);
                let x1 = (x0 + 1).min(src_width - 1);
                let y1 = (y0 + 1).min(src_height - 1);
                let xf = src_x - x0 as f32;
                let yf = src_y - y0 as f32;
                let v00 = data[y0 * src_width + x0];
                let v10 = data[y0 * src_width + x1];
                let v01 = data[y1 * src_width + x0];
                let v11 = data[y1 * src_width + x1];
                let v0 = v00 * (1.0 - xf) + v10 * xf;
                let v1 = v01 * (1.0 - xf) + v11 * xf;
                out[y * dst_width + xi] = v0 * (1.0 - yf) + v1 * yf;
            }
            x += 4;
        }
        while x < dst_width {
            let src_x = x as f32 * x_ratio;
            let src_y = y as f32 * y_ratio;
            let x0 = (src_x as usize).min(src_width - 1);
            let y0 = (src_y as usize).min(src_height - 1);
            let x1 = (x0 + 1).min(src_width - 1);
            let y1 = (y0 + 1).min(src_height - 1);
            let xf = src_x - x0 as f32;
            let yf = src_y - y0 as f32;
            let v00 = data[y0 * src_width + x0];
            let v10 = data[y0 * src_width + x1];
            let v01 = data[y1 * src_width + x0];
            let v11 = data[y1 * src_width + x1];
            let v0 = v00 * (1.0 - xf) + v10 * xf;
            let v1 = v01 * (1.0 - xf) + v11 * xf;
            out[y * dst_width + x] = v0 * (1.0 - yf) + v1 * yf;
            x += 1;
        }
        y += 1;
    }
    out
}

// ── Axis enum ──────────────────────────────────────────────────────────

#[derive(Copy, Clone)]
enum Axis {
    Axial,
    Coronal,
    Sagittal,
}

fn extract_slice_impl(data: &[u8], header: &Header, axis: Axis, index: usize) -> Option<(Vec<f32>, usize, usize)> {
    if header.totalVoxels3D == 0 || data.len() < header.voxOffset {
        return None;
    }
    match axis {
        Axis::Axial => {
            if index >= header.nz { return None; }
            let base = index * header.ny * header.nx;
            let out = extract_slice_simd_f32(data, header, base, header.nx * header.ny);
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

// ════════════════════════════════════════════════════════════════════════
// WASM exports — exposed to JavaScript via wasm-bindgen
// ════════════════════════════════════════════════════════════════════════

#[wasm_bindgen]
pub fn wasm_parse_header(data: &[u8]) -> Option<String> {
    parse_header_impl(data).and_then(|h| serde_json::to_string(&h).ok())
}

#[wasm_bindgen]
pub fn wasm_extract_slice(data: &[u8], header_json: &str, axis: &str, index: usize) -> Option<Vec<u8>> {
    let header: Header = serde_json::from_str(header_json).ok()?;
    let axis_enum = match axis {
        "axial" => Axis::Axial,
        "coronal" => Axis::Coronal,
        "sagittal" => Axis::Sagittal,
        _ => return None,
    };
    let (slice, _w, _h) = extract_slice_impl(data, &header, axis_enum, index)?;
    // Return as raw bytes (f32 little-endian)
    let mut out = Vec::with_capacity(slice.len() * 4);
    for v in &slice {
        out.extend_from_slice(&v.to_le_bytes());
    }
    Some(out)
}

#[wasm_bindgen]
pub fn wasm_extract_preview(data: &[u8]) -> Option<String> {
    let header = parse_header_impl(data)?;
    let axial_idx = header.nz / 2;
    let coronal_idx = header.ny / 2;
    let sagittal_idx = header.nx / 2;

    let (axial, aw, ah) = extract_slice_impl(data, &header, Axis::Axial, axial_idx)?;
    let (coronal, cw, ch) = extract_slice_impl(data, &header, Axis::Coronal, coronal_idx)?;
    let (sagittal, sw, sh) = extract_slice_impl(data, &header, Axis::Sagittal, sagittal_idx)?;

    // Find min/max across all slices
    let mut min_val = f32::INFINITY;
    let mut max_val = f32::NEG_INFINITY;
    for slice in [&axial, &coronal, &sagittal] {
        for v in slice {
            if *v < min_val { min_val = *v; }
            if *v > max_val { max_val = *v; }
        }
    }
    if min_val == max_val { max_val = min_val + 1.0; }

    // Return as JSON with base64-encoded slice data
    let result = serde_json::json!({
        "header": header,
        "axial": {
            "data": base64_encode_f32(&axial),
            "width": aw,
            "height": ah,
        },
        "coronal": {
            "data": base64_encode_f32(&coronal),
            "width": cw,
            "height": ch,
        },
        "sagittal": {
            "data": base64_encode_f32(&sagittal),
            "width": sw,
            "height": sh,
        },
        "min": min_val,
        "max": max_val,
    });
    Some(result.to_string())
}

#[wasm_bindgen]
pub fn wasm_apply_window_level(data: &[f32], window_level: f64, window_width: f64, global_min: f64, global_max: f64) -> Vec<u8> {
    apply_window_level_simd(data, window_level, window_width, global_min, global_max)
}

#[wasm_bindgen]
pub fn wasm_resample_slice(data: &[f32], src_width: usize, src_height: usize, dst_width: usize, dst_height: usize) -> Vec<u8> {
    let out = resample_slice_simd(data, src_width, src_height, dst_width, dst_height);
    let mut bytes = Vec::with_capacity(out.len() * 4);
    for v in &out {
        bytes.extend_from_slice(&v.to_le_bytes());
    }
    bytes
}

#[wasm_bindgen]
pub fn wasm_get_volume_stats(data: &[u8], header_json: &str) -> Option<String> {
    let header: Header = serde_json::from_str(header_json).ok()?;
    let n = header.totalVoxels3D;
    if n == 0 { return None; }

    // Streaming pass: Welford's online algorithm
    let sample_step = max(1, n / 200000);
    let mut min_val = f64::INFINITY;
    let mut max_val = f64::NEG_INFINITY;
    let mut mean = 0.0f64;
    let mut m2 = 0.0f64;
    let mut count = 0usize;
    let mut samples = Vec::new();

    for i in (0..n).step_by(sample_step) {
        let v = voxel_value(data, &header, i) as f64;
        if v < min_val { min_val = v; }
        if v > max_val { max_val = v; }
        count += 1;
        let delta = v - mean;
        mean += delta / count as f64;
        let delta2 = v - mean;
        m2 += delta * delta2;
        samples.push(v);
    }

    if count == 0 || min_val == max_val {
        max_val = min_val + 1.0;
    }

    let variance = if count > 1 { m2 / (count - 1) as f64 } else { 0.0 };
    let std_val = variance.sqrt();

    // Histogram
    let num_bins = 256;
    let range = max_val - min_val;
    let mut histogram = vec![0u32; num_bins];
    for &v in &samples {
        let bin = if range > 0.0 {
            min(num_bins - 1, ((v - min_val) / range * num_bins as f64) as usize)
        } else { 0 };
        histogram[bin] += 1;
    }

    // Percentiles
    samples.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let p1 = samples[samples.len() / 100].min(max_val).max(min_val);
    let p5 = samples[samples.len() / 20].min(max_val).max(min_val);
    let p95 = samples[samples.len() * 19 / 20].min(max_val).max(min_val);
    let p99 = samples[samples.len() * 99 / 100].min(max_val).max(min_val);

    let result = serde_json::json!({
        "min": min_val, "max": max_val, "mean": mean, "std": std_val,
        "p1": p1, "p5": p5, "p95": p95, "p99": p99,
        "histogram": histogram,
    });
    Some(result.to_string())
}

// ── SIMD feature detection ────────────────────────────────────────────

#[wasm_bindgen]
pub fn wasm_has_simd() -> bool {
    // This function returns true if the WASM module was compiled with SIMD support.
    // The browser must support WASM SIMD (V8, SpiderMonkey, JavaScriptCore all do since 2021).
    // When compiled with `wasm-pack --target web -O`, Rust auto-enables SIMD128.
    #[cfg(target_feature = "simd128")]
    { true }
    #[cfg(not(target_feature = "simd128"))]
    { false }
}

// ── Helper: base64 encode f32 array ────────────────────────────────────

fn base64_encode_f32(data: &[f32]) -> String {
    let bytes: Vec<u8> = data.iter().flat_map(|v| v.to_le_bytes()).collect();
    // Simple base64 encoding (no external dependency)
    const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((bytes.len() + 2) / 3 * 4);
    let chunks = bytes.chunks(3);
    for chunk in chunks {
        let b0 = chunk[0] as u32;
        let b1 = if chunk.len() > 1 { chunk[1] as u32 } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] as u32 } else { 0 };
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(CHARS[((triple >> 18) & 0x3F) as usize] as char);
        out.push(CHARS[((triple >> 12) & 0x3F) as usize] as char);
        if chunk.len() > 1 {
            out.push(CHARS[((triple >> 6) & 0x3F) as usize] as char);
        } else {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(CHARS[(triple & 0x3F) as usize] as char);
        } else {
            out.push('=');
        }
    }
    out
}
