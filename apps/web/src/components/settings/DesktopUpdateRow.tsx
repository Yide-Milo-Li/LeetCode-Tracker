import { useState } from 'react';
import type { Language } from '../../i18n.ts';
import {
  checkDesktopUpdate, downloadDesktopUpdate, installDesktopUpdate, releasePage, useDesktopUpdate,
} from '../../platform/desktop-update.ts';
import { Dialog } from '../ui.tsx';

export function DesktopUpdateRow({ lang, noteNeedsSave }: { lang: Language; noteNeedsSave: boolean }) {
  const { info, phase, version, percent, failure } = useDesktopUpdate();
  const [confirming, setConfirming] = useState(false);
  if (!info && !failure) return null;
  const zh = lang === 'zh';
  const installing = phase === 'installing';
  const downloading = phase === 'downloading';
  const checking = phase === 'checking';
  const ready = phase === 'downloaded';
  const failureText = {
    check: zh ? '检查失败。请检查网络连接后重试。' : 'Could not check for updates. Check your connection and try again.',
    download: zh ? '下载或验证失败。请重新下载更新。' : 'Could not download or verify the update. Try downloading it again.',
    install: zh ? '安装失败。请重试，或手动下载安装包。' : 'Could not install the update. Try again or download the installer.',
  };
  const phaseText: Partial<Record<typeof phase, string>> = {
    current: zh ? '已是最新版本。' : 'You’re up to date.',
    available: zh ? `版本 ${version} 可用。` : `Version ${version} is available.`,
    downloading: zh ? '正在下载更新…' : 'Downloading update…',
    downloaded: zh ? `版本 ${version} 已下载。` : `Version ${version} is ready to install.`,
  };
  const status = failure ? failureText[failure] : phaseText[phase];
  const checkLabel = zh ? '检查更新' : 'Check for updates';
  const installLabel = zh ? '安装并重启' : 'Install and restart';
  const downloadLabel = zh ? '下载更新' : 'Download update';
  const progressLabel = zh ? '下载进度' : 'Download progress';

  return (
    <section className="preference-row">
      <div className="preference-label">
        <h2>{zh ? '应用更新' : 'App updates'}</h2>
        {info && <p>{zh ? `当前版本 ${info.version}` : `Current version ${info.version}`}</p>}
      </div>
      <div className="desktop-update-controls">
        {info?.enabled && (
          <div className="desktop-update-actions">
            {!ready && !installing && (
              <button type="button" className="btn btn-secondary" disabled={checking || downloading} onClick={() => void checkDesktopUpdate()}>
                {checking ? (zh ? '正在检查…' : 'Checking…') : checkLabel}
              </button>
            )}
            {phase === 'available' && (
              <button type="button" className="btn btn-primary" onClick={() => void downloadDesktopUpdate()}>{downloadLabel}</button>
            )}
            {(ready || installing) && (
              <button type="button" className="btn btn-primary" disabled={noteNeedsSave || installing} onClick={() => setConfirming(true)}>
                {installLabel}
              </button>
            )}
          </div>
        )}
        <div role="status" className="settings-hint">{status}</div>
        {ready && noteNeedsSave && <p className="settings-hint">
          {zh ? '请先保存或放弃笔记草稿。' : 'Save or discard your note draft before installing.'}
        </p>}
        {downloading && <progress aria-label={progressLabel} max={100} value={percent} />}
        {version && <a className="text-link" href={`${releasePage}/tag/v${encodeURIComponent(version)}`} target="_blank" rel="noreferrer">
          {zh ? '更新说明' : 'Release notes'}
        </a>}
        {(!info?.enabled || failure) && <a className="text-link" href={`${releasePage}/latest`} target="_blank" rel="noreferrer">
          {zh ? '手动下载安装包' : 'Download installer manually'}
        </a>}
      </div>
      {confirming && (
        <Dialog
          title={installLabel}
          lang={lang}
          onClose={() => setConfirming(false)}
          closeDisabled={installing}
          footer={<>
            <button type="button" className="btn btn-secondary" disabled={installing} onClick={() => setConfirming(false)}>
              {zh ? '稍后' : 'Later'}
            </button>
            <button type="button" className="btn btn-primary" disabled={installing || noteNeedsSave} onClick={() => void installDesktopUpdate()}>
              {installing ? (zh ? '正在安装…' : 'Installing…') : installLabel}
            </button>
          </>}
        >
          <p>{zh ? '应用将关闭以完成安装。请先保存手头的更改。' : 'The app will close to complete the installation. Save any work in progress first.'}</p>
          <p role="status">{failure === 'install' ? status : ''}</p>
        </Dialog>
      )}
    </section>
  );
}
