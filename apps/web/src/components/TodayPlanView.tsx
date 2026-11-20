import React, { useEffect, useId, useRef, useState } from 'react';
import {
  RefreshCw,
  CalendarDays,
  ListChecks,
  MoreHorizontal,
  Coffee,
  Globe,
  CheckCircle2,
  Plus,
  AlertTriangle,
  ChevronDown,
} from 'lucide-react';
import { api, ApiError, type DailyPlan, type PlanItem, type Strategy } from '../api.ts';
import { localizeApiError } from '../error-i18n.ts';
import { formatPlanAction, formatPlanSource, translations, type Language } from '../i18n.ts';
import { formatInstant } from '../date-format.ts';
import { PromptOverrideModal } from './PromptOverrideModal.tsx';
import { useDailyPlan, type UseDailyPlanReturn } from '../hooks/useDailyPlan.ts';
import { useEncouragement } from '../hooks/useEncouragement.ts';
import { useWorkspace } from '../workspace.tsx';
import { createPractice } from '../practice-service.ts';
import { clearPendingMinutes, getPendingMinutes, stopTimerFor } from '../timer-service.ts';
import { Dialog, Feedback, PageHeader, InfoPopover } from './ui.tsx';
import { TodayGoalLists } from './TodayGoalLists.tsx';
import { TodayOverview } from './TodayOverview.tsx';
import { useTodayGoals } from '../hooks/useTodayGoals.ts';
import { TodayProblemRow } from './TodayProblemRow.tsx';
import { QuickNoteDrawer } from './QuickNoteDrawer.tsx';
import type { RecommendationFeedbackReason } from '../../../../packages/contracts/src/recommendations.ts';

interface TodayPlanViewProps {
  lang: Language;
  onNavigateToSettings: () => void;
  onNavigateToDashboard?: () => void;
  planController?: UseDailyPlanReturn;
  /** Whether clicking swap or remove on a problem prompts for optional feedback. Defaults to true. */
  promptSwapFeedback?: boolean;
}

const FEEDBACK_REASONS: Array<{
  value: RecommendationFeedbackReason;
  en: string;
  zh: string;
}> = [
  { value: 'time_unavailable', en: 'Time unavailable', zh: '时间不足' },
  { value: 'already_familiar', en: 'Already familiar', zh: '已经熟悉' },
  { value: 'topic_mismatch', en: 'Topic mismatch', zh: '专题不匹配' },
  { value: 'too_difficult', en: 'Too difficult', zh: '过于困难' },
  { value: 'other', en: 'Other', zh: '其他' },
];

/** Optional reason selector shared between swap/remove feedback and completed-item removal dialogs. */
function FeedbackReasonField({
  lang,
  value,
  onChange,
  disabled = false,
}: {
  lang: Language;
  value: RecommendationFeedbackReason | '';
  onChange: (value: RecommendationFeedbackReason | '') => void;
  disabled?: boolean;
}) {
  const zh = lang === 'zh';
  const selectId = useId();
  const helpId = `${selectId}-help`;

  return (
    <div className="form-field">
      <label htmlFor={selectId}>{zh ? '反馈原因（可选）' : 'Reason (optional)'}</label>
      <select
        id={selectId}
        className="form-input"
        value={value}
        disabled={disabled}
        aria-describedby={helpId}
        onChange={(event) => onChange(event.target.value as RecommendationFeedbackReason | '')}
      >
        <option value="">{zh ? '不提供原因' : 'No reason'}</option>
        {FEEDBACK_REASONS.map((option) => (
          <option key={option.value} value={option.value}>
            {zh ? option.zh : option.en}
          </option>
        ))}
      </select>
      <small id={helpId} className="text-muted">
        {zh
          ? '仅在确认操作时保存；不是练习失败，也不会改变掌握评估。'
          : 'Optional. Saved only when confirmed; this is not a failed attempt and does not change mastery evidence.'}
      </small>
    </div>
  );
}

