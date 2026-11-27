//! Native application icon decoding, DPI target selection, and Win32 HICON lifecycle management.
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

/// Largest icon payload accepted from the webview (any target-size PNG is far smaller).
pub const MAX_APP_ICON_BYTES: usize = 1024 * 1024;
/// Maximum number of rasterized variants accepted in a single update.
pub const MAX_ICON_VARIANTS: usize = 16;
/// Maximum pixel edge length accepted for a decoded icon variant.
pub const MAX_ICON_DIMENSION: u32 = 1024;

/// A single rasterized PNG variant at a specific target edge length.
#[derive(Deserialize)]
pub struct IconVariantInput {
    pub size: u32,
    pub png: Vec<u8>,
}

/// Target icon dimensions reported to the web UI for crisp SVG rasterization.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct IconTargetSizes {
    pub platform: &'static str,
    pub small: u32,
    pub big: u32,
    pub sizes: Vec<u32>,
}

/// Decoded RGBA icon variant retained for DPI-change refreshes on Windows.
#[cfg_attr(target_os = "macos", allow(dead_code))]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DecodedIconVariant {
    pub size: u32,
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

/// Decode and validate incoming PNG icon payloads from the webview.
#[cfg(any(not(target_os = "macos"), test))]
pub fn decode_variants(
    png: Option<Vec<u8>>,
    variants: Option<Vec<IconVariantInput>>,
) -> Result<Vec<DecodedIconVariant>, String> {
    let mut decoded = Vec::new();
    if let Some(items) = variants {
        if items.len() > MAX_ICON_VARIANTS {
            return Err("Too many icon variants".into());
        }
        for item in items {
            if item.size == 0 || item.size > MAX_ICON_DIMENSION {
                return Err("Invalid icon size".into());
            }
            let variant = decode_png(&item.png)?;
            if variant.width != item.size || variant.height != item.size {
                return Err("Icon variant dimensions do not match declared size".into());
            }
            decoded.push(variant);
        }
    }
    if decoded.is_empty() {
        let fallback = png.ok_or_else(|| "Invalid icon".to_string())?;
        decoded.push(decode_png(&fallback)?);
    }
    decoded.sort_by_key(|v| v.size);
    decoded.dedup_by_key(|v| v.size);
    Ok(decoded)
}

fn decode_png(bytes: &[u8]) -> Result<DecodedIconVariant, String> {
    if bytes.is_empty() || bytes.len() > MAX_APP_ICON_BYTES {
        return Err("Invalid icon".into());
    }
    let image = tauri::image::Image::from_bytes(bytes).map_err(|_| "Invalid icon")?;
    let width = image.width();
    let height = image.height();
    if width == 0
        || height == 0
        || width > MAX_ICON_DIMENSION
        || height > MAX_ICON_DIMENSION
        || width != height
    {
        return Err("Invalid icon dimensions".into());
    }
    let rgba = image.rgba().to_vec();
    let expected_len = (width as usize)
        .checked_mul(height as usize)
        .and_then(|pixels| pixels.checked_mul(4))
        .ok_or_else(|| "Invalid icon dimensions".to_string())?;
    if rgba.len() != expected_len {
        return Err("Invalid icon buffer".into());
    }
    Ok(DecodedIconVariant {
        size: width,
        width,
        height,
        rgba,
    })
}

/// Select the best variant for a requested pixel dimension:
/// 1) exact match, 2) smallest variant larger than target (no upscaling blur), 3) largest available.
#[cfg(any(not(target_os = "macos"), test))]
pub fn select_variant_for_size(
    variants: &[DecodedIconVariant],
    target: u32,
) -> Option<&DecodedIconVariant> {
    if variants.is_empty() {
        return None;
    }
    if let Some(exact) = variants.iter().find(|v| v.size == target) {
        return Some(exact);
    }
    variants
        .iter()
        .filter(|v| v.size > target)
        .min_by_key(|v| v.size)
        .or_else(|| variants.iter().max_by_key(|v| v.size))
}

