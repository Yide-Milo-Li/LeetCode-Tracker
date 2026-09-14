/**
 * Tauri 2 desktop shell host application.
 * Manages the isolated Node.js Fastify loopback sidecar lifecycle, enforces Windows Job Object
 * termination guarantees, brokers secure IPC requests with cryptographic session authentication,
 * and provides native OS integration (file save dialogs, atomic exports, whitelisted URL launching).
 */
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rand::RngCore;
use serde::Serialize;
use tauri::{AppHandle, Manager, State};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// Windows creation flag to suppress command prompt window when spawning child processes.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

/// State holding sidecar connection details and management handles.
pub struct SidecarState {
    pub port: u16,
    pub session_secret: String,
    pub data_dir: PathBuf,
    pub child_stdin: Arc<Mutex<Option<ChildStdin>>>,
}

#[derive(Serialize)]
pub struct ApiResponse {
    pub status: u16,
    pub body: String,
    pub headers: HashMap<String, String>,
}

#[derive(Serialize)]
pub struct DesktopInfo {
    pub version: String,
    pub data_dir: String,
    pub port: u16,
}

/// Attach child process to a Windows Job Object with KILL_ON_JOB_CLOSE limit.
#[cfg(windows)]
fn attach_to_job_object(child: &Child) {
    use std::mem::size_of;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if !job.is_null() {
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const _,
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            AssignProcessToJobObject(job, child.as_raw_handle() as _);
        }
    }
}

#[cfg(not(windows))]
fn attach_to_job_object(_child: &Child) {}

/// Generate a 256-bit cryptographically random hexadecimal secret.
fn generate_session_secret() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    let mut hex = String::with_capacity(64);
    for b in bytes {
        hex.push_str(&format!("{:02x}", b));
    }
    hex
}

/// Locate the bundled Node executable.
fn resolve_node_executable(app: &AppHandle) -> Result<PathBuf, String> {
    let current_exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let app_dir = current_exe.parent().ok_or("Failed to get app directory")?;

    // Check development path: apps/desktop/src-tauri/binaries/node-x86_64-pc-windows-msvc.exe
    let dev_bin = app_dir.join("binaries/node-x86_64-pc-windows-msvc.exe");
    if dev_bin.exists() {
        return Ok(dev_bin);
    }

    // Check installed path: node.exe next to main executable
    let installed_bin = app_dir.join("node.exe");
    if installed_bin.exists() {
        return Ok(installed_bin);
    }

    // Check resource directory
    if let Ok(res_dir) = app.path().resource_dir() {
        let res_bin = res_dir.join("binaries/node-x86_64-pc-windows-msvc.exe");
        if res_bin.exists() {
            return Ok(res_bin);
        }
        let res_bin2 = res_dir.join("node.exe");
        if res_bin2.exists() {
            return Ok(res_bin2);
        }
    }

    // Fallback search in working directory
    let cwd_bin = PathBuf::from("apps/desktop/src-tauri/binaries/node-x86_64-pc-windows-msvc.exe");
    if cwd_bin.exists() {
        return Ok(cwd_bin);
    }

    Err("Could not locate private Node.js runtime executable.".to_string())
}

/// Locate the bundled server script (desktop-server.mjs).
fn resolve_server_script(app: &AppHandle) -> Result<PathBuf, String> {
    let current_exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let app_dir = current_exe.parent().ok_or("Failed to get app directory")?;

    // Check direct candidate paths
    let candidate_paths = [
        app_dir.join("desktop-server.mjs"),
        app_dir.join("_up_/_up_/server/dist/desktop-server.mjs"),
        app_dir.join("_up_/server/dist/desktop-server.mjs"),
        PathBuf::from("apps/server/dist/desktop-server.mjs"),
    ];

    for candidate in &candidate_paths {
        if candidate.exists() {
            return Ok(candidate.clone());
        }
    }

    if let Ok(res_dir) = app.path().resource_dir() {
        let res_candidates = [
            res_dir.join("desktop-server.mjs"),
            res_dir.join("_up_/_up_/server/dist/desktop-server.mjs"),
            res_dir.join("_up_/server/dist/desktop-server.mjs"),
        ];
        for candidate in &res_candidates {
            if candidate.exists() {
                return Ok(candidate.clone());
            }
        }
    }

    // Recursive search in app_dir as reliable fallback
    fn find_file_recursive(dir: &std::path::Path, target: &str) -> Option<PathBuf> {
        if let Ok(entries) = fs::read_dir(dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_file() && path.file_name().map_or(false, |n| n == target) {
                    return Some(path);
                }
                if path.is_dir() {
                    if let Some(found) = find_file_recursive(&path, target) {
                        return Some(found);
                    }
                }
            }
        }
        None
    }

    if let Some(found) = find_file_recursive(app_dir, "desktop-server.mjs") {
        return Ok(found);
    }

    Err("Could not locate desktop-server.mjs server bundle.".to_string())
}

