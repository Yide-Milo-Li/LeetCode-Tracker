//! Persist the palette-tinted icon in the places the OS shows while the app is not running.
//!
//! The runtime icon (`WM_SETICON` / `setApplicationIconImage`) disappears when the process exits, so
//! the user sees the bundled artwork again in the Start menu, taskbar pins, Finder and the Dock.
//! This module mirrors the chosen icon into those places:
//!
//! - **Windows**: writes a multi-size `.ico` into the app's local data directory and points the
//!   per-user Start menu, Desktop and pinned-taskbar shortcuts that target this executable at it.
//!   The executable's embedded icon is never modified.
//! - **macOS**: publishes a PNG for the idle Dock tile plug-in and sets a Finder custom icon
//!   on the running `.app` bundle through `NSWorkspace.setIcon(_:forFile:options:)`.
//!
//! Requests are best-effort: failures leave the bundled icon in place and never fail the
//! `set_app_icon` command. Each request carries a generation number so a burst of palette changes
//! only persists the most recent one. Restoring the bundled artwork removes the customization.

#[cfg(any(windows, target_os = "macos"))]
use std::sync::atomic::{AtomicU64, Ordering};
#[cfg(windows)]
use std::sync::Mutex;
use tauri::AppHandle;

/// Monotonic id of the most recent persistence request; older queued requests are skipped.
#[cfg(any(windows, target_os = "macos"))]
static LATEST_REQUEST: AtomicU64 = AtomicU64::new(0);
/// Serializes shortcut writes so two requests never interleave file updates.
#[cfg(windows)]
static PERSIST_LOCK: Mutex<()> = Mutex::new(());

/// Register a new request and return its generation number.
#[cfg(any(windows, target_os = "macos"))]
fn next_generation() -> u64 {
    LATEST_REQUEST.fetch_add(1, Ordering::SeqCst) + 1
}

/// Whether `generation` is still the most recent request.
#[cfg(any(windows, target_os = "macos"))]
fn is_latest(generation: u64) -> bool {
    LATEST_REQUEST.load(Ordering::SeqCst) == generation
}