/// Validate and pick raw PNG bytes for macOS Dock icons without unnecessary re-encoding.
#[cfg(any(target_os = "macos", test))]
pub fn pick_macos_png(
    png: Option<Vec<u8>>,
    variants: Option<Vec<IconVariantInput>>,
) -> Result<Vec<u8>, String> {
    let mut best: Option<(u32, Vec<u8>)> = None;
    if let Some(items) = variants {
        if items.len() > MAX_ICON_VARIANTS {
            return Err("Too many icon variants".into());
        }
        for item in items {
            if item.size == 0 || item.size > MAX_ICON_DIMENSION {
                return Err("Invalid icon size".into());
            }
            let variant = decode_png(&item.png)?;
            if variant.width != item.size || variant.height != item.size {
                return Err("Icon variant dimensions do not match declared size".into());
            }
            if best.as_ref().is_none_or(|(size, _)| variant.size >= *size) {
                best = Some((variant.size, item.png));
            }
        }
    }
    if let Some((_, bytes)) = best {
        return Ok(bytes);
    }
    let fallback = png.ok_or_else(|| "Invalid icon".to_string())?;
    decode_png(&fallback)?;
    Ok(fallback)
}

/// Report the OS-preferred icon sizes for the active window.
pub fn target_sizes_for_window(app: &AppHandle) -> IconTargetSizes {
    #[cfg(windows)]
    {
        let (small, big) = windows_target_sizes(app);
        let mut sizes = vec![small, big, 16, 20, 24, 32, 40, 48, 64, 256];
        sizes.sort_unstable();
        sizes.dedup();
        IconTargetSizes {
            platform: "windows",
            small,
            big,
            sizes,
        }
    }
    #[cfg(target_os = "macos")]
    {
        let _ = app;
        IconTargetSizes {
            platform: "macos",
            small: 512,
            big: 512,
            sizes: vec![512],
        }
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let _ = app;
        IconTargetSizes {
            platform: "other",
            small: 32,
            big: 64,
            sizes: vec![16, 24, 32, 48, 64, 256],
        }
    }
}

/// Convert RGBA pixels into Win32 `CreateIcon` buffers: 1-bpp WORD-aligned AND mask + 32-bpp BGRA XOR bitmap.
#[cfg(any(windows, test))]
pub fn build_win32_icon_buffers(
    width: u32,
    height: u32,
    rgba: &[u8],
) -> Result<(Vec<u8>, Vec<u8>), String> {
    if width == 0 || height == 0 || width > MAX_ICON_DIMENSION || height > MAX_ICON_DIMENSION {
        return Err("Invalid icon dimensions".into());
    }
    let expected_len = (width as usize)
        .checked_mul(height as usize)
        .and_then(|pixels| pixels.checked_mul(4))
        .ok_or_else(|| "Invalid icon dimensions".to_string())?;
    if rgba.len() != expected_len {
        return Err("Invalid icon buffer".into());
    }

    let stride = (width as usize).div_ceil(16) * 2;
    let mut and_mask = vec![0u8; stride * height as usize];
    let mut bgra = Vec::with_capacity(expected_len);

    for y in 0..height as usize {
        for x in 0..width as usize {
            let idx = (y * width as usize + x) * 4;
            let r = rgba[idx];
            let g = rgba[idx + 1];
            let b = rgba[idx + 2];
            let a = rgba[idx + 3];
            if a == 0 {
                and_mask[y * stride + (x / 8)] |= 0x80 >> (x % 8);
                bgra.extend_from_slice(&[0, 0, 0, 0]);
            } else {
                bgra.extend_from_slice(&[b, g, r, a]);
            }
        }
    }

    Ok((and_mask, bgra))
}

