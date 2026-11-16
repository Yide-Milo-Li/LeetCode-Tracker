/**
 * Single task row component in Today's plan view.
 * Renders reliable completion circle, topic tags with overflow dropdown, and contextual action links.
 */
import React, { useState, useRef, useEffect } from 'react';
import { Check, Circle, RefreshCw, Plus, BookMarked, BookOpen, PenLine, Trash2 } from 'lucide-react';
import type { PlanItem } from '../api.ts';
import type { RecommendationFeedbackReason } from '../../../../packages/contracts/src/recommendations.ts';
import { translations, type Language } from '../i18n.ts';
import { useWorkspace } from '../workspace.tsx';
import { Feedback, InfoPopover, Tooltip } from './ui.tsx';
import { PracticeTimerButton } from './PracticeTimer.tsx';
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
  isAppending?: boolean;
  canRemove?: boolean;
  isRemoving?: boolean;
  onComplete: (item: PlanItem) => void;
  onReplaceOne: (item: PlanItem, reason?: RecommendationFeedbackReason) => void;
  onRemove?: (item: PlanItem, reason?: RecommendationFeedbackReason) => void;
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
  isAppending = false,
  canRemove = true,
  isRemoving = false,
  onComplete,
  onReplaceOne,
  onRemove,
  onOpenQuickNote,
}: TodayProblemRowProps) {
  const zh = lang === 'zh';
  const t = translations[lang];
  const workspace = useWorkspace();

  const [isNoteMenuOpen, setIsNoteMenuOpen] = useState(false);
  const noteMenuRef = useRef<HTMLDivElement>(null);
  const feedbackId = React.useId();
  const [feedbackReason, setFeedbackReason] = useState<RecommendationFeedbackReason | ''>('');

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (noteMenuRef.current && !noteMenuRef.current.contains(e.target as Node)) {
        setIsNoteMenuOpen(false);
      }
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setIsNoteMenuOpen(false);
      }
    }
    if (isNoteMenuOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      window.addEventListener('keydown', handleKeyDown);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isNoteMenuOpen]);

  const reasonText = item.reason[lang] || item.reason.en;
  const problemUrl = /^https?:\/\//i.test(item.problem.url) ? item.problem.url : undefined;

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
        disabled={isSaving || replacingBatch || replacingItemId === item.id || isAppending}
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
          {problemUrl ? (
            <a
              className="problem-title-link"
              href={problemUrl}
              target="_blank"
              rel="noopener noreferrer"
              title={zh ? '打开题目' : 'Open problem'}
            >
              <span className="problem-number">{item.problem.questionFrontendId}.</span>{' '}
              {item.problem.title}
              <span className="problem-link-mark" aria-hidden="true"> ↗</span>
            </a>
          ) : (
            <>
              <span className="problem-number">{item.problem.questionFrontendId}.</span> {item.problem.title}
            </>
          )}
        </h3>
        <div className="problem-meta">
          <span className={'difficulty ' + item.problem.difficulty.toLowerCase()}>
            {t[('stat' + item.problem.difficulty) as keyof typeof t]}
          </span>
          {item.kind === 'review' && (
            <span className="tag-chip tag-chip-review">{t.kindReview}</span>
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
              content={<div className="recommendation-popover-text"><p>{reasonText}</p>
                {item.explanation?.reviewDecision && <p>{zh ? '结果反馈策略 v2；阶段 ' : 'Outcome policy v2; stage '}{item.explanation.reviewDecision.stage}
                  {zh ? '；间隔 ' : '; interval '}{item.explanation.reviewDecision.intervalDays}{zh ? ' 天；到期 ' : ' days; due '}{item.explanation.reviewDecision.dueDate ?? '—'}</p>}
                {item.explanation?.freshness && <p>{zh ? '90 天证据：' : '90-day evidence: '}{item.explanation.freshness.distinctProblems}{zh ? ' 道题，' : ' problems, '}{item.explanation.freshness.practiceDays}{zh ? ' 天；' : ' days; '}{({ recent: zh ? '近期有记录' : 'recent', stale: zh ? '仅有较旧证据，不能视为近期稳定' : 'stale, not recent stability', unseen: zh ? '尚无记录' : 'unseen' })[item.explanation.freshness.status]}</p>}
                {item.explanation?.durationEstimate && <p>{zh ? '预计用时：' : 'Estimated effort: '}{item.explanation.durationEstimate.minutes}{zh ? ' 分钟；' : ' min; '}{item.explanation.durationEstimate.source === 'personal' ? (zh ? '个人样本中位数' : 'personal sample median') : (zh ? '难度启发式，非承诺' : 'difficulty heuristic, not a promise')}</p>}
                {item.explanation?.durationShadow && <p>{zh ? '个人阈值影子对照：' : 'Personal threshold shadow: '}{item.explanation.durationShadow.sampleCount}{zh ? ' 个样本；' : ' samples; '}{item.explanation.durationShadow.eligible ? item.explanation.durationShadow.thresholdMinutes : item.explanation.durationShadow.staticThresholdMinutes}{zh ? ' 分钟。未应用于复习日期。' : ' min. Not applied to review dates.'}</p>}
              </div>}
            />
          )}
        </div>
        <details className="text-muted">
          <summary>{zh ? '可选换题/移除反馈' : 'Optional swap/removal feedback'}</summary>
          <label htmlFor={feedbackId}>{zh ? '下次操作的原因：' : 'Reason for next action: '}{item.problem.title}</label>
          <select id={feedbackId} className="form-input" value={feedbackReason} aria-describedby={feedbackId + '-help'}
            onChange={event => setFeedbackReason(event.target.value as RecommendationFeedbackReason | '')}>
            <option value="">{zh ? '不提供原因' : 'No reason'}</option>
            <option value="time_unavailable">{zh ? '时间不足' : 'Time unavailable'}</option>
            <option value="already_familiar">{zh ? '已经熟悉' : 'Already familiar'}</option>
            <option value="topic_mismatch">{zh ? '专题不匹配' : 'Topic mismatch'}</option>
            <option value="too_difficult">{zh ? '过于困难' : 'Too difficult'}</option>
            <option value="other">{zh ? '其他' : 'Other'}</option>
          </select>
          <p id={feedbackId + '-help'}>{zh ? '仅在明确换题或移除时保存；不是练习失败，也不会改变掌握评估。' : 'Saved only when you swap or remove. This is not a failed attempt and does not change mastery evidence.'}</p>
        </details>
        {rowError && (
          <Feedback retry={{ label: t.retry, run: () => onComplete(item) }}>
            {rowError}
          </Feedback>
        )}
      </div>

      <div className="problem-actions">
        <div className="notes-dropdown" ref={noteMenuRef} style={{ position: 'relative', display: 'inline-block' }}>
          <Tooltip text={t.noteButtonLabel} position="top" disabled={isNoteMenuOpen}>
            <button
              type="button"
              className="btn-icon"
              aria-label={t.noteButtonLabel}
              aria-expanded={isNoteMenuOpen}
              aria-haspopup="true"
              onClick={() => setIsNoteMenuOpen((open) => !open)}
            >
              <BookMarked size={18} />
            </button>
          </Tooltip>

          {isNoteMenuOpen && (
            <div
              className="notes-dropdown-menu notes-dropdown-menu-right"
              role="menu"
              style={{ minWidth: '180px', whiteSpace: 'nowrap' }}
            >
              <button
                type="button"
                className="notes-dropdown-item"
                role="menuitem"
                onClick={() => {
                  setIsNoteMenuOpen(false);
                  workspace.navigate('notes', item.problem.questionFrontendId);
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <PenLine size={14} style={{ color: 'var(--primary)' }} />
                  <span>{t.writeNewNoteInWorkspace}</span>
                </div>
              </button>
              <button
                type="button"
                className="notes-dropdown-item"
                role="menuitem"
                onClick={() => {
                  setIsNoteMenuOpen(false);
                  onOpenQuickNote?.(item);
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <BookOpen size={14} style={{ color: 'var(--accent, #6366f1)' }} />
                  <span>{t.quickCheckPastNotes}</span>
                </div>
              </button>
            </div>
          )}
        </div>
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
        <Tooltip text={t.replaceOne} position="top">
          <button
            className="btn-icon"
            aria-label={t.replaceOne}
            disabled={item.completed || isSaving || replacingBatch || Boolean(replacingItemId) || isAppending}
            onClick={() => onReplaceOne(item, feedbackReason || undefined)}
          >
            <RefreshCw size={18} className={replacingItemId === item.id ? 'spin' : ''} />
          </button>
        </Tooltip>
        <Tooltip text={zh ? '记录练习' : 'Record practice'} position="top">
          <button
            className="btn-icon"
            aria-label={zh ? '记录练习' : 'Record practice'}
            disabled={isAppending || isSaving}
            onClick={() => {
              if (isAppending || isSaving) return;
              workspace.openPractice({ mode: 'manual', problem: item.problem });
            }}
          >
            <Plus size={18} />
          </button>
        </Tooltip>
        <PracticeTimerButton
          lang={lang}
          frontendId={item.problem.questionFrontendId}
          title={item.problem.title}
          disabled={isAppending || isSaving}
        />
        <Tooltip text={canRemove === false ? t.cannotRemoveLastProblem : t.removeProblem} position="top">
          <button
            className="btn-icon btn-icon-danger"
            aria-label={canRemove === false ? t.cannotRemoveLastProblem : t.removeProblem}
            title={canRemove === false ? t.cannotRemoveLastProblem : t.removeProblem}
            disabled={
              canRemove === false ||
              isSaving ||
              replacingBatch ||
              Boolean(replacingItemId) ||
              isAppending ||
              isRemoving
            }
            onClick={() => onRemove?.(item, feedbackReason || undefined)}
          >
            {isRemoving ? (
              <RefreshCw size={18} className="spin" />
            ) : (
              <Trash2 size={18} />
            )}
          </button>
        </Tooltip>
      </div>
    </article>
  );
}
