# Device sync

Device sync moves your whole profile between any number of your own computers: catalog, practice records, progress snapshots, notes, strategies, daily plans, review state and portable settings. It is built on the same Snapshot Bundle v5 used by **Export migration file**, so the same guarantees apply: references are validated before writing, a safety backup is created before replacing data, and provider API keys never leave the device.

Device sync is unreleased. Automated tests cover the sync folder and a simulated Drive API. On macOS, live testing verified Google Drive with both a custom client and the bundled production client. See [implementation status](status.md) for the acceptance results.

## How it works

Sync is **one active device at a time** with **complete, immutable snapshots**:

1. On the device you used last, click **Publish this device** (Settings → Data → Device sync).
2. On whichever device you switch to next, open Settings → Data. It checks the remote store and offers **Receive _device_'s version**.
3. Preview the counts, confirm, and the app replaces local data after a safety backup, then reloads.

Each device also writes a small status file recording the snapshot it currently holds, so every device lists the others as "up to date" or "not on the latest version". Uploading is not reported as a completed handoff.

Nothing is merged automatically. If more than one version changed independently since the last sync (this device and another, or two other devices publishing before seeing each other), the panel reports a **fork**, lists every competing version, and asks you to choose:

| Choice | Effect |
|---|---|
| Keep this device's version | Publishes this device's data as the new latest snapshot. The competing versions stay in history. |
| Receive one of the listed versions → Archive mine | Uploads this device's data as a "fork archive" snapshot, then receives. |
| Receive one of the listed versions → Discard mine | Receives; this device's previous data is kept only in the local safety backup. |

Whichever version you pick becomes the single latest snapshot (it supersedes the others), so every other device simply sees "newer data available" afterwards. A device without local changes that finds several competing versions still has to pick one; time order is never used to decide.

**History** lists every snapshot. Restoring an older one goes through the same preview and then marks it as the latest version so other devices converge on it.

### What stays on each device

- AI provider API keys (`*_api_key`, `*_secret`, `*_token` settings).
- All `sync_*` settings: device id and name, sync method, folder path, last synced snapshot, Google OAuth client and refresh token.
- Browser-local UI state (sidebar state, first-run completion).

### Detecting local changes

The app hashes the business content of the database (row-order independent, excluding the device-local settings above) and compares it with the hash recorded at the last publish or receive. Any write counts as a change, including the daily plan Today creates when you open it on a new day. Receive on a device before you start using it to avoid forks.

## Option 1: Sync folder (Google Drive for desktop and others)

Use this when a file sync client already mirrors a folder on both computers, for example Google Drive for desktop (`G:\My Drive` on Windows, `~/Library/CloudStorage/GoogleDrive-…/My Drive` on macOS). No Google sign-in happens inside the app.

1. Settings → Data → Device sync → **Sync folder**.
2. Enter the absolute folder path (the desktop app also offers a folder picker) and **Save sync settings**.
3. Repeat on every other computer with the folder that mirrors the same location.

The app creates `LeetCodeTrackerSync/` inside the folder. Files are written to a hidden temporary name and then renamed. Conflict copies created by sync clients (for example `name (1).json`) and temporary files are ignored, and a snapshot whose data has not fully arrived is reported as "not finished syncing" instead of being received.

## Option 2: Google Drive (direct)

