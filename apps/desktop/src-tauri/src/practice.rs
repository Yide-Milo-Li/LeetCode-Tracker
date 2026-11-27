//! A remote LeetCode view beside the trusted renderer. The renderer owns its lifetime and layout.
use reqwest::Url;
use serde::Deserialize;
use tauri::{
    webview::NewWindowResponse, AppHandle, Manager, PhysicalPosition, PhysicalSize, Rect,
    WebviewBuilder, WebviewUrl, WebviewWindowBuilder,
};

const LABEL: &str = "practice-page";
const SIGN_IN: &str = "practice-sign-in";

fn standard_https(url: &Url) -> bool {
    url.scheme() == "https"
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none()
}

fn leetcode(url: &Url) -> bool {
    standard_https(url) && matches!(url.host_str(), Some("leetcode.com" | "leetcode.cn"))
}

fn sign_in(url: &Url) -> bool {
    standard_https(url)
        && match url.host_str() {
            Some("leetcode.com" | "leetcode.cn") => url.path().starts_with("/accounts/"),
            Some("github.com") => {
                url.path() == "/login"
                    || url.path().starts_with("/login/")
                    || url.path().starts_with("/sessions/")
                    || url.path() == "/session"
            }
            Some("accounts.google.com") => true,
            _ => false,
        }
}