#[cfg(windows)]
mod win32 {
    use super::*;
    use crate::DesktopState;
    use tauri::Manager;
    use windows_sys::Win32::Foundation::{HWND, LPARAM, WPARAM};
    use windows_sys::Win32::UI::HiDpi::{GetDpiForWindow, GetSystemMetricsForDpi};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CreateIcon, DestroyIcon, SendMessageW, HICON, ICON_BIG, ICON_SMALL, SM_CXICON, SM_CXSMICON,
        WM_SETICON,
    };

    /// Owning wrapper around a Win32 `HICON` created via `CreateIcon`.
    pub struct OwnedHicon(isize);

    impl OwnedHicon {
        fn raw(&self) -> isize {
            self.0
        }
    }

    impl Drop for OwnedHicon {
        fn drop(&mut self) {
            if self.0 != 0 {
                // SAFETY: `self.0` was created by `CreateIcon` and detached from the HWND before drop.
                unsafe {
                    DestroyIcon(self.0 as HICON);
                }
            }
        }
    }

    /// Holds the active `ICON_SMALL` and `ICON_BIG` handles and decoded variants for DPI changes.
    #[derive(Default)]
    pub struct WindowsIconState {
        small: Option<OwnedHicon>,
        big: Option<OwnedHicon>,
        variants: Vec<DecodedIconVariant>,
    }

    fn query_dpi(hwnd: HWND) -> u32 {
        // SAFETY: `hwnd` is a valid main window handle obtained on the UI thread.
        let dpi = unsafe { GetDpiForWindow(hwnd) };
        if dpi == 0 {
            96
        } else {
            dpi
        }
    }

    fn target_sizes_for_hwnd(hwnd: HWND) -> (u32, u32) {
        let dpi = query_dpi(hwnd);
        // SAFETY: `GetSystemMetricsForDpi` takes valid `SM_CX*` constants and non-zero DPI.
        let small = unsafe { GetSystemMetricsForDpi(SM_CXSMICON, dpi) };
        let big = unsafe { GetSystemMetricsForDpi(SM_CXICON, dpi) };
        (
            if small > 0 { small as u32 } else { 16 },
            if big > 0 { big as u32 } else { 32 },
        )
    }

    pub fn target_sizes(app: &AppHandle) -> (u32, u32) {
        let Some(window) = app.get_window("main") else {
            return (16, 32);
        };
        let Ok(raw) = window.hwnd() else {
            return (16, 32);
        };
        target_sizes_for_hwnd(raw.0 as HWND)
    }

    fn create_hicon(variant: &DecodedIconVariant) -> Result<OwnedHicon, String> {
        let (and_mask, bgra) =
            build_win32_icon_buffers(variant.width, variant.height, &variant.rgba)?;
        // SAFETY: Buffers match `variant.width x variant.height` (1-bpp WORD-aligned AND mask, 32-bpp BGRA).
        let handle = unsafe {
            CreateIcon(
                std::ptr::null_mut(),
                variant.width as i32,
                variant.height as i32,
                1,
                32,
                and_mask.as_ptr(),
                bgra.as_ptr(),
            )
        };
        if handle.is_null() {
            return Err("Could not create Windows icon handle".into());
        }
        Ok(OwnedHicon(handle as isize))
    }

    fn apply_on_main_thread(
        app: &AppHandle,
        variants: &[DecodedIconVariant],
        replace_variants: bool,
    ) -> Result<(), String> {
        let Some(window) = app.get_window("main") else {
            return Ok(());
        };
        let raw_hwnd = window.hwnd().map_err(|_| "Missing window handle")?;
        let hwnd = raw_hwnd.0 as HWND;
        let (small_target, big_target) = target_sizes_for_hwnd(hwnd);

        let small_variant =
            select_variant_for_size(variants, small_target).ok_or("Missing small icon variant")?;
        let big_variant =
            select_variant_for_size(variants, big_target).ok_or("Missing big icon variant")?;

        let new_small = create_hicon(small_variant)?;
        let new_big = create_hicon(big_variant)?;

        // SAFETY: Running on the main thread owning `hwnd`; handles remain alive in `DesktopState`
        // until replaced or dropped, and previous handles are dropped only after `WM_SETICON` returns.
        unsafe {
            SendMessageW(
                hwnd,
                WM_SETICON,
                ICON_SMALL as WPARAM,
                new_small.raw() as LPARAM,
            );
            SendMessageW(
                hwnd,
                WM_SETICON,
                ICON_BIG as WPARAM,
                new_big.raw() as LPARAM,
            );
        }

        let state = app.state::<DesktopState>();
        let mut guard = state
            .win_icons
            .lock()
            .map_err(|_| "Icon state lock failed")?;
        let _old_small = guard.small.replace(new_small);
        let _old_big = guard.big.replace(new_big);
        if replace_variants {
            guard.variants = variants.to_vec();
        }
        Ok(())
    }

    pub fn apply_icons(app: &AppHandle, variants: Vec<DecodedIconVariant>) -> Result<(), String> {
        let handle = app.clone();
        app.run_on_main_thread(move || {
            let _ = apply_on_main_thread(&handle, &variants, true);
        })
        .map_err(|_| "Could not update the window icon".to_string())
    }

    pub fn refresh_for_dpi(app: &AppHandle) {
        let variants = {
            let state = app.state::<DesktopState>();
            let Ok(guard) = state.win_icons.lock() else {
                return;
            };
            if guard.variants.is_empty() {
                return;
            }
            guard.variants.clone()
        };
        let _ = apply_on_main_thread(app, &variants, false);
    }
}

