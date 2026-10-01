import type { ReactNode } from 'react';
import { Target } from 'lucide-react';
import type { DailyPlan, Strategy } from '../api.ts';
import type { Language } from '../i18n.ts';
import { InfoPopover } from './ui.tsx';
import { TodayRecentOverview } from './TodayRecentOverview.tsx';

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
              <span className="progress-big-num num-tabular">{completed}</span>
              <span className="progress-total-num num-tabular">
                / {total} {zh ? '题已完成' : 'completed'}
              </span>
            </div>
            <span className="progress-percent-badge num-tabular">
              {total > 0
                ? `${Math.round((completed / total) * 100)}% ${zh ? '达成' : 'achieved'}`
                : zh ? '暂无目标' : 'No target yet'}
            </span>
          </div>
          <progress
            value={completed}
            max={Math.max(1, total)}
            aria-label={zh ? '今日完成进度' : 'Today completion progress'}
          />
          {total === 0 && (
            <p className="muted">
              {zh ? '安排今日题目后，在这里查看完成进度。' : 'Set today’s problems to track your progress here.'}
            </p>
          )}
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
