/** Device sync panel in the Settings "Data" tab: sync folder or Google Drive snapshots. */
import { AlertTriangle, Cloud, FolderOpen, History, RefreshCw, Upload, Download } from 'lucide-react';
import type { SyncClassification, SyncSnapshotSummary, SyncTransportKind } from '../../api.ts';
import { isTauri } from '../../platform/index.ts';
import type { Language } from '../../i18n.ts';
import { Feedback, Field, InfoPopover } from '../ui.tsx';
import type { DeviceSync } from './useDeviceSync.ts';

interface SyncSectionProps {
  lang: Language;
  /** Sync state owned by the parent so an open preview survives tab switches. */
  sync: DeviceSync;
}

const STATE_COPY: Record<SyncClassification, { en: string; zh: string; tone: 'success' | 'info' | 'warning' }> = {
  'empty-remote': { en: 'Nothing published yet. Publish this device to start.', zh: '还没有快照。发布本机数据即可开始同步。', tone: 'info' },
  'up-to-date': { en: 'Up to date with the latest snapshot.', zh: '已与最新快照一致。', tone: 'success' },
  'local-ahead': { en: 'This device has changes that are not published yet.', zh: '本机有尚未发布的修改。', tone: 'info' },
  'remote-ahead': { en: 'Another device published newer data.', zh: '其他设备发布了更新的数据。', tone: 'info' },
  fork: { en: 'More than one version changed independently since the last sync. Pick the one to keep; nothing is merged automatically.', zh: '上次同步后出现了多个各自修改过的版本。请选择保留哪一份，不会自动合并。', tone: 'warning' },
};

