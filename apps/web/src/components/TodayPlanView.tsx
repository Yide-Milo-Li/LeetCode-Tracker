/** Today's execution surface: compact known activity, server-owned plan and reliable completion circles. */
import React, { useEffect, useRef, useState } from 'react';
import { RefreshCw, CalendarDays, MoreHorizontal } from 'lucide-react';
import { api, type DailyPlan, type PlanItem, type Strategy } from '../api.ts';
import { translations, type Language } from '../i18n.ts';
import { PromptOverrideModal } from './PromptOverrideModal.tsx';
import { useDailyPlan, type UseDailyPlanReturn } from '../hooks/useDailyPlan.ts';
import { useWorkspace } from '../workspace.tsx';
import { createPractice } from '../practice-service.ts';
import { Dialog, Feedback, PageHeader } from './ui.tsx';
import { TodayRecentOverview } from './TodayRecentOverview.tsx';
import { TodayProblemRow } from './TodayProblemRow.tsx';

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
  const zh = lang === 'zh';
  const t = translations[lang];
  const workspace = useWorkspace();
  const [override, setOverride] = useState(false);
  const [versions, setVersions] = useState<DailyPlan[] | null>(null);
  const [localError, setLocalError] = useState('');
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<Set<string>>(new Set());
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
  const plan = controller.ensureResult?.plan;
  const completed = plan?.items.filter((item) => item.completed).length ?? 0;
  const strategy = strategies?.find((s) => s.id === plan?.strategyId);

  /** The base record succeeds before optional fields open; uncertain retries reuse the original timestamp. */
  async function complete(item: PlanItem) {
    if (!plan || locks.current.has(item.id)) return;
    if (item.completed) {
      workspace.openPractice({ mode: 'evidence', item });
      return;
    }
    locks.current.add(item.id);
    setSaving(new Set(locks.current));
    setRowErrors((old) => ({ ...old, [item.id]: '' }));
    try {
      const record = await createPractice('today:' + plan.id + ':' + item.id, {
        questionFrontendId: item.problem.questionFrontendId,
        completed: true,
        practicedAt: new Date().toISOString(),
        timePrecision: 'datetime',
      });
      workspace.notifyMutation(record);
      workspace.openPractice({ mode: 'enrich', record });
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
  return (
    <div className="today-view">
      <PageHeader
        title={zh ? '今日' : 'Today'}
        description={zh ? '让每一次练习，成为一点进步。' : 'A little practice. A little progress.'}
        actions={
          <button className="btn btn-secondary" onClick={() => workspace.navigate('schedule')}>
            <CalendarDays size={16} />
            {zh ? '学习安排' : 'Study schedule'}
          </button>
        }
      />
      <TodayRecentOverview lang={lang} />
      {(controller.error || localError) && (
        <Feedback
          retry={{
            label: t.retry,
            run: () => {
              setLocalError('');
              setStrategyRetry((value) => value + 1);
              void controller.refresh();
            },
          }}
        >
          {controller.error || localError}
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
          <h2>{t.setupTimezoneTitle}</h2>
          <p>{t.setupTimezoneDesc}</p>
          <button className="btn btn-primary" onClick={onNavigateToSettings}>
            {t.navSettings}
          </button>
        </section>
      ) : controller.ensureResult?.status === 'rest' ? (
        <section className="empty-state">
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
      ) : plan ? (
        <>
          <section className="today-plan-summary">
            <div className="section-heading">
              <div>
                <span className="eyebrow">
                  {plan.date} · {plan.timezone}
                </span>
                <h2>{zh ? '今日计划' : 'Today’s plan'}</h2>
                <p className="muted">
                  {strategy?.name ?? (zh ? '临时计划' : 'Temporary plan')}
                  {plan.strategyVersion ? ' · v' + plan.strategyVersion : ''} ·{' '}
                  {plan.source === 'local'
                    ? zh
                      ? '本地推荐'
                      : 'Local recommendations'
                    : zh ? 'Gemini 推荐' : 'Gemini recommendations'}
                </p>
              </div>
              <div className="plan-completion">
                <strong>
                  {completed}
                  <span> / {plan.items.length}</span>
                </strong>
                <small>{zh ? '已完成 / 已生成' : 'completed / generated'}</small>
              </div>
            </div>
            <progress
              value={completed}
              max={Math.max(1, plan.items.length)}
              aria-label={zh ? '今日完成进度' : 'Today completion progress'}
            />
            <div className="section-heading">
              <p className="muted">{plan.encouragement[lang] || plan.encouragement.en}</p>
              <div className="action-row">
                <button className="btn btn-secondary btn-sm" onClick={() => setOverride(true)}>
                  {zh ? '调整今天' : 'Adjust today'}
                </button>
                <details className="action-menu">
                  <summary aria-label={zh ? '更多计划操作' : 'More plan actions'}>
                    <MoreHorizontal size={20} />
                  </summary>
                  <div>
                    <button
                      disabled={
                        controller.replacingBatch ||
                        Boolean(controller.replacingItemId) ||
                        completed === plan.items.length ||
                        saving.size > 0
                      }
                      onClick={() => void controller.replaceAllUnfinished()}
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
          </section>
          {plan.items.length < plan.rules.dailyCount && (
            <Feedback tone="warning">
              {zh ? '候选题目不足，缺口 ' : 'Not enough eligible candidates. Short by '}
              {plan.rules.dailyCount - plan.items.length}
              {zh ? ' 题。已生成题目仍可练习。' : ' problems. The generated plan is ready to use.'}
            </Feedback>
          )}
          {plan.notices.length > 0 && (
            <Feedback tone="warning">
              <ul>
                {plan.notices.map((notice, index) => (
                  <li key={index}>{notice[lang] || notice.en}</li>
                ))}
              </ul>
            </Feedback>
          )}
          <div className="today-problems">
            {plan.items.map((item) => (
              <TodayProblemRow
                key={item.id}
                item={item}
                lang={lang}
                isSaving={saving.has(item.id)}
                rowError={rowErrors[item.id]}
                replacingBatch={controller.replacingBatch}
                replacingItemId={controller.replacingItemId}
                onComplete={(target) => void complete(target)}
                onReplaceOne={(target) => void controller.replaceOne(target)}
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