/// Stable 64-bit FNV-1a fingerprint used for cache-busting file names and change detection.
///
/// `std::hash::DefaultHasher` is not guaranteed stable across Rust releases, and the fingerprint
/// is compared against values written by earlier runs, so a fixed algorithm is required.
#[cfg_attr(not(any(windows, target_os = "macos", test)), allow(dead_code))]
pub fn fingerprint(chunks: &[&[u8]]) -> u64 {
    let mut hash = 0xcbf2_9ce4_8422_2325u64;
    for chunk in chunks {
        for &byte in *chunk {
            hash ^= byte as u64;
            hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
        }
        // Separate chunks so ([a, b], [c]) and ([a], [b, c]) hash differently.
        hash ^= 0xff;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

/// Encode square RGBA variants as an `.ico` file using 32-bpp DIB entries.
///
/// DIB entries (rather than embedded PNG) are understood by every Windows shell component that
/// renders shortcut icons. Variants larger than 256 px are skipped because ICO directory entries
/// cannot describe them; duplicate sizes keep the first occurrence. Each entry stores bottom-up
/// BGRA pixels with straight alpha followed by a DWORD-aligned 1-bpp AND mask.
#[cfg(any(windows, test))]
pub fn build_ico(variants: &[crate::icon::DecodedIconVariant]) -> Result<Vec<u8>, String> {
    let mut entries: Vec<&crate::icon::DecodedIconVariant> = Vec::new();
    for variant in variants {
        if variant.width != variant.height || variant.width == 0 || variant.width > 256 {
            continue;
        }
        if entries
            .iter()
            .any(|existing| existing.width == variant.width)
        {
            continue;
        }
        let expected = (variant.width as usize) * (variant.height as usize) * 4;
        if variant.rgba.len() != expected {
            return Err("Invalid icon buffer".into());
        }
        entries.push(variant);
    }
    if entries.is_empty() {
        return Err("No icon variant fits an .ico file".into());
    }
    entries.sort_by_key(|v| v.width);

    let images: Vec<Vec<u8>> = entries.iter().map(|v| encode_dib(v)).collect();
    let header_len = 6 + 16 * entries.len();
    let total = header_len + images.iter().map(Vec::len).sum::<usize>();
    let mut out = Vec::with_capacity(total);

    // ICONDIR: reserved, type (1 = icon), image count.
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&(entries.len() as u16).to_le_bytes());

    let mut offset = header_len as u32;
    for (variant, image) in entries.iter().zip(&images) {
        // A 256 px edge is encoded as 0 in the one-byte width/height fields.
        let edge = if variant.width == 256 {
            0
        } else {
            variant.width as u8
        };
        out.push(edge);
        out.push(edge);
        out.push(0); // palette color count
        out.push(0); // reserved
        out.extend_from_slice(&1u16.to_le_bytes()); // color planes
        out.extend_from_slice(&32u16.to_le_bytes()); // bits per pixel
        out.extend_from_slice(&(image.len() as u32).to_le_bytes());
        out.extend_from_slice(&offset.to_le_bytes());
        offset += image.len() as u32;
    }
    for image in images {
        out.extend_from_slice(&image);
    }
    Ok(out)
}

/// Encode one RGBA variant as a BITMAPINFOHEADER + XOR bitmap + AND mask icon image.
#[cfg(any(windows, test))]
fn encode_dib(variant: &crate::icon::DecodedIconVariant) -> Vec<u8> {
    let width = variant.width as usize;
    let height = variant.height as usize;
    let xor_len = width * height * 4;
    let mask_stride = width.div_ceil(32) * 4;
    let mask_len = mask_stride * height;
    let mut out = Vec::with_capacity(40 + xor_len + mask_len);

    // BITMAPINFOHEADER; the height covers the XOR bitmap plus the AND mask.
    out.extend_from_slice(&40u32.to_le_bytes());
    out.extend_from_slice(&(width as i32).to_le_bytes());
    out.extend_from_slice(&((height * 2) as i32).to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&32u16.to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes()); // BI_RGB
    out.extend_from_slice(&((xor_len + mask_len) as u32).to_le_bytes());
    out.extend_from_slice(&[0u8; 16]); // resolution and palette fields

    let mut mask = vec![0u8; mask_len];
    // Both bitmaps are stored bottom-up.
    for (row_out, y) in (0..height).rev().enumerate() {
        for x in 0..width {
            let idx = (y * width + x) * 4;
            let [r, g, b, a] = [
                variant.rgba[idx],
                variant.rgba[idx + 1],
                variant.rgba[idx + 2],
                variant.rgba[idx + 3],
            ];
            out.extend_from_slice(&[b, g, r, a]);
            if a == 0 {
                mask[row_out * mask_stride + x / 8] |= 0x80 >> (x % 8);
            }
        }
    }
    out.extend_from_slice(&mask);
    out
}

/// What the Windows shortcuts should show.
#[cfg(windows)]
pub enum PersistRequest {
    /// Remove the customization so the OS shows the bundled artwork again.
    Bundled,
    /// Decoded variants used to build the Windows `.ico`.
    Custom(Vec<crate::icon::DecodedIconVariant>),
}

/// Persist `request` in the background; the latest request wins and errors are logged only.
#[cfg(windows)]
pub fn persist(app: &AppHandle, request: PersistRequest) {
    use tauri::Manager;
    let generation = next_generation();
    let Ok(data_dir) = app.path().app_local_data_dir() else {
        return;
    };
    // COM shell-link work runs on its own STA thread so the UI thread never blocks on disk I/O.
    let spawned = std::thread::Builder::new()
        .name("persist-app-icon".into())
        .spawn(move || {
            let Ok(_guard) = PERSIST_LOCK.lock() else {
                return;
            };
            if !is_latest(generation) {
                return;
            }
            if let Err(error) = windows_shell::apply(&data_dir.join("icons"), request) {
                eprintln!("Could not persist the app icon: {error}");
            }
        });
    if let Err(error) = spawned {
        eprintln!("Could not start the icon persistence thread: {error}");
    }
}

/// Update the bundle and live tile in one AppKit callback. Once the new live icon is
/// visible, quitting cannot interrupt the write that supplies the idle Dock tile.
#[cfg(target_os = "macos")]
pub fn update_macos_icon(app: &AppHandle, png: Vec<u8>, bundled: bool) -> Result<(), String> {
    use tauri::Manager;
    let generation = next_generation();
    let data_dir = app.path().app_local_data_dir();
    app.run_on_main_thread(move || {
        if is_latest(generation) {
            macos_bundle::apply(data_dir.as_deref().ok(), &png, bundled);
        }
    })
    .map_err(|_| "Could not update the Dock icon".into())
}

#[cfg(windows)]
mod windows_shell {
    use super::{build_ico, fingerprint, PersistRequest};
    use std::ffi::OsString;
    use std::os::windows::ffi::{OsStrExt, OsStringExt};
    use std::path::{Path, PathBuf};
    use windows::core::{Interface, PCWSTR};
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, IPersistFile,
        CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, STGM_READ,
    };
    use windows::Win32::UI::Shell::{
        FOLDERID_Desktop, FOLDERID_Programs, FOLDERID_RoamingAppData, IShellLinkW, SHChangeNotify,
        SHGetKnownFolderPath, ShellLink, KF_FLAG_DEFAULT, SHCNE_ASSOCCHANGED, SHCNE_UPDATEITEM,
        SHCNF_IDLIST, SHCNF_PATHW,
    };

    const ICON_PREFIX: &str = "app-icon-";
    const MAX_PATH_CHARS: usize = 32_768;
    /// Start menu folders created by installers are shallow; stop before scanning deep trees.
    const START_MENU_DEPTH: usize = 3;

    /// Balances `CoInitializeEx` on the persistence thread.
    struct ComApartment;

    impl ComApartment {
        fn enter() -> Result<Self, String> {
            // SAFETY: Called once on a dedicated thread that owns no other COM state.
            unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) }
                .ok()
                .map_err(|e| format!("CoInitializeEx failed: {e}"))?;
            Ok(Self)
        }
    }

    impl Drop for ComApartment {
        fn drop(&mut self) {
            // SAFETY: Paired with the successful `CoInitializeEx` in `enter`.
            unsafe { CoUninitialize() };
        }
    }

    /// Wide, NUL-terminated copy of a path for Win32 string parameters.
    fn wide(path: &Path) -> Vec<u16> {
        path.as_os_str().encode_wide().chain(Some(0)).collect()
    }

    /// Convert a NUL-terminated UTF-16 buffer to a path.
    fn from_wide(buffer: &[u16]) -> PathBuf {
        let len = buffer.iter().position(|&c| c == 0).unwrap_or(buffer.len());
        PathBuf::from(OsString::from_wide(&buffer[..len]))
    }

    /// Case-insensitive path identity after resolving symlinks and 8.3 names where possible.
    fn same_file(a: &Path, b: &Path) -> bool {
        let normalize = |p: &Path| {
            dunce::canonicalize(p)
                .unwrap_or_else(|_| p.to_path_buf())
                .to_string_lossy()
                .to_lowercase()
        };
        normalize(a) == normalize(b)
    }

    fn known_folder(id: &windows::core::GUID) -> Option<PathBuf> {
        // SAFETY: `id` is a valid KNOWNFOLDERID; the returned buffer is freed with CoTaskMemFree.
        unsafe {
            let raw = SHGetKnownFolderPath(id, KF_FLAG_DEFAULT, None).ok()?;
            let path = PathBuf::from(OsString::from_wide(raw.as_wide()));
            CoTaskMemFree(Some(raw.0 as *const _));
            Some(path)
        }
    }

    /// Collect `.lnk` files under `dir`, descending at most `depth` directory levels.
    fn collect_links(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_dir() && depth > 0 {
                collect_links(&path, depth - 1, out);
            } else if kind.is_file()
                && path
                    .extension()
                    .is_some_and(|ext| ext.eq_ignore_ascii_case("lnk"))
            {
                out.push(path);
            }
        }
    }

    /// Per-user shortcut locations the installer or the user may have created.
    fn shortcut_candidates() -> Vec<PathBuf> {
        let mut links = Vec::new();
        if let Some(programs) = known_folder(&FOLDERID_Programs) {
            collect_links(&programs, START_MENU_DEPTH, &mut links);
        }
        if let Some(desktop) = known_folder(&FOLDERID_Desktop) {
            collect_links(&desktop, 0, &mut links);
        }
        if let Some(roaming) = known_folder(&FOLDERID_RoamingAppData) {
            let pinned = roaming.join(r"Microsoft\Internet Explorer\Quick Launch\User Pinned");
            collect_links(&pinned.join("TaskBar"), 0, &mut links);
            collect_links(&pinned.join("StartMenu"), 0, &mut links);
        }
        links
    }

    /// A loaded shell link that targets the running executable.
    struct OwnedLink {
        path: PathBuf,
        link: IShellLinkW,
        file: IPersistFile,
    }

    impl OwnedLink {
        /// Load `path` and keep it only when its target is `exe`.
        fn load_if_targets(path: &Path, exe: &Path) -> Option<Self> {
            // SAFETY: COM is initialized on this thread; buffers outlive each call.
            unsafe {
                let link: IShellLinkW =
                    CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER).ok()?;
                let file: IPersistFile = link.cast().ok()?;
                let wide_path = wide(path);
                file.Load(PCWSTR(wide_path.as_ptr()), STGM_READ).ok()?;
                let mut target = vec![0u16; MAX_PATH_CHARS];
                link.GetPath(&mut target, std::ptr::null_mut(), 0).ok()?;
                let target = from_wide(&target);
                if target.as_os_str().is_empty() || !same_file(&target, exe) {
                    return None;
                }
                Some(Self {
                    path: path.to_path_buf(),
                    link,
                    file,
                })
            }
        }

        fn icon_location(&self) -> Option<(PathBuf, i32)> {
            let mut buffer = vec![0u16; MAX_PATH_CHARS];
            let mut index = 0i32;
            // SAFETY: `buffer` and `index` are valid for the duration of the call.
            unsafe { self.link.GetIconLocation(&mut buffer, &mut index) }.ok()?;
            Some((from_wide(&buffer), index))
        }

        /// Point the shortcut at `icon`; returns whether the file changed.
        fn set_icon(&self, icon: &Path, index: i32) -> Result<bool, String> {
            if let Some((current, current_index)) = self.icon_location() {
                if current_index == index
                    && !current.as_os_str().is_empty()
                    && same_file(&current, icon)
                {
                    return Ok(false);
                }
            }
            let wide_icon = wide(icon);
            let wide_path = wide(&self.path);
            // SAFETY: Wide strings are NUL-terminated and outlive the calls.
            unsafe {
                self.link
                    .SetIconLocation(PCWSTR(wide_icon.as_ptr()), index)
                    .map_err(|e| format!("SetIconLocation failed: {e}"))?;
                self.file
                    .Save(PCWSTR(wide_path.as_ptr()), true)
                    .map_err(|e| format!("Saving {} failed: {e}", self.path.display()))?;
                SHChangeNotify(
                    SHCNE_UPDATEITEM,
                    SHCNF_PATHW,
                    Some(wide_path.as_ptr() as *const _),
                    None,
                );
            }
            Ok(true)
        }
    }

    /// Write `bytes` to `path` atomically unless an identical file already exists.
    fn write_icon_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
        if std::fs::read(path).is_ok_and(|existing| existing == bytes) {
            return Ok(());
        }
        let dir = path.parent().ok_or("Icon path has no parent")?;
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        let mut temp = tempfile::NamedTempFile::new_in(dir).map_err(|e| e.to_string())?;
        std::io::Write::write_all(&mut temp, bytes).map_err(|e| e.to_string())?;
        temp.persist(path).map_err(|e| e.error.to_string())?;
        Ok(())
    }

    /// Delete generated `.ico` files other than `keep`; files still locked are left for later.
    fn remove_stale_icons(dir: &Path, keep: Option<&Path>) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if !name.starts_with(ICON_PREFIX) || !name.ends_with(".ico") {
                continue;
            }
            if keep.is_some_and(|keep| same_file(&path, keep)) {
                continue;
            }
            let _ = std::fs::remove_file(&path);
        }
    }

    /// Update every matching shortcut to `request` and tidy generated icon files.
    pub fn apply(icon_dir: &Path, request: PersistRequest) -> Result<(), String> {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let _com = ComApartment::enter()?;
        apply_to_links(icon_dir, &exe, &shortcut_candidates(), request)
    }

    /// Testable core of [`apply`] with explicit executable and shortcut paths.
    pub(super) fn apply_to_links(
        icon_dir: &Path,
        exe: &Path,
        candidates: &[PathBuf],
        request: PersistRequest,
    ) -> Result<(), String> {
        let links: Vec<OwnedLink> = candidates
            .iter()
            .filter_map(|path| OwnedLink::load_if_targets(path, exe))
            .collect();

        let icon_file = match &request {
            PersistRequest::Bundled => None,
            PersistRequest::Custom(variants) => {
                if links.is_empty() {
                    // Source runs and portable copies have no shortcut to update.
                    return Ok(());
                }
                let ico = build_ico(variants)?;
                let name = format!("{ICON_PREFIX}{:016x}.ico", fingerprint(&[&ico]));
                let path = icon_dir.join(name);
                write_icon_file(&path, &ico)?;
                Some(path)
            }
        };

        let (target, index) = match &icon_file {
            Some(path) => (path.as_path(), 0),
            None => (exe, 0),
        };
        let mut changed = false;
        let mut first_error = None;
        for link in &links {
            match link.set_icon(target, index) {
                Ok(updated) => changed |= updated,
                Err(error) => {
                    first_error.get_or_insert(error);
                }
            }
        }
        if changed && !cfg!(test) {
            // Taskbar pins cache their bitmap; an association change asks Explorer to refresh it.
            // Skipped in unit tests to avoid refreshing the developer's desktop.
            // SAFETY: No item pointers are passed for SHCNE_ASSOCCHANGED.
            unsafe { SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_IDLIST, None, None) };
        }
        // Keep the active icon only when every shortcut now references it.
        if first_error.is_none() {
            remove_stale_icons(icon_dir, icon_file.as_deref());
        }
        first_error.map_or(Ok(()), Err)
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use crate::icon::DecodedIconVariant;

        fn create_link(path: &Path, target: &Path) {
            // SAFETY: COM is initialized by the caller; strings are NUL-terminated.
            unsafe {
                let link: IShellLinkW =
                    CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER).unwrap();
                let wide_target = wide(target);
                link.SetPath(PCWSTR(wide_target.as_ptr())).unwrap();
                let file: IPersistFile = link.cast().unwrap();
                let wide_path = wide(path);
                file.Save(PCWSTR(wide_path.as_ptr()), true).unwrap();
            }
        }

        fn read_icon(path: &Path, exe: &Path) -> (PathBuf, i32) {
            OwnedLink::load_if_targets(path, exe)
                .expect("link targets exe")
                .icon_location()
                .expect("icon location")
        }

        fn variant(size: u32, value: u8) -> DecodedIconVariant {
            DecodedIconVariant {
                size,
                width: size,
                height: size,
                rgba: vec![value; (size * size * 4) as usize],
            }
        }

        #[test]
        fn updates_matching_shortcuts_and_restores_the_bundled_icon() {
            let _com = ComApartment::enter().unwrap();
            let root = tempfile::tempdir().unwrap();
            let exe = root.path().join("tracker.exe");
            let other = root.path().join("other.exe");
            std::fs::write(&exe, b"exe").unwrap();
            std::fs::write(&other, b"exe").unwrap();
            let ours = root.path().join("Tracker.lnk");
            let theirs = root.path().join("Other.lnk");
            create_link(&ours, &exe);
            create_link(&theirs, &other);
            let icon_dir = root.path().join("icons");
            let links = vec![ours.clone(), theirs.clone()];

            apply_to_links(
                &icon_dir,
                &exe,
                &links,
                PersistRequest::Custom(vec![variant(16, 10), variant(32, 20)]),
            )
            .unwrap();
            let (first_icon, index) = read_icon(&ours, &exe);
            assert_eq!(index, 0);
            assert!(first_icon.starts_with(&icon_dir));
            assert!(first_icon.exists());
            // Shortcuts for other programs are never touched.
            let (other_icon, _) = read_icon(&theirs, &other);
            assert!(!other_icon.starts_with(&icon_dir));

            // A new palette writes a new file and removes the previous one.
            apply_to_links(
                &icon_dir,
                &exe,
                &links,
                PersistRequest::Custom(vec![variant(16, 30)]),
            )
            .unwrap();
            let (second_icon, _) = read_icon(&ours, &exe);
            assert_ne!(second_icon, first_icon);
            assert!(second_icon.exists());
            assert!(!first_icon.exists());

            // Restoring the bundled artwork points back at the executable and deletes icons.
            apply_to_links(&icon_dir, &exe, &links, PersistRequest::Bundled).unwrap();
            let (restored, _) = read_icon(&ours, &exe);
            assert!(same_file(&restored, &exe));
            assert!(!second_icon.exists());
        }

        #[test]
        fn skips_writing_icons_when_no_shortcut_targets_the_executable() {
            let root = tempfile::tempdir().unwrap();
            let icon_dir = root.path().join("icons");
            let exe = root.path().join("tracker.exe");
            apply_to_links(
                &icon_dir,
                &exe,
                &[],
                PersistRequest::Custom(vec![variant(16, 1)]),
            )
            .unwrap();
            assert!(!icon_dir.exists());
        }
    }
}

