//! Desktop host: native authorization, private sidecar ownership and recoverable startup.
mod lifecycle;
mod process;
mod security;

use rand::RngCore;
use serde::Serialize;
use std::collections::HashMap;
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_autostart::ManagerExt;
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
    state: String,
    message: Option<String>,
}

/// Blocking process work is kept off the window event thread.
struct DesktopState {
    child: Mutex<Option<process::ManagedChild>>,
    connection: Mutex<Option<Connection>>,
    status: Mutex<DesktopStatus>,
    manual_retry: AtomicBool,
    ai_paused: Mutex<Option<bool>>,
    mcp_listener: Mutex<String>,
    renderer_ready: AtomicBool,
    exit_pending: AtomicBool,
    exit_acknowledged: AtomicBool,
    exiting: AtomicBool,
    exports: tokio::sync::Mutex<()>,
}

impl Default for DesktopState {
    /// Start without a process; setup dispatches initialization in a worker.
    fn default() -> Self {
        Self {
            child: Mutex::new(None),
            connection: Mutex::new(None),
            status: Mutex::new(DesktopStatus {
                state: "starting".into(),
                message: None,
            }),
            manual_retry: AtomicBool::new(false),
            ai_paused: Mutex::new(None),
            mcp_listener: Mutex::new("MCP 状态未知 / MCP unknown".into()),
            renderer_ready: AtomicBool::new(false),
            exit_pending: AtomicBool::new(false),
            exit_acknowledged: AtomicBool::new(false),
            exiting: AtomicBool::new(false),
            exports: tokio::sync::Mutex::new(()),
        }
    }
}

impl DesktopState {
    /// The sidecar controller remains the only configuration owner.
    fn mcp_request(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<serde_json::Value>,
    ) -> Result<serde_json::Value, String> {
        let connection = self.connection()?;
        let mut request = blocking_client()?
            .request(
                method,
                format!("http://127.0.0.1:{}/api/v1/mcp/{path}", connection.port),
            )
            .header("x-desktop-session-token", connection.token);
        if let Some(body) = body {
            request = request.json(&body);
        }
        request
            .send()
            .and_then(|r| r.error_for_status())
            .and_then(|r| r.json())
            .map_err(|_| "MCP_UNAVAILABLE".into())
    }
    fn set_ai_paused(&self, paused: bool) -> Result<(), String> {
        self.mcp_request(
            reqwest::Method::PATCH,
            "config",
            Some(serde_json::json!({"aiAccessPaused":paused})),
        )?;
        *self.ai_paused.lock().unwrap() = Some(paused);
        Ok(())
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
        "MCP_CONFIG_PATH",
        "LOCAL_DIR",
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
            "backupDir": data_dir.join("backups"), "mcpConfigPath": data_dir.join("mcp-config.json"), "sessionSecret": token, "nonce": nonce
        }))?;
        *owner = Some(child);
        receiver
    };
    let port = process::wait_ready(receiver, &nonce, STARTUP_TIMEOUT)?;
    let health = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(2))
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

