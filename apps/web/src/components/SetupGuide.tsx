/**
 * First-run guide: three steps (timezone, problem catalog, study rhythm) before the first daily plan.
 *
 * `SetupGate` wraps the Today view. It shows the guide only while something required is missing and
 * the user has not finished or skipped it; afterwards Today's own empty states take over.
 * Completion is remembered per browser origin in localStorage, so returning users never wait on the check.
 */
import React, { useEffect, useState, type ReactNode } from 'react';
import { Check, CheckCircle2, Sparkles, CalendarDays, Settings2 } from 'lucide-react';
import { api } from '../api.ts';
import type { Language } from '../i18n.ts';
import { localizeApiError } from '../error-i18n.ts';
import type { ThemePalette } from '../../../../packages/contracts/src/sync.ts';
import { strategyInputSchema, type StrategyInput } from '../../../../packages/contracts/src/recommendations.ts';
import { percentagesForCounts, reviewPercentForCount } from '../strategy-counts.ts';
import { useWorkspace } from '../workspace.tsx';
import { paletteForMode, type ThemeMode } from './settings/settings-model.ts';
import { TimezoneField } from './TimezoneField.tsx';
import { Feedback } from './ui.tsx';

const CatalogImportWorkspace = React.lazy(() =>
  import('./CatalogImportWorkspace.tsx').then((m) => ({ default: m.CatalogImportWorkspace })),
);

export const SETUP_DONE_KEY = 'leetcode_tracker_setup_done';

/** Read the persisted completion flag; storage failures count as "not done" so the check still runs. */
function readDone(): boolean {
  try {
    return localStorage.getItem(SETUP_DONE_KEY) === 'true';
  } catch {
    return false;
  }
}

function writeDone() {
  try {
    localStorage.setItem(SETUP_DONE_KEY, 'true');
  } catch {
    // Storage is unavailable; the guide simply re-checks on the next mount.
  }
}

/** Facts the guide needs; each maps to one step. */
interface SetupStatus {
  timezone: string | null;
  problemCount: number;
  hasSchedule: boolean;
}

type Step = 0 | 1 | 2 | 3;

/** Index of the first unfinished step, or the finish screen when everything is in place. */
function firstOpenStep(status: SetupStatus): Step {
  if (!status.timezone) return 0;
  if (status.problemCount === 0) return 1;
  if (!status.hasSchedule) return 2;
  return 3;
}

/** Weekday preset: Monday–Friday, three problems (one Easy, two Medium), one of them a review. */
export function presetStrategy(lang: Language): StrategyInput {
  const dailyCount = 3;
  return {
    name: lang === 'zh' ? '工作日 · 每天 3 题' : 'Weekdays · 3 a day',
    rules: {
      dailyCount,
      difficulty: percentagesForCounts(dailyCount, { Easy: 1, Medium: 2, Hard: 0 }),
      tags: [],
      premium: false,
      reviewEnabled: true,
      reviewPercent: reviewPercentForCount(dailyCount, 'partial', 1),
      reviewMode: 'partial',
      reviewCount: 1,
      preference: '',
    },
    weekdays: [1, 2, 3, 4, 5],
  };
}

interface SetupGateProps {
  lang: Language;
  theme: ThemeMode;
  palette: ThemePalette;
  onLanguageChange: (lang: Language) => void;
  onThemeChange: (theme: ThemeMode) => void;
  onPaletteChange: (palette: ThemePalette) => void;
  onTimezoneSaved: (zone: string | null) => void;
  /** Called once the guide closes so the daily plan can be generated with the new setup. */
  onFinish: () => void;
  /** Close the guide and open the AI tab in Settings. */
  onOpenAiSettings: () => void;
  children: ReactNode;
}