#[cfg(target_os = "macos")]
mod macos_bundle {
    use super::fingerprint;
    use objc2::{AnyThread, MainThreadMarker};
    use objc2_app_kit::{NSApplication, NSImage, NSWorkspace, NSWorkspaceIconCreationOptions};
    use objc2_foundation::{NSBundle, NSData, NSDistributedNotificationCenter, NSString};
    use std::path::{Path, PathBuf};

    /// Records which icon was last written so unchanged launches skip the bundle write.
    const MARKER_FILE: &str = "persisted-app-icon";
    /// Finder stores a custom folder/bundle icon in this resource file at the bundle root.
    const CUSTOM_ICON_FILE: &str = "Icon\r";

    /// The running `.app` bundle, or `None` for unbundled source runs.
    fn bundle_path() -> Option<PathBuf> {
        let path = PathBuf::from(NSBundle::mainBundle().bundlePath().to_string());
        path.extension()
            .is_some_and(|ext| ext == "app")
            .then_some(path)
    }

    fn set_bundle_icon(bundle: &Path, image: Option<&NSImage>) -> Result<(), String> {
        let path = NSString::from_str(&bundle.to_string_lossy());
        #[allow(unused_unsafe)]
        let applied = unsafe {
            NSWorkspace::sharedWorkspace().setIcon_forFile_options(
                image,
                &path,
                NSWorkspaceIconCreationOptions(0),
            )
        };
        if !applied {
            return Err(format!(
                "NSWorkspace refused to update {}",
                bundle.display()
            ));
        }
        Ok(())
    }

