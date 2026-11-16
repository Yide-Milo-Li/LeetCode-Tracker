//! Password entry stays in a native dialog; IPC returns only whether a key was accepted.
pub struct Secret(String);

impl Secret {
    /// Validate locally without logging or returning the supplied credential in an error.
    pub fn parse(value: String) -> Result<Self, String> {
        let mut secret = Self(value);
        let trimmed = secret.0.trim();
        if trimmed.len() > 8192
            || !trimmed.starts_with("sk-")
            || trimmed.len() <= 3
            || trimmed.chars().any(|c| c.is_whitespace() || c.is_control())
        {
            return Err("TUNNEL_KEY_INVALID".into());
        }
        if trimmed.len() != secret.0.len() {
            let normalized = trimmed.to_owned();
            secret = Self(normalized);
        }
        Ok(secret)
    }

    pub fn bytes(&self) -> &[u8] {
        self.0.as_bytes()
    }
}

impl Drop for Secret {
    fn drop(&mut self) {
        // SAFETY: no references escape this owner; zero is valid UTF-8 and volatile stores survive optimization.
        unsafe {
            for byte in self.0.as_bytes_mut() {
                std::ptr::write_volatile(byte, 0);
            }
        }
    }
}

#[cfg(windows)]
pub fn prompt(
    parent: windows_sys::Win32::Foundation::HWND,
    zh: bool,
) -> Result<Option<Secret>, String> {
    use windows_sys::Win32::{
        Foundation::*,
        UI::{Input::KeyboardAndMouse::SetFocus, WindowsAndMessaging::*},
    };
    struct Context {
        key: Option<Secret>,
        zh: bool,
    }
    /// The dialog owns the edit control until EndDialog; only this callback reads its contents.
    unsafe extern "system" fn callback(hwnd: HWND, message: u32, w: WPARAM, l: LPARAM) -> isize {
        unsafe {
            if message == WM_INITDIALOG {
                SetWindowLongPtrW(hwnd, (2 * std::mem::size_of::<isize>()) as i32, l);
                SendDlgItemMessageW(hwnd, 100, 0x00C5, 8192, 0); // EM_SETLIMITTEXT
                SetFocus(GetDlgItem(hwnd, 100));
                return 0;
            }
            if message == WM_CLOSE || (message == WM_COMMAND && (w & 0xffff) == IDCANCEL as usize) {
                EndDialog(hwnd, IDCANCEL as isize);
                return 1;
            }
            if message == WM_COMMAND && (w & 0xffff) == IDOK as usize {
                let context =
                    &mut *(GetWindowLongPtrW(hwnd, (2 * std::mem::size_of::<isize>()) as i32)
                        as *mut Context);
                let edit = GetDlgItem(hwnd, 100);
                let length = GetWindowTextLengthW(edit);
                let mut buffer = vec![0u16; length.max(0) as usize + 1];
                let count = GetWindowTextW(edit, buffer.as_mut_ptr(), buffer.len() as i32);
                let text = String::from_utf16(&buffer[..count.max(0) as usize]);
                for word in &mut buffer {
                    std::ptr::write_volatile(word, 0);
                }
                match text
                    .map_err(|_| "TUNNEL_KEY_INVALID".to_owned())
                    .and_then(Secret::parse)
                {
                    Ok(key) => {
                        context.key = Some(key);
                        SetWindowTextW(edit, [0u16].as_ptr());
                        EndDialog(hwnd, IDOK as isize);
                    }
                    Err(_) => {
                        let error: Vec<u16> = if context.zh {
                            "密钥应以 sk- 开头，且不含空格。请检查后重试。"
                        } else {
                            "Use a key starting with sk-, without spaces. Check it and try again."
                        }
                        .encode_utf16()
                        .chain(Some(0))
                        .collect();
                        SetDlgItemTextW(hwnd, 101, error.as_ptr());
                        SetFocus(edit);
                    }
                }
                return 1;
            }
            0
        }
    }
    fn string(words: &mut Vec<u16>, value: &str) {
        words.extend(value.encode_utf16().chain(Some(0)));
    }
    fn dword(words: &mut Vec<u16>, value: u32) {
        words.extend([value as u16, (value >> 16) as u16]);
    }
    #[allow(clippy::too_many_arguments)]
    fn item(
        words: &mut Vec<u16>,
        style: u32,
        x: u16,
        y: u16,
        cx: u16,
        cy: u16,
        id: u16,
        class: u16,
        text: &str,
    ) {
        if !words.len().is_multiple_of(2) {
            words.push(0);
        }
        dword(words, style | WS_CHILD | WS_VISIBLE);
        dword(words, 0);
        words.extend([x, y, cx, cy, id, 0xffff, class]);
        string(words, text);
        words.push(0);
    }
    let mut words = Vec::new();
    dword(
        &mut words,
        WS_POPUP
            | WS_CAPTION
            | WS_SYSMENU
            | DS_MODALFRAME as u32
            | DS_SETFONT as u32
            | DS_CENTER as u32,
    );
    dword(&mut words, 0);
    words.extend([5, 0, 0, 340, 130, 0, 0]);
    string(
        &mut words,
        if zh {
            "ChatGPT Tunnel 运行密钥"
        } else {
            "ChatGPT Tunnel runtime key"
        },
    );
    words.push(9);
    string(&mut words, "Segoe UI");
    item(
        &mut words,
        0,
        12,
        12,
        316,
        28,
        102,
        0x82,
        if zh {
            "粘贴对应组织的运行密钥。点击确定暂存，回到 LCT 保存后生效。"
        } else {
            "Paste the runtime key for the intended organization. Accept to stage it, then save the connection in LCT."
        },
    );
    item(
        &mut words,
        WS_TABSTOP | WS_BORDER | ES_PASSWORD as u32 | ES_AUTOHSCROLL as u32,
        12,
        45,
        316,
        16,
        100,
        0x81,
        "",
    );
    item(&mut words, 0, 12, 66, 316, 25, 101, 0x82, "");
    item(
        &mut words,
        WS_TABSTOP | BS_DEFPUSHBUTTON as u32,
        211,
        100,
        55,
        18,
        IDOK as u16,
        0x80,
        if zh { "确定" } else { "Accept" },
    );
    item(
        &mut words,
        WS_TABSTOP,
        273,
        100,
        55,
        18,
        IDCANCEL as u16,
        0x80,
        if zh { "取消" } else { "Cancel" },
    );
    // DLGTEMPLATE and every control require DWORD alignment, including the allocation itself.
    if !words.len().is_multiple_of(2) {
        words.push(0);
    }
    let aligned: Vec<u32> = words
        .as_chunks::<2>()
        .0
        .iter()
        .map(|v| v[0] as u32 | ((v[1] as u32) << 16))
        .collect();
    let mut context = Context { key: None, zh };
    // SAFETY: the template and Context remain alive through the synchronous modal message loop.
    let result = unsafe {
        DialogBoxIndirectParamW(
            std::ptr::null_mut(),
            aligned.as_ptr().cast(),
            parent,
            Some(callback),
            &mut context as *mut Context as isize,
        )
    };
    if result == -1 || result == 0 {
        return Err("TUNNEL_KEY_DIALOG_FAILED".into());
    }
    Ok(context.key)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validation_returns_safe_errors_and_normalizes_edge_whitespace() {
        assert_eq!(
            Secret::parse("  sk-synthetic-only\r\n".into())
                .unwrap()
                .bytes(),
            b"sk-synthetic-only"
        );
        for value in ["sk-", "token", "sk-two words", "sk-a\0b"] {
            assert_eq!(
                Secret::parse(value.into()).err().unwrap(),
                "TUNNEL_KEY_INVALID"
            );
        }
    }
}
