/**
 * Contextual slide-out drawer for inspecting past notes on review-mode problems in TodayPlanView.
 * Built on the shared `Dialog` drawer, so focus containment, background inertness, stacked
 * Escape handling and focus return to the trigger match every other overlay in the app.
 */
import React from 'react';
import { ExternalLink, BookOpen, Clock, AlertCircle } from 'lucide-react';
import { api, type ProblemNote, hasMeaningfulNoteContent } from '../api.ts';
import { formatDifficulty, translations, type Language } from '../i18n.ts';
import { QuickCopyButtons } from './QuickCopyButtons.tsx';
import { Dialog } from './ui.tsx';
import { useAsyncResource } from '../hooks/useAsyncResource.ts';

export interface QuickNoteDrawerProps {
  lang: Language;
  problem: {
    frontendId: string;
    title: string;
    url: string;
    difficulty: 'Easy' | 'Medium' | 'Hard';
    tags: string[];
    slug: string;
  };
  latestPracticeNotes?: string | null;
  onClose: () => void;
  onOpenWorkspace: (frontendId: string) => void;
}

export function QuickNoteDrawer({
  lang,
  problem,
  latestPracticeNotes,
  onClose,
  onOpenWorkspace,
}: QuickNoteDrawerProps) {
  const t = translations[lang];
  const saved = useAsyncResource((signal) => api.getNote(problem.frontendId, { signal }), [problem.frontendId]);
  // A failed load shows the empty state rather than another problem's note.
  const note: ProblemNote | null = saved.error ? null : (saved.data?.note ?? null);
  const loading = saved.loading;

  return (
    <Dialog
      drawer
      lang={lang}
      title={`#${problem.frontendId} ${problem.title}`}
      onClose={onClose}
      footer={
        <div className="quick-note-footer">
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              onClose();
              onOpenWorkspace(problem.frontendId);
            }}
          >
            {t.openInNotesWorkspace}
          </button>
        </div>
      }
    >
      <div className="quick-note-meta">
        <span className="quick-note-eyebrow">{t.quickNoteDrawerTitle}</span>
        <span className={`badge badge-${problem.difficulty.toLowerCase()}`}>
          {formatDifficulty(problem.difficulty, lang)}
        </span>
        <a
          href={problem.url}
          target="_blank"
          rel="noreferrer"
          className="btn-icon quick-note-external"
          title="LeetCode ↗"
          aria-label="LeetCode ↗"
        >
          <ExternalLink size={14} aria-hidden="true" />
        </a>
      </div>

      <div className="quick-note-copy">
        <QuickCopyButtons
          lang={lang}
          problem={problem}
          record={{ durationMinutes: null, notes: latestPracticeNotes ?? null }}
          customNote={note?.content}
        />
      </div>

      <div className="quick-note-content">
        {/* Latest practice notes from logs */}
        {latestPracticeNotes && latestPracticeNotes.trim().length > 0 && (
          <section className="quick-note-panel">
            <h3 className="quick-note-heading">
              <Clock size={14} aria-hidden="true" />
              <span>{t.lastPracticeLogNote}</span>
            </h3>
            <p className="quick-note-text">{latestPracticeNotes}</p>
          </section>
        )}

        {/* Deep problem note */}
        <section>
          <h3 className="quick-note-heading">
            <BookOpen size={16} aria-hidden="true" />
            <span>{t.solutionReflectionTitle}</span>
          </h3>

          {loading ? (
            <div className="quick-note-loading">{t.loadingNotes}</div>
          ) : note && note.content.trim().length > 0 ? (
            <div className="quick-note-panel quick-note-body">
              {!hasMeaningfulNoteContent(note.content) && (
                <div className="quick-note-template-notice">⚠️ {t.unfilledTemplateNotice}</div>
              )}
              {note.content}
            </div>
          ) : (
            <div className="quick-note-empty">
              <AlertCircle size={20} aria-hidden="true" />
              <div>{lang === 'zh' ? '暂无该题目的深度笔记' : 'No custom note recorded yet.'}</div>
            </div>
          )}
        </section>
      </div>
    </Dialog>
  );
}