    /// Publish a complete image before telling the Dock's separate plug-in process to read it.
    fn publish_dock_icon(
        bundle: &Path,
        data_dir: &Path,
        png: &[u8],
        bundled: bool,
    ) -> std::io::Result<()> {
        use std::io::{ErrorKind, Write};
        let file = data_dir.join("dock-icon.png");
        if bundled {
            match std::fs::remove_file(&file) {
                Ok(()) => {}
                Err(e) if e.kind() == ErrorKind::NotFound => return Ok(()),
                Err(e) => return Err(e),
            }
        } else {
            if std::fs::read(&file).is_ok_and(|saved| saved == png) {
                return Ok(());
            }
            std::fs::create_dir_all(data_dir)?;
            let mut temporary = tempfile::NamedTempFile::new_in(data_dir)?;
            temporary.write_all(png)?;
            temporary.persist(file)?;
        }
        let name = NSString::from_str("LeetCodeTrackerDockIconChanged");
        unsafe {
            NSDistributedNotificationCenter::defaultCenter()
                .postNotificationName_object_userInfo_deliverImmediately(
                    &name,
                    Some(&NSString::from_str(&bundle.to_string_lossy())),
                    None,
                    true,
                );
        }
        Ok(())
    }

    fn persist(
        bundle: &Path,
        data_dir: &Path,
        png: &[u8],
        image: &NSImage,
        bundled: bool,
    ) -> Result<(), String> {
        let marker = data_dir.join(MARKER_FILE);
        let has_custom_icon = bundle.join(CUSTOM_ICON_FILE).exists();
        if bundled {
            if has_custom_icon {
                set_bundle_icon(bundle, None)?;
            }
            let _ = std::fs::remove_file(marker);
            return Ok(());
        }
        let stamp = format!("{:016x}", fingerprint(&[png]));
        if has_custom_icon
            && std::fs::read_to_string(&marker).is_ok_and(|saved| saved.trim() == stamp)
        {
            return Ok(());
        }
        set_bundle_icon(bundle, Some(image))?;
        std::fs::create_dir_all(data_dir).map_err(|e| e.to_string())?;
        std::fs::write(marker, stamp).map_err(|e| e.to_string())
    }

