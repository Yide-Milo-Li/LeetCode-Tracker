import {useWorkspaceEnvironment} from '../context.tsx';
/**
 * Single task row component in Today's plan view.
 * Renders reliable completion circle, topic tags with overflow dropdown, and contextual action links.
 */
import React from 'react';
import { Check, Circle, RefreshCw, Plus, BookMarked, BookOpen, PenLine, Trash2 } from 'lucide-react';
import type { PlanItem } from '../api.ts';
import type { RecommendationFeedbackReason } from '../../../contracts/src/recommendations.ts';
import { translations, type Language } from '../i18n.ts';
import { useWorkspace } from '../workspace.tsx';
import { Feedback, InfoPopover, Tooltip, useActionPopover } from './ui.tsx';
import { PracticeTimerButton } from './PracticeTimer.tsx';
import { QuickCopyButtons } from './QuickCopyButtons.tsx';
import { AssistantAskButton } from '../assistant.tsx';

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
  const {host}=useWorkspaceEnvironment();
  const zh = lang === 'zh';
  const t = translations[lang];
  const workspace = useWorkspace();

  // Native popover handles outside clicks, Escape and the top layer; see useActionPopover.
  const noteMenu = useActionPopover({ align: 'end' });

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
        disabled={!host.capabilities.practice || isSaving || replacingBatch || replacingItemId === item.id || isAppending}
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
                {item.explanation?.reviewDecision && <p>{zh ? '参考用时与结果；阶段 ' : 'Time and outcome spacing; stage '}{item.explanation.reviewDecision.stage}
                  {zh ? '；间隔 ' : '; interval '}{item.explanation.reviewDecision.intervalDays}{zh ? ' 天；到期 ' : ' days; due '}{item.explanation.reviewDecision.dueDate ?? '—'}</p>}
                {item.explanation?.freshness && <p>{zh ? '90 天证据：' : '90-day evidence: '}{item.explanation.freshness.distinctProblems}{zh ? ' 道题，' : ' problems, '}{item.explanation.freshness.practiceDays}{zh ? ' 天；' : ' days; '}{({ recent: zh ? '近期有记录' : 'recent', stale: zh ? '仅有较旧证据，不能视为近期稳定' : 'stale, not recent stability', unseen: zh ? '尚无记录' : 'unseen' })[item.explanation.freshness.status]}</p>}
                {item.explanation?.durationEstimate && <p>{zh ? '预计用时：' : 'Estimated effort: '}{item.explanation.durationEstimate.minutes}{zh ? ' 分钟；' : ' min; '}{item.explanation.durationEstimate.source === 'personal' ? (zh ? '个人样本中位数' : 'personal sample median') : (zh ? '难度启发式，非承诺' : 'difficulty heuristic, not a promise')}</p>}
                {item.explanation?.durationShadow && <p>{zh ? '个人阈值影子对照：' : 'Personal threshold shadow: '}{item.explanation.durationShadow.sampleCount}{zh ? ' 个样本；' : ' samples; '}{item.explanation.durationShadow.eligible ? item.explanation.durationShadow.thresholdMinutes : item.explanation.durationShadow.staticThresholdMinutes}{zh ? ' 分钟。未应用于复习日期。' : ' min. Not applied to review dates.'}</p>}
              </div>}
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
        <AssistantAskButton
          lang={lang}
          subject={{ kind: 'problem', questionFrontendId: item.problem.questionFrontendId, title: item.problem.title }}
        />
        <div className="notes-dropdown">
          <Tooltip text={t.noteButtonLabel} position="top" disabled={noteMenu.open}>
            <button
              type="button"
              className="btn-icon"
              aria-label={t.noteButtonLabel}
              {...noteMenu.triggerProps}
            >
              <BookMarked size={18} />
            </button>
          </Tooltip>

          {noteMenu.rendered && (
            <div
              {...noteMenu.panelProps}
              className="notes-dropdown-menu notes-dropdown-menu-right"
              style={{ minWidth: '180px' }}
            >
              <button
                type="button"
                className="notes-dropdown-item"
                onClick={() => {
                  noteMenu.close();
                  workspace.navigate('notes', item.problem.questionFrontendId);
                }}
              >
                <span className="notes-dropdown-label">
                  <PenLine size={14} className="notes-dropdown-icon" aria-hidden="true" />
                  <span>{t.writeNewNoteInWorkspace}</span>
                </span>
              </button>
              <button
                type="button"
                className="notes-dropdown-item"
                onClick={() => {
                  noteMenu.close();
                  onOpenQuickNote?.(item);
                }}
              >
                <span className="notes-dropdown-label">
                  <BookOpen size={14} className="notes-dropdown-icon is-secondary" aria-hidden="true" />
                  <span>{t.quickCheckPastNotes}</span>
                </span>
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
            disabled={!host.capabilities.planEditing || item.completed || isSaving || replacingBatch || Boolean(replacingItemId) || isAppending}
            onClick={() => onReplaceOne(item)}
          >
            <RefreshCw size={18} className={replacingItemId === item.id ? 'spin' : ''} />
          </button>
        </Tooltip>
        <Tooltip text={zh ? '记录练习' : 'Record practice'} position="top">
          <button
            className="btn-icon"
            aria-label={zh ? '记录练习' : 'Record practice'}
            disabled={!host.capabilities.practice || isAppending || isSaving}
            onClick={() => {
              if (isAppending || isSaving) return;
              workspace.openPractice({ mode: 'manual', problem: item.problem });
            }}
          >
            <Plus size={18} />
          </button>
        </Tooltip>
        {host.capabilities.practice&&<PracticeTimerButton
          lang={lang}
          frontendId={item.problem.questionFrontendId}
          title={item.problem.title}
          disabled={!host.capabilities.practice || isAppending || isSaving}
        />}
        <Tooltip text={canRemove === false ? t.cannotRemoveLastProblem : t.removeProblem} position="top">
          <button
            className="btn-icon btn-icon-danger"
            aria-label={canRemove === false ? t.cannotRemoveLastProblem : t.removeProblem}
            title={canRemove === false ? t.cannotRemoveLastProblem : t.removeProblem}
            disabled={
              !host.capabilities.planEditing || canRemove === false ||
              isSaving ||
              replacingBatch ||
              Boolean(replacingItemId) ||
              isAppending ||
              isRemoving
            }
            onClick={() => onRemove?.(item)}
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
