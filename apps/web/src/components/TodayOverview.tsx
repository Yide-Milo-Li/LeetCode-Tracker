import { useState, type CSSProperties } from 'react';
import { ArrowDownRight, ArrowUpRight } from 'lucide-react';
import { localDate } from '../../../../packages/contracts/src/time-utils.ts';
import type { GoalList } from '../../../../packages/contracts/src/goal-lists.ts';
import { api, type DailyPlan, type EnsureResult } from '../api.ts';
import { formatCalendarDate } from '../date-format.ts';
import { localizeApiError } from '../error-i18n.ts';
import { useAsyncResource } from '../hooks/useAsyncResource.ts';
import type { Language } from '../i18n.ts';
import { useWorkspace } from '../workspace.tsx';
import { Feedback, InfoPopover } from './ui.tsx';

type PlanStatus = EnsureResult['status'] | 'error' | undefined;

function DailyProgress({ plan, status, lang }: { plan?: DailyPlan | null; status: PlanStatus; lang: Language }) {
  const zh = lang === 'zh';
  const total = plan?.items.length ?? 0;
  const completed = plan?.items.filter(item => item.completed).length ?? 0;
  const remaining = total - completed;
  let caption = zh ? '正在读取计划…' : 'Loading plan…';
  if (status === 'error') caption = zh ? '计划暂不可用' : 'Plan unavailable';
  else if (status === 'setup') caption = zh ? '等待设置时区' : 'Timezone needed';
  else if (status === 'rest' || plan) caption = zh ? '今日未安排题目' : 'Nothing scheduled';

  return <section className="today-metric daily-metric">
    <h2>{zh ? '今日策略进度' : 'Daily plan progress'}</h2>
    <div className="daily-metric-body">
      {total > 0 ? <>
        <div className="daily-progress-ring" style={{ '--today-plan-fill': `${completed / total * 100}%` } as CSSProperties}>
          <progress className="visually-hidden" aria-label={zh ? '今日完成进度' : 'Today completion progress'}
            max={total} value={completed} aria-valuetext={zh ? `共 ${total} 题，已完成 ${completed} 题` : `${completed} of ${total} complete`} />
          <span aria-hidden="true">{Math.round(completed / total * 100)}<small>%</small></span>
        </div>
        <div>
          <p className="today-count">{completed}<span> / {total}</span></p>
          <p className="metric-caption">{remaining
            ? (zh ? `还剩 ${remaining} 题` : `${remaining} left today`)
            : (zh ? '今日计划已完成' : 'Daily plan complete')}</p>
        </div>
      </> : <p className="metric-empty">{caption}</p>}
    </div>
  </section>;
}

// Individual marks retain their original positions even when a later problem is completed first.
const MAX_VISIBLE_MARKS = 32;
function GoalProgress({ goal, loaded, error, lang, onJump }: {
  goal?: GoalList; loaded: boolean; error: boolean; lang: Language; onJump(): void;
}) {
  const zh = lang === 'zh';
  const total = goal?.items.length ?? 0;
  const completed = goal?.items.filter(item => item.completed).length ?? 0;
  const next = goal?.items.find(item => !item.completed);
  const summary = zh ? `已完成 ${completed} / ${total} 题` : `${completed} of ${total} complete`;
  const unavailable = error ? (zh ? '题单暂不可用' : 'List unavailable')
    : loaded ? (zh ? '尚无目标题单' : 'No goal list yet') : (zh ? '正在读取题单…' : 'Loading lists…');

  return <section className="today-metric goal-metric">
    <h2>{zh ? '题单进度' : 'Selected goal progress'}</h2>
    {goal ? <>
      <p className="metric-goal-name" title={goal.name}>{goal.name}</p>
      {total ? <>
        {total <= MAX_VISIBLE_MARKS && <div className="goal-order-marks" aria-hidden="true">
          {goal.items.map((item, i) => <span key={item.frontendId} data-complete={item.completed}
            title={`${i + 1}. #${item.frontendId} ${item.title} · ${item.completed ? (zh ? '已完成' : 'Completed') : (zh ? '待做' : 'Pending')}`} />)}
        </div>}
        <progress className={total <= MAX_VISIBLE_MARKS ? 'visually-hidden' : 'goal-long-progress'}
          aria-label={zh ? `题单进度：${goal.name}` : `Goal progress: ${goal.name}`} max={total} value={completed} aria-valuetext={summary} />
        <div className="goal-metric-footer">
          <p className="metric-caption">{summary}</p>
          {next && <button type="button" className="text-link next-goal-task" onClick={onJump}
            title={next.title}>{zh ? `下一题 #${next.frontendId}` : `Next #${next.frontendId}`}<ArrowDownRight size={13} aria-hidden="true" /></button>}
        </div>
      </> : <p className="metric-caption">{zh ? '题单为空' : 'Empty list'}</p>}
    </> : <p className="metric-empty">{unavailable}</p>}
  </section>;
}

