/**
 * Device sync state for the Settings "Data" tab: configuration drafts, status, publish,
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
  SYNC_FORK: { en: 'Both devices changed data since the last sync. Choose which version to keep.', zh: '两台设备在上次同步后都有修改，请选择保留哪一份。' },
  SYNC_REMOTE_AHEAD: { en: 'Another device published newer data. Receive it first.', zh: '另一台设备发布了更新的数据，请先接收。' },
  SYNC_LOCAL_CHANGES: { en: 'This device has unpublished changes. Choose to archive or discard them.', zh: '本机有未发布的修改，请选择归档或丢弃。' },
  SYNC_INCOMPATIBLE: { en: 'This snapshot was made by a newer app version. Update this app first.', zh: '该快照来自更新的应用版本，请先升级本机应用。' },
  SYNC_CORRUPT: { en: 'The snapshot is incomplete or damaged. Wait for your sync client to finish, or pick another snapshot.', zh: '快照不完整或已损坏。请等待同步客户端完成，或选择其他快照。' },
  SYNC_NOT_READY: { en: 'The snapshot has not finished downloading to this device yet.', zh: '快照尚未完整下载到本机。' },
  SYNC_PREVIEW_EXPIRED: { en: 'The preview expired. Preview the snapshot again.', zh: '预览已过期，请重新预览。' },
  SYNC_RECONNECT_REQUIRED: { en: 'Google Drive access expired or was revoked. Connect again.', zh: 'Google Drive 授权已过期或被撤销，请重新连接。' },
  SYNC_INVALID_FOLDER: { en: 'Enter an existing folder with an absolute path.', zh: '请填写一个已存在文件夹的绝对路径。' },
  SYNC_FOLDER_REQUIRED: { en: 'Choose a sync folder first.', zh: '请先选择同步文件夹。' },
  SYNC_GOOGLE_CLIENT_REQUIRED: { en: 'Enter your Google OAuth client ID first.', zh: '请先填写 Google OAuth 客户端 ID。' },
};

/**
 * Load sync status the first time `active` turns true (the Data tab opens) and expose the actions
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
  /** One publish intent keeps its operation ID until a response confirms the result. */
  const publishOperation = useRef<{ key: string; id: string } | null>(null);

  const describe = useCallback((err: unknown, fallback: string) => {
    const code = (err as { code?: string })?.code;
    const copy = code ? SYNC_ERROR_COPY[code] : undefined;
    return copy ? (zh ? copy.zh : copy.en) : localizeApiError(err, lang, fallback);
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
    loaded.current = true;
    let current = true;
    api.getSyncStatus()
      .then(async (initial) => {
        if (!current) return;
        applyStatus(initial, true);
        // Configured devices check the remote on open so "update available" shows without a click.
        if (initial.configured) {
          const checked = await api.checkSync().catch(() => null);
          if (current && checked) applyStatus(checked);
        }
      })
      .catch((err) => {
        loaded.current = false;
        if (current) setError(describe(err, zh ? '无法读取同步状态。' : 'Could not load sync status.'));
      });
    return () => { current = false; };
  }, [active]);

  async function saveConfig() {
    const next = await run('config', () => api.configureSync({
      transport: transportDraft,
      ...(transportDraft === 'folder' && folderDraft.trim() ? { folderPath: folderDraft.trim() } : {}),
      ...(deviceNameDraft.trim() ? { deviceName: deviceNameDraft.trim() } : {}),
      ...(clientIdDraft.trim() ? { googleClientId: clientIdDraft.trim() } : {}),
      ...(clientSecretDraft.trim() ? { googleClientSecret: clientSecretDraft.trim() } : {}),
    }), zh ? '保存同步设置失败。' : 'Could not save sync settings.');
    if (!next) return;
    setClientSecretDraft('');
    setClientIdDraft('');
    applyStatus(next, true);
    setPreview(null);
    setHistory(null);
    if (next.configured) await check();
    else setNotice(zh ? '同步设置已保存。' : 'Sync settings saved.');
  }

  async function chooseFolder() {
    const folder = await pickFolder().catch(() => null);
    if (folder) setFolderDraft(folder);
  }

  async function check() {
    const next = await run('check', () => api.checkSync(), zh ? '检查同步失败。' : 'Sync check failed.');
    if (next) applyStatus(next);
  }

  async function publish(allowFork = false) {
    const key = JSON.stringify({ allowFork });
    if (publishOperation.current?.key !== key) publishOperation.current = { key, id: crypto.randomUUID() };
    const operationId = publishOperation.current.id;
    const result = await run('publish', () => api.publishSync({ operationId, allowFork }), zh ? '发布快照失败。' : 'Publishing failed.');
    if (!result) return;
    publishOperation.current = null;
    setNotice(result.published
      ? (zh ? '快照已上传。其他设备接收后会在下方显示。' : 'Snapshot uploaded. Other devices show here once they receive it.')
      : (zh ? '没有新的修改需要发布。' : 'Nothing new to publish.'));
    if (result.warning) setError(result.warning);
    const next = await api.getSyncStatus().catch(() => null);
    if (next) applyStatus(next);
  }

  async function startPreview(snapshotId: string) {
    const result = await run('preview', () => api.previewSyncReceive(snapshotId), zh ? '读取快照失败。' : 'Could not read the snapshot.');
    if (result) setPreview(result);
  }

  async function confirmReceive(localChanges?: 'fork' | 'discard') {
    if (!preview) return;
    const result = await run('receive', () => api.receiveSync({ previewId: preview.previewId, ...(localChanges ? { localChanges } : {}) }), zh ? '接收失败，本机数据未更改。' : 'Receive failed; this device was not changed.');
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

  async function connectGoogle() {
    const result = await run('connect', async () => {
      // Persist a newly typed client before asking the server for a consent URL.
      if (clientIdDraft.trim() || clientSecretDraft.trim()) {
        applyStatus(await api.configureSync({
          transport: 'gdrive',
          ...(clientIdDraft.trim() ? { googleClientId: clientIdDraft.trim() } : {}),
          ...(clientSecretDraft.trim() ? { googleClientSecret: clientSecretDraft.trim() } : {}),
        }), true);
        setClientIdDraft('');
        setClientSecretDraft('');
      }
      const { authUrl } = await api.connectGoogleDrive();
      await openExternalUrl(authUrl);
      return true;
    }, zh ? '无法开始 Google 授权。' : 'Could not start Google authorization.');
    if (result) setNotice(zh ? '已在浏览器中打开 Google 授权。完成后点击“检查更新”。' : 'Google sign-in opened in your browser. Click "Check" when done.');
  }

  async function disconnectGoogle() {
    const next = await run('disconnect', () => api.disconnectGoogleDrive(), zh ? '断开失败。' : 'Disconnect failed.');
    if (next) applyStatus(next, true);
  }

  return {
    status,
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
    connectGoogle,
    disconnectGoogle,
  };
}

/** State and actions returned by {@link useDeviceSync}. */
export type DeviceSync = ReturnType<typeof useDeviceSync>;
