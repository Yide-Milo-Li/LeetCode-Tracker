/** "General" Settings tab: language, timezone and behavior preferences. */
import { translations, type Language } from '../../i18n.ts';
import { useWorkspace } from '../../workspace.tsx';
import { TimezoneField } from '../TimezoneField.tsx';

interface GeneralSectionProps {
  lang: Language;
  onLanguageChange: (lang: Language) => void;
  onTimezoneSaved?: (zone: string | null) => void;
  promptSwapFeedback: boolean;
  onPromptSwapFeedbackChange: (enabled: boolean) => void;
  notesFormatOnSave: boolean;
  onNotesFormatOnSaveChange: (enabled: boolean) => void;
}

/** Render the General tab panel; preference values and their persistence stay with the parent. */
export function GeneralSection({
  lang,
  onLanguageChange,
  onTimezoneSaved,
  promptSwapFeedback,
  onPromptSwapFeedbackChange,
  notesFormatOnSave,
  onNotesFormatOnSaveChange,
}: GeneralSectionProps) {
  const t = translations[lang];
  const workspace = useWorkspace();
  const zh = lang === 'zh';

  return (
    <div role="tabpanel" id="settings-panel-general" aria-labelledby="settings-tab-general" className="settings-panel">
      <section className="preference-row">
        <div className="preference-label">
          <h2>{t.langLabel}</h2>
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

      <section className="preference-row">
        <div className="preference-label">
          <h2>{zh ? '换题或移除时询问原因' : 'Ask for reason when swapping or removing'}</h2>
          <p>
            {zh
              ? '开启后，在今日计划中换题或移除题目时会弹出可选反馈窗口；关闭后直接执行操作。'
              : 'When enabled, swapping or removing a Today problem opens an optional feedback prompt; when off, the action runs directly.'}
          </p>
        </div>
        <div
          className="segmented-control"
          aria-label={zh ? '换题或移除时询问原因' : 'Ask for reason when swapping or removing'}
        >
          <button
            type="button"
            aria-pressed={promptSwapFeedback}
            onClick={() => onPromptSwapFeedbackChange(true)}
          >
            {zh ? '弹出反馈窗口' : 'Show prompt'}
          </button>
          <button
            type="button"
            aria-pressed={!promptSwapFeedback}
            onClick={() => onPromptSwapFeedbackChange(false)}
          >
            {zh ? '不弹出' : "Don't show"}
          </button>
        </div>
      </section>

      <section className="preference-row">
        <div className="preference-label">
          <h2>{t.notesFormatOnSave}</h2>
          <p>
            {zh
              ? '开启后，保存笔记时会自动整理 Markdown 排版（可在保存后随时撤销）。'
              : 'Automatically clean up Markdown formatting when saving a note (can be undone immediately after saving).'}
          </p>
        </div>
        <div className="segmented-control" role="group" aria-label={t.notesFormatOnSave}>
          <button
            type="button"
            aria-pressed={notesFormatOnSave}
            onClick={() => onNotesFormatOnSaveChange(true)}
          >
            {zh ? '开启' : 'On'}
          </button>
          <button
            type="button"
            aria-pressed={!notesFormatOnSave}
            onClick={() => onNotesFormatOnSaveChange(false)}
          >
            {zh ? '关闭' : 'Off'}
          </button>
        </div>
      </section>
    </div>
  );
}