/** Show the guide while setup is incomplete; otherwise render the regular Today view. */
export function SetupGate({ children, ...props }: SetupGateProps) {
  const workspace = useWorkspace();
  const [phase, setPhase] = useState<'checking' | 'guide' | 'done'>(() => (readDone() ? 'done' : 'checking'));
  const [status, setStatus] = useState<SetupStatus | null>(null);

  useEffect(() => {
    if (phase !== 'checking') return;
    let active = true;
    Promise.all([api.getSettings(), api.getCatalogStats(), api.getStrategies()])
      .then(([settings, stats, strategies]) => {
        if (!active) return;
        const next: SetupStatus = {
          timezone: settings.timezone ?? null,
          problemCount: stats.totalProblems,
          hasSchedule: strategies.some((s) => !s.deleted && s.weekdays.length > 0),
        };
        if (firstOpenStep(next) === 3) {
          // Existing installs (or a restored migration) skip the guide entirely.
          writeDone();
          setPhase('done');
        } else {
          setStatus(next);
          setPhase('guide');
        }
      })
      .catch(() => {
        // Never block Today on the check; its own views report load failures.
        if (active) setPhase('done');
      });
    return () => {
      active = false;
    };
  }, [phase, workspace.revision]);

  if (phase === 'done') return <>{children}</>;
  if (phase === 'checking' || !status) {
    return (
      <div className="setup-loading" role="status">
        {props.lang === 'zh' ? '正在检查设置…' : 'Checking your setup…'}
      </div>
    );
  }
  return (
    <SetupGuide
      {...props}
      initialStatus={status}
      onClose={() => {
        writeDone();
        setPhase('done');
      }}
    />
  );
}