fn problem_slug(url: &Url) -> Option<&str> {
    let slug = url.path().strip_prefix("/problems/")?.split('/').next()?;
    (!slug.is_empty() && slug.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-'))
        .then_some(slug)
}

fn problem_url(value: &str) -> Result<Url, String> {
    let url = Url::parse(value).map_err(|_| "Invalid problem URL")?;
    if leetcode(&url) && problem_slug(&url).is_some() {
        Ok(url)
    } else {
        Err("Invalid problem URL".into())
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Viewport {
    // The page slot and the full renderer width, all measured in CSS pixels.
    width: f64,
    height: f64,
    viewport_width: f64,
}

impl Viewport {
    fn bounds(&self, size: PhysicalSize<u32>) -> Result<Rect, String> {
        if ![self.width, self.height, self.viewport_width]
            .iter()
            .all(|n| n.is_finite() && *n > 0.0)
            || self.width > self.viewport_width
        {
            return Err("Invalid practice layout".into());
        }
        // WebKit excludes the macOS title bar from its CSS viewport; the native parent can
        // extend underneath it. Width gives the CSS-to-device scale on both platforms. The
        // bottom of the page slot coincides with the bottom of the native client area.
        let scale = f64::from(size.width) / self.viewport_width;
        let width = (self.width * scale).round() as u32;
        let height = ((self.height * scale).round() as u32).min(size.height);
        Ok(Rect {
            position: PhysicalPosition::new(0, (size.height - height) as i32).into(),
            size: PhysicalSize::new(width.max(1), height.max(1)).into(),
        })
    }
}

#[tauri::command]
pub async fn practice_open(app: AppHandle, url: String, viewport: Viewport) -> Result<(), String> {
    let url = problem_url(&url)?;
    let main = app.get_webview("main").ok_or("Missing main view")?;
    let window = main.window();
    let bounds = viewport.bounds(window.inner_size().map_err(|e| e.to_string())?)?;
    close_views(&app)?;
    let popup_app = app.clone();
    let builder = WebviewBuilder::new(LABEL, WebviewUrl::External(url))
        .zoom_hotkeys_enabled(false)
        .on_new_window(move |target, features| {
            if !sign_in(&target) || popup_app.get_window(SIGN_IN).is_some() {
                return NewWindowResponse::Deny;
            }
            // WebKit needs the opener's window features for a federated sign-in callback.
            let popup =
                WebviewWindowBuilder::new(&popup_app, SIGN_IN, WebviewUrl::External(target))
                    .window_features(features)
                    .title("LeetCode")
                    .on_navigation(|next| leetcode(next) || sign_in(next))
                    .on_new_window(|_, _| NewWindowResponse::Deny)
                    .build();
            match popup {
                Ok(window) => NewWindowResponse::Create { window },
                Err(_) => NewWindowResponse::Deny,
            }
        })
        .on_navigation(move |next| {
            if next.origin().ascii_serialization() == "https://lct-shortcut.invalid" {
                match next.path() {
                    "/ask" => {
                        let _ = main.set_focus();
                        let _ = main.eval("window.dispatchEvent(new Event('lct-practice-shortcut'))");
                    }
                    "/larger" | "/smaller" | "/reset" => {
                        let direction = &next.path()[1..];
                        let _ = main.eval(format!("window.dispatchEvent(new CustomEvent('lct-practice-zoom', {{detail:'{direction}'}}))"));
                    }
                    _ => {}
                }
                return false;
            }
            leetcode(next) || sign_in(next)
        })
        // Only the explicit shortcut crosses views. Page contents, editor input and cookies stay on the site.
        .initialization_script(include_str!("practice-shortcut.js"));
    window
        .add_child(builder, bounds.position, bounds.size)
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn practice_layout(
    app: AppHandle,
    viewport: Option<Viewport>,
    focus_page: bool,
    zoom: Option<f64>,
) -> Result<(), String> {
    let view = app.get_webview(LABEL).ok_or("Practice page is closed")?;
    if let Some(zoom) = zoom {
        if !(0.8..=2.0).contains(&zoom) {
            return Err("Invalid page zoom".into());
        }
        view.set_zoom(zoom).map_err(|e| e.to_string())?;
    }
    if let Some(viewport) = viewport {
        let size = view.window().inner_size().map_err(|e| e.to_string())?;
        view.set_bounds(viewport.bounds(size)?)
            .map_err(|e| e.to_string())?;
        view.show().map_err(|e| e.to_string())?;
        if focus_page {
            view.set_focus().map_err(|e| e.to_string())?;
            view.eval("window.dispatchEvent(new Event('lct-practice-return'))")
                .map_err(|e| e.to_string())?;
        }
    } else {
        view.hide().map_err(|e| e.to_string())?;
        if let Some(main) = app.get_webview("main") {
            main.set_focus().map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Only the canonical problem link crosses the boundary, including after same-document navigation.
fn current_problem_link(url: &Url) -> Option<String> {
    if !leetcode(url) {
        return None;
    }
    Some(format!(
        "{}/problems/{}/",
        url.origin().ascii_serialization(),
        problem_slug(url)?
    ))
}

#[tauri::command]
pub async fn practice_location(app: AppHandle) -> Result<Option<String>, String> {
    let view = app.get_webview(LABEL).ok_or("Practice page is closed")?;
    let current = view.url().map_err(|e| e.to_string())?;
    Ok(current_problem_link(&current))
}

// The embedded WebDriver cannot target a child of a multi-webview window.
#[cfg(feature = "desktop-e2e")]
#[tauri::command]
pub async fn practice_test_history(app: AppHandle, back: bool) -> Result<(), String> {
    let view = app.get_webview(LABEL).ok_or("Practice page is closed")?;
    view.eval(if back {
        "history.back()"
    } else {
        "history.pushState(null, '', '/problems/add-two-numbers/description/')"
    })
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn practice_close(app: AppHandle) -> Result<(), String> {
    close_views(&app)
}

pub fn close_views(app: &AppHandle) -> Result<(), String> {
    if let Some(popup) = app.get_window(SIGN_IN) {
        popup.destroy().map_err(|e| e.to_string())?;
    }
    if let Some(view) = app.get_webview(LABEL) {
        view.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn location_exposes_only_a_trusted_problem_link() {
        for (url, expected) in [
            (
                "https://leetcode.cn/problems/two-sum/submissions/123/?from=x#code",
                Some("https://leetcode.cn/problems/two-sum/"),
            ),
            (
                "https://leetcode.com/accounts/login/?next=/problems/test/",
                None,
            ),
            ("https://leetcode.com.evil.test/problems/test/", None),
        ] {
            assert_eq!(
                current_problem_link(&Url::parse(url).unwrap()).as_deref(),
                expected
            );
        }
    }
    #[test]
    fn page_slot_stays_below_the_toolbar_with_or_without_window_chrome() {
        let slot = Viewport {
            width: 1200.0,
            height: 717.0,
            viewport_width: 1600.0,
        };
        for (parent_height, top) in [(1600, 166), (1536, 102)] {
            let bounds = slot.bounds(PhysicalSize::new(3200, parent_height)).unwrap();
            assert_eq!(
                bounds.position.to_physical::<i32>(2.0),
                PhysicalPosition::new(0, top)
            );
            assert_eq!(
                bounds.size.to_physical::<u32>(2.0),
                PhysicalSize::new(2400, 1434)
            );
        }
    }

    #[test]
    fn practice_starts_only_on_problem_pages() {
        for value in [
            "https://leetcode.com/problems/two-sum/",
            "https://leetcode.cn/problems/two-sum/description/",
        ] {
            assert!(problem_url(value).is_ok());
        }
        for value in [
            "https://leetcode.com/",
            "https://leetcode.com/problems/",
            "https://github.com/problems/test/",
            "https://leetcode.com.evil.test/problems/test/",
            "https://name@leetcode.com/problems/test/",
            "https://leetcode.com:8080/problems/test/",
            "http://leetcode.com/problems/test/",
        ] {
            assert!(problem_url(value).is_err());
        }
    }
}
