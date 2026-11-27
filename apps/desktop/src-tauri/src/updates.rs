//! The renderer selects actions; the native host owns the feed, signature and downloaded bytes.
use std::sync::atomic::Ordering;
use std::time::Duration;

use serde::Serialize;
use tauri::{ipc::Channel, AppHandle, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};
use tokio::sync::Mutex;

use crate::{initialize_service, DesktopState};

#[derive(Default)]
pub struct DesktopUpdates(Mutex<Option<PendingUpdate>>);

struct PendingUpdate {
    release: Update,
    bytes: Option<Vec<u8>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    version: String,
    enabled: bool,
}

#[tauri::command]
pub fn desktop_update_info(app: AppHandle) -> UpdateInfo {
    let enabled = app
        .config()
        .plugins
        .0
        .get("updater")
        .and_then(|config| config["pubkey"].as_str())
        .is_some_and(|key| !key.is_empty());
    UpdateInfo {
        version: app.package_info().version.to_string(),
        enabled,
    }
}

#[tauri::command]
pub async fn check_desktop_update(app: AppHandle) -> Result<Option<String>, String> {
    if !desktop_update_info(app.clone()).enabled {
        return Err("Updates are unavailable in this build".into());
    }
    let updates = app.state::<DesktopUpdates>();
    let mut pending = updates
        .0
        .try_lock()
        .map_err(|_| "An update is in progress")?;
    let release = app
        .updater_builder()
        .timeout(Duration::from_secs(15))
        .configure_client(|client| {
            client
                .https_only(true)
                .connect_timeout(Duration::from_secs(10))
        })
        .build()
        .map_err(|err| err.to_string())?
        .check()
        .await
        .map_err(|err| err.to_string())?;
    let version = release.as_ref().map(|release| release.version.clone());
    if !pending.as_ref().is_some_and(|current| {
        current.bytes.is_some() && Some(&current.release.version) == version.as_ref()
    }) {
        *pending = release.map(|release| PendingUpdate {
            release,
            bytes: None,
        });
    }
    Ok(version)
}

#[tauri::command]
pub async fn download_desktop_update(app: AppHandle, progress: Channel<u8>) -> Result<(), String> {
    let updates = app.state::<DesktopUpdates>();
    let mut pending = updates
        .0
        .try_lock()
        .map_err(|_| "An update is in progress")?;
    let update = pending.as_mut().ok_or("Check for updates first")?;
    if update.bytes.is_some() {
        return Ok(());
    }
    let mut downloaded = 0;
    let mut last_percent = 0;
    let bytes = tokio::time::timeout(
        Duration::from_secs(15 * 60),
        update.release.download(
            |chunk, total| {
                downloaded += chunk as u64;
                if let Some(total) = total.filter(|&length| length > 0) {
                    let percent = ((downloaded * 100 / total).min(100)) as u8;
                    if percent > last_percent {
                        last_percent = percent;
                        let _ = progress.send(percent);
                    }
                }
            },
            || {},
        ),
    )
    .await
    .map_err(|_| "Update download timed out")?
    .map_err(|err| err.to_string())?;
    // The Updater only returns bytes after verifying the signature.
    update.bytes = Some(bytes);
    Ok(())
}

#[tauri::command]
pub async fn install_desktop_update(app: AppHandle) -> Result<(), String> {
    let updates = app.state::<DesktopUpdates>();
    let mut pending = updates
        .0
        .try_lock()
        .map_err(|_| "An update is in progress")?;
    if pending
        .as_ref()
        .and_then(|update| update.bytes.as_ref())
        .is_none()
    {
        return Err("Download the update first".into());
    }
    let update = pending.take().unwrap();
    let handle = app.clone();
    // Keep ownership across a failed install so retry can use the verified download.
    let (update, result) = tauri::async_runtime::spawn_blocking(move || {
        let result = install(&handle, &update);
        (update, result)
    })
    .await
    .map_err(|err| err.to_string())?;
    if result.is_err() {
        *pending = Some(update);
    }
    result
}

fn install(app: &AppHandle, update: &PendingUpdate) -> Result<(), String> {
    let state = app.state::<DesktopState>();
    if state.starting.load(Ordering::SeqCst) || state.exiting.swap(true, Ordering::SeqCst) {
        return Err("The local service is starting or closing".into());
    }
    state.installing_update.store(true, Ordering::SeqCst);
    let result = state.stop_service().and_then(|clean| {
        if !clean {
            return Err("The local service did not shut down cleanly".into());
        }
        update
            .release
            .install(update.bytes.as_ref().unwrap())
            .map_err(|err| err.to_string())
    });

    if result.is_err() {
        // If the installer could not start or replace the app, bring the existing session back.
        state.exiting.store(false, Ordering::SeqCst);
        initialize_service(app);
        state.installing_update.store(false, Ordering::SeqCst);
        #[cfg(windows)]
        if let Some(window) = app.get_window("main") {
            let _ = window.show();
        }
    } else {
        // On Windows a successful NSIS handoff exits here and the installer relaunches the app.
        app.request_restart();
    }
    result
}
