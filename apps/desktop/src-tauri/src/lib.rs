//! Desktop host: native authorization, private sidecar ownership and recoverable startup.
mod icon;
mod persistent_icon;
mod process;
mod security;
mod updates;

use rand::RngCore;
use serde::Serialize;
use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;

const STARTUP_TIMEOUT: Duration = Duration::from_secs(30);
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(10);

/// Immutable authenticated connection; process ownership stays with DesktopState.
#[derive(Clone)]
struct Connection {
    port: u16,
    token: String,
}

/// Renderer-visible lifecycle state excludes credentials and raw diagnostics.
#[derive(Clone, Serialize)]
struct DesktopStatus {
    state: &'static str,
}

/// Blocking process work is kept off the window event thread.
struct DesktopState {
    http: tokio::sync::OnceCell<reqwest::Client>,
    child: Mutex<Option<process::ManagedChild>>,
    connection: Mutex<Option<Connection>>,
    status: Mutex<DesktopStatus>,
    starting: AtomicBool,
    exiting: AtomicBool,
    installing_update: AtomicBool,
    exports: tokio::sync::Mutex<()>,
    #[cfg(windows)]
    win_icons: Mutex<icon::WindowsIconState>,
}

impl Default for DesktopState {
    /// Start without a process; setup dispatches initialization in a worker.
    fn default() -> Self {
        Self {
            http: tokio::sync::OnceCell::new(),
            child: Mutex::new(None),
            connection: Mutex::new(None),
            status: Mutex::new(DesktopStatus { state: "starting" }),
            starting: AtomicBool::new(false),
            exiting: AtomicBool::new(false),
            installing_update: AtomicBool::new(false),
            exports: tokio::sync::Mutex::new(()),
            #[cfg(windows)]
            win_icons: Mutex::new(icon::WindowsIconState::default()),
        }
    }
}

impl DesktopState {
    async fn http(&self) -> Result<&reqwest::Client, String> {
        self.http.get_or_try_init(|| async { client() }).await
    }

    /// Reject new requests during initialization and shutdown.
    fn connection(&self) -> Result<Connection, String> {
        if self.exiting.load(Ordering::SeqCst) {
            return Err("Application is closing".into());
        }
        self.connection
            .lock()
            .map_err(|_| "Connection lock failed")?
            .clone()
            .ok_or_else(|| "Local service is not ready".into())
    }

    fn stop_service(&self) -> Result<bool, String> {
        self.connection.lock().unwrap().take();
        let child = self.child.lock().unwrap().take();
        child.map_or(Ok(true), |mut child| child.shutdown(SHUTDOWN_TIMEOUT))
    }
}

/// Retain HTTP metadata for conflict handling and idempotent retries.
#[derive(Serialize)]
struct ApiResponse {
    status: u16,
    body: String,
    headers: HashMap<String, String>,
}

/// Fresh per-process secret, never persisted or returned to the WebView.
fn random_secret() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Fixed resource layout; release builds never search the working directory.
fn resources(app: &AppHandle) -> Result<(PathBuf, PathBuf), String> {
    #[cfg(debug_assertions)]
    {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let node = root.join(if cfg!(target_os = "macos") {
            "binaries/node-aarch64-apple-darwin"
        } else {
            "binaries/node-x86_64-pc-windows-msvc.exe"
        });
        let script = root.join("../../server/dist/desktop-server.mjs");
        if node.is_file() && script.is_file() {
            return Ok((
                node.canonicalize().map_err(|e| e.to_string())?,
                script.canonicalize().map_err(|e| e.to_string())?,
            ));
        }
    }
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let node = exe
        .parent()
        .ok_or("Missing application directory")?
        .join(if cfg!(windows) { "node.exe" } else { "node" });
    let script = app
        .path()
        .resource_dir()
        .map_err(|e| e.to_string())?
        .join("desktop-server.mjs");
    if !node.is_file() || !script.is_file() {
        return Err("Packaged runtime or server is missing; reinstall the application".into());
    }
    Ok((node, script))
}

/// Resolve the stdio entrypoint from the same resource root used to start the sidecar.
fn mcp_launch(node: &Path, sidecar: &Path) -> Option<serde_json::Value> {
    let entry = sidecar.parent()?.join("mcp/leetcode-tracker-mcp.mjs");
    if !entry.is_file() {
        return None;
    }
    Some(serde_json::json!({
        "command": dunce::simplified(node),
        "entry": dunce::simplified(&entry)
    }))
}

