//! Native-only private Tunnel configuration and process supervision; no renderer lifetime or MCP command owns it.
use crate::{
    blocking_client, lifecycle::RecoveryPolicy, process::ManagedChild, tunnel_key::Secret,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::Command,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager};

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Configuration {
    pub enabled: bool,
    pub tunnel_id: String,
    pub client_id: String,
    #[serde(default)]
    key_file: Option<String>,
    #[serde(default)]
    verification: Option<Verification>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Verification {
    pub client_id: String,
    pub credential_version: u64,
    pub started_at: u64,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub state: String,
    pub code: Option<String>,
    pub configuration: Configuration,
    pub ready: bool,
    pub credential_saved: bool,
    pub credential_pending: bool,
    pub verification: Option<Verification>,
}

pub struct TunnelManager {
    child: Option<ManagedChild>,
    signature: Option<String>,
    policy: RecoveryPolicy,
    next: Option<Instant>,
    status: Status,
    epoch: Instant,
    started: Option<Instant>,
    blocked: bool,
    diagnostic_cancel: Option<Arc<AtomicBool>>,
    pending_key: Option<Secret>,
}
impl Default for TunnelManager {
    fn default() -> Self {
        Self {
            child: None,
            signature: None,
            policy: RecoveryPolicy::default(),
            next: None,
            status: Status {
                state: "disabled".into(),
                code: None,
                configuration: Configuration::default(),
                ready: false,
                credential_saved: false,
                credential_pending: false,
                verification: None,
            },
            epoch: Instant::now(),
            started: None,
            blocked: false,
            diagnostic_cancel: None,
            pending_key: None,
        }
    }
}
fn folder(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_local_data_dir()
        .map(|p| p.join("tunnel"))
        .map_err(|_| "TUNNEL_PATH_UNAVAILABLE".into())
}

/// Replace the protected DACL on the directory and existing credentials before writing secrets.
fn restrict(directory: &Path) -> Result<(), String> {
    fs::create_dir_all(directory).map_err(|_| "TUNNEL_CONFIG_WRITE_FAILED")?;
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let output = Command::new(r"C:\Windows\System32\whoami.exe")
            .args(["/user", "/fo", "csv", "/nh"])
            .creation_flags(0x08000000)
            .output()
            .map_err(|_| "TUNNEL_ACL_FAILED")?;
        let text = String::from_utf8_lossy(&output.stdout);
        let sid = text
            .split('"')
            .find(|v| {
                v.starts_with("S-1-")
                    && v.chars()
                        .all(|c| c.is_ascii_digit() || c == 'S' || c == '-')
            })
            .ok_or("TUNNEL_ACL_FAILED")?;
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::{
            Foundation::LocalFree,
            Security::{
                Authorization::{
                    ConvertStringSecurityDescriptorToSecurityDescriptorW, SetNamedSecurityInfoW,
                    SE_FILE_OBJECT,
                },
                GetSecurityDescriptorDacl, DACL_SECURITY_INFORMATION,
                PROTECTED_DACL_SECURITY_INFORMATION,
            },
        };
        let sddl: Vec<u16> = format!("D:P(A;OICI;FA;;;{sid})")
            .encode_utf16()
            .chain(Some(0))
            .collect();
        // SAFETY: the parsed descriptor is owned until LocalFree; every path is a terminated UTF-16 string.
        unsafe {
            let mut descriptor = std::ptr::null_mut();
            if ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl.as_ptr(),
                1,
                &mut descriptor,
                std::ptr::null_mut(),
            ) == 0
            {
                return Err("TUNNEL_ACL_FAILED".into());
            }
            let result: Result<(), String> = (|| {
                let mut present = 0;
                let mut defaulted = 0;
                let mut acl = std::ptr::null_mut();
                if GetSecurityDescriptorDacl(descriptor, &mut present, &mut acl, &mut defaulted)
                    == 0
                    || present == 0
                    || acl.is_null()
                {
                    return Err("TUNNEL_ACL_FAILED".into());
                }
                let mut paths = vec![directory.to_path_buf()];
                for entry in fs::read_dir(directory).map_err(|_| "TUNNEL_ACL_FAILED")? {
                    let entry = entry.map_err(|_| "TUNNEL_ACL_FAILED")?;
                    if entry
                        .file_name()
                        .to_string_lossy()
                        .starts_with("control-plane-")
                    {
                        paths.push(entry.path());
                    }
                }
                for name in [
                    "control-plane.key",
                    "bearer.header",
                    "configuration.json",
                    "health.url",
                    "doctor-health.url",
                ] {
                    let path = directory.join(name);
                    if path.exists() {
                        paths.push(path);
                    }
                }
                for path in paths {
                    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
                    if SetNamedSecurityInfoW(
                        wide.as_ptr(),
                        SE_FILE_OBJECT,
                        DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                        std::ptr::null_mut(),
                        std::ptr::null_mut(),
                        acl,
                        std::ptr::null_mut(),
                    ) != 0
                    {
                        return Err("TUNNEL_ACL_FAILED".into());
                    }
                }
                Ok(())
            })();
            LocalFree(descriptor);
            result?;
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(directory, fs::Permissions::from_mode(0o700))
            .map_err(|_| "TUNNEL_ACL_FAILED")?;
    }
    Ok(())
}
fn atomic(path: &Path, value: &[u8]) -> Result<(), String> {
    let mut temp = tempfile::NamedTempFile::new_in(path.parent().ok_or("TUNNEL_PATH_UNAVAILABLE")?)
        .map_err(|_| "TUNNEL_CONFIG_WRITE_FAILED")?;
    temp.write_all(value)
        .and_then(|_| temp.as_file().sync_all())
        .map_err(|_| "TUNNEL_CONFIG_WRITE_FAILED")?;
    temp.persist(path)
        .map_err(|_| "TUNNEL_CONFIG_WRITE_FAILED")?;
    Ok(())
}
fn config(app: &AppHandle) -> Result<Configuration, String> {
    let path = folder(app)?.join("configuration.json");
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|_| "TUNNEL_CONFIG_INVALID".into()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Configuration::default()),
        Err(_) => Err("TUNNEL_CONFIG_INVALID".into()),
    }
}
/// Managed key names are local filenames, never renderer-supplied filesystem paths.
fn key_path(directory: &Path, cfg: &Configuration) -> Result<PathBuf, String> {
    let name = cfg.key_file.as_deref().unwrap_or("control-plane.key");
    if name != "control-plane.key"
        && !(name.starts_with("control-plane-")
            && name.ends_with(".key")
            && name[14..name.len() - 4].len() == 32
            && name[14..name.len() - 4]
                .chars()
                .all(|c| c.is_ascii_hexdigit()))
    {
        return Err("TUNNEL_CONFIG_INVALID".into());
    }
    Ok(directory.join(name))
}
/// Atomic publication keeps the previous key/configuration pair usable if a replacement fails.
fn publish_configuration(
    directory: &Path,
    cfg: &mut Configuration,
    previous: &Configuration,
    next_key: Option<&Secret>,
) -> Result<(), String> {
    restrict(directory)?;
    // Publish a complete key first, then atomically switch the configuration pointer. A failed save leaves the old pair usable.
    let new_path = if let Some(key) = next_key {
        use rand::RngCore;
        let mut random = [0u8; 16];
        rand::rngs::OsRng.fill_bytes(&mut random);
        cfg.key_file = Some(format!(
            "control-plane-{}.key",
            random
                .iter()
                .map(|v| format!("{v:02x}"))
                .collect::<String>()
        ));
        let path = key_path(directory, cfg)?;
        atomic(&path, key.bytes())?;
        Some(path)
    } else {
        None
    };
    let result = atomic(
        &directory.join("configuration.json"),
        &serde_json::to_vec(cfg).map_err(|_| "TUNNEL_CONFIG_INVALID")?,
    );
    if let Err(error) = result {
        if let Some(path) = new_path {
            let _ = fs::remove_file(path);
        }
        return Err(error);
    }
    if new_path.is_some() && previous.key_file.is_some() {
        if let Ok(path) = key_path(directory, previous) {
            let _ = fs::remove_file(path);
        }
    }
    Ok(())
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
/// Validation is side-effect free, including explicit reuse consent when moving to another Tunnel.
fn prepare_configuration(
    directory: &Path,
    mut cfg: Configuration,
    previous: &Configuration,
    has_new_key: bool,
    reuse: bool,
    grants: &Value,
) -> Result<Configuration, String> {
    if !cfg.tunnel_id.starts_with("tunnel_")
        || cfg.tunnel_id.len() <= 7
        || cfg.tunnel_id.len() > 100
        || !cfg
            .tunnel_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_')
        || cfg.client_id.is_empty()
    {
        return Err("TUNNEL_CONFIG_INVALID".into());
    }
    cfg.key_file = previous.key_file.clone();
    cfg.verification = Some(verification(&cfg, grants)?);
    if !has_new_key {
        if !previous.tunnel_id.is_empty() && previous.tunnel_id != cfg.tunnel_id && !reuse {
            return Err("TUNNEL_KEY_REUSE_REQUIRED".into());
        }
        if !key_path(directory, &cfg)?.is_file() {
            return Err("TUNNEL_KEY_MISSING".into());
        }
    }
    Ok(cfg)
}
fn verification(cfg: &Configuration, grants: &Value) -> Result<Verification, String> {
    let grant = grants["clients"]
        .as_array()
        .and_then(|items| {
            items
                .iter()
                .find(|v| v["id"] == cfg.client_id && v["revoked"] == false)
        })
        .ok_or("TUNNEL_GRANT_REVOKED")?;
    Ok(Verification {
        client_id: cfg.client_id.clone(),
        credential_version: grant["credentialVersion"]
            .as_u64()
            .ok_or("TUNNEL_GRANT_UNAVAILABLE")?,
        started_at: now_ms(),
    })
}
fn executable(_app: &AppHandle) -> Result<PathBuf, String> {
    #[cfg(debug_assertions)]
    let directory = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tunnel");
    #[cfg(not(debug_assertions))]
    let directory = _app
        .path()
        .resource_dir()
        .map_err(|_| "TUNNEL_BINARY_MISSING")?
        .join("tunnel");
    for (name, expected) in [
        (
            "tunnel-client.exe",
            "1946de55a038313a9b9b2458d05fe1719fa9cf1f20a94dd5f38fc26a98bfdd42",
        ),
        (
            "cloudflared.exe",
            "cd0bc49aec24d0d62a37b6e842dad46000f7b401f6167b4cbace4e170819c9a2",
        ),
    ] {
        let data = fs::read(directory.join(name)).map_err(|_| "TUNNEL_BINARY_MISSING")?;
        if format!("{:x}", Sha256::digest(data)) != expected {
            return Err("TUNNEL_BINARY_HASH_MISMATCH".into());
        }
    }
    Ok(directory.join("tunnel-client.exe"))
}
/// Select the exact active grant and actual listener; never infer a grant from its display name.
fn target(
    app: &AppHandle,
    cfg: &Configuration,
    status: &Value,
) -> Result<(u16, String, String), String> {
    if status["aiAccessPaused"] != false {
        return Err("TUNNEL_ACCESS_PAUSED".into());
    }
    if status["state"] != "ready" {
        return Err("TUNNEL_RUNTIME_UNAVAILABLE".into());
    }
    let port = status["listeningPort"]
        .as_u64()
        .and_then(|v| u16::try_from(v).ok())
        .filter(|v| *v > 0)
        .ok_or("TUNNEL_RUNTIME_UNAVAILABLE")?;
    let data = fs::read(
        app.path()
            .app_local_data_dir()
            .map_err(|_| "TUNNEL_PATH_UNAVAILABLE")?
            .join("mcp-config.json"),
    )
    .map_err(|_| "TUNNEL_GRANT_UNAVAILABLE")?;
    let grants: Value = serde_json::from_slice(&data).map_err(|_| "TUNNEL_GRANT_UNAVAILABLE")?;
    let key = fs::read(key_path(&folder(app)?, cfg)?).map_err(|_| "TUNNEL_KEY_MISSING")?;
    select_target(cfg, status, &grants, &key, port)
}
/// Recheck persisted authorization on every native tick, including rotation and revocation.
fn select_target(
    cfg: &Configuration,
    status: &Value,
    grants: &Value,
    key: &[u8],
    port: u16,
) -> Result<(u16, String, String), String> {
    if status["aiAccessPaused"] != false || grants["aiAccessPaused"] != false {
        return Err("TUNNEL_ACCESS_PAUSED".into());
    }
    if status["state"] != "ready" || port == 0 {
        return Err("TUNNEL_RUNTIME_UNAVAILABLE".into());
    }
    let grant = grants["clients"]
        .as_array()
        .and_then(|items| {
            items
                .iter()
                .find(|v| v["id"] == cfg.client_id && v["revoked"] == false)
        })
        .ok_or("TUNNEL_GRANT_REVOKED")?;
    let token = grant["token"]
        .as_str()
        .filter(|v| v.len() == 64 && v.chars().all(|c| c.is_ascii_hexdigit()))
        .ok_or("TUNNEL_GRANT_UNAVAILABLE")?;
    let signature = format!(
        "{}:{}:{}:{}:{}:{:x}",
        cfg.tunnel_id,
        cfg.client_id,
        port,
        grant["credentialVersion"],
        grants["accessRevision"],
        Sha256::digest(key)
    );
    Ok((port, format!("Bearer {token}"), signature))
}
/// All dynamic arguments are IDs, loopback addresses, or file references; secrets never appear in argv.
fn command(
    app: &AppHandle,
    cfg: &Configuration,
    port: u16,
    action: &str,
) -> Result<Command, String> {
    let directory = folder(app)?;
    let mut command = Command::new(executable(app)?);
    command.env_clear();
    for name in ["SystemRoot", "WINDIR", "TEMP", "TMP"] {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
    configure_arguments(&mut command, &directory, cfg, port, action);
    Ok(command)
}
fn configure_arguments(
    command: &mut Command,
    directory: &Path,
    cfg: &Configuration,
    port: u16,
    action: &str,
) {
    command.current_dir(directory).arg(action).args([
        "--control-plane.tunnel-id",
        &cfg.tunnel_id,
        "--control-plane.api-key",
        &format!(
            "file:{}",
            dunce::simplified(&key_path(directory, cfg).expect("validated native key filename"))
                .display()
        ),
        "--mcp.server-url",
        &format!("http://127.0.0.1:{port}/mcp"),
        "--mcp.extra-headers",
        &format!(
            "Authorization: file:{}",
            dunce::simplified(&directory.join("bearer.header")).display()
        ),
        "--mcp.discovery-extra-headers",
        &format!(
            "Authorization: file:{}",
            dunce::simplified(&directory.join("bearer.header")).display()
        ),
        "--health.listen-addr",
        "127.0.0.1:0",
        "--health.url-file",
        &directory
            .join(if action == "doctor" {
                "doctor-health.url"
            } else {
                "health.url"
            })
            .to_string_lossy(),
    ]);
}
impl TunnelManager {
    pub fn status(&mut self, app: &AppHandle) -> Status {
        if let Ok(value) = config(app) {
            self.status.credential_saved = folder(app)
                .ok()
                .and_then(|dir| key_path(&dir, &value).ok())
                .is_some_and(|p| p.is_file());
            self.status.verification = value.verification.clone();
            self.status.configuration = value;
        }
        self.status.credential_pending = self.pending_key.is_some();
        self.status.clone()
    }
    pub fn stage_key(&mut self, key: Secret) {
        self.pending_key = Some(key);
    }
    pub fn begin_verification(&mut self, app: &AppHandle, grants: &Value) -> Result<(), String> {
        let mut cfg = config(app)?;
        cfg.verification = Some(verification(&cfg, grants)?);
        atomic(
            &folder(app)?.join("configuration.json"),
            &serde_json::to_vec(&cfg).map_err(|_| "TUNNEL_CONFIG_INVALID")?,
        )?;
        self.status.configuration = cfg;
        Ok(())
    }
    pub fn stop(&mut self) {
        if let Some(cancel) = self.diagnostic_cancel.take() {
            cancel.store(true, Ordering::SeqCst);
        }
        self.stop_connection();
    }
    /// A disabled background connection must not abort an explicitly requested, authorized doctor run.
    fn stop_connection(&mut self) {
        self.child.take();
        self.signature = None;
        self.status.ready = false;
        self.started = None;
    }
    pub fn retry(&mut self) {
        self.stop();
        self.policy.reset();
        self.next = None;
        self.blocked = false;
    }
    pub fn configure(
        &mut self,
        app: &AppHandle,
        cfg: Configuration,
        legacy_key_path: Option<String>,
        reuse_credential: bool,
        grants: &Value,
    ) -> Result<(), String> {
        let directory = folder(app)?;
        let previous = config(app)?;
        let imported = legacy_key_path
            .map(|path| -> Result<Secret, String> {
                let path = PathBuf::from(path);
                if !path.is_absolute() {
                    return Err("TUNNEL_KEY_PATH_REQUIRED".into());
                }
                if fs::metadata(&path).map_err(|_| "TUNNEL_KEY_MISSING")?.len() > 8192 {
                    return Err("TUNNEL_KEY_INVALID".into());
                }
                Secret::parse(fs::read_to_string(path).map_err(|_| "TUNNEL_KEY_INVALID")?)
            })
            .transpose()?;
        let next_key = imported.as_ref().or(self.pending_key.as_ref());
        let mut cfg = prepare_configuration(
            &directory,
            cfg,
            &previous,
            next_key.is_some(),
            reuse_credential,
            grants,
        )?;
        publish_configuration(&directory, &mut cfg, &previous, next_key)?;
        self.pending_key = None;
        self.status.configuration = cfg;
        self.retry();
        self.status.state = if self.status.configuration.enabled {
            "connecting"
        } else {
            "disabled"
        }
        .into();
        self.status.code = None;
        Ok(())
    }
    pub fn tick(&mut self, app: &AppHandle, status: &Value) {
        let cfg = match config(app) {
            Ok(v) => v,
            Err(code) => {
                self.stop();
                self.status.state = "blocked".into();
                self.status.code = Some(code);
                return;
            }
        };
        self.status.configuration = cfg.clone();
        if !cfg.enabled {
            self.stop_connection();
            if self.diagnostic_cancel.is_some() && target(app, &cfg, status).is_err() {
                self.stop();
            }
            self.status.state = "disabled".into();
            self.status.code = None;
            return;
        }
        let (port, bearer, signature) = match target(app, &cfg, status) {
            Ok(v) => v,
            Err(code) => {
                self.stop();
                self.status.state = "blocked".into();
                self.status.code = Some(code);
                return;
            }
        };
        if self.signature.as_ref().is_some_and(|v| v != &signature) {
            self.retry();
        }
        if self
            .child
            .as_ref()
            .is_some_and(|v| v.authentication_failed())
        {
            self.stop();
            self.blocked = true;
            self.status.code = Some("TUNNEL_AUTHENTICATION_FAILED".into());
        }
        if self.blocked {
            self.status.state = "blocked".into();
            return;
        }
        if self.child.as_mut().is_some_and(|v| v.exited()) {
            if self
                .child
                .as_ref()
                .is_some_and(|v| v.authentication_failed())
            {
                self.stop();
                self.blocked = true;
                self.status.state = "blocked".into();
                self.status.code = Some("TUNNEL_AUTHENTICATION_FAILED".into());
                return;
            }
            self.stop();
            self.policy.outage();
            self.next = self.policy.next_retry().map(|delay| Instant::now() + delay);
            if self.next.is_none() {
                self.blocked = true;
                self.status.code = Some("TUNNEL_RETRY_LIMIT".into());
                return;
            }
        }
        if self.child.is_none() {
            if self.next.is_some_and(|when| Instant::now() < when) {
                self.status.state = "recovering".into();
                return;
            }
            let start = (|| {
                let directory = folder(app)?;
                restrict(&directory)?;
                atomic(&directory.join("bearer.header"), bearer.as_bytes())?;
                let _ = fs::remove_file(directory.join("health.url"));
                let (mut child, _) = ManagedChild::spawn(&mut command(app, &cfg, port, "run")?)?;
                if child.exited() {
                    return Err("TUNNEL_START_FAILED".into());
                }
                Ok(child)
            })();
            match start {
                Ok(child) => {
                    self.child = Some(child);
                    self.signature = Some(signature);
                    self.started = Some(Instant::now());
                    self.next = None;
                    self.status.code = None;
                    self.status.state = "connecting".into();
                }
                Err(code) => {
                    self.blocked = true;
                    self.status.state = "blocked".into();
                    self.status.code = Some(code);
                }
            }
            return;
        }
        let ready = folder(app)
            .ok()
            .and_then(|dir| fs::read_to_string(dir.join("health.url")).ok())
            .and_then(|value| {
                let url = value.trim();
                let port = url
                    .strip_prefix("http://127.0.0.1:")?
                    .trim_end_matches('/')
                    .parse::<u16>()
                    .ok()?;
                blocking_client()
                    .ok()?
                    .get(format!("http://127.0.0.1:{port}/readyz"))
                    .send()
                    .ok()
                    .map(|r| r.status().is_success())
            })
            .unwrap_or(false);
        self.status.ready = ready;
        if ready {
            self.policy.healthy(self.epoch.elapsed());
            self.status.state = "ready".into();
        } else {
            self.policy.unhealthy();
            self.status.state = "connecting".into();
            if self
                .started
                .is_some_and(|v| v.elapsed() > Duration::from_secs(60))
            {
                self.stop();
                self.policy.outage();
                self.next = self.policy.next_retry().map(|delay| Instant::now() + delay);
                if self.next.is_none() {
                    self.blocked = true;
                    self.status.code = Some("TUNNEL_RETRY_LIMIT".into());
                }
            }
        }
    }
    pub fn start_diagnostic(
        &mut self,
        app: &AppHandle,
        status: &Value,
    ) -> Result<Diagnostic, String> {
        if let Some(previous) = self.diagnostic_cancel.take() {
            previous.store(true, Ordering::SeqCst);
        }
        let cfg = config(app)?;
        let (port, bearer, _) = target(app, &cfg, status)?;
        let directory = folder(app)?;
        restrict(&directory)?;
        atomic(&directory.join("bearer.header"), bearer.as_bytes())?;
        let mut cmd = command(app, &cfg, port, "doctor")?;
        cmd.arg("--explain");
        let (child, _) = ManagedChild::spawn(&mut cmd).map_err(|_| "TUNNEL_DIAGNOSTIC_FAILED")?;
        let cancel = Arc::new(AtomicBool::new(false));
        self.diagnostic_cancel = Some(cancel.clone());
        Ok(Diagnostic { child, cancel })
    }
}
/// Wait outside the manager lock so pause, retry and exit can cancel a diagnostic promptly.
pub struct Diagnostic {
    child: ManagedChild,
    cancel: Arc<AtomicBool>,
}
impl Diagnostic {
    pub fn run(mut self) -> Result<String, String> {
        let deadline = Instant::now() + Duration::from_secs(15);
        while !self.child.exited() && Instant::now() < deadline {
            if self.cancel.load(Ordering::SeqCst) {
                return Err("TUNNEL_DIAGNOSTIC_CANCELLED".into());
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        if !self.child.exited() {
            return Err("TUNNEL_DIAGNOSTIC_TIMEOUT".into());
        }
        // A completed configuration check is separate from /readyz or any real host acceptance.
        if self.child.authentication_failed() {
            return Err("TUNNEL_AUTHENTICATION_FAILED".into());
        }
        if !self.child.success() {
            return Err("TUNNEL_DIAGNOSTIC_FAILED".into());
        }
        Ok("TUNNEL_DIAGNOSTIC_COMPLETED".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn legacy_configuration_reuses_key_without_resetting_and_changed_tunnel_requires_consent() {
        let directory = tempfile::tempdir().unwrap();
        fs::write(
            directory.path().join("control-plane.key"),
            b"sk-synthetic-old",
        )
        .unwrap();
        let previous: Configuration =
            serde_json::from_str(r#"{"enabled":true,"tunnelId":"tunnel_old","clientId":"chosen"}"#)
                .unwrap();
        let grants =
            serde_json::json!({"clients":[{"id":"chosen","revoked":false,"credentialVersion":3}]});
        let restored = prepare_configuration(
            directory.path(),
            previous.clone(),
            &previous,
            false,
            false,
            &grants,
        )
        .unwrap();
        assert!(restored.key_file.is_none());
        assert_eq!(restored.verification.unwrap().credential_version, 3);
        let changed = Configuration {
            tunnel_id: "tunnel_new".into(),
            ..previous.clone()
        };
        assert_eq!(
            prepare_configuration(
                directory.path(),
                changed.clone(),
                &previous,
                false,
                false,
                &grants
            )
            .err()
            .unwrap(),
            "TUNNEL_KEY_REUSE_REQUIRED"
        );
        assert!(
            prepare_configuration(directory.path(), changed, &previous, false, true, &grants)
                .is_ok()
        );
        assert_eq!(
            fs::read(directory.path().join("control-plane.key")).unwrap(),
            b"sk-synthetic-old"
        );
        let invalid = Configuration {
            tunnel_id: "tunnel_".into(),
            ..previous.clone()
        };
        assert_eq!(
            prepare_configuration(directory.path(), invalid, &previous, true, false, &grants)
                .err()
                .unwrap(),
            "TUNNEL_CONFIG_INVALID"
        );
        assert!(key_path(
            directory.path(),
            &Configuration {
                key_file: Some("../outside.key".into()),
                ..previous
            }
        )
        .is_err());
    }
    #[test]
    fn rotation_publishes_complete_key_and_configuration_without_serializing_the_secret() {
        let directory = tempfile::tempdir().unwrap();
        let previous = Configuration::default();
        let mut cfg = Configuration {
            enabled: true,
            tunnel_id: "tunnel_synthetic".into(),
            client_id: "chosen".into(),
            ..previous.clone()
        };
        let key = Secret::parse("sk-synthetic-first".into()).unwrap();
        publish_configuration(directory.path(), &mut cfg, &previous, Some(&key)).unwrap();
        let old_path = key_path(directory.path(), &cfg).unwrap();
        assert_eq!(fs::read(&old_path).unwrap(), key.bytes());
        let first = cfg.clone();
        let replacement = Secret::parse("sk-synthetic-replacement".into()).unwrap();
        publish_configuration(directory.path(), &mut cfg, &first, Some(&replacement)).unwrap();
        assert!(!old_path.exists());
        let raw = fs::read_to_string(directory.path().join("configuration.json")).unwrap();
        assert!(!raw.contains("sk-synthetic"));
        let saved: Configuration = serde_json::from_str(&raw).unwrap();
        assert_eq!(
            fs::read(key_path(directory.path(), &saved).unwrap()).unwrap(),
            replacement.bytes()
        );
    }
    #[cfg(windows)]
    #[test]
    fn failed_rotation_preserves_old_pair_and_removes_unpublished_key() {
        use std::os::windows::fs::OpenOptionsExt;
        let directory = tempfile::tempdir().unwrap();
        let previous = Configuration::default();
        let mut cfg = Configuration {
            enabled: true,
            tunnel_id: "tunnel_synthetic".into(),
            client_id: "chosen".into(),
            ..previous.clone()
        };
        publish_configuration(
            directory.path(),
            &mut cfg,
            &previous,
            Some(&Secret::parse("sk-synthetic-first".into()).unwrap()),
        )
        .unwrap();
        let raw = fs::read(directory.path().join("configuration.json")).unwrap();
        let first = cfg.clone();
        let old_path = key_path(directory.path(), &first).unwrap();
        // A real Windows sharing violation forces configuration publication to fail after staging the new key.
        let held = fs::OpenOptions::new()
            .read(true)
            .share_mode(1)
            .open(directory.path().join("configuration.json"))
            .unwrap();
        assert_eq!(
            publish_configuration(
                directory.path(),
                &mut cfg,
                &first,
                Some(&Secret::parse("sk-synthetic-second".into()).unwrap())
            )
            .err()
            .unwrap(),
            "TUNNEL_CONFIG_WRITE_FAILED"
        );
        assert_eq!(
            fs::read(directory.path().join("configuration.json")).unwrap(),
            raw
        );
        assert_eq!(fs::read(old_path).unwrap(), b"sk-synthetic-first");
        assert_eq!(
            fs::read_dir(directory.path())
                .unwrap()
                .filter(|e| e
                    .as_ref()
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .starts_with("control-plane-"))
                .count(),
            1
        );
        drop(held);
    }
    #[cfg(windows)]
    use std::process::Stdio;
    #[test]
    fn background_disable_preserves_diagnostics_but_access_stop_cancels_them() {
        let cancel = Arc::new(AtomicBool::new(false));
        let mut manager = TunnelManager {
            diagnostic_cancel: Some(cancel.clone()),
            ..TunnelManager::default()
        };
        manager.stop_connection();
        assert!(!cancel.load(Ordering::SeqCst));
        manager.stop();
        assert!(cancel.load(Ordering::SeqCst));
    }
    /// A pre-existing explicit account grant must not survive credential-directory hardening.
    #[cfg(windows)]
    #[test]
    fn credential_acl_removes_other_explicit_grants_from_directory_and_existing_key() {
        use std::os::windows::process::CommandExt;
        let temporary = tempfile::tempdir().unwrap();
        let directory = temporary.path().join("synthetic-tunnel");
        fs::create_dir(&directory).unwrap();
        let key = directory.join("control-plane.key");
        fs::write(&key, b"synthetic-test-only").unwrap();
        for path in [&directory, &key] {
            assert!(Command::new(r"C:\Windows\System32\icacls.exe")
                .arg(path)
                .args(["/grant", "*S-1-5-32-546:R"])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .creation_flags(0x08000000)
                .status()
                .unwrap()
                .success());
        }
        restrict(&directory).unwrap();
        for path in [&directory, &key] {
            use std::os::windows::ffi::OsStrExt;
            use windows_sys::Win32::Security::*;
            let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
            // SAFETY: the descriptor buffer and returned DACL stay alive during the ACL query.
            unsafe {
                let mut needed = 0;
                GetFileSecurityW(
                    wide.as_ptr(),
                    DACL_SECURITY_INFORMATION,
                    std::ptr::null_mut(),
                    0,
                    &mut needed,
                );
                let mut bytes = vec![0u8; needed as usize];
                assert_ne!(
                    GetFileSecurityW(
                        wide.as_ptr(),
                        DACL_SECURITY_INFORMATION,
                        bytes.as_mut_ptr().cast(),
                        needed,
                        &mut needed
                    ),
                    0
                );
                let mut present = 0;
                let mut defaulted = 0;
                let mut acl = std::ptr::null_mut();
                assert_ne!(
                    GetSecurityDescriptorDacl(
                        bytes.as_mut_ptr().cast(),
                        &mut present,
                        &mut acl,
                        &mut defaulted
                    ),
                    0
                );
                assert_ne!(present, 0);
                assert!(!acl.is_null());
                let mut info: ACL_SIZE_INFORMATION = std::mem::zeroed();
                assert_ne!(
                    GetAclInformation(
                        acl,
                        (&mut info as *mut ACL_SIZE_INFORMATION).cast(),
                        std::mem::size_of_val(&info) as u32,
                        AclSizeInformation
                    ),
                    0
                );
                assert_eq!(info.AceCount, 1, "Unexpected ACL grant on {path:?}");
            }
        }
    }
    #[test]
    fn stopping_the_manager_cancels_an_owned_diagnostic_without_waiting_for_its_deadline() {
        let (child, _) =
            ManagedChild::spawn(Command::new("node").args(["-e", "setInterval(()=>{},1000)"]))
                .unwrap();
        let cancel = Arc::new(AtomicBool::new(false));
        let mut manager = TunnelManager {
            diagnostic_cancel: Some(cancel.clone()),
            ..TunnelManager::default()
        };
        let diagnostic = Diagnostic { child, cancel };
        let worker = std::thread::spawn(move || diagnostic.run());
        let started = Instant::now();
        manager.stop();
        assert_eq!(
            worker.join().unwrap().unwrap_err(),
            "TUNNEL_DIAGNOSTIC_CANCELLED"
        );
        assert!(started.elapsed() < Duration::from_secs(1));
    }
    #[test]
    fn pause_revocation_rotation_and_actual_port_control_the_target() {
        let cfg = Configuration {
            enabled: true,
            tunnel_id: "tunnel_synthetic".into(),
            client_id: "chosen".into(),
            ..Configuration::default()
        };
        let ready = serde_json::json!({"state":"ready","aiAccessPaused":false});
        let mut grants = serde_json::json!({"aiAccessPaused":false,"accessRevision":1,"clients":[{"id":"other","revoked":false,"token":"a".repeat(64)},{"id":"chosen","revoked":false,"token":"b".repeat(64),"credentialVersion":1}]});
        let original = select_target(&cfg, &ready, &grants, b"sk-synthetic", 3456).unwrap();
        assert_eq!(original.0, 3456);
        assert_eq!(original.1, format!("Bearer {}", "b".repeat(64)));
        grants["clients"][1]["revoked"] = true.into();
        assert_eq!(
            select_target(&cfg, &ready, &grants, b"sk-synthetic", 3456).unwrap_err(),
            "TUNNEL_GRANT_REVOKED"
        );
        grants["clients"][1]["revoked"] = false.into();
        grants["clients"][1]["credentialVersion"] = 2.into();
        assert_ne!(
            original.2,
            select_target(&cfg, &ready, &grants, b"sk-synthetic", 3456)
                .unwrap()
                .2
        );
        assert_ne!(
            original.2,
            select_target(&cfg, &ready, &grants, b"sk-synthetic", 3457)
                .unwrap()
                .2
        );
        grants["aiAccessPaused"] = true.into();
        assert_eq!(
            select_target(&cfg, &ready, &grants, b"sk-synthetic", 3456).unwrap_err(),
            "TUNNEL_ACCESS_PAUSED"
        );
    }
    #[test]
    fn unavailable_listener_is_not_reported_as_paused_authorization() {
        let cfg = Configuration {
            client_id: "chosen".into(),
            ..Configuration::default()
        };
        let grants = serde_json::json!({"aiAccessPaused":false,"clients":[{"id":"chosen","revoked":false,"token":"b".repeat(64)}]});
        for state in ["disabled", "error", "starting"] {
            let status = serde_json::json!({"state":state,"aiAccessPaused":false});
            assert_eq!(
                select_target(&cfg, &status, &grants, b"sk-synthetic", 3456).unwrap_err(),
                "TUNNEL_RUNTIME_UNAVAILABLE"
            );
        }
        let ready = serde_json::json!({"state":"ready","aiAccessPaused":false});
        assert_eq!(
            select_target(&cfg, &ready, &grants, b"sk-synthetic", 0).unwrap_err(),
            "TUNNEL_RUNTIME_UNAVAILABLE"
        );
    }
    #[test]
    fn run_and_diagnostic_arguments_use_file_credentials_and_loopback_only() {
        for action in ["run", "doctor"] {
            let cfg = Configuration {
                enabled: true,
                tunnel_id: "tunnel_synthetic".into(),
                client_id: "chosen".into(),
                ..Configuration::default()
            };
            let mut cmd = Command::new("verified-tunnel-client");
            configure_arguments(
                &mut cmd,
                Path::new("C:/synthetic 用户/tunnel"),
                &cfg,
                4321,
                action,
            );
            let args: Vec<String> = cmd
                .get_args()
                .map(|v| v.to_string_lossy().into_owned())
                .collect();
            assert_eq!(args[0], action);
            assert!(args.iter().any(|v| v == "http://127.0.0.1:4321/mcp"));
            for flag in [
                "--control-plane.api-key",
                "--mcp.extra-headers",
                "--mcp.discovery-extra-headers",
            ] {
                let index = args.iter().position(|v| v == flag).unwrap();
                assert!(args[index + 1].contains("file:"));
            }
            assert!(!args
                .iter()
                .any(|v| v.contains("sk-") || v.contains(&"b".repeat(64))));
        }
    }
}
