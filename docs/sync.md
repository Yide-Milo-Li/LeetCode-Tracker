# Device sync

Device sync moves your whole profile between any number of your own computers: catalog, practice records, progress snapshots, notes, strategies, daily plans, review state and portable settings. It is built on the same Snapshot Bundle v5 used by **Export migration file**, so the same guarantees apply: references are validated before writing, a safety backup is created before replacing data, and provider API keys never leave the device.

Device sync is available starting with 1.4.0. Automated tests cover the sync folder and a simulated Drive API. See [implementation status](status.md) for the macOS and Windows live acceptance results and candidate revisions.

## How it works

Sync is **one active device at a time** with **complete, immutable snapshots**:

1. Open Settings → Sync on the device you edited. An established Google Drive device with unpublished changes can show **Check and publish**. It reads Drive when you click and offers conflict choices if another device published first. Choose **Check** to inspect Drive without uploading. For a first publish, choose **Publish this device**.
2. Open Settings → Sync on the device you switch to next. A device with no unpublished changes checks automatically and offers **Receive _device_'s version** when an update is available.
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

### Automatic sync

Under **Settings → Sync**, turn on **Automatic sync** and save. The setting applies to this device and works with either sync method.

- Opening the app, returning to it or reconnecting to the network checks for updates. If there is a newer snapshot or a conflict, the app links to Sync for review.
- Once this device has published or received its first snapshot, saved edits are batched until 30 seconds after the last save. A fresh check must find that this device is the only one ahead before the app publishes.
- With direct Google Drive, automatic checks start at most once per five minutes per running app. A batch of saved edits waits for that interval if needed, and publishing reuses the check. Folder sync uses the local folder and leaves file transfer to your file sync client.

First publishes, receiving and conflict resolution require confirmation. Use **Check** or **Publish this device** to act immediately, including before switching devices. If you quit with saved edits waiting, the next launch can publish them. An interrupted Drive upload can be resumed from Sync with the original snapshot and its saved upload state.

Publishing captures a snapshot before starting the upload. You can continue recording practice or editing notes during the transfer. New saves stay local until a later publish. With Automatic sync enabled, they are queued for the next eligible check.

### What stays on each device

- AI provider API keys (`*_api_key`, `*_secret`, `*_token` settings).
- All `sync_*` settings: device id and name, sync method, folder path, last synced snapshot, Google OAuth client and refresh token.
- Browser-local UI state (sidebar state, first-run completion).

### Detecting local changes

The app hashes the business content of the database (row-order independent, excluding the device-local settings above) and compares it with the hash recorded at the last publish or receive. Any write counts as a change, including the daily plan Today creates when you open it on a new day. Receive on a device before you start using it to avoid forks.

## Option 1: Sync folder (Google Drive for desktop and others)

Use this when a file sync client already mirrors a folder on both computers, for example Google Drive for desktop (`G:\My Drive` on Windows, `~/Library/CloudStorage/GoogleDrive-…/My Drive` on macOS). No Google sign-in happens inside the app.

1. Settings → Sync → **Sync folder**.
2. Enter the absolute folder path (the desktop app also offers a folder picker) and **Save sync settings**.
3. Repeat on every other computer with the folder that mirrors the same location.

The app creates `LeetCodeTrackerSync/` inside the folder. Files are written to a hidden temporary name and then renamed. Conflict copies created by sync clients (for example `name (1).json`) and temporary files are ignored, and a snapshot whose data has not fully arrived is reported as "not finished syncing" instead of being received.

## Option 2: Google Drive (direct)

