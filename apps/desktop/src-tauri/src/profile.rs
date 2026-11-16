//! Select isolated acceptance storage before Tauri initializes paths, WebViews or its instance lock.
use std::ffi::OsString;

const FLAG: &str = "--acceptance-profile";
const INVALID: &str = "Invalid acceptance profile; use --acceptance-profile followed by a lowercase name (1-48 letters, digits or single internal hyphens).";

#[derive(Debug, Default, PartialEq, Eq)]
pub struct LaunchProfile {
    acceptance_name: Option<String>,
}

impl LaunchProfile {
    /// Read arguments after the executable; malformed or repeated isolation flags fail closed.
    pub fn parse(args: impl IntoIterator<Item = OsString>) -> Result<Self, String> {
        let mut args = args.into_iter();
        let mut profile = Self::default();
        while let Some(arg) = args.next() {
            let value = if arg == FLAG {
                Some(args.next().ok_or(INVALID)?)
            } else if let Some(value) = arg
                .to_str()
                .and_then(|arg| arg.strip_prefix("--acceptance-profile="))
            {
                Some(OsString::from(value))
            } else {
                if arg.to_string_lossy().starts_with(FLAG) {
                    return Err(INVALID.into());
                }
                None
            };
            if let Some(value) = value {
                let name = value.to_str().ok_or(INVALID)?;
                if profile.acceptance_name.is_some() || !valid_name(name) {
                    return Err(INVALID.into());
                }
                profile.acceptance_name = Some(name.to_owned());
            }
        }
        Ok(profile)
    }

    /// A reserved identifier suffix isolates every app path and the native single-instance lock.
    pub fn identifier(&self, production: &str) -> String {
        match &self.acceptance_name {
            Some(name) => format!("{production}.acceptance.{name}"),
            None => production.to_owned(),
        }
    }

    pub fn is_acceptance(&self) -> bool {
        self.acceptance_name.is_some()
    }

    pub fn window_title(&self) -> String {
        match &self.acceptance_name {
            Some(name) => format!("LeetCode Tracker [Acceptance: {name}]"),
            None => "LeetCode Tracker".into(),
        }
    }
}

fn valid_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    (1..=48).contains(&bytes.len())
        && bytes[0].is_ascii_lowercase()
        && bytes.last().is_some_and(u8::is_ascii_alphanumeric)
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-')
        && !name.contains("--")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(args: &[&str]) -> Result<LaunchProfile, String> {
        LaunchProfile::parse(args.iter().map(OsString::from))
    }

    #[test]
    fn ordinary_and_background_launches_keep_the_production_identity() {
        for args in [vec![], vec!["--background"]] {
            let profile = parse(&args).unwrap();
            assert_eq!(
                profile.identifier("com.leetcodetracker.desktop"),
                "com.leetcodetracker.desktop"
            );
            assert_eq!(profile.window_title(), "LeetCode Tracker");
            assert!(!profile.is_acceptance());
        }
    }

    #[test]
    fn same_profile_restores_its_own_identity_and_other_profiles_never_share_it() {
        let a = parse(&["--acceptance-profile", "phase38-r3"]).unwrap();
        let restored = parse(&["--background", "--acceptance-profile=phase38-r3"]).unwrap();
        let b = parse(&["--acceptance-profile", "phase38-other"]).unwrap();
        assert_eq!(a, restored);
        assert_eq!(
            a.identifier("com.leetcodetracker.desktop"),
            "com.leetcodetracker.desktop.acceptance.phase38-r3"
        );
        assert_ne!(
            a.identifier("com.leetcodetracker.desktop"),
            b.identifier("com.leetcodetracker.desktop")
        );
        assert!(a.is_acceptance());
        assert!(a.window_title().contains("Acceptance: phase38-r3"));
    }

    #[test]
    fn malformed_names_cannot_select_a_path_or_fall_back_to_personal_storage() {
        for name in [
            "",
            "..",
            "../personal",
            r"C:\personal",
            "a/b",
            r"a\b",
            "a.b",
            "UPPER",
            "1start",
            "-start",
            "end-",
            "a--b",
            "a b",
            "a\n",
            "中文",
            &"a".repeat(49),
        ] {
            assert!(
                parse(&["--acceptance-profile", name]).is_err(),
                "accepted {name:?}"
            );
            assert!(parse(&[&format!("--acceptance-profile={name}")]).is_err());
        }
    }

    #[test]
    fn missing_repeated_and_mistyped_flags_fail_before_tauri_initialization() {
        for args in [
            vec!["--acceptance-profile"],
            vec!["--acceptance-profile", "--background"],
            vec!["--acceptance-profiles=test"],
            vec!["--acceptance-profile=a", "--acceptance-profile=a"],
            vec!["--acceptance-profile", "a", "--acceptance-profile=b"],
        ] {
            assert!(parse(&args).is_err());
        }
    }

    #[cfg(windows)]
    #[test]
    fn invalid_windows_unicode_cannot_fall_back_to_the_personal_profile() {
        use std::os::windows::ffi::OsStringExt;
        let invalid = OsString::from_wide(&[0xd800]);
        assert!(LaunchProfile::parse([OsString::from(FLAG), invalid]).is_err());
    }

    #[test]
    fn longest_supported_name_remains_valid_without_echoing_rejected_input() {
        assert!(parse(&["--acceptance-profile", &"a".repeat(48)]).is_ok());
        let error = parse(&["--acceptance-profile", "sk-secret-never-echo! "]).unwrap_err();
        assert!(!error.contains("sk-secret"));
    }
}
