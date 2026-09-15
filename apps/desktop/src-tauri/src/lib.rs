//! Desktop host: native authorization, private sidecar ownership and recoverable startup.
mod process;
mod security;

use rand::RngCore;
use serde::Serialize;
use std::collections::HashMap;
use std::io::Write;
use std::path::PathBuf;
use std::process::Command;
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
    child: Mutex<Option<process::ManagedChild>>,
    connection: Mutex<Option<Connection>>,
    status: Mutex<DesktopStatus>,
    starting: AtomicBool,
    exiting: AtomicBool,
    exports: tokio::sync::Mutex<()>,
}

impl Default for DesktopState {
    /// Start without a process; setup dispatches initialization in a worker.
    fn default() -> Self {
        Self {
            child: Mutex::new(None),
            connection: Mutex::new(None),
            status: Mutex::new(DesktopStatus { state: "starting" }),
            starting: AtomicBool::new(false),
            exiting: AtomicBool::new(false),
            exports: tokio::sync::Mutex::new(()),
        }
    }
}

impl DesktopState {
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
        let node = root.join("binaries/node-x86_64-pc-windows-msvc.exe");
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
        .join("node.exe");
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

/// Own the process before waiting for ready, allowing close to stop a slow startup.
fn start_service(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<DesktopState>();
    let (node, script) = resources(app)?;
    let data_dir = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
    let token = random_secret();
    let nonce = random_secret();
    let mut command = Command::new(node);
    command.arg(script).current_dir(&data_dir);
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
            "backupDir": data_dir.join("backups"), "sessionSecret": token, "nonce": nonce
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
    if state.exiting.load(Ordering::SeqCst) || state.starting.swap(true, Ordering::SeqCst) {
        return;
    }
    // A renderer retry must never replace an already healthy owner.
    if state.status.lock().unwrap().state == "ready" {
        state.starting.store(false, Ordering::SeqCst);
        return;
    }
    *state.status.lock().unwrap() = DesktopStatus { state: "starting" };
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<DesktopState>();
        let result = start_service(&app);
        if result.is_err() {
            state.child.lock().unwrap().take();
            state.connection.lock().unwrap().take();
        }
        *state.status.lock().unwrap() = DesktopStatus {
            state: if result.is_ok() { "ready" } else { "error" },
        };
        state.starting.store(false, Ordering::SeqCst);
    });
}

/// Poll liveness without returning private paths, secrets or raw provider errors.
#[tauri::command]
fn get_desktop_status(state: State<'_, DesktopState>) -> DesktopStatus {
    let mut status = state.status.lock().unwrap();
    if status.state == "ready" {
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
    if body.as_ref().is_some_and(|b| b.len() > 15 * 1024 * 1024) {
        return Err("Request exceeds 15 MiB".into());
    }
    let mut request = client()?
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
    let mut response = client()?
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

/// ShellExecuteW receives a URL as data; cmd.exe is never involved.
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
    #[cfg(not(windows))]
    {
        let _ = url;
        Err("This desktop release supports Windows only".into())
    }
}

/// Initialize the host and delay final exit until sidecar writes finish or the deadline expires.
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .manage(DesktopState::default())
        .setup(|app| {
            begin_startup(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            api_request,
            export_data_file,
            open_external,
            get_desktop_status,
            retry_sidecar
        ])
        .build(tauri::generate_context!())
        .expect("Could not initialize the desktop window")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { api, code, .. } = event {
                let state = app.state::<DesktopState>();
                // The explicit app.exit below must not re-enter graceful shutdown.
                if code.is_some() && state.exiting.load(Ordering::SeqCst) {
                    return;
                }
                api.prevent_exit();
                if state.exiting.swap(true, Ordering::SeqCst) {
                    return;
                }
                state.connection.lock().unwrap().take();
                let handle = app.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    let state = handle.state::<DesktopState>();
                    let child = state.child.lock().unwrap().take();
                    if let Some(mut child) = child {
                        let _ = child.shutdown(SHUTDOWN_TIMEOUT);
                    }
                    handle.exit(0);
                });
            }
        });
}
