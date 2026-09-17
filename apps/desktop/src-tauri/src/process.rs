//! Owned sidecar processes: bounded startup, drained pipes and graceful shutdown before forced exit.
use std::io::{BufRead, BufReader, Read, Write};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::time::{Duration, Instant};

pub type ReadyReceiver = Receiver<Result<String, String>>;

/// Preserve resolved resource identity while avoiding verbatim paths Node cannot use as entrypoints.
pub fn node_command(executable: &Path, script: &Path) -> Command {
    // Tauri canonicalizes Windows paths to \\?\ form. Simplify only when Win32 semantics are equivalent;
    // do not strip prefixes blindly or fall back to searching PATH or the working directory.
    let mut command = Command::new(dunce::simplified(executable));
    command.arg(dunce::simplified(script));
    command
}

/// The OS closes this handle after crashes; ordinary exits retain it until the child has drained.
#[cfg(windows)]
struct Job {
    _handle: std::os::windows::io::OwnedHandle,
}

#[cfg(windows)]
impl Job {
    /// Fail closed if containment could not be established; never advertise an unchecked guarantee.
    fn attach(child: &Child) -> Result<Self, String> {
        use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
        use windows_sys::Win32::System::JobObjects::*;
        // SAFETY: null attributes/name are allowed; the returned handle is owned exactly once.
        unsafe {
            let raw = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if raw.is_null() {
                return Err(std::io::Error::last_os_error().to_string());
            }
            let owned = OwnedHandle::from_raw_handle(raw);
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(
                raw,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const _,
                std::mem::size_of_val(&info) as u32,
            ) == 0
                || AssignProcessToJobObject(raw, child.as_raw_handle()) == 0
            {
                return Err(std::io::Error::last_os_error().to_string());
            }
            Ok(Self { _handle: owned })
        }
    }
}

/// Owns the child until it exits; dropping an unfinished startup also reaps its process.
pub struct ManagedChild {
    child: Child,
    #[cfg(windows)]
    _job: Job,
}

