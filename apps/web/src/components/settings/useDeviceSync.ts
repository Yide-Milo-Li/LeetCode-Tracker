/**
 * Device sync state for the Settings "Sync" tab: configuration drafts, status, publish,
 * preview-then-receive and Google Drive connection.
 *
 * Owned by `SettingsView` so a pending receive preview survives switching Settings tabs.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type SyncReceivePreview, type SyncSnapshotSummary, type SyncStatus, type SyncTransportKind } from '../../api.ts';
import { openExternalUrl, pickFolder } from '../../platform/index.ts';
import { clearPracticeIntents } from '../../practice-service.ts';
import type { Language } from '../../i18n.ts';
import { localizeApiError } from '../../error-i18n.ts';
import { useWorkspace } from '../../workspace.tsx';

/** Error codes with dedicated copy; other failures fall back to the server message. */
const SYNC_ERROR_COPY: Record<string, { en: string; zh: string }> = {
  SYNC_FORK: { en: 'More than one device changed data since the last sync. Choose which version to keep.', zh: '上次同步后有多台设备各自修改了数据，请选择保留哪一份。' },
  SYNC_REMOTE_AHEAD: { en: 'Another device published newer data. Receive the latest snapshot first.', zh: '其他设备发布了更新的数据，请先接收最新快照。' },
  SYNC_LOCAL_CHANGES: { en: 'This device has unpublished changes. Choose to archive or discard them.', zh: '本机有未发布的修改，请选择归档或丢弃。' },
  SYNC_INCOMPATIBLE: { en: 'This snapshot was made by a newer app version. Update this app first.', zh: '该快照来自更新的应用版本，请先升级本机应用。' },
  SYNC_CORRUPT: { en: 'The snapshot is incomplete or damaged. Wait for your sync client to finish, or pick another snapshot.', zh: '快照不完整或已损坏。请等待同步客户端完成，或选择其他快照。' },
  SYNC_INVALID_DATA: { en: 'The snapshot is intact but its data failed validation. Update all devices to the same app version.', zh: '快照完整，但其中的数据未通过校验。请把所有设备更新到同一应用版本。' },
  SYNC_NOT_READY: { en: 'The snapshot has not finished downloading to this device yet.', zh: '快照尚未完整下载到本机。' },
  SYNC_PREVIEW_EXPIRED: { en: 'The preview expired. Preview the snapshot again.', zh: '预览已过期，请重新预览。' },
  SYNC_UPDATE_CHANGED: { en: 'The available update changed. Choose a version from the refreshed list.', zh: '可接收的更新已变化，请从刷新后的列表选择版本。' },
  SYNC_PREVIEW_STALE: { en: 'Local data changed after you opened the preview. Preview the snapshot again.', zh: '打开预览后，本机数据已更改。请重新预览此快照。' },
  SYNC_RECONNECT_REQUIRED: { en: 'Google Drive access expired or was revoked. Connect again.', zh: 'Google Drive 授权已过期或被撤销，请重新连接。' },
  SYNC_INVALID_FOLDER: { en: 'Enter an existing folder with an absolute path.', zh: '请填写一个已存在文件夹的绝对路径。' },
  SYNC_FOLDER_REQUIRED: { en: 'Choose a sync folder first.', zh: '请先选择同步文件夹。' },
  SYNC_CONFIG_CHANGED: { en: 'Sync settings changed. Try again.', zh: '同步设置已更改，请重试。' },
  SYNC_GOOGLE_CLIENT_MANAGED: { en: 'This installation uses the LCT OAuth client.', zh: '此安装版使用 LCT 官方 OAuth 客户端。' },
  SYNC_GOOGLE_CLIENT_REQUIRED: { en: 'Enter your Google OAuth client ID first.', zh: '请先填写 Google OAuth 客户端 ID。' },
};

// Match the loopback authorization window and check promptly when returning from the browser.
const GOOGLE_AUTH_TIMEOUT_MS = 10 * 60 * 1000;
const GOOGLE_AUTH_CHECK_MS = 3_000;