#[cfg(windows)]
pub use win32::{
    apply_icons as apply_windows_icons, refresh_for_dpi as refresh_windows_icons_for_dpi,
    target_sizes as windows_target_sizes, WindowsIconState,
};

#[cfg(test)]
mod tests {
    use super::*;

    fn test_variant(size: u32) -> DecodedIconVariant {
        DecodedIconVariant {
            size,
            width: size,
            height: size,
            rgba: vec![0; (size * size * 4) as usize],
        }
    }

    /// Encode an arbitrary RGBA square image into a minimal valid PNG for unit tests.
    fn encode_rgba_png(size: u32, rgba: &[u8]) -> Vec<u8> {
        fn crc32(data: &[u8]) -> u32 {
            let mut crc = 0xffff_ffffu32;
            for &b in data {
                crc ^= b as u32;
                for _ in 0..8 {
                    let mask = (crc & 1).wrapping_neg();
                    crc = (crc >> 1) ^ (0xedb8_8320 & mask);
                }
            }
            !crc
        }
        fn chunk(kind: &[u8; 4], payload: &[u8], out: &mut Vec<u8>) {
            out.extend_from_slice(&(payload.len() as u32).to_be_bytes());
            out.extend_from_slice(kind);
            out.extend_from_slice(payload);
            let mut crc_input = Vec::with_capacity(4 + payload.len());
            crc_input.extend_from_slice(kind);
            crc_input.extend_from_slice(payload);
            out.extend_from_slice(&crc32(&crc_input).to_be_bytes());
        }
        fn adler32(data: &[u8]) -> u32 {
            let (mut s1, mut s2) = (1u32, 0u32);
            for &b in data {
                s1 = (s1 + b as u32) % 65521;
                s2 = (s2 + s1) % 65521;
            }
            (s2 << 16) | s1
        }

        let mut raw_scanlines = Vec::with_capacity((size as usize) * (1 + size as usize * 4));
        for row in rgba.chunks_exact(size as usize * 4) {
            raw_scanlines.push(0); // Filter type 0 (None)
            raw_scanlines.extend_from_slice(row);
        }
        // Uncompressed zlib stream (CMF/FLG + single stored DEFLATE block + Adler-32).
        assert!(raw_scanlines.len() <= u16::MAX as usize);
        let len = raw_scanlines.len() as u16;
        let mut zlib = Vec::with_capacity(2 + 5 + raw_scanlines.len() + 4);
        zlib.extend_from_slice(&[0x78, 0x01]);
        zlib.push(0x01); // BFINAL=1, BTYPE=00 (stored)
        zlib.extend_from_slice(&len.to_le_bytes());
        zlib.extend_from_slice(&(!len).to_le_bytes());
        zlib.extend_from_slice(&raw_scanlines);
        zlib.extend_from_slice(&adler32(&raw_scanlines).to_be_bytes());

        let mut png = vec![137, 80, 78, 71, 13, 10, 26, 10];
        let mut ihdr = Vec::with_capacity(13);
        ihdr.extend_from_slice(&size.to_be_bytes());
        ihdr.extend_from_slice(&size.to_be_bytes());
        ihdr.extend_from_slice(&[8, 6, 0, 0, 0]); // 8-bit RGBA
        chunk(b"IHDR", &ihdr, &mut png);
        chunk(b"IDAT", &zlib, &mut png);
        chunk(b"IEND", &[], &mut png);
        png
    }

    #[test]
    fn selects_exact_then_smallest_larger_then_largest_smaller_variant() {
        let variants = vec![test_variant(16), test_variant(32), test_variant(48)];
        assert_eq!(select_variant_for_size(&variants, 32).unwrap().size, 32);
        assert_eq!(select_variant_for_size(&variants, 20).unwrap().size, 32);
        assert_eq!(select_variant_for_size(&variants, 64).unwrap().size, 48);
        assert!(select_variant_for_size(&[], 16).is_none());
    }