impl ManagedChild {
    /// Spawn without a console, retain ownership, and drain output even after the ready line.
    pub fn spawn(command: &mut Command) -> Result<(Self, ReadyReceiver), String> {
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }
        let mut child = command.spawn().map_err(|e| e.to_string())?;
        #[cfg(windows)]
        let job = match Job::attach(&child) {
            Ok(job) => job,
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error);
            }
        };
        let stdout = child.stdout.take().ok_or("Missing sidecar stdout")?;
        let stderr = child.stderr.take().ok_or("Missing sidecar stderr")?;
        let (sender, receiver) = mpsc::channel();
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            let mut line = Vec::new();
            // Bound the allocation before parsing untrusted/broken protocol output.
            let result = reader
                .by_ref()
                .take(8193)
                .read_until(b'\n', &mut line)
                .map_err(|_| "Could not read sidecar readiness".to_string())
                .and_then(|_| {
                    if line.len() > 8192 || !line.ends_with(b"\n") {
                        Err("Invalid or oversized sidecar readiness message".to_string())
                    } else {
                        String::from_utf8(line).map_err(|_| "Invalid readiness encoding".into())
                    }
                });
            let _ = sender.send(result);
            let _ = std::io::copy(&mut reader, &mut std::io::sink());
        });
        std::thread::spawn(move || {
            // Raw provider diagnostics can contain credentials; drain without recording payloads.
            let _ = std::io::copy(&mut BufReader::new(stderr), &mut std::io::sink());
        });
        Ok((
            Self {
                child,
                #[cfg(windows)]
                _job: job,
            },
            receiver,
        ))
    }

    /// Send a bounded JSON control message over the inherited private pipe.
    pub fn send(&mut self, message: &serde_json::Value) -> Result<(), String> {
        let input = self.child.stdin.as_mut().ok_or("Sidecar input is closed")?;
        writeln!(input, "{message}")
            .and_then(|_| input.flush())
            .map_err(|e| e.to_string())
    }

    /// Reap a terminated child while allowing callers to detect unexpected exits.
    pub fn exited(&mut self) -> bool {
        self.child
            .try_wait()
            .map_or(true, |status| status.is_some())
    }

    /// Return true for a clean exit; allow outstanding writes to finish before a bounded forced kill.
    pub fn shutdown(&mut self, timeout: Duration) -> Result<bool, String> {
        let _ = self.send(&serde_json::json!({"type":"shutdown"}));
        self.child.stdin.take();
        let deadline = Instant::now() + timeout;
        loop {
            if let Some(status) = self.child.try_wait().map_err(|e| e.to_string())? {
                return Ok(status.success());
            }
            if Instant::now() >= deadline {
                self.child.kill().map_err(|e| e.to_string())?;
                self.child.wait().map_err(|e| e.to_string())?;
                return Ok(false);
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}

impl Drop for ManagedChild {
    /// Failed startup and application teardown must not leave an unmanaged process behind.
    fn drop(&mut self) {
        if !self.exited() {
            let _ = self.child.kill();
        }
        let _ = self.child.wait();
    }
}

/// Validate protocol identity and port within a deadline; never echo raw child output to the UI.
pub fn wait_ready(receiver: ReadyReceiver, nonce: &str, timeout: Duration) -> Result<u16, String> {
    let line = receiver
        .recv_timeout(timeout)
        .map_err(|_| "Sidecar startup timed out or stopped".to_string())??;
    let message: serde_json::Value =
        serde_json::from_str(&line).map_err(|_| "Invalid sidecar ready message")?;
    if message["type"] != "ready" || message["nonce"] != nonce || message["protocolVersion"] != 1 {
        return Err("Sidecar initialization failed or protocol mismatch".into());
    }
    message["port"]
        .as_u64()
        .and_then(|p| u16::try_from(p).ok())
        .filter(|p| *p != 0)
        .ok_or_else(|| "Invalid sidecar port".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Exercise the pinned private runtime under canonical Unicode paths on both supported hosts.
    #[cfg(any(windows, target_os = "macos"))]
    #[test]
    fn canonical_resource_paths_start_the_private_bundle() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"));
        let runtime = root
            .join(if cfg!(windows) {
                "binaries/node-x86_64-pc-windows-msvc.exe"
            } else {
                "binaries/node-aarch64-apple-darwin"
            })
            .canonicalize()
            .unwrap();
        let temporary = tempfile::tempdir().unwrap();
        let install = temporary.path().join("安装目录 with spaces");
        std::fs::create_dir(&install).unwrap();
        let script = install.join("desktop-server.mjs");
        std::fs::copy(root.join("../../server/dist/desktop-server.mjs"), &script).unwrap();
        // Tauri resource_dir canonicalizes the executable and returns a verbatim Windows path.
        let script = script.canonicalize().unwrap();
        let mut command = node_command(&runtime, &script);
        command.current_dir(&install);
        command.env_remove("NODE_OPTIONS").env_remove("NODE_PATH");
        let (mut child, ready) = ManagedChild::spawn(&mut command).unwrap();
        let nonce = "synthetic-resource-nonce-1234567890";
        let token = "synthetic-resource-token-1234567890";
        child
            .send(&serde_json::json!({"protocolVersion":1,"port":0,
            "dbPath":install.join("test.sqlite"),"backupDir":install.join("backups"),
            "sessionSecret":token,"nonce":nonce}))
            .unwrap();
        let port = wait_ready(ready, nonce, Duration::from_secs(10)).unwrap();
        let response = reqwest::blocking::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(3))
            .build()
            .unwrap()
            .get(format!("http://127.0.0.1:{port}/api/v1/health"))
            .header("x-desktop-session-token", token)
            .send()
            .unwrap();
        assert!(response.status().is_success());
        assert!(child.shutdown(Duration::from_secs(5)).unwrap());
    }

    /// Spawn only synthetic local Node programs, never the user's application or database.
    fn node(script: &str) -> (ManagedChild, ReadyReceiver) {
        ManagedChild::spawn(Command::new("node").arg("-e").arg(script)).unwrap()
    }

    #[test]
    fn shutdown_waits_for_an_inflight_write() {
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("finished.txt");
        let script = format!(
            r#"console.log(JSON.stringify({{type:'ready',nonce:'test',protocolVersion:1,port:1234}}));
            process.stdin.once('data',()=>setTimeout(()=>{{require('fs').writeFileSync({},'finished');process.exit(0)}},200));"#,
            serde_json::to_string(&marker).unwrap()
        );
        let (mut child, ready) = node(&script);
        wait_ready(ready, "test", Duration::from_secs(5)).unwrap();
        assert!(child.shutdown(Duration::from_secs(5)).unwrap());
        assert_eq!(std::fs::read_to_string(marker).unwrap(), "finished");
    }

    #[test]
    fn startup_and_shutdown_timeouts_reap_unresponsive_children() {
        let (mut child, ready) = node("setInterval(()=>{},1000)");
        assert!(wait_ready(ready, "test", Duration::from_millis(100)).is_err());
        assert!(!child.shutdown(Duration::from_millis(100)).unwrap());
        assert!(child.exited());
    }

    #[test]
    fn bad_identity_and_out_of_range_ports_are_rejected() {
        for value in [
            serde_json::json!({"type":"ready","nonce":"wrong","protocolVersion":1,"port":1234}),
            serde_json::json!({"type":"ready","nonce":"test","protocolVersion":1,"port":65536}),
        ] {
            let (tx, rx) = mpsc::channel();
            tx.send(Ok(value.to_string())).unwrap();
            assert!(wait_ready(rx, "test", Duration::from_secs(1)).is_err());
        }
    }

    #[test]
    fn noisy_stderr_and_post_ready_stdout_do_not_block_the_sidecar() {
        let (mut child, ready) = node(
            "process.stderr.write('diagnostic'.repeat(20000)); console.log(JSON.stringify({type:'ready',nonce:'test',protocolVersion:1,port:1234})); process.stdout.write('extra'.repeat(50000)); process.stdin.once('data',()=>process.exit(0));",
        );
        wait_ready(ready, "test", Duration::from_secs(5)).unwrap();
        assert!(child.shutdown(Duration::from_secs(5)).unwrap());
    }
}
