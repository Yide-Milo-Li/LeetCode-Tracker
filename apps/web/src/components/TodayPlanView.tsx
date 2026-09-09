/** Today's execution surface: compact known activity, server-owned plan and reliable completion circles. */
import React, { useEffect, useRef, useState } from 'react';
import { Check, Circle, RefreshCw, ExternalLink, CalendarDays, MoreHorizontal } from 'lucide-react';
import { api, type DailyPlan, type DashboardResponse, type PlanItem, type Strategy } from '../api.ts';
import { translations, type Language } from '../i18n.ts';
import { PromptOverrideModal } from './PromptOverrideModal.tsx';
import { useDailyPlan, type UseDailyPlanReturn } from '../hooks/useDailyPlan.ts';
import { useWorkspace } from '../workspace.tsx';
import { createPractice } from '../practice-service.ts';
import { Dialog, Feedback, PageHeader } from './ui.tsx';

interface TodayPlanViewProps {
  lang: Language;
  onNavigateToSettings: () => void;
  onNavigateToDashboard?: () => void;
  planController?: UseDailyPlanReturn;
}

/** Read the same deduplicated activity series used by Statistics; missing data is never inferred. */
function RecentOverview({ lang }: { lang: Language }) {
  const workspace = useWorkspace();
  const [data, setData] = useState<DashboardResponse | null>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    api
      .getDashboard()
      .then((value) => {
        if (active) {
          setData(value);
          setError('');
        }
      })
      .catch((err) => {
        if (active) setError(String(err.message));
      });
    return () => {
      active = false;
    };
  }, [workspace.revision, retry]);
  const days = data?.dataStatus.userTimezone ? data.trend30Days.slice(-7) : [];
  const max = Math.max(1, ...days.map((day) => day.completedCount));
  return (
    <section className="recent-overview" aria-label={lang === 'zh' ? '最近 7 天' : 'Last 7 days'}>
      <div>
        <span className="eyebrow">
          {lang === 'zh' ? '最近 7 天 · 含今天' : 'LAST 7 DAYS · INCLUDING TODAY'}
        </span>
        <p>
          {data && !data.dataStatus.userTimezone ? (
            lang === 'zh' ? (
              '请先确认时区'
            ) : (
              'Confirm your timezone first'
            )
          ) : data ? (
            <>
              <strong>{data.overview.currentStreak}</strong>{' '}
              {lang === 'zh' ? '天连续有记录' : 'day activity streak'}
            </>
          ) : error ? (
            lang === 'zh' ? (
              '近期记录暂不可用'
            ) : (
              'Recent records unavailable'
            )
          ) : lang === 'zh' ? (
            '正在读取近期记录…'
          ) : (
            'Loading recent records…'
          )}
        </p>
      </div>
      <div
        className="mini-chart"
        role="img"
        aria-label={days.map((d) => d.date + ': ' + d.completedCount).join('; ') || (lang === 'zh' ? '每日记录尚不可用' : 'Daily activity not available yet')}
      >
        {days.map((day) => (
          <div className="mini-day" key={day.date} title={day.date + ': ' + day.completedCount}>
            <span className="mini-count">{day.completedCount}</span>
            <div className="mini-bar-track">
              <span style={{ height: Math.max(3, (day.completedCount / max) * 32) }} />
            </div>
            <small>{day.date.slice(5)}</small>
          </div>
        ))}
      </div>
      <div className="overview-note">
        {data && (
          <small>
            {!data.dataStatus.userTimezone
              ? lang === 'zh'
                ? '设置时区后显示每日分布'
                : 'Set a timezone to assign daily activity'
              : days.every((d) => !d.activeCount)
                ? lang === 'zh'
                  ? '这 7 天暂无已知记录'
                  : 'No known activity in these 7 days'
                : lang === 'zh'
                  ? '含计划外练习和有效导入记录'
                  : 'Includes extra practice and valid imports'}
          </small>
        )}
        <button className="text-link" onClick={() => workspace.navigate('statistics')}>
          {lang === 'zh' ? '查看完整统计 →' : 'View full statistics →'}
        </button>
      </div>
      {error && (
        <Feedback retry={{ label: lang === 'zh' ? '重试' : 'Retry', run: () => setRetry((n) => n + 1) }}>
          {error}
        </Feedback>
      )}
    </section>
  );
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
      <RecentOverview lang={lang} />
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
              <article className={'today-problem ' + (item.completed ? 'completed' : '')} key={item.id}>
                <button
                  className="completion-circle"
                  aria-label={
                    (item.completed
                      ? zh
                        ? '查看完成记录：'
                        : 'View completion records: '
                      : zh
                        ? '记录完成：'
                        : 'Mark complete: ') + item.problem.title
                  }
                  aria-pressed={item.completed}
                  aria-busy={saving.has(item.id)}
                  disabled={
                    saving.has(item.id) || controller.replacingBatch || controller.replacingItemId === item.id
                  }
                  onClick={() => void complete(item)}
                >
                  {saving.has(item.id) ? (
                    <RefreshCw className="spin" size={19} />
                  ) : item.completed ? (
                    <Check size={20} />
                  ) : (
                    <Circle size={26} />
                  )}
                </button>
                <div className="problem-content">
                  <h3>
                    <span className="problem-number">{item.problem.questionFrontendId}.</span>{' '}
                    {item.problem.title}
                  </h3>
                  <div className="problem-meta">
                    <span className={'difficulty ' + item.problem.difficulty.toLowerCase()}>
                      {t[('stat' + item.problem.difficulty) as keyof typeof t]}
                    </span>
                    {item.kind === 'review' && <span className="tag-chip">{t.kindReview}</span>}
                    {item.problem.isPaidOnly && <span className="tag-chip">{t.statPremium}</span>}
                    {item.problem.topicTags.slice(0, 2).map((tag) => (
                      <span className="tag-chip" key={tag.slug}>
                        {tag.name}
                      </span>
                    ))}
                    {item.problem.topicTags.length > 2 && (
                      <details className="tag-overflow">
                        <summary>
                          +{item.problem.topicTags.length - 2} {zh ? '标签' : 'tags'}
                        </summary>
                        <div>
                          {item.problem.topicTags.slice(2).map((tag) => (
                            <span className="tag-chip" key={tag.slug}>
                              {tag.name}
                            </span>
                          ))}
                        </div>
                      </details>
                    )}
                  </div>
                  <p className="recommendation-reason">{item.reason[lang] || item.reason.en}</p>
                  {rowErrors[item.id] && (
                    <Feedback retry={{ label: t.retry, run: () => void complete(item) }}>
                      {rowErrors[item.id]}
                    </Feedback>
                  )}
                </div>
                <div className="problem-actions">
                  <a
                    className="btn btn-secondary btn-sm"
                    href={/^https?:\/\//i.test(item.problem.url) ? item.problem.url : undefined}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {zh ? '打开题目' : 'Open problem'}
                    <ExternalLink size={14} />
                  </a>
                  <button
                    className="text-link"
                    disabled={
                      item.completed ||
                      saving.has(item.id) ||
                      controller.replacingBatch ||
                      Boolean(controller.replacingItemId)
                    }
                    onClick={() => void controller.replaceOne(item)}
                  >
                    <RefreshCw size={14} className={controller.replacingItemId === item.id ? 'spin' : ''} />
                    {t.replaceOne}
                  </button>
                  <button
                    className="text-link"
                    onClick={() => workspace.openPractice({ mode: 'manual', problem: item.problem })}
                  >
                    {zh ? '记录练习' : 'Record practice'}
                  </button>
                </div>
              </article>
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