    pub fn apply(data_dir: Option<&Path>, png: &[u8], bundled: bool) {
        let Some(mtm) = MainThreadMarker::new() else {
            return;
        };
        let Some(image) = NSImage::initWithData(NSImage::alloc(), &NSData::with_bytes(png)) else {
            return;
        };
        if let (Some(bundle), Some(dir)) = (bundle_path(), data_dir) {
            if let Err(error) = publish_dock_icon(&bundle, dir, png, bundled) {
                eprintln!("Could not publish the idle Dock icon: {error}");
            }
            if let Err(error) = persist(&bundle, dir, png, &image, bundled) {
                eprintln!("Could not persist the app icon: {error}");
            }
        }
        // Also works for an unbundled dev build or a read-only installation.
        unsafe { NSApplication::sharedApplication(mtm).setApplicationIconImage(Some(&image)) };
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::icon::DecodedIconVariant;

    fn variant(size: u32, rgba: Vec<u8>) -> DecodedIconVariant {
        DecodedIconVariant {
            size,
            width: size,
            height: size,
            rgba,
        }
    }

    fn u16_at(bytes: &[u8], at: usize) -> u16 {
        u16::from_le_bytes([bytes[at], bytes[at + 1]])
    }

    fn u32_at(bytes: &[u8], at: usize) -> u32 {
        u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap())
    }

