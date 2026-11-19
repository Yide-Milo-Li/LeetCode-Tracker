import { useEffect } from 'react';
import type { Language } from '../i18n.ts';
import { dismissDesktopUpdate, startDesktopUpdates, useDesktopUpdate } from '../platform/desktop-update.ts';
import { Feedback } from './ui.tsx';

export function DesktopUpdateNotice({ lang, onOpen, visible = true }: {
  lang: Language;
  onOpen: () => void;
  visible?: boolean;
}) {
  const { version, dismissedVersion } = useDesktopUpdate();
  useEffect(() => { startDesktopUpdates(); }, []);
  if (!visible || !version || version === dismissedVersion) return null;
  const zh = lang === 'zh';
  return (
    <Feedback tone="info" retry={{ label: zh ? '查看更新' : 'View update', run: () => {
      dismissDesktopUpdate(version);
      onOpen();
    } }}>
      {zh ? `版本 ${version} 可用。` : `Version ${version} is available.`}{' '}
      <button type="button" className="text-link" onClick={() => dismissDesktopUpdate(version)}>
        {zh ? '稍后' : 'Later'}
      </button>
    </Feedback>
  );
}