/// Bounded requests never follow redirects, consult proxy settings, or expose the session token.
fn blocking_client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(2))
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .build()
        .map_err(|_| "HTTP_CLIENT_FAILED".into())
}
fn wait_or_exit(state: &DesktopState, duration: Duration) -> bool {
    let deadline = Instant::now() + duration;
    while Instant::now() < deadline {
        if state.exiting.load(Ordering::SeqCst) || state.exit_pending.load(Ordering::SeqCst) {
            return false;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    !state.exiting.load(Ordering::SeqCst)
}
fn set_status(app: &AppHandle, name: &str, code: Option<&str>) {
    let state = app.state::<DesktopState>();
    if state.exiting.load(Ordering::SeqCst) {
        return;
    }
    *state.status.lock().unwrap() = DesktopStatus {
        state: name.into(),
        message: code.map(str::to_owned),
    };
    update_tray_menu(app);
}
/// Reap the old owner before acquiring the same database lease again.
fn stop_service(state: &DesktopState) {
    state.connection.lock().unwrap().take();
    *state.ai_paused.lock().unwrap() = None;
    if let Some(mut child) = state.child.lock().unwrap().take() {
        let _ = child.shutdown(Duration::from_secs(2));
    }
}
/// This worker exists even when no WebView was created. A resumed sleep proceeds directly to health checks.
fn begin_startup(app: AppHandle) {
    std::thread::spawn(move || {
        let state = app.state::<DesktopState>();
        let epoch = Instant::now();
        let mut policy = lifecycle::RecoveryPolicy::default();
        let mut needs_start = true;
        let mut recovery = false;
        while !state.exiting.load(Ordering::SeqCst) {
            let check_started = Instant::now();
            if state.exit_pending.load(Ordering::SeqCst) {
                std::thread::sleep(Duration::from_millis(20));
                continue;
            }
            if state.manual_retry.swap(false, Ordering::SeqCst)
                && state.status.lock().unwrap().state != "ready"
            {
                policy.reset();
                needs_start = true;
                recovery = false;
            }
            if needs_start {
                if recovery {
                    let Some(delay) = policy.next_retry() else {
                        set_status(&app, "failed", Some("RETRY_LIMIT_REACHED"));
                        needs_start = false;
                        continue;
                    };
                    set_status(&app, "recovering", None);
                    if !wait_or_exit(&state, delay) {
                        if state.exiting.load(Ordering::SeqCst) {
                            break;
                        } else {
                            continue;
                        }
                    }
                } else {
                    set_status(&app, "starting", None);
                }
                match start_service(&app) {
                    Ok(()) => {
                        policy.healthy(epoch.elapsed());
                        needs_start = false;
                        set_status(&app, "ready", None);
                    }
                    Err(error) => {
                        stop_service(&state);
                        if state.exiting.load(Ordering::SeqCst) {
                            break;
                        }
                        policy.outage();
                        if error == "DATABASE_IN_USE" {
                            needs_start = false;
                            set_status(&app, "conflict", Some("DATABASE_IN_USE"));
                        } else {
                            recovery = true;
                            set_status(&app, "recovering", Some("SIDECAR_START_FAILED"));
                        }
                        continue;
                    }
                }
            }
            if state.status.lock().unwrap().state == "ready" {
                let stopped = state
                    .child
                    .lock()
                    .unwrap()
                    .as_mut()
                    .is_none_or(|child| child.exited());
                let healthy = state.connection().ok().is_some_and(|c| {
                    blocking_client()
                        .ok()
                        .and_then(|client| {
                            client
                                .get(format!("http://127.0.0.1:{}/api/v1/health", c.port))
                                .header("x-desktop-session-token", c.token)
                                .send()
                                .ok()
                        })
                        .is_some_and(|r| r.status().is_success())
                });
                if stopped || (!healthy && policy.unhealthy()) {
                    policy.outage();
                    set_status(&app, "recovering", Some("SIDECAR_UNHEALTHY"));
                    stop_service(&state);
                    needs_start = true;
                    recovery = true;
                    continue;
                }
                if healthy {
                    policy.healthy(epoch.elapsed());
                }
                // A failed health request already used the polling budget; do not wait on the same service twice.
                let mcp = healthy
                    .then(|| state.mcp_request(reqwest::Method::GET, "status", None).ok())
                    .flatten();
                let paused = mcp
                    .as_ref()
                    .filter(|j| j["configuredPort"].is_number())
                    .and_then(|j| j["aiAccessPaused"].as_bool());
                let label = mcp.as_ref().map_or_else(
                    || "MCP 不可用 / MCP unavailable".to_string(),
                    |j| {
                        if j["state"] == "ready" {
                            format!(
                                "MCP 就绪 / Ready :{}{}",
                                j["listeningPort"],
                                if j["restartRequired"] == true {
                                    " (待重启 / restart pending)"
                                } else {
                                    ""
                                }
                            )
                        } else {
                            format!(
                                "MCP 不可用 / Unavailable: {}",
                                j["errorCode"].as_str().unwrap_or("MCP_STOPPED")
                            )
                        }
                    },
                );
                let changed = {
                    let mut old = state.ai_paused.lock().unwrap();
                    let mut old_label = state.mcp_listener.lock().unwrap();
                    let changed = *old != paused || *old_label != label;
                    *old = paused;
                    *old_label = label;
                    changed
                };
                if changed {
                    update_tray_menu(&app);
                }
            }
            let remaining = Duration::from_secs(2).saturating_sub(check_started.elapsed());
            if !wait_or_exit(&state, remaining) && state.exiting.load(Ordering::SeqCst) {
                break;
            }
        }
    });
}
/// Renderer polling observes state only; it cannot start or supervise a process.
#[tauri::command]
fn get_desktop_status(state: State<'_, DesktopState>) -> DesktopStatus {
    state.status.lock().unwrap().clone()
}
#[tauri::command]
fn retry_sidecar(state: State<'_, DesktopState>) {
    state.manual_retry.store(true, Ordering::SeqCst);
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

/// Ensure main webview window exists, unminimized, shown, and focused.
pub fn ensure_main_window(app: &AppHandle) -> Result<tauri::WebviewWindow, String> {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        return Ok(window);
    }
    let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::default())
        .title("LeetCode Tracker")
        .inner_size(1280.0, 800.0)
        .min_inner_size(1024.0, 700.0)
        .resizable(true)
        .fullscreen(false)
        .build()
        .map_err(|e| e.to_string())?;
    let _ = window.set_focus();
    Ok(window)
}

/// Show one-time tip informing user the window closed to system tray.
fn show_first_close_hint(app: &AppHandle) {
    if let Ok(data_dir) = app.path().app_local_data_dir() {
        let hint_file = data_dir.join(".closed_to_tray_hint");
        if !hint_file.exists() {
            let _ = std::fs::write(&hint_file, b"1");
            app.dialog()
                .message("LeetCode Tracker 仍在后台运行。\n您可以从任务栏右下角的系统托盘图标重新打开窗口，或右键托盘图标选择“退出”以完全退出程序。")
                .title("后台运行提示")
                .show(|_| {});
        }
    }
}

/// Update system tray menu with latest state and AI toggle.
pub fn update_tray_menu(app: &AppHandle) {
    let Some(tray) = app.tray_by_id("main-tray") else {
        return;
    };
    let state = app.state::<DesktopState>();
    let status_text = {
        let status = state.status.lock().unwrap();
        match status.state.as_str() {
            "ready" => "运行状态：就绪 / Runtime ready",
            "starting" => "启动中 / Starting",
            "recovering" => "恢复中 / Recovering",
            "exiting" => "退出中 / Exiting",
            "conflict" => "数据库被占用 / Database conflict",
            _ => "运行失败 / Runtime failed",
        }
    };
    let ai_paused = *state.ai_paused.lock().unwrap();
    let ai_text = match ai_paused {
        Some(true) => "恢复 AI 访问 / Resume AI access",
        Some(false) => "暂停 AI 访问 / Pause AI access",
        None => "AI 不可用 / AI unavailable",
    };

    let Ok(open_item) = MenuItem::with_id(
        app,
        "open",
        "打开 / Open LeetCode Tracker",
        true,
        None::<&str>,
    ) else {
        return;
    };
    let Ok(status_item) = MenuItem::with_id(app, "status", status_text, false, None::<&str>) else {
        return;
    };
    let Ok(pause_ai_item) =
        MenuItem::with_id(app, "toggle_ai", ai_text, ai_paused.is_some(), None::<&str>)
    else {
        return;
    };
    let label = state.mcp_listener.lock().unwrap().clone();
    let Ok(mcp_item) = MenuItem::with_id(app, "mcp_status", label, false, None::<&str>) else {
        return;
    };
    let Ok(sep) = PredefinedMenuItem::separator(app) else {
        return;
    };
    let Ok(quit_item) = MenuItem::with_id(app, "quit", "退出 / Quit", true, None::<&str>) else {
        return;
    };

    if let Ok(menu) = Menu::with_items(
        app,
        &[
            &open_item,
            &status_item,
            &mcp_item,
            &pause_ai_item,
            &sep,
            &quit_item,
        ],
    ) {
        let _ = tray.set_menu(Some(menu));
    }
}

/// Build system tray icon and event handlers.
pub fn setup_tray(app: &AppHandle) -> Result<(), String> {
    let mut builder = TrayIconBuilder::with_id("main-tray")
        .show_menu_on_left_click(false)
        .tooltip("LeetCode Tracker")
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => {
                let _ = ensure_main_window(app);
            }
            "toggle_ai" => {
                let handle = app.clone();
                std::thread::spawn(move || {
                    let state = handle.state::<DesktopState>();
                    let paused = state
                        .mcp_request(reqwest::Method::GET, "status", None)
                        .ok()
                        .and_then(|j| j["aiAccessPaused"].as_bool());
                    if let Some(paused) = paused {
                        if state.set_ai_paused(!paused).is_ok() {
                            let _ = handle.emit("desktop:ai-access-changed", ());
                        }
                    }
                    update_tray_menu(&handle);
                });
            }
            "quit" => {
                request_app_exit(app);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                let _ = ensure_main_window(app);
            }
        });

    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }

    builder.build(app).map_err(|e| e.to_string())?;
    update_tray_menu(app);
    Ok(())
}

