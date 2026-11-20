/** Selected problem header: title, save CTA, unified export menu, zen toggle, metadata chips and inline timeline pill. */
import { Check, ChevronDown, Clock, ExternalLink, Maximize2, Minimize2, Save } from 'lucide-react';
import type { ProblemNoteSummary } from '../../api.ts';
import { translations, type Language } from '../../i18n.ts';
import { NotesExportMenu } from './NotesExportMenu.tsx';

interface NoteProblemHeaderProps {
  lang: Language;
  summary: ProblemNoteSummary;
  /** Current editor draft included when copying to Notion. */
  noteContent: string;
  zenMode: boolean;
  onToggleZen: () => void;
  /** Platform-specific tooltip that names the zen shortcut. */
  zenModeTitle: string;
  practiceCount: number;
  timelineOpen: boolean;
  onToggleTimeline: () => void;
  isMac: boolean;
  savingNote: boolean;
  saveSuccess: boolean;
  saveError: string;
  formatNotice: string;
  copiedNotice: boolean;
  onCopied: () => void;
  canSave: boolean;
  isModified: boolean;
  isBlank: boolean;
  unfilledTemplate: boolean;
  onSave: () => void;
}

/** Render the compact problem header with primary Save action, unified Export menu and collapsible metadata. */
export function NoteProblemHeader({
  lang,
  summary,
  noteContent,
  zenMode,
  onToggleZen,
  zenModeTitle,
  practiceCount,
  timelineOpen,
  onToggleTimeline,
  isMac,
  savingNote,
  saveSuccess,
  saveError,
  formatNotice,
  copiedNotice,
  onCopied,
  canSave,
  isModified,
  isBlank,
  unfilledTemplate,
  onSave,
}: NoteProblemHeaderProps) {
  const t = translations[lang];
  const zh = lang === 'zh';
  const tags = summary.tags ?? [];
  const visibleTags = tags.slice(0, 3);
  const hiddenTags = tags.slice(3);

  return (
    <div className={`nw-problem-header ${zenMode ? 'is-zen' : ''}`}>
      <div className="nw-header-top">
        <div className="nw-title-row">
          <h2 className="nw-title">
            <span className="nw-title-text" title={`#${summary.questionFrontendId}. ${summary.title}`}>
              #{summary.questionFrontendId}. {summary.title}
            </span>
            <a
              href={summary.url}
              target="_blank"
              rel="noreferrer"
              className="nw-external-link"
              aria-label={zh ? '在 LeetCode 打开' : 'Open on LeetCode'}
              title={zh ? '在 LeetCode 打开 ↗' : 'Open on LeetCode ↗'}
            >
              <ExternalLink size={13} aria-hidden="true" />
            </a>
          </h2>
        </div>

        {/* Actions: Status indicators, Save CTA, Unified Export menu, and Icon-only Zen Mode */}
        <div className="nw-header-tools">
          {unfilledTemplate && (
            <span title={t.unfilledTemplateTooltip} className="nw-template-warning">
              ⚠️ {t.unfilledTemplateNotice}
            </span>
          )}
          {saveSuccess && (
            <span className="nw-save-success">
              <Check size={13} aria-hidden="true" />
              <span>{noteContent.trim().length === 0 ? t.noteClearedSuccess : t.noteSaved}</span>
            </span>
          )}
          {!saveSuccess && copiedNotice && (
            <span className="nw-save-success" role="status">
              <Check size={13} aria-hidden="true" />
              <span>{t.cardCopied}</span>
            </span>
          )}
          {saveError && <span className="nw-save-error" role="alert">{saveError}</span>}
          {formatNotice && <span role="status" className="nw-format-notice">{formatNotice}</span>}

          <button
            type="button"
            className="btn btn-primary btn-sm nw-save-btn"
            onClick={onSave}
            disabled={!canSave}
            title={
              !canSave
                ? !isModified
                  ? t.noChangesToSave
                  : isBlank
                  ? t.emptyNoteSaveDisabled
                  : t.unfilledTemplateNotice
                : undefined
            }
          >
            <Save size={13} aria-hidden="true" />
            <span>{savingNote ? t.savingNote : t.saveNote}</span>
            <span className="nw-shortcut-hint">
              {isMac ? '(⌘S)' : '(Ctrl+S)'}
            </span>
          </button>

          <NotesExportMenu
            lang={lang}
            summary={summary}
            noteContent={noteContent}
            onCopied={onCopied}
          />

          <button
            type="button"
            className={`btn btn-secondary btn-sm nw-zen-btn ${zenMode ? 'active' : ''}`}
            onClick={onToggleZen}
            title={zenModeTitle}
            aria-label={zenMode ? (zh ? '退出专注' : 'Exit Zen') : (zh ? '专注' : 'Zen')}
            aria-pressed={zenMode}
          >
            {zenMode ? <Minimize2 size={14} aria-hidden="true" /> : <Maximize2 size={14} aria-hidden="true" />}
          </button>
        </div>
      </div>

      {/* Row 2: Metadata chips & inline Practice Timeline trigger (hidden in Zen mode) */}
      {!zenMode && (
        <div className="nw-meta-row">
          <span className={`notes-diff-badge ${summary.difficulty}`}>
            {zh
              ? summary.difficulty === 'Easy'
                ? t.statEasy
                : summary.difficulty === 'Medium'
                ? t.statMedium
                : t.statHard
              : summary.difficulty}
          </span>

          {summary.hasAccepted && (
            <span className="nw-solved-label">
              ✓ {zh ? '已解出' : 'Solved'}
            </span>
          )}

          {Boolean(summary.reviewStage) && (
            <span className="nw-review-stage">
              {zh ? `复习 · 第 ${summary.reviewStage} 阶段` : `Review · Stage ${summary.reviewStage}`}
            </span>
          )}

          {visibleTags.length > 0 && (
            <div className="nw-tags">
              {visibleTags.map((tag) => (
                <span key={tag} className="notes-tag-chip nw-tag-chip">
                  #{tag}
                </span>
              ))}
              {hiddenTags.length > 0 && (
                <span
                  className="notes-tag-chip nw-tag-chip nw-tag-more"
                  title={hiddenTags.map((tag) => `#${tag}`).join(' ')}
                >
                  +{hiddenTags.length}
                </span>
              )}
            </div>
          )}

          <button
            type="button"
            className={`nw-timeline-pill ${timelineOpen ? 'is-open' : ''}`}
            onClick={onToggleTimeline}
            aria-expanded={timelineOpen}
            title={t.practiceTimelineTitle}
          >
            <Clock size={12} aria-hidden="true" />
            <span>{zh ? `${practiceCount} 次打卡` : `${practiceCount} ${practiceCount === 1 ? 'log' : 'logs'}`}</span>
            <ChevronDown size={11} className="nw-timeline-chevron" aria-hidden="true" />
          </button>
        </div>
      )}
    </div>
  );
}