/** The three-step guide itself; only the active step is rendered. */
function SetupGuide({
  lang,
  theme,
  palette,
  onLanguageChange,
  onThemeChange,
  onPaletteChange,
  onTimezoneSaved,
  onFinish,
  onOpenAiSettings,
  initialStatus,
  onClose,
}: Omit<SetupGateProps, 'children'> & { initialStatus: SetupStatus; onClose: () => void }) {
  const zh = lang === 'zh';
  const workspace = useWorkspace();
  const [status, setStatus] = useState(initialStatus);
  const [step, setStep] = useState<Step>(() => firstOpenStep(initialStatus));
  const [importAnother, setImportAnother] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');

  // Work done elsewhere (the schedule page, another import) bumps the revision; keep the checklist honest.
  const firstRevision = React.useRef(workspace.revision);
  useEffect(() => {
    if (workspace.revision === firstRevision.current) return;
    let active = true;
    Promise.all([api.getCatalogStats(), api.getStrategies()])
      .then(([stats, strategies]) => {
        if (!active) return;
        setStatus((s) => ({
          ...s,
          problemCount: stats.totalProblems,
          hasSchedule: strategies.some((item) => !item.deleted && item.weekdays.length > 0),
        }));
      })
      .catch(() => {
        // Keep the last known status; the user can still continue or skip.
      });
    return () => {
      active = false;
    };
  }, [workspace.revision]);

  const done = [Boolean(status.timezone), status.problemCount > 0, status.hasSchedule];
  const steps = [
    { title: zh ? '时区' : 'Timezone' },
    { title: zh ? '题库' : 'Problems' },
    { title: zh ? '学习节奏' : 'Study rhythm' },
  ];

  const goTo = (next: Step) => {
    setError('');
    setImportAnother(false);
    setStep(next);
  };


  /** Create and schedule the weekday preset; validation mirrors the strategy editor. */
  async function applyPreset() {
    if (creating) return;
    setCreating(true);
    setError('');
    try {
      const parsed = strategyInputSchema.safeParse(presetStrategy(lang));
      if (!parsed.success) throw new Error(zh ? '预设无效。' : 'The preset is invalid.');
      await api.createStrategy(parsed.data);
      workspace.notifyMutation();
      setStatus((s) => ({ ...s, hasSchedule: true }));
      setStep(3);
    } catch (err) {
      setError(localizeApiError(err, lang));
    } finally {
      setCreating(false);
    }
  }

  const finish = (openAi: boolean) => {
    onClose();
    if (openAi) onOpenAiSettings();
    else onFinish();
  };

  return (
    <div className="setup-guide">
      <header className="setup-header">
        <div>
          <h1>{zh ? '欢迎使用 LeetCode Tracker' : 'Welcome to LeetCode Tracker'}</h1>
          <p className="page-description">
            {zh ? '三步完成设置，然后就能拿到第一份每日计划。' : 'Three quick steps to your first daily plan.'}
          </p>
        </div>
        {step !== 3 && (
          <button type="button" className="text-link" onClick={() => finish(false)}>
            {zh ? '跳过设置' : 'Skip setup'}
          </button>
        )}
      </header>

      <ol className="setup-steps" aria-label={zh ? '设置步骤' : 'Setup steps'}>
        {steps.map((item, index) => (
          <li key={item.title}>
            <button
              type="button"
              className={`setup-step${step === index ? ' is-active' : ''}${done[index] ? ' is-done' : ''}`}
              aria-current={step === index ? 'step' : undefined}
              onClick={() => goTo(index as Step)}
            >
              <span className="setup-step-index" aria-hidden="true">
                {done[index] ? <Check size={14} /> : index + 1}
              </span>
              <span>{item.title}</span>
              <span className="visually-hidden">
                {done[index] ? (zh ? '（已完成）' : ' (done)') : ''}
              </span>
            </button>
          </li>
        ))}
      </ol>

      {error && <Feedback>{error}</Feedback>}

      <section className="setup-panel" aria-live="polite">
        {step === 0 && (
          <>
            <h2>{zh ? '你的一天从哪个时区开始？' : 'Which timezone is your day in?'}</h2>
            <p className="setup-lead">
              {zh
                ? '每日计划在你所在时区的零点刷新。选择后会立即保存。'
                : 'Your daily plan rolls over at midnight in this timezone. Your choice is saved right away.'}
            </p>
            <div className="setup-field">
              <TimezoneField
                id="setup-timezone"
                hideLabel
                lang={lang}
                value={status.timezone}
                onSaved={(zone) => {
                  setStatus((s) => ({ ...s, timezone: zone }));
                  onTimezoneSaved(zone);
                }}
              />
            </div>
            <div className="setup-preferences">
              <div className="segmented-control" aria-label={zh ? '界面语言' : 'Language'}>
                <button type="button" aria-pressed={zh} onClick={() => onLanguageChange('zh')}>
                  简体中文
                </button>
                <button type="button" aria-pressed={!zh} onClick={() => onLanguageChange('en')}>
                  English
                </button>
              </div>
              <div className="segmented-control" aria-label={zh ? '界面模式' : 'Interface mode'}>
                {(['light', 'dark', 'system'] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    aria-pressed={theme === mode}
                    onClick={() => {
                      const nextPalette = paletteForMode(palette, mode);
                      if (nextPalette !== palette) onPaletteChange(nextPalette);
                      onThemeChange(mode);
                    }}
                  >
                    {mode === 'light' ? (zh ? '浅色' : 'Light') : mode === 'dark' ? (zh ? '深色' : 'Dark') : (zh ? '跟随系统' : 'System')}
                  </button>
                ))}
              </div>
            </div>
            <div className="setup-actions">
              <span />
              <button type="button" className="btn btn-primary" disabled={!done[0]} onClick={() => goTo(1)}>
                {zh ? '下一步' : 'Continue'}
              </button>
            </div>
          </>
        )}

        {step === 1 && (
          <>
            <h2>{zh ? '导入你的题库' : 'Bring your problem list'}</h2>
            <p className="setup-lead">
              {zh
                ? '应用不内置题目。导入一份你自己的 JSONL 文件，每行一道题。'
                : 'The app ships without problems. Import a JSONL file you own, one problem per line.'}
            </p>
            {done[1] && !importAnother ? (
              <div className="setup-done-note">
                <CheckCircle2 size={18} aria-hidden="true" />
                <span>
                  {zh ? `题库已有 ${status.problemCount} 道题。` : `Your catalog has ${status.problemCount} problems.`}
                </span>
                <button type="button" className="text-link" onClick={() => setImportAnother(true)}>
                  {zh ? '再导入一个文件' : 'Import another file'}
                </button>
              </div>
            ) : (
              <React.Suspense fallback={<p role="status">{zh ? '加载中…' : 'Loading…'}</p>}>
                <CatalogImportWorkspace lang={lang} embedded onCommitted={(summary) => {
                    const added = summary.insertedCount + summary.updatedCount + summary.unchangedCount;
                    setStatus((s) => ({ ...s, problemCount: Math.max(s.problemCount, added) }));
                    setImportAnother(false);
                  }} />
              </React.Suspense>
            )}
            <div className="setup-actions">
              <button type="button" className="btn btn-secondary" onClick={() => goTo(0)}>
                {zh ? '上一步' : 'Back'}
              </button>
              {done[1] ? (
                <button type="button" className="btn btn-primary" onClick={() => goTo(2)}>
                  {zh ? '下一步' : 'Continue'}
                </button>
              ) : (
                <button type="button" className="text-link" onClick={() => goTo(2)}>
                  {zh ? '稍后再导入' : 'Skip for now'}
                </button>
              )}
            </div>
          </>
        )}

        {step === 2 && (
          <>
            <h2>{zh ? '选择你的学习节奏' : 'Pick a study rhythm'}</h2>
            <p className="setup-lead">
              {zh
                ? '学习安排决定每天推荐几道题、什么难度。以后可以随时调整。'
                : 'Your schedule decides how many problems you get each day, and how hard. You can change it any time.'}
            </p>
            {done[2] ? (
              <div className="setup-done-note">
                <CheckCircle2 size={18} aria-hidden="true" />
                <span>{zh ? '学习安排已设置。' : 'Your study schedule is set.'}</span>
              </div>
            ) : (
              <div className="setup-choices">
                <div className="setup-choice is-recommended">
                  <span className="setup-choice-tag">{zh ? '推荐' : 'Recommended'}</span>
                  <h3>{zh ? '工作日，每天 3 题' : 'Weekdays, 3 a day'}</h3>
                  <p>
                    {zh
                      ? '周一至周五：1 道简单、2 道中等，其中 1 道用于复习。周末休息。'
                      : 'Monday to Friday: 1 Easy and 2 Medium, one of them a review. Weekends off.'}
                  </p>
                  <button type="button" className="btn btn-primary" disabled={creating} onClick={() => void applyPreset()}>
                    {creating ? '…' : zh ? '使用这个节奏' : 'Use this rhythm'}
                  </button>
                </div>
                <div className="setup-choice">
                  <h3>{zh ? '自己定制' : 'Make your own'}</h3>
                  <p>
                    {zh
                      ? '设置每天题量、难度比例、标签和复习方式，并分配到星期几。'
                      : 'Set the daily count, difficulty mix, tags and review, then assign weekdays.'}
                  </p>
                  <button type="button" className="btn btn-secondary" onClick={() => workspace.navigate('schedule')}>
                    <CalendarDays size={16} aria-hidden="true" />
                    {zh ? '打开学习安排' : 'Open study schedule'}
                  </button>
                </div>
              </div>
            )}
            <div className="setup-actions">
              <button type="button" className="btn btn-secondary" onClick={() => goTo(1)}>
                {zh ? '上一步' : 'Back'}
              </button>
              {done[2] ? (
                <button type="button" className="btn btn-primary" onClick={() => goTo(3)}>
                  {zh ? '下一步' : 'Continue'}
                </button>
              ) : (
                <button type="button" className="text-link" onClick={() => goTo(3)}>
                  {zh ? '稍后再设置' : 'Skip for now'}
                </button>
              )}
            </div>
          </>
        )}

        {step === 3 && (
          <>
            <h2>
              {done.every(Boolean)
                ? zh ? '一切就绪' : 'You’re all set'
                : zh ? '基本完成' : 'Almost there'}
            </h2>
            <p className="setup-lead">
              {done.every(Boolean)
                ? zh
                  ? '每日计划会按你的时区和学习节奏生成，休息日不安排题目。'
                  : 'Daily plans follow your timezone and study rhythm. Rest days stay free.'
                : zh
                  ? '还有步骤没完成，你可以随时回到上面的步骤，或者之后在对应页面补上。'
                  : 'Some steps are still open. Go back above, or finish them later from their pages.'}
            </p>
            <div className="setup-ai-note">
              <Sparkles size={18} aria-hidden="true" />
              <div>
                <strong>{zh ? 'AI 助手是可选的' : 'AI is optional'}</strong>
                <p>
                  {zh
                    ? '不配置也能完整使用，计划由本地规则生成。接入 Gemini、OpenAI 或 DeepSeek 后，选题和讲解会更贴合你。'
                    : 'Everything works without it; plans come from local rules. Connect Gemini, OpenAI or DeepSeek for better-tailored picks and explanations.'}
                </p>
              </div>
            </div>
            <div className="setup-actions">
              <button type="button" className="btn btn-secondary" onClick={() => finish(true)}>
                <Settings2 size={16} aria-hidden="true" />
                {zh ? '配置 AI' : 'Set up AI'}
              </button>
              <button type="button" className="btn btn-primary" onClick={() => finish(false)}>
                {zh ? '前往今日' : 'Go to Today'}
              </button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