/// Spawn the Node sidecar, handshake via stdin/stdout, and configure state.
pub fn spawn_sidecar(app: &AppHandle) -> Result<SidecarState, String> {
    let node_exe = resolve_node_executable(app)?;
    let server_script = resolve_server_script(app)?;

    let data_dir = app
        .path()
        .app_local_data_dir()
        .unwrap_or_else(|_| PathBuf::from("./data"));
    fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;

    let db_path = data_dir.join("tracker.sqlite");
    let backup_dir = data_dir.join("backups");
    let session_secret = generate_session_secret();
    let nonce = format!("nonce-{}", generate_session_secret());

    let mut cmd = Command::new(&node_exe);
    cmd.arg(&server_script)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn sidecar: {}", e))?;

    attach_to_job_object(&child);

    let mut stdin = child.stdin.take().ok_or("Failed to open child stdin")?;
    let stdout = child.stdout.take().ok_or("Failed to open child stdout")?;

    // Send initialization configuration
    let init_payload = serde_json::json!({
        "port": 0,
        "dbPath": db_path.to_string_lossy(),
        "backupDir": backup_dir.to_string_lossy(),
        "sessionSecret": session_secret,
        "nonce": nonce,
    });
    let payload_str = format!("{}\n", init_payload);
    stdin
        .write_all(payload_str.as_bytes())
        .map_err(|e| format!("Failed to write handshake to child stdin: {}", e))?;
    stdin
        .flush()
        .map_err(|e| format!("Failed to flush child stdin: {}", e))?;

    // Read ready event from stdout
    let mut reader = BufReader::new(stdout);
    let mut ready_line = String::new();
    reader
        .read_line(&mut ready_line)
        .map_err(|e| format!("Failed to read handshake response from sidecar: {}", e))?;

    let ready_json: serde_json::Value = serde_json::from_str(&ready_line)
        .map_err(|e| format!("Invalid JSON from sidecar ready line: {} (raw: {})", e, ready_line))?;

    if ready_json.get("type").and_then(|t| t.as_str()) != Some("ready") {
        return Err(format!("Expected ready message, got: {}", ready_line));
    }

    let port = ready_json
        .get("port")
        .and_then(|p| p.as_u64())
        .ok_or("Missing or invalid port in ready message")? as u16;

    let received_nonce = ready_json.get("nonce").and_then(|n| n.as_str()).unwrap_or("");
    if received_nonce != nonce {
        return Err("Handshake nonce mismatch between host and sidecar".to_string());
    }

    println!("[Desktop Host] Sidecar listening on 127.0.0.1:{}", port);

    Ok(SidecarState {
        port,
        session_secret,
        data_dir,
        child_stdin: Arc::new(Mutex::new(Some(stdin))),
    })
}

// -----------------------------------------------------------------------------
// Tauri IPC Commands
// -----------------------------------------------------------------------------

