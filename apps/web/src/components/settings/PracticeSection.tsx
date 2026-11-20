/** "Practice & notes" Settings tab: review spacing plus behavior toggles for the Today plan and the notes editor. */
import { useEffect, useId, useState } from 'react';
import { api } from '../../api.ts';
import { localizeApiError } from '../../error-i18n.ts';
import { translations, type Language } from '../../i18n.ts';
import { ReviewSpacingOptions, type ReviewSpacingValue } from '../RecommendationOptions.tsx';
import { useWorkspace } from '../../workspace.tsx';
import { SettingSwitch } from './SettingSwitch.tsx';

/**
 * Learner-wide review spacing. Loads the effective values (derived from older strategies until
 * first saved) and persists each change immediately, rolling back on failure.
 */
export function ReviewSpacingRow({ lang, compact = false, onBusyChange }: {
  lang: Language; compact?: boolean; onBusyChange?: (busy: boolean) => void;
}) {
  const workspace = useWorkspace();
  const zh = lang === 'zh';
  const [value, setValue] = useState<ReviewSpacingValue | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    api.getSettings()
      .then(settings => { if (active) setValue({ reviewPolicy: settings.reviewPolicy, reviewIntervals: settings.reviewIntervals, personalDurationCalibration: settings.personalDurationCalibration }); })
      .catch(err => { if (active) setError(localizeApiError(err, lang, zh ? '加载复习设置失败。' : 'Failed to load review settings.')); });
    return () => { active = false; };
  }, [workspace.revision, lang]);

  /** Optimistically apply one change; restore the previous value if saving fails. */
  function update(patch: ReviewSpacingValue) {
    if (!value) return;
    const previous = value;
    setValue({ ...value, ...patch });
    setSaving(true);
    onBusyChange?.(true);
    setError('');
    api.updateSettings(patch)
      .then(() => workspace.notifyMutation())
      .catch(err => { setValue(previous); setError(localizeApiError(err, lang, zh ? '保存复习设置失败。' : 'Failed to save review settings.')); })
      .finally(() => { setSaving(false); onBusyChange?.(false); });
  }

  return (
    <section className={compact ? 'study-goal-fields' : 'preference-row'}>
      <div className="preference-label">
        {!compact && <h2>{zh ? '复习节奏' : 'Review rhythm'}</h2>}
        <p>{compact
          ? (zh ? '切换复习策略会立即生效。修改天数后点击「应用全局间隔」。所有学习安排共用这些设置。' : 'Changing the spacing policy takes effect immediately. Apply interval lengths separately. Both settings apply to every plan.')
          : zh ? '决定每道题何时再次到期。所有学习安排共用同一套节奏，同一道题在任何一天的到期日都一致。'
          : 'Decides when each problem is due again. Every strategy shares it, so a problem has the same due date on any day.'}</p>
        {error && <p role="alert" className="text-danger">{error}</p>}
      </div>
      <div>
        {value
          ? <ReviewSpacingOptions lang={lang} value={value} disabled={saving} showExperiment={!compact} onChange={update} />
          : !error && <p role="status" className="text-muted">{zh ? '加载中…' : 'Loading…'}</p>}
      </div>
    </section>
  );
}

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
      <ReviewSpacingRow lang={lang} />

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
