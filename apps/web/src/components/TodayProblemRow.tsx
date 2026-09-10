/**
 * Single task row component in Today's plan view.
 * Renders reliable completion circle, topic tags with overflow dropdown, and contextual action links.
 */
import React from 'react';
import { Check, Circle, RefreshCw, ExternalLink } from 'lucide-react';
import type { PlanItem } from '../api.ts';
import { translations, type Language } from '../i18n.ts';
import { useWorkspace } from '../workspace.tsx';
import { Feedback } from './ui.tsx';

export interface TodayProblemRowProps {
  item: PlanItem;
  lang: Language;
  isSaving: boolean;
  rowError?: string;
  replacingBatch: boolean;
  replacingItemId: string | null;
  onComplete: (item: PlanItem) => void;
  onReplaceOne: (item: PlanItem) => void;
}

/**
 * Render an individual problem card with progress status and actions.
 */
export function TodayProblemRow({
  item,
  lang,
  isSaving,
  rowError,
  replacingBatch,
  replacingItemId,
  onComplete,
  onReplaceOne,
}: TodayProblemRowProps) {
  const zh = lang === 'zh';
  const t = translations[lang];
  const workspace = useWorkspace();

  return (
    <article className={'today-problem ' + (item.completed ? 'completed' : '')}>
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
        aria-busy={isSaving}
        disabled={isSaving || replacingBatch || replacingItemId === item.id}
        onClick={() => onComplete(item)}
      >
        {isSaving ? (
          <RefreshCw className="spin" size={19} />
        ) : item.completed ? (
          <Check size={20} />
        ) : (
          <Circle size={26} />
        )}
      </button>

      <div className="problem-content">
        <h3>
          <span className="problem-number">{item.problem.questionFrontendId}.</span> {item.problem.title}
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
        {rowError && (
          <Feedback retry={{ label: t.retry, run: () => onComplete(item) }}>
            {rowError}
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
          disabled={item.completed || isSaving || replacingBatch || Boolean(replacingItemId)}
          onClick={() => onReplaceOne(item)}
        >
          <RefreshCw size={14} className={replacingItemId === item.id ? 'spin' : ''} />
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
  );
}