/// Own the process before waiting for ready, allowing close to stop a slow startup.
fn start_service(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<DesktopState>();
    let (node, script) = resources(app)?;
    let data_dir = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
    let token = random_secret();
    let nonce = random_secret();
    let mut command = process::node_command(&node, &script);
    command.current_dir(&data_dir);
    // Keep OS settings, but do not inherit executable injection, credentials or test configuration.
    for key in [
        "NODE_OPTIONS",
        "NODE_PATH",
        "DESKTOP_CONFIG_JSON",
        "DB_PATH",
        "BACKUP_DIR",
        "SESSION_SECRET",
        "PORT",
        "NONCE",
        "GEMINI_API_KEY",
        "OPENAI_API_KEY",
        "DEEPSEEK_API_KEY",
    ] {
        command.env_remove(key);
    }
    let receiver = {
        let mut owner = state.child.lock().map_err(|_| "Process lock failed")?;
        if state.exiting.load(Ordering::SeqCst) {
            return Err("Application is closing".into());
        }
        let (mut child, receiver) = process::ManagedChild::spawn(&mut command)?;
        child.send(&serde_json::json!({
            "protocolVersion": 1, "port": 0, "dbPath": data_dir.join("tracker.sqlite"),
            "backupDir": data_dir.join("backups"), "sessionSecret": token, "nonce": nonce,
            "mcpLaunch": mcp_launch(&node, &script)
        }))?;
        *owner = Some(child);
        receiver
    };
    let port = process::wait_ready(receiver, &nonce, STARTUP_TIMEOUT)?;
    let health = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(3))
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .build()
        .map_err(|e| e.to_string())?
        .get(format!("http://127.0.0.1:{port}/api/v1/health"))
        .header("x-desktop-session-token", &token)
        .send()
        .map_err(|e| e.to_string())?;
    if !health.status().is_success() {
        return Err("Local health check failed".into());
    }
    if state.exiting.load(Ordering::SeqCst) {
        return Err("Application is closing".into());
    }
    *state
        .connection
        .lock()
        .map_err(|_| "Connection lock failed")? = Some(Connection { port, token });
    Ok(())
}

/// Failed initialization reaps its process and leaves the window available for retry.
fn begin_startup(app: AppHandle) {
    let state = app.state::<DesktopState>();
    if state.exiting.load(Ordering::SeqCst)
        || state.installing_update.load(Ordering::SeqCst)
        || state.starting.swap(true, Ordering::SeqCst)
    {
        return;
    }
    // A renderer retry must never replace an already healthy owner.
    if state.status.lock().unwrap().state == "ready" {
        state.starting.store(false, Ordering::SeqCst);
        return;
    }
    *state.status.lock().unwrap() = DesktopStatus { state: "starting" };
    tauri::async_runtime::spawn_blocking(move || {
        initialize_service(&app);
        app.state::<DesktopState>()
            .starting
            .store(false, Ordering::SeqCst);
    });
}

fn initialize_service(app: &AppHandle) {
    let state = app.state::<DesktopState>();
    let result = start_service(app);
    if result.is_err() {
        state.child.lock().unwrap().take();
        state.connection.lock().unwrap().take();
    }
    *state.status.lock().unwrap() = DesktopStatus {
        state: if result.is_ok() { "ready" } else { "error" },
    };
}

/// Poll liveness without returning private paths, secrets or raw provider errors.
#[tauri::command]
fn get_desktop_status(state: State<'_, DesktopState>) -> DesktopStatus {
    let mut status = state.status.lock().unwrap();
    if status.state == "ready" && !state.installing_update.load(Ordering::SeqCst) {
        let stopped = state
            .child
            .lock()
            .unwrap()
            .as_mut()
            .is_none_or(|child| child.exited());
        if stopped {
            state.connection.lock().unwrap().take();
            *status = DesktopStatus { state: "error" };
        }
    }
    status.clone()
}

/// Retry the same profile after startup failure or an unexpected exit.
#[tauri::command]
fn retry_sidecar(app: AppHandle) {
    begin_startup(app);
}

/// Loopback-only HTTP client, without redirect or proxy credential leakage.
fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(60))
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .build()
        .map_err(|e| e.to_string())
}