function formatTime(ms: number, zh: boolean): string {
  return new Date(ms).toLocaleString(zh ? 'zh-CN' : 'en-US', { dateStyle: 'medium', timeStyle: 'short' });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Render sync configuration, status and actions. */
export function SyncSection({ lang, sync }: SyncSectionProps) {
  const zh = lang === 'zh';
  const { status, busy, error, notice, preview, history } = sync;
  const disabled = busy !== null;
  const classification = status?.classification ?? null;
  const head: SyncSnapshotSummary | undefined = status?.heads.find(h => h.compatible) ?? status?.heads[0];
  // Competing versions (several heads) are all offered; none is preferred by time.
  const receivable = status?.heads.filter(h => h.compatible) ?? [];
  const latestId = status?.heads.length === 1 ? status.heads[0].snapshotId : null;
  const otherDevices = status?.devices.filter(d => d.deviceId !== status.deviceId) ?? [];
  const methods: Array<{ id: SyncTransportKind; label: string }> = [
    { id: 'none', label: zh ? '关闭' : 'Off' },
    { id: 'folder', label: zh ? '同步文件夹' : 'Sync folder' },
    { id: 'gdrive', label: 'Google Drive' },
  ];

  return (
    <section className="preference-row">
      <div className="preference-label">
        <h2>{zh ? '设备同步' : 'Device sync'}</h2>
        <InfoPopover
          label={zh ? '设备同步说明' : 'Device sync help'}
          content={
            <div>
              <p>{zh
                ? '同步以完整快照进行：在刚使用过的设备上“发布”，切换到任意其他设备时先“接收”。可以有任意多台设备，但同一时间请只在一台上修改。'
                : 'Sync works with complete snapshots: publish on the device you just used, and receive first whenever you switch to any other device. Any number of devices can join; edit on one at a time.'}</p>
              <p>{zh
                ? '接收前会自动生成本地安全备份。API Key、Google 授权和同步设置只保存在本机。'
                : 'Receiving always creates a local safety backup first. API keys, Google access and sync settings stay on each device.'}</p>
              <p>{zh
                ? '“同步文件夹”可以选择 Google Drive 桌面版里的目录；“Google Drive”直接使用你自己的 OAuth 客户端，数据存放在应用专用的隐藏目录。'
                : '"Sync folder" can point at a folder inside Google Drive for desktop. "Google Drive" uses your own OAuth client and stores data in a hidden app folder.'}</p>
            </div>
          }
        />
        <p>{zh
          ? '在多台设备之间传递题库、进度、笔记、学习安排和设置。'
          : 'Carry your catalog, progress, notes, study schedule and settings between devices.'}</p>
      </div>

      <div className="settings-stack">
        <div className="form-field">
          <span>{zh ? '同步方式' : 'Sync method'}</span>
          <div className="segmented-control" aria-label={zh ? '同步方式' : 'Sync method'}>
            {methods.map(({ id, label }) => (
              <button key={id} type="button" aria-pressed={sync.transportDraft === id} onClick={() => sync.setTransportDraft(id)} disabled={disabled}>
                {label}
              </button>
            ))}
          </div>
        </div>

        {sync.transportDraft === 'folder' && (
          <Field
            label={zh ? '同步文件夹（绝对路径）' : 'Sync folder (absolute path)'}
            hint={zh ? '会在其中创建 LeetCodeTrackerSync 子文件夹。' : 'A LeetCodeTrackerSync subfolder is created inside it.'}
          >
            <div className="input-with-action">
              <input
                type="text"
                value={sync.folderDraft}
                onChange={(e) => sync.setFolderDraft(e.target.value)}
                placeholder={zh ? '例如 G:\\我的云端硬盘' : 'e.g. G:\\My Drive'}
                spellCheck={false}
              />
              {isTauri() && (
                <button type="button" className="icon-action-btn" onClick={() => void sync.chooseFolder()} aria-label={zh ? '浏览文件夹' : 'Browse folders'} disabled={disabled}>
                  <FolderOpen size={16} />
                </button>
              )}
            </div>
          </Field>
        )}

        {sync.transportDraft === 'gdrive' && (
          <>
            <Field
              label={zh ? 'OAuth 客户端 ID' : 'OAuth client ID'}
              hint={status?.google.clientConfigured
                ? (zh ? '已保存。留空则保持不变。' : 'Saved. Leave empty to keep it.')
                : (zh ? '在 Google Cloud 创建“桌面应用”类型的客户端，并将发布状态设为“正式版”。' : 'Create a "Desktop app" client in Google Cloud and set its publishing status to "In production".')}
            >
              <input type="text" value={sync.clientIdDraft} onChange={(e) => sync.setClientIdDraft(e.target.value)} autoComplete="off" spellCheck={false} placeholder="….apps.googleusercontent.com" />
            </Field>
            <Field label={zh ? 'OAuth 客户端密钥（可选）' : 'OAuth client secret (optional)'}>
              <input type="password" value={sync.clientSecretDraft} onChange={(e) => sync.setClientSecretDraft(e.target.value)} autoComplete="off" spellCheck={false} />
            </Field>
            <div className="action-row">
              {status?.google.connected && !status.google.reconnectRequired ? (
                <>
                  <span className="field-status">{zh ? '已连接 Google Drive' : 'Google Drive connected'}</span>
                  <button type="button" className="btn btn-secondary btn-sm" onClick={() => void sync.disconnectGoogle()} disabled={disabled}>
                    {zh ? '断开' : 'Disconnect'}
                  </button>
                </>
              ) : (
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => void sync.connectGoogle()} disabled={disabled}>
                  <Cloud size={14} />
                  <span>{status?.google.reconnectRequired ? (zh ? '重新连接 Google Drive' : 'Reconnect Google Drive') : (zh ? '连接 Google Drive' : 'Connect Google Drive')}</span>
                </button>
              )}
            </div>
          </>
        )}

        {sync.transportDraft !== 'none' && (
          <Field label={zh ? '本机名称' : 'This device’s name'}>
            <input type="text" value={sync.deviceNameDraft} maxLength={80} onChange={(e) => sync.setDeviceNameDraft(e.target.value)} />
          </Field>
        )}

        <div className="action-row">
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => void sync.saveConfig()} disabled={disabled}>
            {busy === 'config' ? '…' : zh ? '保存同步设置' : 'Save sync settings'}
          </button>
        </div>

        {status?.configured && (
          <>
            {classification && (
              <Feedback tone={STATE_COPY[classification].tone}>
                {zh ? STATE_COPY[classification].zh : STATE_COPY[classification].en}
                {status.heads.length > 1 ? (
                  <> {zh ? `当前有 ${status.heads.length} 个并列版本。` : `${status.heads.length} competing versions.`}</>
                ) : head && classification !== 'up-to-date' && (
                  <> {zh ? '最新：' : 'Latest: '}{head.deviceName} · {formatTime(head.createdAt, zh)}{head.compatible ? '' : (zh ? '（需要更新版本的应用）' : ' (needs a newer app)')}</>
                )}
              </Feedback>
            )}
            {status.unreadableFiles > 0 && (
              <Feedback tone="warning">
                {zh ? `有 ${status.unreadableFiles} 个同步文件无法读取，已忽略。` : `${status.unreadableFiles} sync files could not be read and were ignored.`}
              </Feedback>
            )}

            <div className="action-row">
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => void sync.check()} disabled={disabled}>
                <RefreshCw size={14} />
                <span>{busy === 'check' ? '…' : zh ? '检查更新' : 'Check'}</span>
              </button>
              {(classification === 'empty-remote' || classification === 'local-ahead') && (
                <button type="button" className="btn btn-primary btn-sm" onClick={() => void sync.publish()} disabled={disabled}>
                  <Upload size={14} />
                  <span>{busy === 'publish' ? '…' : zh ? '发布本机数据' : 'Publish this device'}</span>
                </button>
              )}
              {(classification === 'remote-ahead' || classification === 'fork') && receivable.length === 1 && (
                <button type="button" className="btn btn-primary btn-sm" onClick={() => void sync.startPreview(receivable[0].snapshotId)} disabled={disabled}>
                  <Download size={14} />
                  <span>{busy === 'preview' ? '…' : zh ? `接收 ${receivable[0].deviceName} 的版本` : `Receive ${receivable[0].deviceName}’s version`}</span>
                </button>
              )}
              {classification === 'fork' && status.heads.every(h => h.compatible) && (
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => void sync.publish(true)} disabled={disabled}>
                  <Upload size={14} />
                  <span>{zh ? '保留本机版本并发布' : 'Keep this device’s version'}</span>
                </button>
              )}
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => void sync.loadHistory()} disabled={disabled}>
                <History size={14} />
                <span>{zh ? '历史快照' : 'History'}</span>
              </button>
            </div>

            {(classification === 'remote-ahead' || classification === 'fork') && receivable.length > 1 && (
              <ul className="sync-device-list" aria-label={zh ? '可接收的版本' : 'Versions you can receive'}>
                {receivable.map(h => (
                  <li key={h.snapshotId} className="sync-head-row">
                    <span><strong>{h.deviceName}</strong> · {formatTime(h.createdAt, zh)}</span>
                    <button type="button" className="btn btn-secondary btn-sm" onClick={() => void sync.startPreview(h.snapshotId)} disabled={disabled}>
                      <Download size={14} />
                      <span>{zh ? `接收 ${h.deviceName} 的版本` : `Receive ${h.deviceName}’s version`}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {otherDevices.length > 0 && (
              <ul className="sync-device-list" aria-label={zh ? '其他设备' : 'Other devices'}>
                {otherDevices.map(d => (
                  <li key={d.deviceId}>
                    <strong>{d.deviceName}</strong>
                    {' · '}
                    {latestId && d.currentSnapshotId === latestId
                      ? (zh ? '已是最新' : 'up to date')
                      : d.currentSnapshotId === undefined
                        ? (d.lastReceived ? (zh ? `已接收快照 ${d.lastReceived.slice(0, 8)}` : `received snapshot ${d.lastReceived.slice(0, 8)}`) : (zh ? '尚未接收' : 'nothing received yet'))
                        : (zh ? '不是最新版本' : 'not on the latest version')}
                    {' · '}
                    {formatTime(d.updatedAt, zh)}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}

        {preview && (
          <div className="restore-confirm" role="alertdialog" aria-labelledby="sync-confirm-title">
            <div className="restore-confirm-title" id="sync-confirm-title">
              <AlertTriangle size={16} aria-hidden="true" />
              <span>{zh ? `用 ${preview.snapshot.deviceName} 的快照替换本机数据？` : `Replace this device’s data with ${preview.snapshot.deviceName}’s snapshot?`}</span>
            </div>
            <p>
              {formatTime(preview.snapshot.createdAt, zh)} · v{preview.snapshot.appVersion} · {formatBytes(preview.snapshot.payloadBytes)}
            </p>
            <p>
              {zh ? '接收后 / 当前：' : 'After / now: '}
              {preview.counts.problems.incoming}/{preview.counts.problems.local} {zh ? '题目' : 'problems'} ·{' '}
              {preview.counts.practiceRecords.incoming}/{preview.counts.practiceRecords.local} {zh ? '练习记录' : 'practice records'} ·{' '}
              {preview.counts.notes.incoming}/{preview.counts.notes.local} {zh ? '笔记' : 'notes'} ·{' '}
              {preview.counts.dailyPlans.incoming}/{preview.counts.dailyPlans.local} {zh ? '每日计划' : 'daily plans'}
            </p>
            <p className="restore-confirm-note">
              {preview.localDirty
                ? (zh ? '本机有未发布的修改。“归档并接收”会先把本机数据上传为一份分叉快照；“丢弃并接收”只在本地安全备份中保留它。'
                  : 'This device has unpublished changes. "Archive mine" uploads them as a fork snapshot first; "Discard mine" keeps them only in the local safety backup.')
                : (zh ? '会先创建本地安全备份，再替换数据；失败将保留原库。请先保存未完成的编辑，成功后页面会重新加载。'
                  : 'A safety backup is created before replacing; a failure keeps the current data. Save unfinished edits first; the app reloads afterwards.')}
            </p>
            <div className="action-row">
              {preview.localDirty ? (
                <>
                  <button type="button" className="btn btn-primary btn-sm" onClick={() => void sync.confirmReceive('fork')} disabled={disabled}>
                    {busy === 'receive' ? '…' : zh ? '归档本机修改并接收' : 'Archive mine and receive'}
                  </button>
                  <button type="button" className="btn btn-secondary btn-sm" onClick={() => void sync.confirmReceive('discard')} disabled={disabled}>
                    {zh ? '丢弃本机修改并接收' : 'Discard mine and receive'}
                  </button>
                </>
              ) : (
                <button type="button" className="btn btn-primary btn-sm" onClick={() => void sync.confirmReceive()} disabled={disabled}>
                  {busy === 'receive' ? '…' : zh ? '确认并接收' : 'Confirm & receive'}
                </button>
              )}
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => sync.setPreview(null)} disabled={disabled}>
                {zh ? '取消' : 'Cancel'}
              </button>
            </div>
          </div>
        )}

        {history && (
          history.length === 0 ? (
            <p className="restore-confirm-note">{zh ? '还没有快照。' : 'No snapshots yet.'}</p>
          ) : (
            <div className="sync-history" role="region" aria-label={zh ? '历史快照' : 'Snapshot history'}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>{zh ? '时间' : 'Time'}</th>
                    <th>{zh ? '设备' : 'Device'}</th>
                    <th>{zh ? '类型' : 'Type'}</th>
                    <th>{zh ? '大小' : 'Size'}</th>
                    <th aria-label={zh ? '操作' : 'Actions'} />
                  </tr>
                </thead>
                <tbody>
                  {history.map(item => (
                    <tr key={item.snapshotId}>
                      <td>{formatTime(item.createdAt, zh)}{item.isHead ? (zh ? '（最新）' : ' (latest)') : ''}</td>
                      <td>{item.deviceName}</td>
                      <td>{item.kind === 'fork' ? (zh ? '分叉归档' : 'Fork archive') : (zh ? '发布' : 'Publish')}</td>
                      <td>{formatBytes(item.payloadBytes)}</td>
                      <td>
                        <button type="button" className="btn btn-secondary btn-sm" onClick={() => void sync.startPreview(item.snapshotId)} disabled={disabled || !item.compatible}>
                          {zh ? '恢复' : 'Restore'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        )}

        {notice && <Feedback tone="success">{notice}</Feedback>}
        {error && <Feedback tone="error">{error}</Feedback>}
      </div>
    </section>
  );
}
