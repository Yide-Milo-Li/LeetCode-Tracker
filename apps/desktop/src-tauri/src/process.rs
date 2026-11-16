//! Owned sidecar processes: bounded startup, drained pipes and graceful shutdown before forced exit.
use std::io::{BufRead, BufReader, Read, Write};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
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

/// A newly created Windows process stays suspended until its Job owns all future descendants.
#[cfg(windows)]
fn resume_owned_process(child: &Child) -> Result<(), String> {
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use windows_sys::Win32::{
        Foundation::INVALID_HANDLE_VALUE,
        System::{Diagnostics::ToolHelp::*, Threading::*},
    };
    // SAFETY: each native handle is owned once; the snapshot entry is initialized to its documented size.
    unsafe {
        let raw = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
        if raw == INVALID_HANDLE_VALUE {
            return Err("Could not enumerate suspended process threads".into());
        }
        let snapshot = OwnedHandle::from_raw_handle(raw);
        let mut entry: THREADENTRY32 = std::mem::zeroed();
        entry.dwSize = std::mem::size_of_val(&entry) as u32;
        let mut available = Thread32First(snapshot.as_raw_handle(), &mut entry) != 0;
        while available {
            if entry.th32OwnerProcessID == child.id() {
                let raw = OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID);
                if raw.is_null() {
                    return Err("Could not open suspended process thread".into());
                }
                let thread = OwnedHandle::from_raw_handle(raw);
                if ResumeThread(thread.as_raw_handle()) != 1 {
                    return Err("Could not resume owned process".into());
                }
                return Ok(());
            }
            available = Thread32Next(snapshot.as_raw_handle(), &mut entry) != 0;
        }
        Err("Suspended process thread is unavailable".into())
    }
}