/** Quiet, single-line notice strip for candidate shortages and per-difficulty scheduling notes. */
function PlanNoticesStrip({ plan, lang }: { plan: DailyPlan; lang: Language }) {
  const zh = lang === 'zh';
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();

  const shortageCount = Math.max(0, plan.rules.dailyCount - plan.items.length);
  const noticeTexts = plan.notices.map((notice) => notice[lang] || notice.en).filter(Boolean);

  useEffect(() => {
    setExpanded(false);
  }, [plan.id]);

  if (shortageCount === 0 && noticeTexts.length === 0) return null;

  const summaryText =
    shortageCount > 0
      ? zh
        ? `今日计划缺口 ${shortageCount} 题（已生成题目仍可练习）`
        : `${shortageCount} ${shortageCount === 1 ? 'problem' : 'problems'} short today (generated items ready)`
      : noticeTexts[0];

  const details = shortageCount > 0 ? noticeTexts : noticeTexts.slice(1);
  const toggleLabel =
    shortageCount > 0
      ? zh
        ? `详情 (${details.length})`
        : `Details (${details.length})`
      : zh
        ? `其余 ${details.length} 项`
        : `+${details.length} more`;

  return (
    <div className="plan-notice-strip" role="status">
      <div className="plan-notice-row">
        <div className="plan-notice-summary">
          <AlertTriangle size={15} className="plan-notice-icon" aria-hidden="true" />
          <span className="plan-notice-text">{summaryText}</span>
        </div>
        {details.length > 0 && (
          <button
            type="button"
            className="plan-notice-toggle"
            aria-expanded={expanded}
            aria-controls={detailsId}
            onClick={() => setExpanded((open) => !open)}
          >
            <span>{toggleLabel}</span>
            <ChevronDown size={14} aria-hidden="true" />
          </button>
        )}
      </div>
      {expanded && details.length > 0 && (
        <ul id={detailsId} className="plan-notice-details">
          {details.map((text, index) => (
            <li key={index}>{text}</li>
          ))}
        </ul>
      )}
    </div>
  );
}


/** Due reviews left out by today's review cap, with an explicit action to pull one in. */
function ReviewBacklogRow({ plan, lang, disabled, onAddReview }: {
  plan: DailyPlan; lang: Language; disabled: boolean; onAddReview: () => void;
}) {
  const count = plan.reviewBacklog ?? 0;
  if (count <= 0) return null;
  const zh = lang === 'zh';
  return (
    <div className="plan-notice-strip" role="status">
      <div className="plan-notice-row">
        <div className="plan-notice-summary">
          <span className="plan-notice-text">
            {zh ? `另有 ${count} 道到期复习超出今日复习上限` : `${count} more due ${count === 1 ? 'review is' : 'reviews are'} past today's review cap`}
          </span>
        </div>
        <button type="button" className="plan-notice-toggle" disabled={disabled} onClick={onAddReview}>
          <Plus size={14} aria-hidden="true" />
          <span>{zh ? '加一道复习' : 'Add a review'}</span>
        </button>
      </div>
    </div>
  );
}