/// Forward bounded API calls and retain HTTP status/error payloads.
#[tauri::command]
async fn api_request(
    state: State<'_, DesktopState>,
    method: String,
    path: String,
    headers: Option<HashMap<String, String>>,
    body: Option<String>,
) -> Result<ApiResponse, String> {
    let connection = state.connection()?;
    let url = security::api_url(connection.port, &path)?;
    let method = match method.as_str() {
        "GET" => reqwest::Method::GET,
        "POST" => reqwest::Method::POST,
        "PUT" => reqwest::Method::PUT,
        "PATCH" => reqwest::Method::PATCH,
        "DELETE" => reqwest::Method::DELETE,
        _ => return Err("Unsupported method".into()),
    };
    let limit = if url.path() == "/api/v1/bundle/import" {
        64
    } else {
        15
    } * 1024
        * 1024;
    if body.as_ref().is_some_and(|b| b.len() > limit) {
        return Err("Request exceeds endpoint size limit".into());
    }
    let mut request = state
        .http()
        .await?
        .request(method, url)
        .header("x-desktop-session-token", &connection.token);
    for (name, value) in headers.unwrap_or_default() {
        if matches!(
            name.to_ascii_lowercase().as_str(),
            "content-type" | "accept"
        ) {
            request = request.header(name, value);
        }
    }
    if let Some(body) = body {
        request = request.body(body);
    }
    let response = request.send().await.map_err(|e| e.to_string())?;
    let status = response.status().as_u16();
    let headers = response
        .headers()
        .iter()
        .filter_map(|(k, v)| v.to_str().ok().map(|v| (k.to_string(), v.to_string())))
        .collect();
    let body = response.text().await.map_err(|e| e.to_string())?;
    Ok(ApiResponse {
        status,
        body,
        headers,
    })
}

/// Only a Rust native dialog grants a destination; no renderer path is accepted.
#[tauri::command]
async fn export_data_file(
    app: AppHandle,
    state: State<'_, DesktopState>,
    api_path: String,
    default_filename: String,
) -> Result<bool, String> {
    let _exclusive = state.exports.lock().await;
    let connection = state.connection()?;
    let url = security::export_url(connection.port, &api_path)?;
    security::validate_filename(&default_filename)?;
    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_file_name(default_filename)
        .save_file(move |selected| {
            let _ = sender.send(selected);
        });
    let Some(selected) = receiver
        .await
        .map_err(|_| "Save dialog closed unexpectedly")?
    else {
        return Ok(false);
    };
    let destination = selected.into_path().map_err(|_| "Select a local file")?;
    // Existing-file confirmation belongs to the native dialog, before any destination is opened.
    let mut output = security::AuthorizedSave::new(destination)?;
    let mut response = state
        .http()
        .await?
        .get(url)
        .header("x-desktop-session-token", connection.token)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("Export failed: {}", response.status()));
    }
    let mut length = 0usize;
    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        length += chunk.len();
        if length > 512 * 1024 * 1024 {
            return Err("Export exceeds 512 MiB".into());
        }
        output.write_all(&chunk).map_err(|e| e.to_string())?;
    }
    output.finish()?;
    Ok(true)
}

/// Native folder picker for the device sync folder. The path is only a suggestion to the local
/// API, which validates it again before storing it.
#[tauri::command]
async fn pick_folder(app: AppHandle) -> Result<Option<String>, String> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.dialog().file().pick_folder(move |selected| {
        let _ = sender.send(selected);
    });
    let Some(selected) = receiver
        .await
        .map_err(|_| "Folder dialog closed unexpectedly")?
    else {
        return Ok(None);
    };
    let path = selected.into_path().map_err(|_| "Select a local folder")?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

/// Report OS-preferred target icon sizes so the webview can rasterize SVG directly at each size.
#[tauri::command]
fn get_icon_target_sizes(app: AppHandle) -> icon::IconTargetSizes {
    icon::target_sizes_for_window(&app)
}

/// Replace the running app icon with palette-tinted PNGs rendered by the web UI.
///
/// Windows selects exact target-size variants for `ICON_SMALL` (titlebar) and `ICON_BIG` (taskbar
/// and Alt+Tab) via Win32 `WM_SETICON`; macOS updates the live Dock icon.
/// The same artwork supplies Windows shortcuts, the Finder icon and the idle macOS Dock tile
/// after quit; `bundled: true` means the artwork matches the shipped icon and removes that
/// customization instead. Persistence failures are logged and never fail the command.
/// Empty, oversized or undecodable payloads are rejected and leave the current icon unchanged.
#[tauri::command]
fn set_app_icon(
    app: AppHandle,
    png: Option<Vec<u8>>,
    variants: Option<Vec<icon::IconVariantInput>>,
    bundled: Option<bool>,
) -> Result<(), String> {
    let bundled = bundled.unwrap_or(false);
    #[cfg(target_os = "macos")]
    {
        let bytes = icon::pick_macos_png(png, variants)?;
        persistent_icon::update_macos_icon(&app, bytes, bundled)
    }
    #[cfg(windows)]
    {
        let decoded = icon::decode_variants(png, variants)?;
        let persisted = if bundled {
            persistent_icon::PersistRequest::Bundled
        } else {
            persistent_icon::PersistRequest::Custom(decoded.clone())
        };
        icon::apply_windows_icons(&app, decoded)?;
        persistent_icon::persist(&app, persisted);
        Ok(())
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let _ = bundled;
        let decoded = icon::decode_variants(png, variants)?;
        let Some(best) = icon::select_variant_for_size(&decoded, 256) else {
            return Err("Invalid icon".into());
        };
        let image = tauri::image::Image::new_owned(best.rgba.clone(), best.width, best.height);
        if let Some(window) = app.get_webview_window("main") {
            window
                .set_icon(image)
                .map_err(|_| "Could not update the window icon")?;
        }
        Ok(())
    }
}