LCT stores snapshots in the hidden **app data folder** of your Google Drive using the non-sensitive `https://www.googleapis.com/auth/drive.appdata` scope. The app can access its own app data folder. The folder is hidden in the Drive web interface. [Google Drive app data](https://developers.google.com/workspace/drive/api/guides/appdata)

### Official installer

In Settings → Sync, choose **Google Drive** and click **Connect Google Drive**. The installer uses LCT's production Desktop OAuth client. Select your own Google account and grant access in the system browser. Return to LCT after the browser confirms the connection. LCT updates the status and checks for snapshots automatically. Repeat on each device with the same Google account. Publishing and receiving are separate actions.

If you previously used a custom client, the installer asks you to reconnect when it cannot associate your grant with LCT's client. Different Google Cloud projects have separate Drive snapshot histories, even for the same account. To bring an old project's data across, receive the desired snapshot with the old client before upgrading. If the data is in a separate source profile, export it there and preview and import the bundle in the installer. Verify the local data before publishing it to the new project. Connecting alone leaves both histories intact.

### Source checkout

1. Create a project in [Google Cloud Console](https://console.cloud.google.com/) and enable the **Google Drive API**.
2. In Google Auth Platform, configure **Branding**, choose **External** under **Audience** for personal Google accounts, and add `https://www.googleapis.com/auth/drive.appdata` under **Data Access**. In **Testing**, add your account as a test user. Use **In production** for ongoing use. Testing grants for Drive expire after seven days. [Google publishing status](https://support.google.com/cloud/answer/15549945?hl=en)
3. Under **Clients**, create an OAuth client of type **Desktop app**. LCT uses Google's loopback redirect on an automatically chosen local port. [Google desktop OAuth](https://developers.google.com/identity/protocols/oauth2/native-app)
4. Under **Settings → Sync → Google Drive → Developer OAuth settings**, enter the client ID and its desktop client secret if supplied, then **Save and use custom client** and connect. Alternatively, set `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET` in the checkout's `.env` and restart the source server. An ID saved in Settings takes precedence. Use the same Google Cloud project on devices that share snapshots.

LCT uses an installed-app loopback callback with PKCE and an expiring, single-use state. The refresh token stays in local SQLite settings, unencrypted and excluded from exports. **Disconnect** clears the local token and attempts to revoke the Google grant. Revoking the grant can require other devices on the same account and project to reconnect. [Google token revocation](https://developers.google.com/identity/protocols/oauth2/native-app#tokenrevoke)

### Interrupted Drive sync

If a publish is interrupted, reopen **Settings → Sync** and choose **Resume previous publish**. LCT uploads the snapshot captured when you first clicked publish. Edits made afterwards stay on this device as unpublished changes. A large upload continues from the last byte Drive confirms. If the session expired, LCT restarts the same file using its reserved ID.

Drive requests back off with jitter on rate limits, temporary server errors and network failures. The installation honors Google's `Retry-After` and shares the cooldown across its active connection. If the wait would exceed the remaining request time, the app returns control so you can retry later.

### Loading snapshot history on a new device

Every check lists the files in the connected account’s app data folder. A publisher includes a copy of each snapshot envelope and device acknowledgement in the corresponding Drive file’s description. A new device verifies this JSON against Drive’s SHA-256 checksum, checks its identity against the filename, and builds the full history from the listing. It downloads the selected snapshot payload when you preview a receive. Overlapping checks on one installation share a listing.

For older snapshots, the first upgraded device can use its local SQLite cache or download the missing envelopes. When a check or history view finds at least eight verified envelopes missing from the Drive descriptions, it groups them into small index files in the same app data folder. Later checks fill in any remaining entries and include new snapshots from older publishers. Each check spends up to three seconds and eight writes on this optional work. Another device can then read those envelopes in its own listing. A missing or stale hint falls back to the local cache or original envelope. Each listed snapshot is checked individually, so deleted snapshots disappear and competing versions stay visible.

In the simulated Drive test, a new device with 100 current or fully indexed snapshots makes one account lookup and one single-page listing, with zero file downloads. Larger histories can require additional listing pages. Local caches, pending upload bytes and upload sessions are isolated by account and OAuth project and excluded from migration exports.

When publishing or receiving, a device updates its acknowledgement by ID if the listing shows one matching file and this installation has already confirmed that ID for the connected account and project. A missing, replaced, or duplicate file triggers a lookup by name.

### Small changes between devices

Each Drive publish still uploads a complete snapshot. For an ordinary publish, the sender can also attach up to 4 KiB of row changes to the data file’s description in the same upload. A single-row edit can carry just the changed part of a long text field. The sender compares against the previous snapshot saved locally for this account and OAuth project. The cache holds one compressed base per account and project. After an upgrade, the next successful publish or receive establishes that base.

A device with no unpublished edits can catch up on as many as eight consecutive small publishes using the hints in one Drive listing. Starting from the snapshot it last received or published, it reconstructs each version in memory. Each step checks the parent identity, the description checksum, the listed data file’s SHA-256, the payload size and the content hashes, then validates the reconstructed profile. Only the selected version is previewed. Confirming creates a safety backup and applies that version once.

New devices and devices with unpublished edits download the selected full snapshot. The receiver also downloads that snapshot if it is more than eight versions away, the history forks, or any required file or hint is missing or fails validation. Older clients can continue reading the same full snapshots.

When a clean device checks Drive and finds one compatible update, it remembers the selected version for up to one minute. If it can reconstruct that version, clicking **Receive** opens the prepared preview. If it needs the full snapshot, including on a new device, clicking **Receive** downloads the file by its listed ID and verifies the snapshot ID and content hash before opening the preview. Opening settings alone does not download the payload.

An expired check, changed sync settings or local edits require a fresh listing. For full downloads, the receiver also refreshes the listing if snapshot filenames were ambiguous or the remembered file ID is missing. The app checks the local data again when confirming the preview.

Confirming an update acknowledges exactly the version shown. If another device publishes a newer version in the meantime, that version stays available for the next check. A detected fork asks you to choose again. **History → Restore** still lets you deliberately make an older version current.

In the simulated Drive test, both established devices open settings, the sender chooses **Check and publish**, and the receiver opens the update within a minute. The complete publish and receive uses two single-page listings (one per device), four writes and one ID reservation. A small edit requires zero media downloads. A full snapshot requires one media download. Choosing **Check** separately on the sender adds one listing. Devices with a pending publish, a known fork or unreadable metadata still check on open.

### Configure the bundled client for distribution

Use a dedicated LCT production Google Cloud project with Drive API enabled and a **Desktop app** client. In Google Auth Platform, configure **External / In production** with the `drive.appdata` scope. Use a verified domain you own for the app homepage and privacy policy, and complete brand verification to display LCT's name and logo during consent. Google classifies `drive.appdata` as non-sensitive. [Production requirements](https://developers.google.com/identity/protocols/oauth2/production-readiness/policy-compliance) · [Brand verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/brand-verification)

Store `LCT_GOOGLE_DESKTOP_CLIENT_ID` and `LCT_GOOGLE_DESKTOP_CLIENT_SECRET` as GitHub Actions repository secrets. The hosted Windows and macOS packaging steps select `LCT_DESKTOP_DISTRIBUTION=official` on pushes to `main`, `release/**` and version tags. Both credentials are required before those jobs can produce an installer. Source runs and pull-request checks use developer mode. Google treats installed apps as public OAuth clients, and the bundled desktop client secret is extractable from the installer. [Google desktop OAuth](https://developers.google.com/identity/protocols/oauth2/native-app)

All installations using the bundled client share the project's Drive API quota. Google Workspace administrators can restrict access to the app. Users authorize their own account on each device and can be asked to reconnect if access is revoked or expires. [Drive API limits](https://developers.google.com/workspace/drive/api/guides/limits) · [Workspace app access](https://support.google.com/a/answer/7281227)

## Remote layout

Both options store the same flat set of files:

| File | Written by | Content |
|---|---|---|
| `snap-<createdAt>-<id>.ltsync.gz` | publishing device, once | gzip of `{ envelope, payload }` (payload = Snapshot Bundle v5) |
| `snap-<createdAt>-<id>.json` | publishing device, once, after the data file | envelope: parent, superseded heads, device, app version, bundle/schema version, content hash |
| `device-<id>.json` | that device only | snapshot it currently holds, last published and last received |

Direct Drive sync can also create `lct-history-cache-v1-<hash>.json` files. Their descriptions hold copies of older envelopes. Older apps ignore them.

A receive verifies the gzip stream, that the embedded envelope matches the listed one, that the bundle version is supported, the content hash, and the bundle's table references, all before anything is replaced. If an envelope, bundle or schema version is too new for this device, the app lists the incompatible snapshot and blocks receiving or superseding it. The producer app version is displayed for reference.

## Limits

- Not a live or merging sync; there is no limit on the number of devices, but edit on one at a time.
- Snapshots are full copies (up to the 64 MiB bundle limit, gzip-compressed). The app does not delete old snapshots yet.
- The desktop window allows 60 seconds per request. Drive operations budget 55 seconds for network work. Uploads over 5 MiB use resumable sessions with 2 MiB chunks.
- Snapshots are not encrypted by the app; they are protected by your Drive account or sync folder permissions.
