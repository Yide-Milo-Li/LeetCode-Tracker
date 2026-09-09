/** Application preferences only; catalog and progress imports live in their respective workspaces. */
import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api.ts';
import { translations, type Language } from '../i18n.ts';
import { useWorkspace } from '../workspace.tsx';
import { PageHeader, Feedback, Field } from './ui.tsx';

interface SettingsViewProps {
  lang: Language;
  onLanguageChange: (lang: Language) => void;
  onThemeChange: (theme: 'light' | 'dark' | 'system') => void;
  currentTheme: 'light' | 'dark' | 'system';
  onTimezoneSaved?: (zone: string | null) => void;
}

/** Keep the timezone draft intact on background refresh; only explicit save changes date interpretation. */
export function SettingsView({
  lang,
  onLanguageChange,
  onThemeChange,
  currentTheme,
  onTimezoneSaved,
}: SettingsViewProps) {
  const t = translations[lang];
  const workspace = useWorkspace();
  const zh = lang === 'zh';
  const [zone, setZone] = useState(workspace.timezone ?? '');
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const dirty = useRef(false);
  useEffect(() => {
    let active = true;
    api
      .getSettings()
      .then((settings) => {
        if (active && !dirty.current) setZone(settings.timezone ?? '');
      })
      .catch((err) => {
        if (active) setError(String(err.message));
      });
    return () => {
      active = false;
    };
  }, []);
  /** Validate IANA names locally and wait for server persistence before publishing the new timezone. */
  async function saveZone(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError('');
    setSaved(false);
    try {
      if (zone.trim()) new Intl.DateTimeFormat('en', { timeZone: zone.trim() });
      const settings = await api.updateSettings({ timezone: zone.trim() || null });
      onTimezoneSaved?.(settings.timezone);
      workspace.notifyMutation();
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="settings-view">
      <PageHeader
        title={zh ? '设置' : 'Settings'}
        description={zh ? '让工作空间适合你的习惯。' : 'Make this workspace feel like yours.'}
      />
      <section className="preference-row">
        <div>
          <h2>{t.langLabel}</h2>
          <p className="muted">
            {zh ? '界面语言立即生效。' : 'Your interface language updates immediately.'}
          </p>
        </div>
        <div className="segmented-control" aria-label={t.langLabel}>
          <button aria-pressed={lang === 'zh'} onClick={() => onLanguageChange('zh')}>
            简体中文
          </button>
          <button aria-pressed={lang === 'en'} onClick={() => onLanguageChange('en')}>
            English
          </button>
        </div>
      </section>
      <section className="preference-row">
        <div>
          <h2>{t.themeLabel}</h2>
          <p className="muted">
            {zh
              ? '跟随系统会响应桌面外观的变化。'
              : 'System mode follows changes to your desktop appearance.'}
          </p>
        </div>
        <div className="segmented-control" aria-label={t.themeLabel}>
          {(['light', 'dark', 'system'] as const).map((theme) => (
            <button key={theme} aria-pressed={currentTheme === theme} onClick={() => onThemeChange(theme)}>
              {theme === 'light' ? t.themeLight : theme === 'dark' ? t.themeDark : t.themeSystem}
            </button>
          ))}
        </div>
      </section>
      <section className="preference-row">
        <div>
          <h2>{t.timezoneLabel}</h2>
          <p className="muted">
            {zh
              ? '用于今日计划和活动日期统计。更改不会改写原始记录时间。'
              : 'Used for daily plans and activity dates. Changing it preserves original record times.'}
          </p>
        </div>
        <form className="timezone-form" onSubmit={saveZone}>
          <Field label={zh ? 'IANA 时区' : 'IANA timezone'}>
            <input
              list="timezone-options"
              value={zone}
              onChange={(e) => {
                dirty.current = true;
                setZone(e.target.value);
                setSaved(false);
              }}
              placeholder={zh ? '尚未配置' : 'Not configured'}
            />
          </Field>
          <datalist id="timezone-options">
            {[
              'UTC',
              'Asia/Shanghai',
              'Asia/Tokyo',
              'America/Los_Angeles',
              'America/New_York',
              'Europe/London',
              'Europe/Paris',
            ].map((z) => (
              <option key={z} value={z} />
            ))}
          </datalist>
          <div className="action-row">
            <button
              type="button"
              className="text-link"
              onClick={() => {
                dirty.current = true;
                setZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
                setSaved(false);
              }}
            >
              {zh ? '使用浏览器建议' : 'Use browser suggestion'}
            </button>
            <button className="btn btn-primary" disabled={saving}>
              {saving ? '…' : zh ? '保存时区' : 'Save timezone'}
            </button>
          </div>
          {error && <Feedback>{error}</Feedback>}
          {saved && <Feedback tone="success">{zh ? '时区已保存' : 'Timezone saved'}</Feedback>}
        </form>
      </section>
    </div>
  );
}
