//! Validated native boundaries and atomic export replacement after dialog authorization.
use reqwest::Url;
use std::io::{self, Write};
use std::path::PathBuf;

/// Reject traversal/alternate origins before constructing a fixed loopback URL.
pub fn api_url(port: u16, path: &str) -> Result<Url, String> {
    // Search text in the query may contain encoded punctuation; only the path controls routing.
    let lower = path.split('?').next().unwrap_or(path).to_ascii_lowercase();
    if !path.starts_with("/api/v1/")
        || path.contains('\\')
        || path.contains('#')
        || path.chars().any(char::is_control)
        || lower.contains("%2e")
        || lower.contains("%2f")
        || lower.contains("%5c")
    {
        return Err("Invalid local API path".into());
    }
    let url =
        Url::parse(&format!("http://127.0.0.1:{port}{path}")).map_err(|_| "Invalid API URL")?;
    if !url.path().starts_with("/api/v1/") {
        return Err("API path escaped its namespace".into());
    }
    Ok(url)
}

/// Disk exports cannot retrieve settings or other non-export API payloads.
pub fn export_url(port: u16, path: &str) -> Result<Url, String> {
    let url = api_url(port, path)?;
    if matches!(
        url.path(),
        "/api/v1/export/obsidian-zip" | "/api/v1/export/notion-csv" | "/api/v1/bundle/export"
    ) || url.path().starts_with("/api/v1/export/markdown/")
    {
        Ok(url)
    } else {
        Err("Not an export endpoint".into())
    }
}

/// Validate parsed origins instead of trusting hostname prefixes.
pub fn external_url(value: &str) -> Result<Url, String> {
    if value.chars().any(char::is_control) {
        return Err("Invalid URL".into());
    }
    let url = Url::parse(value).map_err(|_| "Invalid URL")?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || !matches!(
            url.host_str(),
            Some("leetcode.com" | "leetcode.cn" | "github.com")
        )
    {
        return Err("External URL is not allowed".into());
    }
    Ok(url)
}

/// Filename suggestions cannot smuggle absolute or relative paths into the dialog.
pub fn validate_filename(name: &str) -> Result<(), String> {
    if name.is_empty()
        || name.len() > 180
        || name
            .chars()
            .any(|c| c.is_control() || "/\\:*?\"<>|".contains(c))
        || name.ends_with(['.', ' '])
    {
        return Err("Invalid suggested filename".into());
    }
    Ok(())
}

/// Drop removes incomplete output; existing sibling files are never reused.
pub struct AuthorizedSave {
    file: tempfile::NamedTempFile,
    destination: PathBuf,
}

impl AuthorizedSave {
    /// Only the native-dialog result supplies this path; it is not an IPC parameter.
    pub fn new(destination: PathBuf) -> Result<Self, String> {
        if !destination.is_absolute() {
            return Err("An absolute destination is required".into());
        }
        if let Ok(meta) = std::fs::symlink_metadata(&destination) {
            if meta.file_type().is_symlink() || meta.is_dir() {
                return Err("Select a regular destination file".into());
            }
        }
        let parent = destination.parent().ok_or("Missing parent directory")?;
        let file = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
        Ok(Self { file, destination })
    }
    /// Flush to disk, then atomically replace the selected destination, including on Windows.
    pub fn finish(self) -> Result<(), String> {
        self.file.as_file().sync_all().map_err(|e| e.to_string())?;
        self.file
            .persist(&self.destination)
            .map_err(|e| e.to_string())?;
        Ok(())
    }
}
impl Write for AuthorizedSave {
    /// Append a bounded chunk to the uniquely owned temporary file.
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.file.write(bytes)
    }
    /// Flush without publishing a partial destination.
    fn flush(&mut self) -> io::Result<()> {
        self.file.flush()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn origins_and_export_paths_are_constrained() {
        for url in [
            "https://leetcode.com.evil.test/",
            "https://leetcode.com@evil.test/",
            "javascript:alert(1)",
            "file:///C:/test",
            "https://github.com:1234/",
        ] {
            assert!(external_url(url).is_err(), "{url}");
        }
        // Query separators stay data passed to ShellExecuteW, never shell commands.
        assert!(external_url("https://leetcode.com/?a=1&b=2").is_ok());
        for path in [
            "/api/v1/../../secret",
            "/api/v1/%2e%2e/secret",
            "//evil.test/",
            "/api/v1/settings",
        ] {
            assert!(export_url(1234, path).is_err(), "{path}");
        }
        assert!(export_url(1234, "/api/v1/export/notion-csv?table=history").is_ok());
        assert!(api_url(1234, "/api/v1/problems?search=a%2Fb%2Ec%5Cd").is_ok());
        assert!(validate_filename("../output.zip").is_err());
    }
    #[test]
    fn failures_leave_destination_and_temp_siblings_untouched() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("notes.zip");
        let sibling = dir.path().join("notes.tmp");
        std::fs::write(&dest, b"old").unwrap();
        std::fs::write(&sibling, b"unrelated").unwrap();
        {
            let mut save = AuthorizedSave::new(dest.clone()).unwrap();
            save.write_all(b"partial").unwrap();
            // Dropping simulates a network/write failure before commit.
        }
        assert_eq!(std::fs::read(&dest).unwrap(), b"old");
        assert_eq!(std::fs::read(&sibling).unwrap(), b"unrelated");
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 2);
        let mut save = AuthorizedSave::new(dest.clone()).unwrap();
        save.write_all(b"complete").unwrap();
        save.finish().unwrap();
        assert_eq!(std::fs::read(dest).unwrap(), b"complete");
        assert_eq!(std::fs::read(sibling).unwrap(), b"unrelated");
    }
}
