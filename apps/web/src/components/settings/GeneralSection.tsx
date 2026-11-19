/** "General" Settings tab: language and timezone. */
import { translations, type Language } from '../../i18n.ts';
import { useWorkspace } from '../../workspace.tsx';
import { TimezoneField } from '../TimezoneField.tsx';

interface GeneralSectionProps {
  lang: Language;
  onLanguageChange: (lang: Language) => void;
  onTimezoneSaved?: (zone: string | null) => void;
}

/** Render the General tab panel; preference values and their persistence stay with the parent. */
export function GeneralSection({
  lang,
  onLanguageChange,
  onTimezoneSaved,
}: GeneralSectionProps) {
  const t = translations[lang];
  const workspace = useWorkspace();
  const zh = lang === 'zh';

  return (
    <div role="tabpanel" id="settings-panel-general" aria-labelledby="settings-tab-general" className="settings-panel">
      <section className="preference-row">
        <div className="preference-label">
          <h2>{t.langLabel}</h2>
          <p>{zh ? '界面文字使用的语言，导出到 Obsidian 的笔记骨架也会使用它。' : 'Used for the interface and for note skeletons exported to Obsidian.'}</p>
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
        <div className="preference-label">
          <h2>{t.timezoneLabel}</h2>
          <p>
            {zh
              ? '决定"今天"从何时开始，用于每日计划和活动日期。更改不会改写已有记录的时间。'
              : 'Decides when "today" starts for daily plans and activity dates. Existing record times are kept.'}
          </p>
        </div>
        <TimezoneField lang={lang} value={workspace.timezone} onSaved={(zone) => onTimezoneSaved?.(zone)} hideLabel />
      </section>
    </div>
  );
}