/// Owns the child until it exits; dropping an unfinished startup also reaps its process.
pub struct ManagedChild {
    child: Child,
    auth_failed: Arc<AtomicBool>,
    diagnostics: Option<std::thread::JoinHandle<()>>,
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
            command.creation_flags(0x08000000 | 0x00000004); // CREATE_NO_WINDOW | CREATE_SUSPENDED
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
        #[cfg(windows)]
        if let Err(error) = resume_owned_process(&child) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
        let stdout = child.stdout.take().ok_or("Missing sidecar stdout")?;
        let stderr = child.stderr.take().ok_or("Missing sidecar stderr")?;
        let auth_failed = Arc::new(AtomicBool::new(false));
        let diagnostic_flag = auth_failed.clone();
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
        let diagnostics = std::thread::spawn(move || {
            // Retain only a boolean classification; raw diagnostics and credentials are never recorded.
            let mut reader = BufReader::new(stderr);
            let mut buffer = [0u8; 4096];
            let mut tail = String::new();
            while let Ok(size) = reader.read(&mut buffer) {
                if size == 0 {
                    break;
                }
                let text = (tail + &String::from_utf8_lossy(&buffer[..size])).to_ascii_lowercase();
                if [
                    "unauthorized",
                    "invalid_api_key",
                    "permission_denied",
                    "status=401",
                    "status=403",
                    "status_code=401",
                    "status_code=403",
                ]
                .iter()
                .any(|marker| text.contains(marker))
                {
                    diagnostic_flag.store(true, Ordering::SeqCst);
                }
                tail = text
                    .chars()
                    .rev()
                    .take(64)
                    .collect::<String>()
                    .chars()
                    .rev()
                    .collect();
            }
        });
        Ok((
            Self {
                child,
                auth_failed,
                diagnostics: Some(diagnostics),
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
        let exited = self
            .child
            .try_wait()
            .map_or(true, |status| status.is_some());
        // A reaped child's stderr must be classified before deciding whether to retry it.
        if exited {
            let deadline = Instant::now() + Duration::from_millis(20);
            while self
                .diagnostics
                .as_ref()
                .is_some_and(|reader| !reader.is_finished())
                && Instant::now() < deadline
            {
                std::thread::sleep(Duration::from_millis(1));
            }
            if self
                .diagnostics
                .as_ref()
                .is_some_and(|reader| reader.is_finished())
            {
                let _ = self.diagnostics.take().unwrap().join();
            }
        }
        exited
    }
    pub fn authentication_failed(&self) -> bool {
        self.auth_failed.load(Ordering::SeqCst)
    }
    pub fn success(&mut self) -> bool {
        self.child
            .try_wait()
            .ok()
            .flatten()
            .is_some_and(|status| status.success())
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
    if message["type"] == "error" {
        if message["code"] == "DATABASE_IN_USE" {
            return Err("DATABASE_IN_USE".into());
        }
        let err = message["error"].as_str().unwrap_or("Sidecar error");
        return Err(format!("Sidecar initialization error: {err}"));
    }
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

    /// A fast child may spawn immediately; containment must precede its first instruction.
    #[cfg(windows)]
    #[test]
    fn dropping_a_managed_process_terminates_its_immediate_descendant() {
        use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
        use windows_sys::Win32::{Foundation::WAIT_OBJECT_0, System::Threading::*};
        let (child, ready) = node("const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); console.log(c.pid);setInterval(()=>{},1000);");
        let pid = ready
            .recv_timeout(Duration::from_secs(3))
            .unwrap()
            .unwrap()
            .trim()
            .parse::<u32>()
            .unwrap();
        // SAFETY: the descendant process handle is owned once and retained while the Job is dropped.
        unsafe {
            let raw = OpenProcess(0x00100000, 0, pid); // SYNCHRONIZE
            assert!(!raw.is_null());
            let descendant = OwnedHandle::from_raw_handle(raw);
            drop(child);
            assert_eq!(
                WaitForSingleObject(descendant.as_raw_handle(), 3000),
                WAIT_OBJECT_0
            );
        }
    }

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
            "mcpConfigPath":install.join("mcp-config.json"),
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
    fn typed_database_conflict_does_not_depend_on_diagnostic_wording() {
        let (tx, rx) = mpsc::channel();
        tx.send(Ok(serde_json::json!({"type":"error","code":"DATABASE_IN_USE","error":"arbitrary diagnostic"}).to_string())).unwrap();
        assert_eq!(
            wait_ready(rx, "test", Duration::from_secs(1)).unwrap_err(),
            "DATABASE_IN_USE"
        );
    }

    #[test]
    fn noisy_stderr_and_post_ready_stdout_do_not_block_the_sidecar() {
        let (mut child, ready) = node(
            "process.stderr.write('diagnostic'.repeat(20000)); console.log(JSON.stringify({type:'ready',nonce:'test',protocolVersion:1,port:1234})); process.stdout.write('extra'.repeat(50000)); process.stdin.once('data',()=>process.exit(0));",
        );
        wait_ready(ready, "test", Duration::from_secs(5)).unwrap();
        assert!(child.shutdown(Duration::from_secs(5)).unwrap());
    }

    #[test]
    fn authentication_failure_is_classified_across_chunks_before_exit() {
        let (mut child,ready)=node("console.log(JSON.stringify({type:'ready',nonce:'test',protocolVersion:1,port:1234}));process.stderr.write('x'.repeat(4094)+'unauth');setTimeout(()=>process.stderr.write('orized synthetic diagnostic'),10);setTimeout(()=>process.exit(1),30);");
        wait_ready(ready, "test", Duration::from_secs(5)).unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while !child.exited() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(child.exited());
        assert!(child.authentication_failed());
        assert!(!child.success());
    }

    #[test]
    fn sidecar_error_message_is_propagated() {
        let (tx, rx) = mpsc::channel();
        tx.send(Ok(
            serde_json::json!({"type":"error","error":"Database is locked by another process"})
                .to_string(),
        ))
        .unwrap();
        let err = wait_ready(rx, "test", Duration::from_secs(1)).unwrap_err();
        assert!(err.contains("Database is locked by another process"));
    }
}
