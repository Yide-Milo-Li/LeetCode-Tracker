# Device sync

Device sync moves your whole profile between any number of your own computers: catalog, practice records, progress snapshots, notes, strategies, daily plans, review state and portable settings. It is built on the same Snapshot Bundle v5 used by **Export migration file**, so the same guarantees apply: references are validated before writing, a safety backup is created before replacing data, and provider API keys never leave the device.

Status: unreleased. The feature is implemented in source and covered by synthetic tests (sync folder and a fake Google Drive). A real Google account round trip and installed-app acceptance on Windows and macOS have not been run yet.

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

The app talks to the Google Drive API itself and stores snapshots in the hidden **app data folder** of your Drive (scope `https://www.googleapis.com/auth/drive.appdata`). These files do not appear in the Drive web interface and the app cannot see any of your other Drive files. Google classifies this scope as non-sensitive, so the OAuth client does not need Google's app verification.

You provide your own OAuth client:

1. In the [Google Cloud console](https://console.cloud.google.com/), create a project and enable the **Google Drive API**.
2. Configure the OAuth consent screen (External), add yourself as a user, and set the publishing status to **In production**. In "Testing" status Google issues refresh tokens that expire after 7 days ([Google OAuth 2.0 documentation](https://developers.google.com/identity/protocols/oauth2)). Google shows an "unverified app" notice for your own client; that is expected.
3. Create credentials → **OAuth client ID** → application type **Desktop app**. Google documents that the secret of an installed app is not treated as confidential.
4. In the app: Settings → Data → Device sync → **Google Drive**, paste the client ID (and secret), then **Connect Google Drive**. Approve in the browser; the tab confirms when the app has stored access. Click **Check**.
5. Repeat on every other computer with the same Google account. The same client ID can be reused.

For source runs you can instead set `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET` in `.env`; values saved in Settings take precedence.

Sign-in uses the installed-app loopback flow with PKCE: the redirect goes to `http://127.0.0.1:<port>/api/v1/sync/google/callback` on the local server. That route is the only one reachable without the desktop session header; it accepts a single-use `state` that expires after ten minutes. The refresh token is stored in the local SQLite settings like API keys (unencrypted, never exported). **Disconnect** revokes it and removes it.

If Google rejects the stored token (revoked, expired, or a Testing-status client), the panel shows **Reconnect Google Drive**.

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