function WeekActivity({ lang }: { lang: Language }) {
  const zh = lang === 'zh';
  const { revision, navigate, openRecords } = useWorkspace();
  const [retry, setRetry] = useState(0);
  const recent = useAsyncResource(signal => api.getRecentDashboard({ signal }), [revision, retry]);
  const days = recent.data?.timezone ? recent.data.days : [];
  // A failed midnight refresh can leave yesterday's series on screen.
  const today = days.length && recent.data?.timezone ? localDate(Date.now(), recent.data.timezone) : undefined;
  const peak = Math.max(1, ...days.map(day => day.completedCount));
  const solvedDays = days.filter(day => day.completedCount > 0).length;
  const emptyText = recent.error ? (zh ? '近期记录暂不可用' : 'Recent records unavailable')
    : recent.loading ? (zh ? '正在读取近期记录…' : 'Loading recent records…')
    : !recent.data?.timezone ? (zh ? '设置时区后显示每日分布' : 'Set a timezone to assign daily activity')
    : (zh ? '暂无近期数据' : 'No recent data');

  return <section className="today-metric week-metric">
    <div className="week-heading">
      <div className="week-title"><h2>{zh ? '近 7 天完成情况' : 'Last 7 days'}</h2>
        <InfoPopover label={zh ? '节奏统计说明' : 'Activity details'} content={<p>{zh
          ? '按你设置的时区统计，包含手动练习和导入的完成记录。当天重复完成同一道题只计一次。'
          : 'Counts recorded solves and imported completions in your profile timezone. Each problem counts once per day.'}</p>} />
      </div>
      <button type="button" className="text-link week-statistics" onClick={() => navigate('statistics')}
        aria-label={zh ? '查看完整统计' : 'View full statistics'}>{zh ? '完整统计' : 'Statistics'}<ArrowUpRight size={14} aria-hidden="true" /></button>
    </div>
    {days.length > 0 ? <>
      <ol className="week-chart" aria-label={zh ? '每天完成的题数' : 'Problems completed each day'}>
        {days.map(day => {
          const isToday = day.date === today;
          const weekday = isToday ? (zh ? '今日' : 'Today') : formatCalendarDate(day.date, lang, { weekday: 'short' });
          const label = zh ? `${day.date}，完成 ${day.completedCount} 题` : `${day.date}, ${day.completedCount} completed`;
          const mark = <>
            <span className="week-track" aria-hidden="true">
              <span className="week-bar" data-zero={day.completedCount === 0} style={{ height: `${day.completedCount / peak * 100}%` }}>
                <span className="week-count">{day.completedCount}</span>
              </span>
            </span>
            <time dateTime={day.date}>{weekday}</time>
          </>;
          return <li key={day.date} className={isToday ? 'is-today' : undefined}>
            {openRecords
              ? <button type="button" className="week-day" onClick={() => openRecords({ date: day.date })}
                  aria-label={zh ? `${label}，查看练习记录` : `${label}. View records`} title={label}>{mark}</button>
              : <div className="week-day" role="img" aria-label={label}>{mark}</div>}
          </li>;
        })}
      </ol>
      <p className="metric-caption week-summary">{zh ? `${days.length} 天中有 ${solvedDays} 天完成过题目` : `Solved on ${solvedDays} of ${days.length} days`}</p>
    </> : <p className="metric-empty">{emptyText}</p>}
    {recent.error != null && <Feedback retry={{ label: zh ? '重试' : 'Retry', run: () => setRetry(n => n + 1) }}>
      {localizeApiError(recent.error, lang)}
    </Feedback>}
  </section>;
}

export function TodayOverview({ lang, plan, planStatus, goal, goalsLoaded, goalsError, onJumpToGoal }: {
  lang: Language;
  plan?: DailyPlan | null;
  planStatus: PlanStatus;
  goal?: GoalList;
  goalsLoaded: boolean;
  goalsError: boolean;
  onJumpToGoal(): void;
}) {
  return <section className="today-overview" aria-label={lang === 'zh' ? '练习概览' : 'Practice overview'}>
    <DailyProgress lang={lang} plan={plan} status={planStatus} />
    <GoalProgress lang={lang} goal={goal} loaded={goalsLoaded} error={goalsError} onJump={onJumpToGoal} />
    <WeekActivity lang={lang} />
  </section>;
}
