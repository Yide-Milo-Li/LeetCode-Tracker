import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import { Target } from 'lucide-react';
import type { DailyPlan, Strategy } from '../api.ts';
import type { Language } from '../i18n.ts';
import { InfoPopover } from './ui.tsx';
import { TodayRecentOverview } from './TodayRecentOverview.tsx';

/** Above this many planned problems, segments get too thin to read and the meter becomes one bar. */
const MAX_METER_SEGMENTS = 12;

/**
 * Segmented completion meter: one segment per planned problem, filled left to right so it reads
 * as a count rather than a map of rows. Segments fill in a short stagger on first render only;
 * later changes animate just the segment that changed.
 */
function TargetMeter({ completed, total, label }: { completed: number; total: number; label: string }) {
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
  }, []);
  const segmented = total > 0 && total <= MAX_METER_SEGMENTS;
  const segmentCount = segmented ? total : 1;
  const continuousFill = total > 0 ? completed / total : 0;

  return (
    <>
      <progress className="visually-hidden" value={completed} max={Math.max(1, total)} aria-label={label} />
      <div className={`target-meter${segmented ? '' : ' is-continuous'}`} aria-hidden="true">
        {Array.from({ length: segmentCount }, (_, index) => (
          <span
            key={index}
            className={`target-meter-seg${segmented && index < completed ? ' is-filled' : ''}`}
            style={
              {
                '--seg-delay': mounted.current ? '0ms' : `${index * 45}ms`,
                ...(segmented ? {} : { '--seg-fill': continuousFill }),
              } as CSSProperties
            }
          />
        ))}
      </div>
    </>
  );
}

/** Keep the daily target visible on rest days and empty plans without inventing a goal. */
export function TodayGoalOverview({
  lang,
  plan,
  strategy,
  showRecent,
  children,
}: {
  lang: Language;
  plan: DailyPlan | null;
  strategy?: Strategy;
  showRecent: boolean;
  children?: ReactNode;
}) {
  const zh = lang === 'zh';
  const total = plan?.items.length ?? 0;
  const completed = plan?.items.filter((item) => item.completed).length ?? 0;

  return (
    <section
      className={`today-unified-hub${showRecent ? '' : ' is-target-only'}`}
      aria-label={zh ? '今日工作台' : 'Today workbench'}
    >
      <div className="hub-left">
        <div>
          <div className="bento-card-header">
            <span className="bento-card-title">
              <Target size={14} aria-hidden="true" />
              <span>{zh ? '今日目标推进' : 'Today’s Target'}</span>
            </span>
            {plan && (
              <div className="strategy-capsule">
                <span className="strategy-capsule-name">
                  {strategy?.name ?? (zh ? '临时计划' : 'Temporary plan')}
                  {' · '}
                  {plan.source === 'local'
                    ? zh ? '本地推荐' : 'Local'
                    : ({ gemini: 'Gemini', openai: 'OpenAI', deepseek: 'DeepSeek' })[plan.source] ?? plan.source}
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
          <div className="progress-hero-row">
            <div className="progress-count-group">
              {/* Keyed by the count so each new solve replays the tick-in motion. */}
              <span key={completed} className="progress-big-num num-tabular">{completed}</span>
              <span className="progress-total-num num-tabular">
                {zh ? `/ ${total} 题已完成` : `of ${total} solved`}
              </span>
            </div>
            <span className="progress-percent-text num-tabular">
              {total > 0
                ? `${Math.round((completed / total) * 100)}%`
                : zh ? '暂无目标' : 'No target yet'}
            </span>
          </div>

          <TargetMeter
            completed={completed}
            total={total}
            label={zh ? '今日完成进度' : 'Today completion progress'}
          />
          <p className="progress-meter-note">
            {total === 0
              ? zh ? '安排今日题目后，在这里查看完成进度。' : 'Set today’s problems to track your progress here.'
              : completed >= total
                ? zh ? '今日计划已全部完成。' : 'Every planned problem is solved.'
                : showRecent
                  ? zh
                    ? `还剩 ${total - completed} 题。点击圆圈即可记录完成，时长可稍后补充。`
                    : `${total - completed} left. Click a circle to log a solve, add duration later.`
                  : zh ? `还剩 ${total - completed} 题。` : `${total - completed} left.`}
          </p>
        </div>
        {children}
      </div>
      {showRecent && (
        <>
          <div className="hub-divider" aria-hidden="true" />
          <TodayRecentOverview lang={lang} embedded />
        </>
      )}
    </section>
  );
}
