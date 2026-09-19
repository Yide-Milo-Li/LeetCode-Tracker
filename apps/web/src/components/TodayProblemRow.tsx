/**
 * Single task row component in Today's plan view.
 * Renders reliable completion circle, topic tags with overflow dropdown, and contextual action links.
 */
import React from 'react';
import { Check, Circle, RefreshCw, ExternalLink, Plus, BookMarked } from 'lucide-react';
import type { PlanItem } from '../api.ts';
import { translations, type Language } from '../i18n.ts';
import { useWorkspace } from '../workspace.tsx';
import { Feedback, InfoPopover, Tooltip } from './ui.tsx';
import { QuickCopyButtons } from './QuickCopyButtons.tsx';

export interface TodayProblemRowProps {
  item: PlanItem;
  lang: Language;
  isSaving: boolean;
  /** Transient success feedback, never inferred from persisted completion alone. */
  justCompleted?: boolean;
  rowError?: string;
  replacingBatch: boolean;
  replacingItemId: string | null;
  onComplete: (item: PlanItem) => void;
  onReplaceOne: (item: PlanItem) => void;
  onOpenQuickNote?: (item: PlanItem) => void;
}

/**
 * Render an individual problem card with progress status and actions.
 */
export function TodayProblemRow({
  item,
  lang,
  isSaving,
  justCompleted = false,
  rowError,
  replacingBatch,
  replacingItemId,
  onComplete,
  onReplaceOne,
  onOpenQuickNote,
}: TodayProblemRowProps) {
  const zh = lang === 'zh';
  const t = translations[lang];
  const workspace = useWorkspace();

  const reasonText = item.reason[lang] || item.reason.en;

  return (
    <article className={'today-problem ' + (item.completed ? 'completed' : '') + (justCompleted && item.completed ? ' just-completed' : '')}>
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
          <Check size={20} className="checkmark-icon" />
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
          {item.kind === 'review' && (
            <span className="tag-chip">{t.kindReview}</span>
          )}
          {!!item.explanation?.focusTagSlugs.length && <InfoPopover
            label={item.explanation.role === 'exploration' ? (zh ? '探索' : 'Explore') : t.focusSessionBadge}
            content={<p>{item.explanation.evidenceSummary?.reasonText
              ? (zh ? item.explanation.evidenceSummary.reasonText.zh : item.explanation.evidenceSummary.reasonText.en)
              : `${t.focusWeakTagsDesc} ${item.explanation.focusTagSlugs.map(slug=>item.problem.topicTags.find(t=>t.slug===slug)?.name??slug).join(', ')}`}</p>} />}
          {item.explanation?.review && <InfoPopover
            label={t.adaptiveReviewBadge}
            content={<p>{zh
              ? '记录用时 '+item.explanation.review.durationMinutes+' 分钟，达到 '+item.explanation.review.thresholdMinutes+' 分钟阈值；间隔从 '+item.explanation.review.baseIntervalDays+' 天缩短为 '+item.explanation.review.intervalDays+' 天。'
              : 'Recorded '+item.explanation.review.durationMinutes+' minutes, meeting the '+item.explanation.review.thresholdMinutes+' minute threshold; interval shortened from '+item.explanation.review.baseIntervalDays+' to '+item.explanation.review.intervalDays+' days.'}</p>} />}
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
          {reasonText && (
            <InfoPopover
              title={zh ? '推荐理由' : 'Why recommended'}
              label={zh ? '推荐理由' : 'Why recommended'}
              content={<p className="recommendation-popover-text">{reasonText}</p>}
            />
          )}
        </div>
        {rowError && (
          <Feedback retry={{ label: t.retry, run: () => onComplete(item) }}>
            {rowError}
          </Feedback>
        )}
      </div>

      <div className="problem-actions">
        <Tooltip text={zh ? '速查往期笔记' : 'Quick notes'} position="top">
          <button
            className="btn-icon"
            aria-label={zh ? '速查往期笔记' : 'Quick notes'}
            onClick={() => onOpenQuickNote?.(item)}
          >
            <BookMarked size={18} />
          </button>
        </Tooltip>
        <Tooltip text={t.copyObsidianCard} position="top">
          <QuickCopyButtons
            lang={lang}
            problem={{
              frontendId: item.problem.questionFrontendId,
              title: item.problem.title,
              url: item.problem.url,
              difficulty: item.problem.difficulty,
              tags: item.problem.topicTags.map((t) => t.name),
              slug: item.problem.titleSlug,
            }}
            compact
          />
        </Tooltip>
        <Tooltip text={zh ? '打开题目' : 'Open problem'} position="top">
          <a
            className="btn-icon"
            aria-label={zh ? '打开题目' : 'Open problem'}
            href={/^https?:\/\//i.test(item.problem.url) ? item.problem.url : undefined}
            target="_blank"
            rel="noopener noreferrer"
          >
            <ExternalLink size={18} />
          </a>
        </Tooltip>
        <Tooltip text={t.replaceOne} position="top">
          <button
            className="btn-icon"
            aria-label={t.replaceOne}
            disabled={item.completed || isSaving || replacingBatch || Boolean(replacingItemId)}
            onClick={() => onReplaceOne(item)}
          >
            <RefreshCw size={18} className={replacingItemId === item.id ? 'spin' : ''} />
          </button>
        </Tooltip>
        <Tooltip text={zh ? '记录练习' : 'Record practice'} position="top">
          <button
            className="btn-icon"
            aria-label={zh ? '记录练习' : 'Record practice'}
            onClick={() => workspace.openPractice({ mode: 'manual', problem: item.problem })}
          >
            <Plus size={18} />
          </button>
        </Tooltip>
      </div>
    </article>
  );
}