/** Keep plan refreshes independent of language/theme, and scope save state to a single task row. */
function TodayPlanViewInner({
  lang,
  onNavigateToSettings,
  planController: controller,
  promptSwapFeedback = true,
}: TodayPlanViewProps & { planController: UseDailyPlanReturn }) {
  const zh = lang === 'zh';
  const t = translations[lang];
  const workspace = useWorkspace();
  const goals = useTodayGoals(lang);
  const nextGoalRow = useRef<HTMLLIElement>(null);
  const quote = useEncouragement({ timeZone: workspace.timezone, lang });
  const [override, setOverride] = useState(false);
  const [versions, setVersions] = useState<DailyPlan[] | null>(null);
  const [localError, setLocalError] = useState('');
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<Set<string>>(new Set());
  const [recentCompletions, setRecentCompletions] = useState<Set<string>>(new Set());
  const [quickNoteProblem, setQuickNoteProblem] = useState<PlanItem | null>(null);
  const [pendingAction, setPendingAction] = useState<{ type: 'replace' | 'remove'; item: PlanItem } | null>(null);
  const [actionReason, setActionReason] = useState<RecommendationFeedbackReason | ''>('');
  const [problemToRemove, setProblemToRemove] = useState<PlanItem | null>(null);
  const [removalReason, setRemovalReason] = useState<RecommendationFeedbackReason | ''>('');
  const completionTimers = useRef(new Set<ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const clearFeedback = () => {
      completionTimers.current.forEach(clearTimeout);
      completionTimers.current.clear();
      setRecentCompletions(new Set());
    };
    window.addEventListener('hashchange', clearFeedback);
    return () => {
      window.removeEventListener('hashchange', clearFeedback);
      completionTimers.current.forEach(clearTimeout);
    };
  }, []);
  const locks = useRef(new Set<string>());
  const [strategies, setStrategies] = useState<Strategy[] | null>(null);
  const [strategyRetry, setStrategyRetry] = useState(0);
  useEffect(() => {
    let active = true;
    api
      .getStrategies()
      .then((items) => {
        if (active) setStrategies(items);
      })
      .catch((err) => {
        if (active) setLocalError(localizeApiError(err, lang));
      });
    return () => {
      active = false;
    };
  }, [workspace.revision, strategyRetry]);
  // An empty catalog leaves plans nothing to pick from; say so instead of showing a bare rest day.
  const [catalogEmpty, setCatalogEmpty] = useState(false);
  useEffect(() => {
    let active = true;
    api
      .getCatalogStats()
      .then((stats) => {
        if (active) setCatalogEmpty(stats.totalProblems === 0);
      })
      .catch(() => {
        // Catalog views report their own failures; this hint is best-effort.
      });
    return () => {
      active = false;
    };
  }, [workspace.revision]);
  const plan = controller.ensureResult?.plan;
  const completed = plan?.items.filter((item) => item.completed).length ?? 0;
  const strategy = strategies?.find((s) => s.id === plan?.strategyId);

  /** The base record succeeds before optional fields open; uncertain retries reuse the original timestamp. */
  async function complete(item: PlanItem) {
    if (
      !plan ||
      locks.current.has(item.id) ||
      controller.appending ||
      controller.isPlanMutationPending()
    ) return;
    if (item.completed) {
      workspace.openPractice({ mode: 'evidence', item });
      return;
    }
    locks.current.add(item.id);
    setSaving(new Set(locks.current));
    setRowErrors((old) => ({ ...old, [item.id]: '' }));
    // Clicking the completion circle also stops a running timer for this problem;
    // its minutes travel with the enrich form instead of being silently dropped.
    const stopped = stopTimerFor(item.problem.questionFrontendId);
    const elapsedMinutes =
      stopped?.minutes ?? getPendingMinutes(item.problem.questionFrontendId) ?? undefined;
    try {
      const record = await createPractice('today:' + plan.id + ':' + item.id, {
        todayItem: { planId: plan.id, itemId: item.id },
        questionFrontendId: item.problem.questionFrontendId,
        completed: true,
        practicedAt: new Date().toISOString(),
        timePrecision: 'datetime',
      });
      if (elapsedMinutes != null) clearPendingMinutes(item.problem.questionFrontendId);
      setRecentCompletions((ids) => new Set([...ids, item.id]));
      const timer = setTimeout(() => {
        setRecentCompletions((ids) => { const next = new Set(ids); next.delete(item.id); return next; });
        completionTimers.current.delete(timer);
      }, 240);
      completionTimers.current.add(timer);
      workspace.notifyMutation(record);
      workspace.openPractice({ mode: 'enrich', record, elapsedMinutes });
    } catch (err) {
      setRowErrors((old) => ({ ...old, [item.id]: localizeApiError(err, lang) }));
      if (err instanceof ApiError && err.code === 'STALE_PLAN') workspace.notifyMutation();
    } finally {
      locks.current.delete(item.id);
      setSaving(new Set(locks.current));
    }
  }
  /** Version history is read-only; failure leaves the current plan and all rows in place. */
  async function showVersions() {
    if (!plan) return;
    try {
      setVersions(await api.getPlanVersions(plan.id));
    } catch (err) {
      setLocalError(localizeApiError(err, lang));
    }
  }

  /** Execute uncompleted problem removal directly and notify workspace observers. */
  async function executeRemoveUncompleted(target: PlanItem, reason?: RecommendationFeedbackReason) {
    try {
      await controller.removeOne(target, reason);
      workspace.notifyMutation();
    } catch (err) {
      setRowErrors((old) => ({
        ...old,
        [target.id]: localizeApiError(err, lang),
      }));
    }
  }

  /**
   * Handle single-problem replacement.
   * When swap feedback prompting is enabled, opens an optional reason modal before replacing.
   */
  function handleReplaceClick(target: PlanItem, explicitReason?: RecommendationFeedbackReason) {
    if (
      controller.appending ||
      controller.isPlanMutationPending() ||
      saving.size > 0
    ) return;
    if (explicitReason !== undefined || !promptSwapFeedback) {
      void controller.replaceOne(target, explicitReason);
      return;
    }
    setActionReason('');
    setPendingAction({ type: 'replace', item: target });
  }

  /**
   * Handle problem removal.
   * Completed problems always require confirmation (removal revokes practice records); when enabled,
   * the optional feedback selector is embedded in that confirmation dialog to avoid double modals.
   * Uncompleted problems prompt for optional feedback when enabled, or remove immediately when disabled.
   */
  async function handleRemoveItem(target: PlanItem, explicitReason?: RecommendationFeedbackReason) {
    if (
      !plan ||
      controller.appending ||
      controller.isPlanMutationPending() ||
      Boolean(controller.removingItemId) ||
      saving.size > 0
    ) return;

    if (target.completed) {
      setRemovalReason(explicitReason ?? '');
      setProblemToRemove(target);
      return;
    }

    if (explicitReason !== undefined || !promptSwapFeedback) {
      await executeRemoveUncompleted(target, explicitReason);
      return;
    }

    setActionReason('');
    setPendingAction({ type: 'remove', item: target });
  }

  function confirmPendingAction() {
    if (!pendingAction) return;
    const { type, item } = pendingAction;
    const reason = actionReason || undefined;
    setPendingAction(null);
    setActionReason('');
    if (type === 'replace') {
      void controller.replaceOne(item, reason);
    } else {
      void executeRemoveUncompleted(item, reason);
    }
  }

  async function confirmRemoveCompleted() {
    if (!problemToRemove) return;
    const target = problemToRemove;
    const reason = removalReason || undefined;
    try {
      await controller.removeOne(target, reason);
      workspace.notifyMutation();
      setProblemToRemove(null);
      setRemovalReason('');
    } catch (err) {
      setRowErrors((old) => ({
        ...old,
        [target.id]: localizeApiError(err, lang),
      }));
      setProblemToRemove(null);
      setRemovalReason('');
    }
  }
  return (
    <div className="today-view">
      <PageHeader
        title={zh ? '今日' : 'Today'}
        description={quote.text || undefined}
        actions={
          <button className="btn btn-secondary" onClick={() => workspace.navigate('schedule')}>
            <CalendarDays size={16} />
            {zh ? '学习安排' : 'Study schedule'}
          </button>
        }
      />
      <TodayOverview lang={lang} plan={plan} planStatus={controller.error && !plan ? 'error' : controller.ensureResult?.status}
        goal={goals.list} goalsLoaded={goals.loaded} goalsError={Boolean(goals.error)} onJumpToGoal={() => {
          const row = nextGoalRow.current;
          (row?.querySelector<HTMLAnchorElement>('a.problem-title-link') ?? row)?.focus();
        }} />
      <div className="today-task-columns">
        <section className="today-strategy-tasks" aria-labelledby="strategy-tasks-title">
          <div className="today-task-heading">
            <h2 id="strategy-tasks-title"><ListChecks size={19} aria-hidden="true" />{zh ? '策略练习' : 'Strategy tasks'}</h2>
            {plan && (
              <div className="strategy-capsule">
                <span className="strategy-capsule-name">
                  {strategy?.name ?? (zh ? '临时计划' : 'Temporary plan')}
                  {' · '}
                  {plan.source === 'local'
                    ? zh
                      ? '本地推荐'
                      : 'Local'
                    : `${({ gemini: 'Gemini', openai: 'OpenAI', deepseek: 'DeepSeek' })[plan.source] ?? plan.source}`}
                </span>
                <InfoPopover
                  label={zh ? '计划详情' : 'Plan details'}
                  content={
                    <dl className="detail-grid">
                      <dt>{zh ? '时区' : 'Timezone'}</dt><dd>{plan.timezone}</dd>
                      <dt>{zh ? '计划版本' : 'Plan version'}</dt><dd>v{plan.version}</dd>
                      <dt>{zh ? '策略版本' : 'Strategy version'}</dt><dd>{plan.strategyVersion ?? '—'}</dd>
                    </dl>
                  }
                />
              </div>
            )}
          </div>
          {(controller.error || localError) && (
            <Feedback
              retry={{
                label: t.retry,
                run: () => {
                  setLocalError('');
                  setStrategyRetry((value) => value + 1);
                  controller.clearError?.();
                  void controller.refresh();
                },
              }}
            >
              {controller.error || localError}
            </Feedback>
          )}
          {catalogEmpty && controller.ensureResult?.status !== 'setup' && (
            <Feedback tone="info">
              {zh ? '题库还是空的，每日计划暂时没有题目可选。' : 'Your problem catalog is empty, so daily plans have nothing to pick from.'}{' '}
              <button className="text-link" onClick={() => workspace.navigate('catalog-import')}>
                {zh ? '导入题库' : 'Import problems'}
              </button>
            </Feedback>
          )}
          {controller.loading && !plan ? (
            <div className="plan-skeleton" role="status">
              <RefreshCw className="spin" size={20} />
              <p>{zh ? '正在准备今日计划…' : 'Preparing today’s plan…'}</p>
              <div />
              <div />
              <div />
            </div>
          ) : controller.ensureResult?.status === 'setup' ? (
            <section className="empty-state">
              <div className="empty-state-icon">
                <Globe size={40} className="text-indigo" />
              </div>
              <h2>{t.setupTimezoneTitle}</h2>
              <p>{t.setupTimezoneDesc}</p>
              <button className="btn btn-primary" onClick={onNavigateToSettings}>
                {zh ? '设置时区' : 'Set timezone'}
              </button>
            </section>
          ) : controller.ensureResult?.status === 'rest' ? (
            <section className="empty-state">
              <div className="empty-state-icon">
                <Coffee size={40} className="text-muted" />
              </div>
              <h2>
                {strategies?.length === 0 ? (zh ? '还没有学习安排' : 'No study schedule yet') : t.restDayTitle}
              </h2>
              <p>
                {strategies?.length === 0
                  ? zh
                    ? '选择适合自己的节奏，配置后再开始。'
                    : 'Choose your study rhythm when you’re ready.'
                  : t.restDayDesc}
              </p>
              <div className="action-row">
                <button className="btn btn-primary" onClick={() => workspace.navigate('schedule')}>
                  {zh ? '设置学习安排' : 'Set study schedule'}
                </button>
                <button className="btn btn-secondary" onClick={() => setOverride(true)}>
                  {t.createTemporaryPlan}
                </button>
              </div>
            </section>
          ) : plan && plan.items.length === 0 ? (
            <section className="empty-state">
              <div className="empty-state-icon">
                <Coffee size={40} className="text-muted" />
              </div>
              <h2>{t.restDayTitle}</h2>
              <p>{t.allProblemsRemovedRestDesc}</p>
              <div className="action-row">
                <button
                  className="btn btn-primary"
                  disabled={
                    controller.loading ||
                    controller.appending ||
                    controller.isPlanMutationPending() ||
                    controller.replacingBatch ||
                    Boolean(controller.replacingItemId) ||
                    saving.size > 0
                  }
                  aria-busy={controller.appending}
                  onClick={() => {
                    if (
                      controller.loading ||
                      controller.appending ||
                      controller.isPlanMutationPending() ||
                      saving.size > 0
                    ) return;
                    void controller.appendOne();
                  }}
                >
                  {controller.appending ? (
                    <RefreshCw size={16} className="spin" />
                  ) : (
                    <Plus size={16} />
                  )}
                  {controller.appending
                    ? zh
                      ? '加题中…'
                      : 'Adding…'
                    : zh
                      ? '加一题'
                      : 'Add one'}
                </button>
                <button
                  className="btn btn-secondary"
                  disabled={
                    controller.loading ||
                    controller.appending ||
                    controller.isPlanMutationPending()
                  }
                  onClick={() => {
                    if (
                      controller.loading ||
                      controller.appending ||
                      controller.isPlanMutationPending()
                    ) return;
                    setOverride(true);
                  }}
                >
                  {zh ? '调整今天' : 'Adjust today'}
                </button>
                <button className="btn btn-secondary" onClick={showVersions}>
                  {t.planVersions} · v{plan.version}
                </button>
              </div>
            </section>
          ) : plan ? (
            <>
              {completed === plan.items.length && plan.items.length > 0 && (
                <div className="goal-completion-badge" role="status" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <CheckCircle2 size={18} className="goal-badge-icon" />
                    <span>{zh ? '今日计划已完成' : 'Today’s plan complete'}</span>
                  </div>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    style={{ fontSize: '0.8125rem' }}
                    onClick={() => workspace.navigate('notes')}
                  >
                    {zh ? '前往复盘工作区整理思路 →' : 'Organize Notes & Solutions →'}
                  </button>
                </div>
              )}
              <div className="strategy-list-controls">
                <div className="plan-actions-toolbar">
                  <button
                    className="btn btn-primary btn-sm"
                    disabled={
                      controller.loading ||
                      controller.appending ||
                      controller.isPlanMutationPending() ||
                      controller.replacingBatch ||
                      Boolean(controller.replacingItemId) ||
                      saving.size > 0
                    }
                    aria-busy={controller.appending}
                    onClick={() => {
                      if (
                        controller.loading ||
                        controller.appending ||
                        controller.isPlanMutationPending() ||
                        saving.size > 0
                      ) return;
                      void controller.appendOne();
                    }}
                  >
                    {controller.appending ? (
                      <RefreshCw size={14} className="spin" />
                    ) : (
                      <Plus size={14} />
                    )}
                    {controller.appending
                      ? zh
                        ? '加题中…'
                        : 'Adding…'
                      : zh
                        ? '加一题'
                        : 'Add one'}
                  </button>
                  <button
                    className="btn btn-secondary btn-sm"
                    disabled={
                      controller.loading ||
                      controller.appending ||
                      controller.isPlanMutationPending()
                    }
                    onClick={() => {
                      if (
                        controller.loading ||
                        controller.appending ||
                        controller.isPlanMutationPending()
                      ) return;
                      setOverride(true);
                    }}
                  >
                    {zh ? '调整今天' : 'Adjust today'}
                  </button>
                  <details className="action-menu">
                    <summary aria-label={zh ? '更多计划操作' : 'More plan actions'}>
                      <MoreHorizontal size={18} />
                    </summary>
                    <div>
                      <button
                        disabled={
                          controller.replacingBatch ||
                          Boolean(controller.replacingItemId) ||
                          controller.appending ||
                          controller.isPlanMutationPending() ||
                          completed === plan.items.length ||
                          saving.size > 0
                        }
                        onClick={() => {
                          if (
                            controller.appending ||
                            controller.isPlanMutationPending() ||
                            saving.size > 0
                          ) return;
                          void controller.replaceAllUnfinished();
                        }}
                      >
                        {t.replaceAllUnfinished}
                      </button>
                      <button onClick={showVersions}>
                        {t.planVersions} · v{plan.version}
                      </button>
                    </div>
                  </details>
                </div>
              </div>
              {plan.timeEstimate && !plan.timeEstimate.feasible && (
                <section className="form-group" aria-label={zh ? '计划用时估计' : 'Plan effort estimate'}>
                  <Feedback tone="warning">
                    <p>{zh ? '预计用时超出预算，题数与难度保持不变。' : 'The estimate exceeds your budget. Counts and difficulty remain unchanged.'}</p>
                    <button type="button" className="btn btn-secondary" disabled={controller.isPlanMutationPending()} onClick={() => setOverride(true)}>{zh ? '明确调整题数或预算' : 'Adjust count or budget'}</button>
                  </Feedback>
                </section>
              )}
              <PlanNoticesStrip plan={plan} lang={lang} />
              <ReviewBacklogRow
                plan={plan}
                lang={lang}
                disabled={controller.loading || controller.appending || controller.isPlanMutationPending() || saving.size > 0}
                onAddReview={() => {
                  if (controller.loading || controller.appending || controller.isPlanMutationPending() || saving.size > 0) return;
                  void controller.appendOne('review');
                }}
              />
              <div className="today-problems">
                {plan.items.map((item) => (
                  <TodayProblemRow
                    key={item.id}
                    item={item}
                    lang={lang}
                    isSaving={saving.has(item.id)}
                    justCompleted={recentCompletions.has(item.id)}
                    rowError={rowErrors[item.id]}
                    replacingBatch={controller.replacingBatch}
                    replacingItemId={controller.replacingItemId}
                    isAppending={controller.appending || controller.isPlanMutationPending()}
                    canRemove={true}
                    isRemoving={controller.removingItemId === item.id}
                    onComplete={(target) => void complete(target)}
                    onReplaceOne={(target, reason) => handleReplaceClick(target, reason)}
                    onRemove={(target, reason) => void handleRemoveItem(target, reason)}
                    onOpenQuickNote={(target) => setQuickNoteProblem(target)}
                  />
                ))}
              </div>
            </>
          ) : (
            !controller.error && (
              <section className="empty-state">
                <h2>{t.noPlans}</h2>
                <button className="btn btn-primary" onClick={() => void controller.refresh()}>
                  {t.retry}
                </button>
              </section>
            )
          )}
        </section>
        <TodayGoalLists lang={lang} goals={goals} nextTaskRef={nextGoalRow} />
      </div>
      {versions && (
        <Dialog title={t.planVersions} lang={lang} onClose={() => setVersions(null)} drawer>
          {versions.map((version) => (
            <article className="version-card" key={version.version}>
              <p className="muted">
                {formatPlanSource(version.source, lang)} · {version.model ?? (zh ? '本地' : 'Local')} ·{' '}
                {zh ? '策略版本' : 'Strategy version'} {version.strategyVersion ?? '—'}
              </p>
              <h3>
                v{version.version} · {formatPlanAction(version.action, lang)}
              </h3>
              <p className="muted">
                {formatInstant(version.updatedAt, lang, { timeZone: version.timezone })}
              </p>
              <ul>
                {version.items.map((item) => (
                  <li key={item.id}>
                    {item.problem.questionFrontendId}. {item.problem.title}
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </Dialog>
      )}
      {quickNoteProblem && (
        <QuickNoteDrawer
          lang={lang}
          problem={{
            frontendId: quickNoteProblem.problem.questionFrontendId,
            title: quickNoteProblem.problem.title,
            url: quickNoteProblem.problem.url,
            difficulty: quickNoteProblem.problem.difficulty,
            tags: quickNoteProblem.problem.topicTags.map((t) => t.name),
          }}
          latestPracticeNotes={null}
          onClose={() => setQuickNoteProblem(null)}
          onOpenWorkspace={(frontendId) => {
            setQuickNoteProblem(null);
            workspace.navigate('notes', frontendId);
          }}
        />
      )}
      <PromptOverrideModal
        isOpen={override}
        onClose={() => setOverride(false)}
        currentPlan={plan ?? null}
        lang={lang}
        onApplied={(newPlan) => {
          controller.onOverrideCommitted(newPlan);
          workspace.notifyMutation();
        }}
      />
      {pendingAction && (
        <Dialog
          title={
            pendingAction.type === 'replace'
              ? zh
                ? '换一题'
                : 'Swap problem'
              : zh
                ? '移除题目'
                : 'Remove problem'
          }
          onClose={() => {
            setPendingAction(null);
            setActionReason('');
          }}
          lang={lang}
          footer={
            <div className="action-dialog-footer">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => {
                  setPendingAction(null);
                  setActionReason('');
                }}
              >
                {t.cancel}
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={confirmPendingAction}
              >
                {pendingAction.type === 'replace'
                  ? zh
                    ? '确认换题'
                    : 'Confirm swap'
                  : zh
                    ? '确认移除'
                    : 'Confirm removal'}
              </button>
            </div>
          }
        >
          <div className="action-dialog-body">
            <div className="action-dialog-problem">
              <strong>
                {pendingAction.item.problem.questionFrontendId}. {pendingAction.item.problem.title}
              </strong>
            </div>
            <FeedbackReasonField
              lang={lang}
              value={actionReason}
              onChange={setActionReason}
            />
          </div>
        </Dialog>
      )}
      {problemToRemove && (
        <Dialog
          title={t.confirmRemoveCompletedTitle}
          onClose={() => {
            setProblemToRemove(null);
            setRemovalReason('');
          }}
          lang={lang}
          closeDisabled={Boolean(controller.removingItemId)}
          footer={
            <div className="action-dialog-footer">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => {
                  setProblemToRemove(null);
                  setRemovalReason('');
                }}
                disabled={Boolean(controller.removingItemId)}
              >
                {t.cancel}
              </button>
              <button
                type="button"
                className="btn btn-danger"
                onClick={() => void confirmRemoveCompleted()}
                disabled={Boolean(controller.removingItemId)}
                aria-busy={Boolean(controller.removingItemId)}
              >
                {controller.removingItemId ? (
                  <RefreshCw size={14} className="spin" />
                ) : null}
                {t.confirmRemoveBtn}
              </button>
            </div>
          }
        >
          <div className="action-dialog-body">
            <p className="action-dialog-message">{t.confirmRemoveCompletedMessage}</p>
            <div className="action-dialog-problem">
              <strong>{problemToRemove.problem.questionFrontendId}. {problemToRemove.problem.title}</strong>
            </div>
            {promptSwapFeedback && (
              <FeedbackReasonField
                lang={lang}
                value={removalReason}
                onChange={setRemovalReason}
                disabled={Boolean(controller.removingItemId)}
              />
            )}
          </div>
        </Dialog>
      )}
    </div>
  );
}

/** Standalone tests may supply no controller; the application always injects its single shared instance. */
function TodayStandalone(props: TodayPlanViewProps) {
  const controller = useDailyPlan(props.lang);
  return <TodayPlanViewInner {...props} planController={controller} />;
}
/** Render Today without remounting the application-level plan lifecycle. */
export function TodayPlanView(props: TodayPlanViewProps) {
  return props.planController ? (
    <TodayPlanViewInner {...props} planController={props.planController} />
  ) : (
    <TodayStandalone {...props} />
  );
}
