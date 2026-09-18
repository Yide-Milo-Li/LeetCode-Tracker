/**
 * Contextual slide-out drawer for inspecting past notes on review-mode problems in TodayPlanView.
 */
import React, { useEffect, useState } from 'react';
import { X, ExternalLink, BookOpen, Clock, AlertCircle } from 'lucide-react';
import { api, type ProblemNote, hasMeaningfulNoteContent } from '../api.ts';
import { translations, type Language } from '../i18n.ts';
import { QuickCopyButtons } from './QuickCopyButtons.tsx';

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
  const [note, setNote] = useState<ProblemNote | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    setLoading(true);
    api
      .getNote(problem.frontendId)
      .then((res) => {
        if (active) setNote(res.note);
      })
      .catch(() => {
        if (active) setNote(null);
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [problem.frontendId]);

  // Keyboard Escape listener
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  return (
    <div
      className="quick-note-drawer-overlay"
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(0, 0, 0, 0.45)',
        zIndex: 1000,
        display: 'flex',
        justifyContent: 'flex-end',
        backdropFilter: 'blur(2px)',
      }}
    >
      <div
        className="quick-note-drawer"
        role="dialog"
        aria-modal="true"
        aria-label={t.quickNoteDrawerTitle}
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '540px',
          maxWidth: '90vw',
          height: '100%',
          backgroundColor: 'var(--surface)',
          color: 'var(--text-primary)',
          boxShadow: 'var(--shadow-lg)',
          display: 'flex',
          flexDirection: 'column',
          overflowY: 'auto',
          padding: '24px',
          borderLeft: '1px solid var(--border)',
        }}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-start',
            borderBottom: '1px solid var(--border)',
            paddingBottom: '16px',
            marginBottom: '16px',
          }}
        >
          <div>
            <div style={{ fontSize: '0.8125rem', color: 'var(--text-muted)', marginBottom: '4px' }}>
              {t.quickNoteDrawerTitle}
            </div>
            <h3 style={{ margin: 0, fontSize: '1.25rem', fontWeight: 600 }}>
              #{problem.frontendId} {problem.title}
            </h3>
            <div style={{ display: 'flex', gap: '8px', marginTop: '8px', alignItems: 'center' }}>
              <span className={`badge badge-${problem.difficulty.toLowerCase()}`}>
                {problem.difficulty}
              </span>
              <a
                href={problem.url}
                target="_blank"
                rel="noreferrer"
                className="btn-icon"
                title="LeetCode ↗"
                style={{ color: 'var(--text-muted)' }}
              >
                <ExternalLink size={14} />
              </a>
            </div>
          </div>

          <button
            type="button"
            className="btn-icon"
            onClick={onClose}
            aria-label={t.closeDrawer}
          >
            <X size={20} />
          </button>
        </div>

        {/* Quick copy buttons */}
        <div style={{ marginBottom: '16px' }}>
          <QuickCopyButtons
            lang={lang}
            problem={problem}
            record={{ durationMinutes: null, notes: latestPracticeNotes ?? null }}
            customNote={note?.content}
          />
        </div>

        {/* Content */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '16px' }}>
          {/* Latest practice notes from logs */}
          {latestPracticeNotes && latestPracticeNotes.trim().length > 0 && (
            <div
              style={{
                backgroundColor: 'var(--surface-muted)',
                borderRadius: '8px',
                padding: '12px 16px',
                border: '1px solid var(--border)',
              }}
            >
              <div
                style={{
                  fontSize: '0.8125rem',
                  fontWeight: 600,
                  color: 'var(--text-secondary)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  marginBottom: '8px',
                }}
              >
                <Clock size={14} />
                <span>上次打卡备注 (Last Practice Log Note)</span>
              </div>
              <p style={{ margin: 0, fontSize: '0.9375rem', whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>
                {latestPracticeNotes}
              </p>
            </div>
          )}

          {/* Deep problem note */}
          <div>
            <div
              style={{
                fontSize: '0.875rem',
                fontWeight: 600,
                color: 'var(--text-secondary)',
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                marginBottom: '8px',
              }}
            >
              <BookOpen size={16} />
              <span>{t.solutionReflectionTitle}</span>
            </div>

            {loading ? (
              <div style={{ color: 'var(--text-muted)', fontSize: '0.875rem' }}>Loading notes...</div>
            ) : note && note.content.trim().length > 0 ? (
              <div
                style={{
                  backgroundColor: 'var(--surface-muted)',
                  borderRadius: '8px',
                  padding: '16px',
                  border: '1px solid var(--border)',
                  fontSize: '0.9375rem',
                  lineHeight: 1.6,
                  whiteSpace: 'pre-wrap',
                  fontFamily: 'inherit',
                }}
              >
                {!hasMeaningfulNoteContent(note.content) && (
                  <div
                    style={{
                      marginBottom: '10px',
                      padding: '4px 8px',
                      backgroundColor: 'var(--warning-bg, rgba(234, 179, 8, 0.15))',
                      color: 'var(--warning, #eab308)',
                      borderRadius: '4px',
                      fontSize: '0.75rem',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '4px',
                      border: '1px solid var(--warning, #eab308)',
                    }}
                  >
                    ⚠️ {t.unfilledTemplateNotice}
                  </div>
                )}
                {note.content}
              </div>
            ) : (
              <div
                style={{
                  padding: '24px',
                  textAlign: 'center',
                  color: 'var(--text-muted)',
                  border: '1px dashed var(--border)',
                  borderRadius: '8px',
                  fontSize: '0.875rem',
                }}
              >
                <AlertCircle size={20} style={{ margin: '0 auto 8px', opacity: 0.7 }} />
                <div>{lang === 'zh' ? '暂无该题目的深度笔记' : 'No custom note recorded yet.'}</div>
              </div>
            )}
          </div>
        </div>

        {/* Bottom action */}
        <div
          style={{
            marginTop: '24px',
            paddingTop: '16px',
            borderTop: '1px solid var(--border)',
            display: 'flex',
            justifyContent: 'flex-end',
          }}
        >
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
      </div>
    </div>
  );
}