/// Open an allowlisted URL as OS data, never as shell code.
#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    let url = security::external_url(&url)?;
    #[cfg(windows)]
    {
        use windows_sys::Win32::UI::Shell::ShellExecuteW;
        use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
        let wide: Vec<u16> = url.as_str().encode_utf16().chain(Some(0)).collect();
        let verb: Vec<u16> = "open".encode_utf16().chain(Some(0)).collect();
        // SAFETY: NUL-terminated strings outlive the call; no pointers escape.
        let result = unsafe {
            ShellExecuteW(
                std::ptr::null_mut(),
                verb.as_ptr(),
                wide.as_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                SW_SHOWNORMAL,
            )
        };
        if result as isize <= 32 {
            return Err("Windows could not open the URL".into());
        }
        Ok(())
    }
    #[cfg(target_os = "macos")]
    {
        let status = std::process::Command::new("/usr/bin/open")
            .arg(url.as_str())
            .status()
            .map_err(|_| "Could not open external URL")?;
        if status.success() {
            Ok(())
        } else {
            Err("macOS could not open the URL".into())
        }
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let _ = url;
        Err("This desktop release supports Windows only".into())
    }
}

/// Initialize the host and delay final exit until sidecar writes finish or the deadline expires.
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(feature = "desktop-e2e")]
    let builder = builder
        .plugin(tauri_plugin_wdio::init())
        .plugin(tauri_plugin_wdio_webdriver::init());
    builder
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(DesktopState::default())
        .manage(updates::DesktopUpdates::default())
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_menu(tauri::menu::Menu::default(app.handle())?)?;
            begin_startup(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            api_request,
            export_data_file,
            pick_folder,
            open_external,
            get_desktop_status,
            retry_sidecar,
            get_icon_target_sizes,
            set_app_icon,
            updates::desktop_update_info,
            updates::check_desktop_update,
            updates::download_desktop_update,
            updates::install_desktop_update
        ])
        .build(tauri::generate_context!())
        .expect("Could not initialize the desktop window")
        .run(|app, event| {
            #[cfg(windows)]
            if let tauri::RunEvent::WindowEvent {
                label,
                event: tauri::WindowEvent::ScaleFactorChanged { .. },
                ..
            } = &event
            {
                if label == "main" {
                    icon::refresh_windows_icons_for_dpi(app);
                }
            }
            #[cfg(target_os = "macos")]
            match &event {
                tauri::RunEvent::WindowEvent {
                    label,
                    event: tauri::WindowEvent::CloseRequested { api, .. },
                    ..
                } => {
                    if !app.state::<DesktopState>().exiting.load(Ordering::SeqCst) {
                        api.prevent_close();
                        if let Some(window) = app.get_webview_window(label) {
                            let _ = window.hide();
                        }
                    }
                }
                tauri::RunEvent::Reopen { .. } => {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
                _ => {}
            }
            if let tauri::RunEvent::ExitRequested { api, code, .. } = event {
                let state = app.state::<DesktopState>();
                if state.installing_update.load(Ordering::SeqCst) {
                    if code != Some(tauri::RESTART_EXIT_CODE) {
                        api.prevent_exit();
                    }
                    return;
                }
                // The explicit app.exit below must not re-enter graceful shutdown.
                if code.is_some() && state.exiting.load(Ordering::SeqCst) {
                    return;
                }
                api.prevent_exit();
                if state.exiting.swap(true, Ordering::SeqCst) {
                    return;
                }
                let handle = app.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    let state = handle.state::<DesktopState>();
                    let _ = state.stop_service();
                    handle.exit(0);
                });
            }
        });
}