LCT stores snapshots in the hidden **app data folder** of your Google Drive using the non-sensitive `https://www.googleapis.com/auth/drive.appdata` scope. The app can access its own app data folder. The folder is hidden in the Drive web interface. [Google Drive app data](https://developers.google.com/workspace/drive/api/guides/appdata)

### Connect with the bundled client

In Settings → Data → Device sync, choose **Google Drive** and click **Connect Google Drive**. Select your account and grant access in the system browser. Return to LCT after the browser confirms the connection. LCT updates the status and checks for snapshots automatically. Repeat on each device with the same Google account and OAuth project. Publishing and receiving are separate actions.

### Use your own OAuth client

An existing custom client stays active after upgrading. Builds without a bundled client also support this setup.

1. Create a project in [Google Cloud Console](https://console.cloud.google.com/) and enable the **Google Drive API**.
2. In Google Auth Platform, configure **Branding**, choose **External** under **Audience** for personal Google accounts, and add `https://www.googleapis.com/auth/drive.appdata` under **Data Access**. In **Testing**, add your account as a test user. Use **In production** for ongoing use. Testing grants for Drive expire after seven days. [Google publishing status](https://support.google.com/cloud/answer/15549945?hl=en)
3. Under **Clients**, create an OAuth client of type **Desktop app**. LCT uses Google's loopback redirect on an automatically chosen local port. [Google desktop OAuth](https://developers.google.com/identity/protocols/oauth2/native-app)
4. In **Advanced OAuth settings**, enter the client ID and its desktop client secret if supplied, then **Save and use custom client** and connect. Use the same Google Cloud project on all devices. Source runs also accept `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET` in `.env`. An ID saved in Settings takes precedence.

To switch to the bundled client, use **Use the LCT OAuth client** in Advanced OAuth settings. The custom client settings remain saved so you can switch back. Switching to a different client ID requires consent again. Drive keeps separate histories for different Google Cloud projects. To start with your existing data under a new project, first receive the latest snapshot using your old client, then switch, authorize, and publish that device to the new app data folder.

LCT uses an installed-app loopback callback with PKCE and an expiring, single-use state. The refresh token stays in local SQLite settings, unencrypted and excluded from exports. **Disconnect** clears the local token and attempts to revoke the Google grant. Revoking the grant can require other devices on the same account and project to reconnect. [Google token revocation](https://developers.google.com/identity/protocols/oauth2/native-app#tokenrevoke)

### Configure the bundled client for distribution

Use a dedicated LCT production Google Cloud project with Drive API enabled and a **Desktop app** client. In Google Auth Platform, configure **External / In production** with the `drive.appdata` scope. Use a verified domain you own for the app homepage and privacy policy, and complete brand verification to display LCT's name and logo during consent. Google classifies `drive.appdata` as non-sensitive. [Production requirements](https://developers.google.com/identity/protocols/oauth2/production-readiness/policy-compliance) · [Brand verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/brand-verification)

For both installer builds, set `LCT_GOOGLE_DESKTOP_CLIENT_ID` and, if supplied, `LCT_GOOGLE_DESKTOP_CLIENT_SECRET` at build time. For the GitHub installer jobs triggered by pushes to `main` or `release/**`, set the ID as an Actions repository variable and the desktop client secret as an Actions repository secret. The settings are bundled into the sidecar, so the desktop client secret is extractable from the installer. Google treats installed apps as public OAuth clients. Use separate credentials for test builds. With no build-time ID, the installer offers custom client setup. [Google desktop OAuth](https://developers.google.com/identity/protocols/oauth2/native-app)

All installations using the bundled client share the project's Drive API quota. Google Workspace administrators can restrict access to the app. Users authorize their own account on each device and can be asked to reconnect if access is revoked or expires. [Drive API limits](https://developers.google.com/workspace/drive/api/guides/limits) · [Workspace app access](https://support.google.com/a/answer/7281227)

## Remote layout

Both options store the same flat set of files:

| File | Written by | Content |
|---|---|---|
| `snap-<createdAt>-<id>.ltsync.gz` | publishing device, once | gzip of `{ envelope, payload }` (payload = Snapshot Bundle v5) |
| `snap-<createdAt>-<id>.json` | publishing device, once, after the data file | envelope: parent, superseded heads, device, app version, bundle/schema version, content hash |
| `device-<id>.json` | that device only | snapshot it currently holds, last published and last received |

A receive verifies the gzip stream, that the embedded envelope matches the listed one, that the bundle version is supported, the content hash, and the bundle's table references, all before anything is replaced. A snapshot from a newer app version is listed but cannot be received or overwritten until this device is updated.

## Limits

- Not a live or merging sync; there is no limit on the number of devices, but edit on one at a time.
- Snapshots are full copies (up to the 64 MiB bundle limit, gzip-compressed). The app does not delete old snapshots yet.
- Requests from the desktop window time out after 60 seconds, which bounds very large uploads on slow connections.
- Snapshots are not encrypted by the app; they are protected by your Drive account or sync folder permissions.
