import { useWorkspaceEnvironment } from '../context.tsx';
import React, { useEffect, useRef, useState } from 'react';
import { RefreshCw, CalendarDays, MoreHorizontal, Coffee, Globe, Sparkles, CheckCircle2, Plus } from 'lucide-react';
import { type DailyPlan, type PlanItem, type Strategy } from '../api.ts';
import { translations, type Language } from '../i18n.ts';
import { PromptOverrideModal } from './PromptOverrideModal.tsx';
import { useDailyPlan, type UseDailyPlanReturn } from '../hooks/useDailyPlan.ts';
import { useEncouragement } from '../hooks/useEncouragement.ts';
import { useWorkspace } from '../workspace.tsx';


import { Dialog, Feedback, PageHeader } from './ui.tsx';
import { TodayGoalOverview } from './TodayGoalOverview.tsx';
import { TodayProblemRow } from './TodayProblemRow.tsx';
import { QuickNoteDrawer } from './QuickNoteDrawer.tsx';
import type { RecommendationFeedbackReason } from '../../../contracts/src/recommendations.ts';

interface TodayPlanViewProps {
  lang: Language;
  onNavigateToSettings: () => void;
  onNavigateToDashboard?: () => void;
  planController?: UseDailyPlanReturn;
}


/** Keep plan refreshes independent of language/theme, and scope save state to a single task row. */
function TodayPlanViewInner({
  lang,
  onNavigateToSettings,
  planController: controller,
}: TodayPlanViewProps & { planController: UseDailyPlanReturn }) {
  const environment = useWorkspaceEnvironment();
  const api = environment.client;
  const createPractice = environment.practice.createPractice;
  const clearPendingMinutes = environment.timer.clearPendingMinutes;
  const getPendingMinutes = environment.timer.getPendingMinutes;
  const stopTimerFor = environment.timer.stopTimerFor;

  const zh = lang === 'zh';
  const t = translations[lang];
  const workspace = useWorkspace();
  const quote = useEncouragement({ timeZone: workspace.timezone, lang });
  const [override, setOverride] = useState(false);
  const [versions, setVersions] = useState<DailyPlan[] | null>(null);
  const [localError, setLocalError] = useState('');
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<Set<string>>(new Set());
  const [recentCompletions, setRecentCompletions] = useState<Set<string>>(new Set());
  const [quickNoteProblem, setQuickNoteProblem] = useState<PlanItem | null>(null);
  const [problemToRemove, setProblemToRemove] = useState<PlanItem | null>(null);
  const [removalReason, setRemovalReason] = useState<RecommendationFeedbackReason | undefined>();
  const completionTimers = useRef(new Set<ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const clearFeedback = () => {
      completionTimers.current.forEach(clearTimeout);
      completionTimers.current.clear();
      setRecentCompletions(new Set());
    };
    const unsubscribe = environment.host.subscribe(event => { if (event.type === 'navigate') clearFeedback(); });
    return () => {
      unsubscribe();
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
        if (active) setLocalError(String(err.message));
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
      setRowErrors((old) => ({ ...old, [item.id]: err instanceof Error ? err.message : String(err) }));
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
      setLocalError(String((err as Error).message));
    }
  }

  /**
   * Handle problem removal.
   * Uncompleted problems are removed immediately with single click (no dialog).
   * Completed problems prompt a confirmation dialog since removal cascades to revoking practice records.
   */
  async function handleRemoveItem(target: PlanItem, reason?: RecommendationFeedbackReason) {
    if (
      !plan ||
      controller.appending ||
      controller.isPlanMutationPending() ||
      Boolean(controller.removingItemId) ||
      saving.size > 0
    ) return;

    if (target.completed) {
      setRemovalReason(reason);
      setProblemToRemove(target);
      return;
    }

    try {
      await controller.removeOne(target, reason);
      workspace.notifyMutation();
    } catch (err) {
      setRowErrors((old) => ({
        ...old,
        [target.id]: err instanceof Error ? err.message : String(err),
      }));
    }
  }

  async function confirmRemoveCompleted() {
    if (!problemToRemove) return;
    const target = problemToRemove;
    try {
      await controller.removeOne(target, removalReason);
      workspace.notifyMutation();
      setProblemToRemove(null);
      setRemovalReason(undefined);
    } catch (err) {
      setRowErrors((old) => ({
        ...old,
        [target.id]: err instanceof Error ? err.message : String(err),
      }));
      setProblemToRemove(null);
    }
  }
  return (
    <div className="today-view">
      <PageHeader
        title={zh ? '今日' : 'Today'}
        description={
          quote.text ? (
            <span className="today-quote-editorial">
              <span className="quote-sparkle-icon" aria-hidden="true">✦</span>
              <span className="quote-editorial-text">{quote.text}</span>
            </span>
          ) : undefined
        }
        actions={
          <button disabled={!environment.host.capabilities.planEditing} className="btn btn-secondary" onClick={() => workspace.navigate('schedule')}>
            <CalendarDays size={16} />
            {zh ? '学习安排' : 'Study schedule'}
          </button>
        }
      />
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
          <button disabled={!environment.host.capabilities.planEditing} className="btn btn-primary" onClick={onNavigateToSettings}>
            {zh ? '设置时区' : 'Set timezone'}
          </button>
        </section>
      ) : controller.ensureResult?.status === 'rest' ? (
        <>
          <TodayGoalOverview lang={lang} plan={plan ?? null} strategy={strategy} showRecent={environment.host.capabilities.practice} />
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
              <button disabled={!environment.host.capabilities.planEditing} className="btn btn-primary" onClick={() => workspace.navigate('schedule')}>
                {zh ? '设置学习安排' : 'Set study schedule'}
              </button>
              <button disabled={!environment.host.capabilities.planEditing} className="btn btn-secondary" onClick={() => setOverride(true)}>
                {t.createTemporaryPlan}
              </button>
            </div>
          </section>
        </>
      ) : plan && plan.items.length === 0 ? (
        <>
          <TodayGoalOverview lang={lang} plan={plan ?? null} strategy={strategy} showRecent={environment.host.capabilities.practice} />
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
                    !environment.host.capabilities.append ||
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
                    !environment.host.capabilities.planEditing ||
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
              <button disabled={!environment.host.capabilities.planEditing} className="btn btn-secondary" onClick={showVersions}>
                {t.planVersions} · v{plan.version}
              </button>
            </div>
          </section>
        </>
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
          <TodayGoalOverview lang={lang} plan={plan} strategy={strategy} showRecent={environment.host.capabilities.practice}>
            <div className="plan-actions-toolbar">
              <button
                className="btn btn-primary btn-sm"
                disabled={
                  !environment.host.capabilities.append ||
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
                  !environment.host.capabilities.planEditing ||
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
                  !environment.host.capabilities.planEditing ||
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
                  <button disabled={!environment.host.capabilities.planEditing} onClick={showVersions}>
                    {t.planVersions} · v{plan.version}
                  </button>
                </div>
              </details>
            </div>
          </TodayGoalOverview>
          {plan.timeEstimate && <section className="form-group" aria-label={zh ? '计划用时估计' : 'Plan effort estimate'}>
            <p>{zh ? '预计用时 ' : 'Estimated effort '}{plan.timeEstimate.totalMinutes}{zh ? ' 分钟：新题 ' : ' min: new '}{plan.timeEstimate.newMinutes}{zh ? '，复习 ' : ', review '}{plan.timeEstimate.reviewMinutes}{zh ? '。仅为估计。' : '. Estimates only.'}</p>
            {!plan.timeEstimate.feasible && <Feedback tone="warning">
              <p>{zh ? '预计用时超出预算，题数与难度保持不变。' : 'The estimate exceeds your budget. Counts and difficulty remain unchanged.'}</p>
              <button type="button" className="btn btn-secondary" disabled={!environment.host.capabilities.planEditing || controller.isPlanMutationPending()} onClick={() => setOverride(true)}>{zh ? '明确调整题数或预算' : 'Adjust count or budget'}</button>
            </Feedback>}
          </section>}
          {plan.items.length < plan.rules.dailyCount && (
            <Feedback tone="warning">
              {zh ? '候选题目不足，缺口 ' : 'Not enough eligible candidates. Short by '}
              {plan.rules.dailyCount - plan.items.length}
              {zh ? ' 题。已生成题目仍可练习。' : ' problems. The generated plan is ready to use.'}
            </Feedback>
          )}
          {plan.notices.length > 0 && (
            <Feedback tone="warning">
              {plan.notices.length === 1 ? (
                plan.notices[0][lang] || plan.notices[0].en
              ) : (
                <ul>
                  {plan.notices.map((notice, index) => (
                    <li key={index}>{notice[lang] || notice.en}</li>
                  ))}
                </ul>
              )}
            </Feedback>
          )}
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
                onReplaceOne={(target, reason) => {
                  if (
                    controller.appending ||
                    controller.isPlanMutationPending() ||
                    saving.size > 0
                  ) return;
                  void controller.replaceOne(target, reason);
                }}
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
      {versions && (
        <Dialog title={t.planVersions} lang={lang} onClose={() => setVersions(null)} drawer>
          {versions.map((version) => (
            <article className="version-card" key={version.version}>
              <p className="muted">{version.source} · {version.model ?? 'Local'} · {zh ? '策略版本' : 'Strategy version'} {version.strategyVersion ?? '—'}</p>
              <h3>
                v{version.version} · {version.action}
              </h3>
              <p className="muted">
                {new Date(version.updatedAt).toLocaleString(zh ? 'zh-CN' : 'en-US', {
                  timeZone: version.timezone,
                })}
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
            slug: quickNoteProblem.problem.titleSlug,
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
      {problemToRemove && (
        <Dialog
          title={t.confirmRemoveCompletedTitle}
          onClose={() => setProblemToRemove(null)}
          lang={lang}
          footer={
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
              <button
                className="btn btn-secondary"
                onClick={() => setProblemToRemove(null)}
                disabled={Boolean(controller.removingItemId)}
              >
                {t.cancel}
              </button>
              <button
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
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <p style={{ margin: 0, fontSize: '14px', lineHeight: '1.5' }}>
              {t.confirmRemoveCompletedMessage}
            </p>
            <div style={{ padding: '10px 14px', borderRadius: '8px', background: 'var(--muted-surface)', fontSize: '13px', color: 'var(--text-muted)' }}>
              <strong>{problemToRemove.problem.questionFrontendId}. {problemToRemove.problem.title}</strong>
            </div>
          </div>
        </Dialog>
      )}
    </div>
  );
}

/** Standalone tests may supply no controller; the application always injects its single shared instance. */
function TodayStandalone(props: TodayPlanViewProps) {
  const controller = useDailyPlan();
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