/// Request graceful exit, prompting frontend if unsaved drafts exist.
fn request_app_exit(app: &AppHandle) {
    let state = app.state::<DesktopState>();
    if state.exiting.load(Ordering::SeqCst) || state.exit_pending.swap(true, Ordering::SeqCst) {
        return;
    }
    state.exit_acknowledged.store(false, Ordering::SeqCst);
    if !state.renderer_ready.load(Ordering::SeqCst) {
        force_exit_app(app);
        return;
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        let _ = window.emit("desktop:request-exit", ());
        let _ = window.eval("window.dispatchEvent(new CustomEvent('desktop:request-exit'))");
    }
    let handle = app.clone();
    std::thread::spawn(move || {
        let state = handle.state::<DesktopState>();
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            if state.exiting.load(Ordering::SeqCst)
                || state.exit_acknowledged.load(Ordering::SeqCst)
                || !state.exit_pending.load(Ordering::SeqCst)
            {
                return;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        // A renderer that previously mounted an editor may contain a draft even when unresponsive.
        handle.dialog().message("The editor did not respond. Quit and discard possible unsaved notes? / 编辑器未响应，是否退出并放弃可能未保存的笔记？")
            .title("LeetCode Tracker").buttons(tauri_plugin_dialog::MessageDialogButtons::OkCancel).show(move |confirmed| {
                let state = handle.state::<DesktopState>();
                if !state.exit_pending.load(Ordering::SeqCst) || state.exit_acknowledged.load(Ordering::SeqCst) { return; }
                if confirmed { force_exit_app(&handle); } else { state.exit_pending.store(false, Ordering::SeqCst); }
            });
    });
}
#[tauri::command]
fn renderer_ready(state: State<'_, DesktopState>) {
    state.renderer_ready.store(true, Ordering::SeqCst);
}
#[tauri::command]
fn acknowledge_exit(state: State<'_, DesktopState>) {
    state.exit_acknowledged.store(true, Ordering::SeqCst);
}

/// Bounded teardown of child process and database lease before exiting host.
fn force_exit_app(app: &AppHandle) {
    let state = app.state::<DesktopState>();
    if state.exiting.swap(true, Ordering::SeqCst) {
        return;
    }
    state.connection.lock().unwrap().take();
    *state.status.lock().unwrap() = DesktopStatus {
        state: "exiting".into(),
        message: None,
    };
    update_tray_menu(app);
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

#[tauri::command]
fn confirm_exit(app: AppHandle) {
    force_exit_app(&app);
}

#[tauri::command]
fn request_exit(app: AppHandle) {
    request_app_exit(&app);
}

#[tauri::command]
fn cancel_exit(state: State<'_, DesktopState>) {
    state.exit_pending.store(false, Ordering::SeqCst);
}

#[tauri::command]
fn get_autostart_status(app: AppHandle) -> Result<bool, String> {
    app.autolaunch().is_enabled().map_err(|e| e.to_string())
}

#[tauri::command]
fn set_autostart_status(app: AppHandle, enabled: bool) -> Result<(), String> {
    let autolaunch = app.autolaunch();
    if enabled {
        autolaunch.enable().map_err(|e| e.to_string())?;
        #[cfg(windows)]
        {
            // auto-launch stores an unquoted path on Windows; quote it before login can execute it.
            use winreg::{
                enums::{HKEY_CURRENT_USER, KEY_SET_VALUE},
                RegKey,
            };
            let exe = std::env::current_exe().map_err(|e| e.to_string())?;
            let result = RegKey::predef(HKEY_CURRENT_USER)
                .open_subkey_with_flags(
                    "Software\\Microsoft\\Windows\\CurrentVersion\\Run",
                    KEY_SET_VALUE,
                )
                .and_then(|key| {
                    key.set_value(
                        &app.package_info().name,
                        &format!("\"{}\" --background", exe.display()),
                    )
                });
            if let Err(error) = result {
                let _ = autolaunch.disable();
                return Err(error.to_string());
            }
        }
    } else {
        autolaunch.disable().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn get_ai_access_status(app: AppHandle) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<DesktopState>()
            .mcp_request(reqwest::Method::GET, "status", None)?["aiAccessPaused"]
            .as_bool()
            .ok_or("MCP_UNAVAILABLE".into())
    })
    .await
    .map_err(|_| "MCP_UNAVAILABLE".to_string())?
}
#[tauri::command]
async fn set_ai_access_status(app: AppHandle, paused: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<DesktopState>().set_ai_paused(paused)?;
        update_tray_menu(&app);
        Ok(())
    })
    .await
    .map_err(|_| "MCP_UNAVAILABLE".to_string())?
}