    #[test]
    fn builds_word_aligned_and_mask_and_bgra_pixels() {
        // 17x1 tests WORD-aligned 1-bpp stride: ((17 + 15) / 16) * 2 = 4 bytes per row.
        let mut rgba = vec![0u8; 17 * 4];
        // Pixel 0: opaque red -> AND bit 0, BGRA = [0, 0, 255, 255]
        rgba[0..4].copy_from_slice(&[255, 0, 0, 255]);
        // Pixel 1: transparent with non-zero RGB -> AND bit 1 (0x40), BGRA zeroed
        rgba[4..8].copy_from_slice(&[12, 34, 56, 0]);
        // Pixel 16: transparent -> third byte MSB (0x80)
        rgba[16 * 4..16 * 4 + 4].copy_from_slice(&[0, 0, 0, 0]);

        let (and_mask, bgra) = build_win32_icon_buffers(17, 1, &rgba).unwrap();
        assert_eq!(and_mask.len(), 4);
        assert_eq!(and_mask[0], 0b0111_1111); // Pixel 0 opaque (0), pixels 1..7 transparent (1)
        assert_eq!(and_mask[1], 0b1111_1111); // Pixels 8..15 transparent (1)
        assert_eq!(and_mask[2], 0b1000_0000); // Pixel 16 transparent (1), padding bits 0
        assert_eq!(and_mask[3], 0);
        assert_eq!(&bgra[0..4], &[0, 0, 255, 255]);
        assert_eq!(&bgra[4..8], &[0, 0, 0, 0]);
    }

    #[test]
    fn decodes_and_validates_target_size_variants() {
        let png16 = encode_rgba_png(16, &vec![255u8; 16 * 16 * 4]);
        let png32 = encode_rgba_png(32, &vec![128u8; 32 * 32 * 4]);

        let decoded = decode_variants(
            None,
            Some(vec![
                IconVariantInput {
                    size: 32,
                    png: png32.clone(),
                },
                IconVariantInput {
                    size: 16,
                    png: png16.clone(),
                },
            ]),
        )
        .unwrap();
        assert_eq!(
            decoded.iter().map(|v| v.size).collect::<Vec<_>>(),
            vec![16, 32]
        );

        // Mismatched declared size must be rejected.
        let mismatch = decode_variants(
            None,
            Some(vec![IconVariantInput {
                size: 24,
                png: png16,
            }]),
        );
        assert!(mismatch.is_err());

        // Fallback to single png payload remains supported.
        let single = decode_variants(Some(png32), None).unwrap();
        assert_eq!(single.len(), 1);
        assert_eq!(single[0].size, 32);
    }

    #[test]
    fn pick_macos_png_validates_variants_and_rejects_invalid_payloads() {
        let png16 = encode_rgba_png(16, &vec![255u8; 16 * 16 * 4]);
        let png32 = encode_rgba_png(32, &vec![128u8; 32 * 32 * 4]);

        // Selects the largest validated variant even when fallback `png` is smaller.
        let picked = pick_macos_png(
            Some(png16.clone()),
            Some(vec![
                IconVariantInput {
                    size: 16,
                    png: png16.clone(),
                },
                IconVariantInput {
                    size: 32,
                    png: png32.clone(),
                },
            ]),
        )
        .unwrap();
        assert_eq!(picked, png32);

        // Falls back to validated `png` when variants are absent or empty.
        assert_eq!(
            pick_macos_png(Some(png16.clone()), None).unwrap(),
            png16.clone()
        );
        assert_eq!(
            pick_macos_png(Some(png16.clone()), Some(Vec::new())).unwrap(),
            png16
        );

        // Rejects corrupt PNG payloads, mismatched variant sizes, and empty payloads.
        assert!(pick_macos_png(Some(b"not-a-png".to_vec()), None).is_err());
        assert!(pick_macos_png(
            Some(png32),
            Some(vec![IconVariantInput {
                size: 64,
                png: png16,
            }]),
        )
        .is_err());
        assert!(pick_macos_png(None, None).is_err());
    }
}