#[tauri::command]
async fn api_request(
    state: State<'_, SidecarState>,
    method: String,
    path: String,
    headers: Option<HashMap<String, String>>,
    body: Option<String>,
) -> Result<ApiResponse, String> {
    // Security check: Only allow /api/v1/ endpoints
    if !path.starts_with("/api/v1/") {
        return Err("Forbidden: only /api/v1/ requests are permitted via desktop transport.".into());
    }
    if path.contains("..") {
        return Err("Forbidden: path traversal detected.".into());
    }

    let url = format!("http://127.0.0.1:{}{}", state.port, path);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| e.to_string())?;

    let req_method = match method.to_uppercase().as_str() {
        "GET" => reqwest::Method::GET,
        "POST" => reqwest::Method::POST,
        "PUT" => reqwest::Method::PUT,
        "PATCH" => reqwest::Method::PATCH,
        "DELETE" => reqwest::Method::DELETE,
        _ => return Err(format!("Unsupported HTTP method: {}", method)),
    };

    let mut req = client.request(req_method, &url);

    // Inject session token header
    req = req.header("x-desktop-session-token", &state.session_secret);

    if let Some(custom_headers) = headers {
        for (k, v) in custom_headers {
            let lower = k.to_lowercase();
            // Disallow overriding critical host/auth headers
            if lower != "x-desktop-session-token" && lower != "host" {
                req = req.header(k, v);
            }
        }
    }

    if let Some(payload) = body {
        req = req.body(payload);
    }

    let resp = req.send().await.map_err(|e| e.to_string())?;
    let status = resp.status().as_u16();

    let mut resp_headers = HashMap::new();
    for (k, v) in resp.headers() {
        if let Ok(v_str) = v.to_str() {
            resp_headers.insert(k.as_str().to_string(), v_str.to_string());
        }
    }

    let resp_body = resp.text().await.map_err(|e| e.to_string())?;

    Ok(ApiResponse {
        status,
        body: resp_body,
        headers: resp_headers,
    })
}

#[tauri::command]
async fn export_data_file(
    state: State<'_, SidecarState>,
    api_path: String,
    destination_path: String,
) -> Result<(), String> {
    if !api_path.starts_with("/api/v1/") {
        return Err("Forbidden: only /api/v1/ export endpoints are permitted.".into());
    }

    let url = format!("http://127.0.0.1:{}{}", state.port, api_path);
    let client = reqwest::Client::new();
    let resp = client
        .get(&url)
        .header("x-desktop-session-token", &state.session_secret)
        .send()
        .await
        .map_err(|e| format!("Export request failed: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("Export failed with HTTP {}", resp.status()));
    }

    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("Failed to read export stream: {}", e))?;

    let dest = PathBuf::from(&destination_path);
    let tmp_dest = dest.with_extension("tmp");

    // Write to atomic temporary file first
    let mut file = File::create(&tmp_dest).map_err(|e| format!("Failed to create temporary export file: {}", e))?;
    file.write_all(&bytes).map_err(|e| format!("Failed to write export bytes: {}", e))?;
    file.flush().map_err(|e| format!("Failed to flush export file: {}", e))?;
    drop(file);

    // Atomically replace target
    fs::rename(&tmp_dest, &dest).map_err(|e| format!("Failed to finalize export file: {}", e))?;

    Ok(())
}

#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    let lower = url.to_lowercase();
    // Strict whitelist verification
    let allowed = lower.starts_with("https://leetcode.com/")
        || lower.starts_with("https://leetcode.cn/")
        || lower.starts_with("https://github.com/");

    if !allowed {
        return Err("URL not permitted by desktop security whitelist.".into());
    }

    #[cfg(target_os = "windows")]
    {
        Command::new("cmd")
            .args(["/C", "start", "", &url])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    #[cfg(not(target_os = "windows"))]
    {
        Command::new("xdg-open")
            .arg(&url)
            .spawn()
            .map_err(|e| e.to_string())?;
        Ok(())
    }
}

#[tauri::command]
fn get_desktop_info(state: State<'_, SidecarState>) -> DesktopInfo {
    DesktopInfo {
        version: "0.1.0".to_string(),
        data_dir: state.data_dir.to_string_lossy().to_string(),
        port: state.port,
    }
}

/// Main library entrypoint configuring plugins, state, commands, and lifecycle hooks.
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let sidecar_state = spawn_sidecar(&app.handle())?;
            app.manage(sidecar_state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            api_request,
            export_data_file,
            open_external,
            get_desktop_info
        ])
        .build(tauri::generate_context!())
        .expect("Error while building LeetCode Tracker desktop application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::ExitRequested { .. } = event {
                // Graceful shutdown signal to sidecar stdin
                if let Some(state) = app_handle.try_state::<SidecarState>() {
                    if let Ok(mut guard) = state.child_stdin.lock() {
                        if let Some(mut stdin) = guard.take() {
                            let _ = stdin.write_all(b"{\"type\":\"shutdown\"}\n");
                            let _ = stdin.flush();
                        }
                    }
                }
            }
        });
}