/** An established Drive sender can use the fresh listing already required by a normal publish. */
function canCheckOnPublish(status: SyncStatus): boolean {
  return status.transport === 'gdrive' && status.configured && status.google.connected && !status.google.reconnectRequired
    && status.baseSnapshotId !== null && status.localDirty && !status.pendingPublish
    && (status.classification === null || status.classification === 'local-ahead')
    && status.unreadableFiles === 0 && status.heads.every(head => head.compatible);
}

/**
 * Load sync status the first time `active` turns true (the Sync tab opens) and expose the actions
 * behind the sync panel.
 *
 * Side effects: a successful receive notifies the workspace, clears practice intents and reloads
 * the page, like a migration bundle restore.
 */
export function useDeviceSync(lang: Language, active: boolean) {
  const workspace = useWorkspace();
  const zh = lang === 'zh';
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [preview, setPreview] = useState<SyncReceivePreview | null>(null);
  const [history, setHistory] = useState<SyncSnapshotSummary[] | null>(null);
  const [transportDraft, setTransportDraft] = useState<SyncTransportKind>('none');
  const [folderDraft, setFolderDraft] = useState('');
  const [deviceNameDraft, setDeviceNameDraft] = useState('');
  const [clientIdDraft, setClientIdDraft] = useState('');
  const [clientSecretDraft, setClientSecretDraft] = useState('');
  const [googleAuthDeadline, setGoogleAuthDeadline] = useState<number | null>(null);
  /** One publish intent keeps its operation ID until a response confirms the result. */
  const publishOperation = useRef<{ key: string; id: string } | null>(null);

  const describe = useCallback((err: unknown, fallback: string) => {
    const code = (err as { code?: string })?.code;
    const copy = code ? SYNC_ERROR_COPY[code] : undefined;
    if (!copy) return localizeApiError(err, lang, fallback);
    const text = zh ? copy.zh : copy.en;
    // Validation failures name the offending field; keep it visible for diagnosis.
    const detail = code === 'SYNC_INVALID_DATA' && err instanceof Error ? ` (${err.message})` : '';
    return text + detail;
  }, [lang, zh]);

  const applyStatus = useCallback((next: SyncStatus, syncDrafts = false) => {
    setStatus(next);
    if (syncDrafts) {
      setTransportDraft(next.transport);
      setFolderDraft(next.folderPath ?? '');
      setDeviceNameDraft(next.deviceName);
    }
  }, []);

  /** Run one action at a time and surface failures inline. */
  const run = useCallback(async <T,>(name: string, action: () => Promise<T>, fallback: string): Promise<T | undefined> => {
    setBusy(name);
    setError('');
    setNotice('');
    try {
      return await action();
    } catch (err) {
      setError(describe(err, fallback));
      return undefined;
    } finally {
      setBusy(null);
    }
  }, [describe]);

  const loaded = useRef(false);
  useEffect(() => {
    if (!active || loaded.current) return;
    let current = true;
    api.getSyncStatus()
      .then(async (initial) => {
        if (!current) return;
        const deferCheck = canCheckOnPublish(initial);
        // Until the sender checks Drive, show its local edits and the time of its last check.
        applyStatus(deferCheck ? { ...initial, classification: null, heads: [], devices: [] } : initial, true);
        if (initial.configured && !deferCheck) {
          const checked = await api.checkSync().catch(() => null);
          if (current && checked) applyStatus(checked);
        }
        if (current) loaded.current = true;
      })
      .catch((err) => {
        if (current) setError(describe(err, zh ? '无法读取同步状态。' : 'Could not load sync status.'));
      });
    return () => { current = false; };
  }, [active]);

  const check = useCallback(async () => {
    const next = await run('check', () => api.checkSync(), zh ? '检查同步失败。' : 'Sync check failed.');
    if (next) applyStatus(next);
  }, [applyStatus, run, zh]);

  useEffect(() => {
    if (!active || busy || googleAuthDeadline === null) return;
    const deadline = googleAuthDeadline;
    let cancelled = false;
    let reading = false;

    async function refreshGoogleStatus() {
      if (reading || document.visibilityState === 'hidden') return;
      reading = true;
      try {
        const next = await api.getSyncStatus();
        if (cancelled) return;
        if (next.transport === 'gdrive' && next.google.connected && !next.google.reconnectRequired) {
          applyStatus(next);
          setGoogleAuthDeadline(null);
          void check();
          return;
        }
      } catch {
        // A transient local status read can be retried while authorization is pending.
      } finally {
        reading = false;
      }
      if (!cancelled && Date.now() >= deadline) {
        setGoogleAuthDeadline(null);
        setNotice(zh ? 'Google 授权未完成，请重新连接。' : 'Google sign-in did not finish. Connect again to retry.');
      }
    }

    const refresh = () => void refreshGoogleStatus();
    const timer = window.setInterval(refresh, GOOGLE_AUTH_CHECK_MS);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    refresh();
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [active, applyStatus, busy, check, googleAuthDeadline, zh]);

  async function saveConfig() {
    const next = await run('config', () => api.configureSync({
      transport: transportDraft,
      ...(transportDraft === 'folder' && folderDraft.trim() ? { folderPath: folderDraft.trim() } : {}),
      ...(deviceNameDraft.trim() ? { deviceName: deviceNameDraft.trim() } : {}),
    }), zh ? '保存同步设置失败。' : 'Could not save sync settings.');
    if (!next) return;
    applyStatus(next, true);
    if (next.transport !== 'gdrive') setGoogleAuthDeadline(null);
    setPreview(null);
    setHistory(null);
    if (next.configured) await check();
    else setNotice(zh ? '同步设置已保存。' : 'Sync settings saved.');
  }

  async function chooseFolder() {
    const folder = await pickFolder().catch(() => null);
    if (folder) setFolderDraft(folder);
  }

  async function publish(allowFork = false, resumeId?: string) {
    const key = JSON.stringify({ allowFork });
    if (publishOperation.current?.key !== key) publishOperation.current = { key, id: crypto.randomUUID() };
    const operationId = resumeId ?? publishOperation.current.id;
    const result = await run('publish', () => api.publishSync({ operationId, allowFork }), zh ? '发布快照失败。' : 'Publishing failed.');
    if (!result) {
      const next = await api.getSyncStatus().catch(() => null);
      if (next) applyStatus(next);
      return;
    }
    publishOperation.current = null;
    setNotice(result.published
      ? (zh ? '快照已上传。各设备接收后会在下方显示为“已是最新”。' : 'Snapshot uploaded. Each device shows as up to date below once it receives it.')
      : (zh ? '没有新的修改需要发布。' : 'Nothing new to publish.'));
    if (result.warning) setError(result.warning);
    const next = await api.getSyncStatus().catch(() => null);
    if (next) applyStatus(next);
  }

  async function startPreview(snapshotId: string, updateOnly?: boolean) {
    const result = await run('preview', async () => {
      try {
        return await api.previewSyncReceive(snapshotId, updateOnly);
      } catch (cause) {
        if ((cause as { code?: string })?.code === 'SYNC_UPDATE_CHANGED') {
          setPreview(null);
          const next = await api.getSyncStatus().catch(() => null);
          if (next) applyStatus(next);
        }
        throw cause;
      }
    }, zh ? '读取快照失败。' : 'Could not read the snapshot.');
    if (result) setPreview(result);
  }

  async function confirmReceive(localChanges?: 'fork' | 'discard') {
    if (!preview) return;
    const result = await run('receive', async () => {
      try {
        return await api.receiveSync({ previewId: preview.previewId, ...(localChanges ? { localChanges } : {}) });
      } catch (cause) {
        const code = (cause as { code?: string })?.code;
        if (code === 'SYNC_PREVIEW_STALE' || code === 'SYNC_PREVIEW_EXPIRED' || code === 'SYNC_UPDATE_CHANGED') {
          setPreview(current => current?.previewId === preview.previewId ? null : current);
          const next = await api.getSyncStatus().catch(() => null);
          if (next) applyStatus(next);
        }
        throw cause;
      }
    }, zh ? '接收失败，本机数据未更改。' : 'Receive failed; this device was not changed.');
    if (!result) return;
    setPreview(null);
    setNotice(zh ? `已接收。安全备份：${result.safetyBackupPath}` : `Received. Safety backup: ${result.safetyBackupPath}`);
    workspace.notifyMutation();
    clearPracticeIntents();
    // Reload drops stale workspace drafts and reapplies received language/theme settings.
    window.location.reload();
  }

  async function loadHistory() {
    const result = await run('history', () => api.getSyncHistory(), zh ? '读取历史失败。' : 'Could not load history.');
    if (result) setHistory(result.items);
  }

  async function saveGoogleClient() {
    const clientId = clientIdDraft.trim();
    const clientSecret = clientSecretDraft.trim();
    const next = await run('config', () => api.configureSync({
      transport: 'gdrive',
      ...(clientId ? { googleClientId: clientId } : {}),
      ...(clientSecret ? { googleClientSecret: clientSecret } : {}),
    }), zh ? '无法保存 OAuth 客户端。' : 'Could not save the OAuth client.');
    if (!next) return;
    applyStatus(next);
    setClientIdDraft('');
    setClientSecretDraft('');
    setGoogleAuthDeadline(null);
    setPreview(null);
    setHistory(null);
    publishOperation.current = null;
    if (next.configured) await check();
    else setNotice(zh ? '客户端已保存。请连接 Google Drive。' : 'OAuth client saved. Connect Google Drive to continue.');
  }

  async function connectGoogle() {
    setGoogleAuthDeadline(null);
    const result = await run('connect', async () => {
      if (status?.transport !== 'gdrive') {
        const next = await api.configureSync({ transport: 'gdrive' });
        applyStatus(next);
        setPreview(null);
        setHistory(null);
        if (next.google.connected && !next.google.reconnectRequired) return 'already-connected';
      }
      const deadline = Date.now() + GOOGLE_AUTH_TIMEOUT_MS;
      const { authUrl } = await api.connectGoogleDrive();
      await openExternalUrl(authUrl);
      return deadline;
    }, zh ? '无法开始 Google 授权。' : 'Could not start Google authorization.');
    if (result === 'already-connected') {
      await check();
    } else if (result !== undefined) {
      setGoogleAuthDeadline(result);
      setNotice(zh ? '请在浏览器中完成 Google 授权。连接状态会自动更新。' : 'Finish signing in to Google in your browser. This panel will update automatically.');
    }
  }

  async function disconnectGoogle() {
    const next = await run('disconnect', () => api.disconnectGoogleDrive(), zh ? '断开失败。' : 'Disconnect failed.');
    if (!next) return;
    setGoogleAuthDeadline(null);
    setPreview(null);
    setHistory(null);
    publishOperation.current = null;
    applyStatus(next, true);
  }

  return {
    status,
    checkOnPublish: status?.classification === null && canCheckOnPublish(status),
    busy,
    error,
    notice,
    preview,
    setPreview,
    history,
    transportDraft,
    setTransportDraft,
    folderDraft,
    setFolderDraft,
    deviceNameDraft,
    setDeviceNameDraft,
    clientIdDraft,
    setClientIdDraft,
    clientSecretDraft,
    setClientSecretDraft,
    saveConfig,
    chooseFolder,
    check,
    publish,
    startPreview,
    confirmReceive,
    loadHistory,
    saveGoogleClient,
    connectGoogle,
    disconnectGoogle,
  };
}

/** State and actions returned by {@link useDeviceSync}. */
export type DeviceSync = ReturnType<typeof useDeviceSync>;
