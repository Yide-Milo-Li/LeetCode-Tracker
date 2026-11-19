/** "Practice & notes" Settings tab: behavior toggles for the Today plan and the notes editor. */
import { useId } from 'react';
import { translations, type Language } from '../../i18n.ts';
import { SettingSwitch } from './SettingSwitch.tsx';

interface PracticeSectionProps {
  lang: Language;
  promptSwapFeedback: boolean;
  onPromptSwapFeedbackChange: (enabled: boolean) => void;
  notesFormatOnSave: boolean;
  onNotesFormatOnSaveChange: (enabled: boolean) => void;
}

/** Render the Practice tab panel; preference values and their persistence stay with the parent. */
export function PracticeSection({
  lang,
  promptSwapFeedback,
  onPromptSwapFeedbackChange,
  notesFormatOnSave,
  onNotesFormatOnSaveChange,
}: PracticeSectionProps) {
  const t = translations[lang];
  const zh = lang === 'zh';
  const swapDescId = useId();
  const formatDescId = useId();
  const swapLabel = zh ? '换题或移除时询问原因' : 'Ask for a reason when swapping or removing';

  return (
    <div role="tabpanel" id="settings-panel-practice" aria-labelledby="settings-tab-practice" className="settings-panel">
      <section className="preference-row">
        <div className="preference-label">
          <h2>{swapLabel}</h2>
          <p id={swapDescId}>
            {zh
              ? '在今日计划中换题或移除题目时，弹出一个可跳过的反馈窗口，帮助后续推荐。关闭后直接执行。'
              : 'Swapping or removing a Today problem opens a skippable feedback prompt that tunes later picks. When off, the action runs directly.'}
          </p>
        </div>
        <SettingSwitch
          lang={lang}
          checked={promptSwapFeedback}
          onChange={onPromptSwapFeedbackChange}
          label={swapLabel}
          describedBy={swapDescId}
        />
      </section>

      <section className="preference-row">
        <div className="preference-label">
          <h2>{t.notesFormatOnSave}</h2>
          <p id={formatDescId}>
            {zh
              ? '保存笔记时自动整理 Markdown 排版，保存后可立即撤销。'
              : 'Clean up Markdown formatting when saving a note. You can undo right after saving.'}
          </p>
        </div>
        <SettingSwitch
          lang={lang}
          checked={notesFormatOnSave}
          onChange={onNotesFormatOnSaveChange}
          label={t.notesFormatOnSave}
          describedBy={formatDescId}
        />
      </section>
    </div>
  );
}