    #[test]
    fn fingerprint_is_stable_and_chunk_sensitive() {
        assert_eq!(fingerprint(&[b"abc"]), fingerprint(&[b"abc"]));
        assert_ne!(fingerprint(&[b"abc"]), fingerprint(&[b"abd"]));
        assert_ne!(fingerprint(&[b"ab", b"c"]), fingerprint(&[b"a", b"bc"]));
    }

    #[test]
    fn builds_sorted_ico_directory_with_256_encoded_as_zero() {
        let ico = build_ico(&[
            variant(256, vec![0; 256 * 256 * 4]),
            variant(16, vec![0; 16 * 16 * 4]),
            variant(16, vec![9; 16 * 16 * 4]),
            variant(512, vec![0; 512 * 512 * 4]),
        ])
        .unwrap();
        assert_eq!(u16_at(&ico, 0), 0);
        assert_eq!(u16_at(&ico, 2), 1);
        assert_eq!(
            u16_at(&ico, 4),
            2,
            "duplicate 16 px and oversized 512 px are dropped"
        );

        // First entry: 16 px, 40-byte header + 16*16*4 XOR + 16 rows * 4-byte mask stride.
        assert_eq!(ico[6], 16);
        assert_eq!(u16_at(&ico, 6 + 6), 32);
        let first_len = u32_at(&ico, 6 + 8);
        assert_eq!(first_len, 40 + 16 * 16 * 4 + 16 * 4);
        let first_offset = u32_at(&ico, 6 + 12);
        assert_eq!(first_offset, 6 + 16 * 2);

        // Second entry: 256 px stored as 0 and placed right after the first image.
        assert_eq!(ico[6 + 16], 0);
        assert_eq!(u32_at(&ico, 6 + 16 + 12), first_offset + first_len);
        assert_eq!(
            ico.len(),
            (first_offset + first_len + u32_at(&ico, 6 + 16 + 8)) as usize
        );
    }