/// Initialize the host and delay final exit until sidecar writes finish or the deadline expires.
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(feature = "desktop-e2e")]
    let builder = builder
        .plugin(tauri_plugin_wdio::init())
        .plugin(tauri_plugin_wdio_webdriver::init());
    builder
        .plugin(tauri_plugin_single_instance::init(|app, argv, _| {
            let is_bg = argv.iter().any(|arg| arg == "--background");
            if !is_bg {
                let _ = ensure_main_window(app);
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--background"]),
        ))
        .manage(DesktopState::default())
        .setup(|app| {
            let is_background = std::env::args().any(|arg| arg == "--background");
            #[cfg(target_os = "macos")]
            app.set_menu(tauri::menu::Menu::default(app.handle())?)?;

            setup_tray(app.handle())?;
            begin_startup(app.handle().clone());

            if !is_background {
                let _ = ensure_main_window(app.handle());
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            api_request,
            export_data_file,
            open_external,
            get_desktop_status,
            retry_sidecar,
            renderer_ready,
            acknowledge_exit,
            confirm_exit,
            request_exit,
            cancel_exit,
            get_autostart_status,
            set_autostart_status,
            get_ai_access_status,
            set_ai_access_status
        ])
        .build(tauri::generate_context!())
        .expect("Could not initialize the desktop application")
        .run(|app, event| {
            match &event {
                tauri::RunEvent::WindowEvent {
                    label,
                    event: tauri::WindowEvent::CloseRequested { api, .. },
                    ..
                } => {
                    let state = app.state::<DesktopState>();
                    if !state.exiting.load(Ordering::SeqCst) {
                        api.prevent_close();
                        if let Some(window) = app.get_webview_window(label) {
                            let _ = window.hide();
                            show_first_close_hint(app);
                        }
                    }
                }
                #[cfg(target_os = "macos")]
                tauri::RunEvent::Reopen { .. } => {
                    let _ = ensure_main_window(app);
                }
                _ => {}
            }
            if let tauri::RunEvent::ExitRequested { api, code, .. } = event {
                let state = app.state::<DesktopState>();
                if code.is_some() && state.exiting.load(Ordering::SeqCst) {
                    return;
                }
                api.prevent_exit();
                request_app_exit(app);
            }
        });
}