    #[test]
    fn encodes_bottom_up_bgra_and_dword_aligned_mask() {
        // 2x2: top-left opaque red, top-right transparent, bottom row opaque blue.
        let rgba = vec![
            255, 0, 0, 255, 1, 2, 3, 0, //
            0, 0, 255, 255, 0, 0, 255, 128,
        ];
        let ico = build_ico(&[variant(2, rgba)]).unwrap();
        let image = &ico[u32_at(&ico, 6 + 12) as usize..];
        assert_eq!(u32_at(image, 0), 40);
        assert_eq!(u32_at(image, 8), 4, "height covers XOR and AND bitmaps");
        let pixels = &image[40..40 + 16];
        // Bottom row first: blue pixels in BGRA order.
        assert_eq!(&pixels[0..4], &[255, 0, 0, 255]);
        assert_eq!(&pixels[4..8], &[255, 0, 0, 128]);
        // Then the top row: red, then the transparent pixel with its straight color.
        assert_eq!(&pixels[8..12], &[0, 0, 255, 255]);
        assert_eq!(&pixels[12..16], &[3, 2, 1, 0]);
        let mask = &image[56..];
        assert_eq!(mask.len(), 8, "two rows of 4-byte DWORD-aligned mask");
        assert_eq!(mask[0], 0, "bottom row is fully opaque");
        assert_eq!(mask[4], 0b0100_0000, "top-right pixel is transparent");
    }

    #[test]
    fn rejects_sets_without_any_ico_sized_variant() {
        assert!(build_ico(&[variant(512, vec![0; 512 * 512 * 4])]).is_err());
        assert!(build_ico(&[]).is_err());
    }
}
