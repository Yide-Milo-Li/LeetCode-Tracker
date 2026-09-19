import { ExportLink } from './ExportLink.tsx';
/**
 * Independent Notes Workspace providing Master-Detail browsing,
 * deep solution editing, practice history timeline, and Obsidian/Notion knowledge export.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Search,
  BookOpen,
  FileText,
  ExternalLink,
  Download,
  Save,
  Check,
  Clock,
  Archive,
  Layers,
} from 'lucide-react';
import {
  api,
  type ProblemNoteSummary,
  type PracticeRecord,
  NOTE_TEMPLATES,
  hasMeaningfulNoteContent,
} from '../api.ts';
import { translations, type Language } from '../i18n.ts';
import { PageHeader, Feedback, Field, Pagination, Dialog } from './ui.tsx';
import { QuickCopyButtons } from './QuickCopyButtons.tsx';

export interface NotesWorkspaceProps {
  lang: Language;
  initialFrontendId?: string | null;
}

/** Browse and edit notes while keeping asynchronous responses owned by their selection visit. */
export function NotesWorkspace({ lang, initialFrontendId }: NotesWorkspaceProps) {
  const t = translations[lang];
  const zh = lang === 'zh';

  // Filters state
  const [scope, setScope] = useState<'practiced' | 'all'>('practiced');
  const [search, setSearch] = useState('');
  const [difficulty, setDifficulty] = useState<'all' | 'Easy' | 'Medium' | 'Hard'>('all');
  const [hasNote, setHasNote] = useState<'all' | 'true' | 'false'>('all');
  const [page, setPage] = useState(1);
  const limit = 25;

  // List data
  const [items, setItems] = useState<ProblemNoteSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [loadingList, setLoadingList] = useState(true);
  const [listRevision, setListRevision] = useState(0);

  // Selected problem state
  const [selectedId, setSelectedId] = useState<string | null>(initialFrontendId ?? null);

  // Phase 30: Unsaved note switch guard state
  const [pendingTargetId, setPendingTargetId] = useState<string | null>(null);
  const [showUnsavedModal, setShowUnsavedModal] = useState(false);

  const [selectedSummary, setSelectedSummary] = useState<ProblemNoteSummary | null>(null);
  const [noteContent, setNoteContent] = useState('');
  const [savedContent, setSavedContent] = useState('');
  const [loadingNote, setLoadingNote] = useState(false);
  const [noteLoadError, setNoteLoadError] = useState(false);
  const [savingNote, setSavingNote] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [retryRevision, setRetryRevision] = useState(0);
  const editorSession = useRef({ active: false, saving: false, saveVersion: 0 });

  useEffect(() => {
    // A -> B -> A creates a new visit too; comparing question IDs alone is insufficient.
    const session = { active: true, saving: false, saveVersion: 0 };
    editorSession.current = session;
    setSavingNote(false);
    return () => { session.active = false; };
  }, [selectedId]);

  // Selected problem practice timeline
  const [practices, setPractices] = useState<PracticeRecord[]>([]);
  const [loadingPractices, setLoadingPractices] = useState(false);
  const [showTimeline, setShowTimeline] = useState(false);

  // Retain selected summary or update from current items if present
  useEffect(() => {
    if (selectedId) {
      const matched = items.find((it) => it.questionFrontendId === selectedId);
      if (matched) {
        setSelectedSummary(matched);
      }
    }
  }, [items, selectedId]);

  /** Fetch the current filters and return cancellation for superseded list requests. */
  const loadList = useCallback(() => {
    let active = true;
    setLoadingList(true);
    api
      .listNotes({
        scope,
        search: search.trim() || undefined,
        difficulty,
        hasNote,
        page,
        limit,
      })
      .then((res) => {
        if (!active) return;
        setItems(res.items);
        setTotal(res.total);
        const maxPage = Math.max(1, Math.ceil(res.total / limit));
        if (page > maxPage) {
          setPage(maxPage);
        }
        if (res.items.length > 0) {
          setSelectedId((current) => current ?? res.items[0].questionFrontendId);
        }
      })
      .catch(() => {
        if (active) setItems([]);
      })
      .finally(() => {
        if (active) setLoadingList(false);
      });

    return () => {
      active = false;
    };
  }, [scope, search, difficulty, hasNote, page, limit]);

  useEffect(() => {
    return loadList();
  }, [loadList, listRevision]);

  // Initial loads and retries share cancellation, independently of list and language changes.
  useEffect(() => {
    if (!selectedId) {
      setSelectedSummary(null);
      setNoteContent('');
      setSavedContent('');
      setPractices([]);
      setNoteLoadError(false);
      return;
    }

    let active = true;
    setLoadingNote(true);
    setSaveSuccess(false);
    setSaveError('');
    setNoteLoadError(false);

    // Fetch note content
    api
      .getNote(selectedId)
      .then((res) => {
        if (!active) return;
        const content = res.note?.content ?? '';
        setNoteContent(content);
        setSavedContent(content);
      })
      .catch(() => {
        if (active) {
          setNoteLoadError(true);
        }
      })
      .finally(() => {
        if (active) setLoadingNote(false);
      });

    // Fetch practice timeline
    setLoadingPractices(true);
    api
      .getPracticeRecords({ questionFrontendId: selectedId, page: 1, limit: 100 })
      .then((res) => {
        if (!active) return;
        setPractices(res.items);
      })
      .catch(() => {
        if (active) setPractices([]);
      })
      .finally(() => {
        if (active) setLoadingPractices(false);
      });

    return () => {
      active = false;
    };
  }, [selectedId, retryRevision]);

  /** Retry through the cancellable loading effect rather than a separate unguarded request. */
  const handleRetryLoad = useCallback(() => {
    if (selectedId) setRetryRevision((current) => current + 1);
  }, [selectedId]);

  // Meaningful note validity check & save eligibility
  const isModified = noteContent !== savedContent;
  const isBlank = noteContent.trim().length === 0;
  const hasMeaningful = hasMeaningfulNoteContent(noteContent);
  const canSave =
    !loadingNote &&
    !savingNote &&
    !noteLoadError &&
    isModified &&
    (isBlank ? savedContent.trim().length > 0 : hasMeaningful);

  // Phase 30: Unsaved note modifications check
  // Clean if note is unchanged, actively saving, or if an empty note only had whitespace typed.
  const hasUnsavedChanges =
    !loadingNote &&
    !savingNote &&
    isModified &&
    (savedContent.trim().length > 0 || noteContent.trim().length > 0);

  // Phase 30: Browser beforeunload guard when unsaved changes exist
  useEffect(() => {
    if (!hasUnsavedChanges) return;
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [hasUnsavedChanges]);

  /** Persist one snapshot, retaining newer edits and ignoring responses from an obsolete visit. */
  async function handleSaveNote() {
    const session = editorSession.current;
    if (!selectedId || !canSave || !session.active || session.saving) return;
    // Synchronous guard also blocks repeated shortcuts before React commits savingNote.
    session.saving = true;
    const saveVersion = ++session.saveVersion;
    const targetId = selectedId;
    const targetContent = noteContent;
    setSavingNote(true);
    setSaveSuccess(false);
    setSaveError('');

    try {
      const { note } = await api.upsertNote(targetId, targetContent);
      if (session.active) {
        setSavedContent(note.content);
        setSaveSuccess(true);
        setTimeout(() => {
          if (session.active && session.saveVersion === saveVersion) setSaveSuccess(false);
        }, 2500);

        const isMeaningful = hasMeaningfulNoteContent(note.content);
        setSelectedSummary((prev) =>
          prev && prev.questionFrontendId === targetId
            ? {
                ...prev,
                hasCustomNote: isMeaningful,
                customNoteUpdatedAt: isMeaningful ? note.updatedAt : null,
              }
            : prev
        );

        setItems((prev) =>
          prev.map((it) =>
            it.questionFrontendId === targetId
              ? {
                  ...it,
                  hasCustomNote: isMeaningful,
                  customNoteUpdatedAt: isMeaningful ? note.updatedAt : null,
                }
              : it
          )
        );
      }
      // A saved note can change list membership even after switching problems. Refresh
      // the latest filters while mounted, without reloading the current editor draft.
      if (editorSession.current.active) setListRevision((current) => current + 1);
    } catch (err) {
      if (session.active) {
        setSaveError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      session.saving = false;
      if (session.active) {
        setSavingNote(false);
      }
    }
  }

  // Ctrl+S / Cmd+S shortcut to save
  useEffect(() => {
    /** Route the browser save shortcut through the same eligibility and in-flight guard. */
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (canSave) {
          void handleSaveNote();
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [canSave, handleSaveNote]);

  /**
   * Request switching to another problem note.
   * If there are unsaved edits in the current note, intercept with a confirmation dialog.
   * Otherwise switch directly without prompt.
   */
  const handleSelectProblem = useCallback(
    (targetId: string) => {
      if (targetId === selectedId) return;
      if (hasUnsavedChanges) {
        setPendingTargetId(targetId);
        setShowUnsavedModal(true);
      } else {
        setSelectedId(targetId);
      }
    },
    [selectedId, hasUnsavedChanges],
  );

  const isInitialMount = useRef(true);
  useEffect(() => {
    if (isInitialMount.current) {
      isInitialMount.current = false;
      return;
    }
    if (initialFrontendId && initialFrontendId !== selectedId) {
      handleSelectProblem(initialFrontendId);
    }
  }, [initialFrontendId, selectedId, handleSelectProblem]);

  /** Discard unsaved modifications and switch to the pending target problem. */
  const handleDiscardAndSwitch = useCallback(() => {
    if (!pendingTargetId) return;
    const target = pendingTargetId;
    setShowUnsavedModal(false);
    setPendingTargetId(null);
    setSelectedId(target);
  }, [pendingTargetId]);

  /** Cancel switching and stay on the current problem note. */
  const handleCancelSwitch = useCallback(() => {
    setShowUnsavedModal(false);
    setPendingTargetId(null);
  }, []);

  const pendingTargetSummary = pendingTargetId
    ? items.find((it) => it.questionFrontendId === pendingTargetId) ?? null
    : null;

  const totalPages = Math.max(1, Math.ceil(total / limit));

  return (
    <div className="notes-workspace-view" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <PageHeader
        title={t.notesWorkspaceTitle}
        description={t.notesWorkspaceDesc}
        actions={
          <div style={{ display: 'flex', gap: '8px' }}>
            <ExportLink
                lang={lang}
                onExport={() => api.exportObsidianZip('all', lang)}
                href={api.getObsidianZipUrl('all', lang)}
              className="btn btn-secondary btn-sm"
              title="Download 4,000+ Obsidian markdown skeleton"
              style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
            >
              <Archive size={14} />
              <span>{t.exportObsidianVault}</span>
            </ExportLink>
            <ExportLink
                lang={lang}
                onExport={() => api.exportNotionCsv('summary')}
                href={api.getNotionCsvUrl('summary')}
              className="btn btn-secondary btn-sm"
              title="Download Notion Problems Summary CSV"
              style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
            >
              <Download size={14} />
              <span>{zh ? 'Notion 题库表' : 'Notion CSV'}</span>
            </ExportLink>
          </div>
        }
      />

      {/* Master-Detail Grid */}
      <div
        className="notes-master-detail"
        style={{
          display: 'grid',
          gridTemplateColumns: '340px 1fr',
          gap: '16px',
          flex: 1,
          minHeight: '620px',
          alignItems: 'start',
        }}
      >
        {/* Left Master Column: Problem List & Filters */}
        <div
          className="notes-master-pane"
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '10px',
            backgroundColor: 'var(--surface)',
            border: '1px solid var(--border-color)',
            borderRadius: '10px',
            padding: '14px',
            height: '100%',
            maxHeight: 'calc(100vh - 160px)',
            overflow: 'hidden',
          }}
        >
          {/* Scope switch: Sleek segmented control pill */}
          <div
            role="tablist"
            style={{
              display: 'flex',
              padding: '3px',
              backgroundColor: 'var(--muted-surface)',
              borderRadius: '8px',
              gap: '2px',
            }}
          >
            <button
              type="button"
              role="tab"
              aria-selected={scope === 'practiced'}
              style={{
                flex: 1,
                padding: '5px 10px',
                borderRadius: '6px',
                border: 'none',
                fontSize: '0.8125rem',
                fontWeight: scope === 'practiced' ? 600 : 450,
                backgroundColor: scope === 'practiced' ? 'var(--surface)' : 'transparent',
                color: scope === 'practiced' ? 'var(--text-main)' : 'var(--text-muted)',
                boxShadow: scope === 'practiced' ? '0 1px 2px rgba(0,0,0,0.06)' : 'none',
                cursor: 'pointer',
                transition: 'all 0.15s ease',
              }}
              onClick={() => {
                setScope('practiced');
                setPage(1);
              }}
            >
              {t.practicedNotesScope}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={scope === 'all'}
              style={{
                flex: 1,
                padding: '5px 10px',
                borderRadius: '6px',
                border: 'none',
                fontSize: '0.8125rem',
                fontWeight: scope === 'all' ? 600 : 450,
                backgroundColor: scope === 'all' ? 'var(--surface)' : 'transparent',
                color: scope === 'all' ? 'var(--text-main)' : 'var(--text-muted)',
                boxShadow: scope === 'all' ? '0 1px 2px rgba(0,0,0,0.06)' : 'none',
                cursor: 'pointer',
                transition: 'all 0.15s ease',
              }}
              onClick={() => {
                setScope('all');
                setPage(1);
              }}
            >
              {t.allNotesScope}
            </button>
          </div>

          {/* Search bar */}
          <div style={{ position: 'relative' }}>
            <Search
              size={14}
              style={{
                position: 'absolute',
                left: '9px',
                top: '50%',
                transform: 'translateY(-50%)',
                color: 'var(--text-muted)',
                pointerEvents: 'none',
              }}
            />
            <input
              type="text"
              placeholder={t.searchNotesPlaceholder}
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
              style={{
                width: '100%',
                padding: '6px 10px 6px 28px',
                borderRadius: '6px',
                border: '1px solid var(--border-color)',
                backgroundColor: 'var(--surface)',
                color: 'var(--text-main)',
                fontSize: '0.8125rem',
                minHeight: '32px',
                boxSizing: 'border-box',
              }}
            />
          </div>

          {/* Filter row: high contrast in both light and dark mode */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px' }}>
            <select
              value={difficulty}
              onChange={(e) => {
                setDifficulty(e.target.value as typeof difficulty);
                setPage(1);
              }}
              style={{
                padding: '5px 8px',
                borderRadius: '6px',
                border: '1px solid var(--border-color)',
                backgroundColor: 'var(--surface)',
                color: 'var(--text-main)',
                fontSize: '0.8125rem',
                minHeight: '32px',
                cursor: 'pointer',
              }}
            >
              <option value="all" style={{ backgroundColor: 'var(--surface)', color: 'var(--text-main)' }}>{t.allDifficulties}</option>
              <option value="Easy" style={{ backgroundColor: 'var(--surface)', color: 'var(--text-main)' }}>{t.statEasy}</option>
              <option value="Medium" style={{ backgroundColor: 'var(--surface)', color: 'var(--text-main)' }}>{t.statMedium}</option>
              <option value="Hard" style={{ backgroundColor: 'var(--surface)', color: 'var(--text-main)' }}>{t.statHard}</option>
            </select>

            <select
              value={hasNote}
              onChange={(e) => {
                setHasNote(e.target.value as typeof hasNote);
                setPage(1);
              }}
              style={{
                padding: '5px 8px',
                borderRadius: '6px',
                border: '1px solid var(--border-color)',
                backgroundColor: 'var(--surface)',
                color: 'var(--text-main)',
                fontSize: '0.8125rem',
                minHeight: '32px',
                cursor: 'pointer',
              }}
            >
              <option value="all" style={{ backgroundColor: 'var(--surface)', color: 'var(--text-main)' }}>{t.filterHasNote}: 全部</option>
              <option value="true" style={{ backgroundColor: 'var(--surface)', color: 'var(--text-main)' }}>{t.hasNoteOnly}</option>
              <option value="false" style={{ backgroundColor: 'var(--surface)', color: 'var(--text-main)' }}>{t.noNoteOnly}</option>
            </select>
          </div>

          {/* List items */}
          <div
            className="notes-list-items"
            style={{
              flex: 1,
              overflowY: 'auto',
              display: 'flex',
              flexDirection: 'column',
              gap: '3px',
              paddingRight: '2px',
            }}
          >
            {loadingList ? (
              <div style={{ padding: '24px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.8125rem' }}>
                Loading notes...
              </div>
            ) : items.length === 0 ? (
              <div style={{ padding: '32px 16px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.8125rem' }}>
                {t.noNotesFound}
              </div>
            ) : (
              items.map((it) => {
                const isSelected = selectedId === it.questionFrontendId;
                const diffColor =
                  it.difficulty === 'Easy'
                    ? 'var(--easy)'
                    : it.difficulty === 'Medium'
                    ? 'var(--medium)'
                    : 'var(--hard)';

                return (
                  <button
                    key={it.questionId}
                    type="button"
                    onClick={() => handleSelectProblem(it.questionFrontendId)}
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '3px',
                      padding: '8px 10px',
                      borderRadius: '6px',
                      borderTop: 'none',
                      borderRight: 'none',
                      borderBottom: 'none',
                      borderLeft: isSelected ? '3px solid var(--primary)' : '3px solid transparent',
                      backgroundColor: isSelected ? 'var(--selected)' : 'transparent',
                      textAlign: 'left',
                      cursor: 'pointer',
                      transition: 'background-color 0.12s ease',
                      boxSizing: 'border-box',
                    }}
                    onMouseEnter={(e) => {
                      if (!isSelected) e.currentTarget.style.backgroundColor = 'var(--muted-surface)';
                    }}
                    onMouseLeave={(e) => {
                      if (!isSelected) e.currentTarget.style.backgroundColor = 'transparent';
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <span style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-muted)', fontFamily: 'monospace' }}>
                          #{it.questionFrontendId}
                        </span>
                        <span
                          style={{
                            display: 'inline-block',
                            width: '6px',
                            height: '6px',
                            borderRadius: '50%',
                            backgroundColor: diffColor,
                          }}
                          title={it.difficulty}
                        />
                        <span style={{ fontSize: '0.6875rem', color: diffColor, fontWeight: 500 }}>
                          {it.difficulty}
                        </span>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                        {it.hasAccepted && (
                          <span title="Solved" style={{ color: 'var(--primary)', fontSize: '0.75rem', fontWeight: 600, lineHeight: 1 }}>
                            ✓
                          </span>
                        )}
                        {it.hasCustomNote && (
                          <span title={t.hasNoteOnly} style={{ color: 'var(--text-muted)', display: 'inline-flex' }}>
                            <FileText size={11} />
                          </span>
                        )}
                      </div>
                    </div>
                    <div
                      style={{
                        fontSize: '0.8125rem',
                        fontWeight: isSelected ? 600 : 450,
                        color: 'var(--text-main)',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      {it.title}
                    </div>
                  </button>
                );
              })
            )}
          </div>

          {/* Pagination */}
          {total > limit && (
            <div style={{ paddingTop: '6px', borderTop: '1px solid var(--border-color)' }}>
              <Pagination lang={lang} page={page} total={total} limit={limit} onPage={setPage} />
            </div>
          )}
        </div>

        {/* Right Detail Column: Selected Problem Notes & Actions */}
        <div
          className="notes-detail-pane"
          style={{
            backgroundColor: 'var(--surface)',
            border: '1px solid var(--border-color)',
            borderRadius: '10px',
            padding: '20px',
            display: 'flex',
            flexDirection: 'column',
            gap: '16px',
            maxHeight: 'calc(100vh - 160px)',
            overflowY: 'auto',
          }}
        >
          {selectedSummary ? (
            <>
              {/* Problem header & copy/export bar */}
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'flex-start',
                  borderBottom: '1px solid var(--border-color)',
                  paddingBottom: '14px',
                  gap: '12px',
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginBottom: '6px' }}>
                    <h2 style={{ margin: 0, fontSize: '1.25rem', fontWeight: 620, color: 'var(--text-main)', display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                      <span>#{selectedSummary.questionFrontendId}. {selectedSummary.title}</span>
                      <a
                        href={selectedSummary.url}
                        target="_blank"
                        rel="noreferrer"
                        className="btn-icon"
                        title="Open on LeetCode ↗"
                        style={{ color: 'var(--text-muted)', display: 'inline-flex', alignItems: 'center' }}
                      >
                        <ExternalLink size={14} />
                      </a>
                    </h2>
                    <span className={`badge badge-${selectedSummary.difficulty.toLowerCase()}`} style={{ fontSize: '0.6875rem' }}>
                      {selectedSummary.difficulty}
                    </span>
                    {selectedSummary.hasAccepted && (
                      <span style={{ fontSize: '0.75rem', color: 'var(--primary)', fontWeight: 600 }}>
                        ✓ Solved
                      </span>
                    )}
                    {Boolean(selectedSummary.reviewStage) && (
                      <span style={{ fontSize: '0.6875rem', padding: '1px 6px', borderRadius: '4px', backgroundColor: 'var(--warning-bg)', color: 'var(--warning)', fontWeight: 500 }}>
                        Review · Stage {selectedSummary.reviewStage}
                      </span>
                    )}
                  </div>

                  {/* Subtle tags */}
                  {selectedSummary.tags.length > 0 && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                      {selectedSummary.tags.map((tag) => (
                        <span
                          key={tag}
                          style={{
                            fontSize: '0.6875rem',
                            backgroundColor: 'var(--muted-surface)',
                            padding: '1px 6px',
                            borderRadius: '3px',
                            color: 'var(--text-muted)',
                          }}
                        >
                          #{tag}
                        </span>
                      ))}
                    </div>
                  )}
                </div>

                {/* Actions: Quick Copy and single Markdown download */}
                <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexShrink: 0 }}>
                  <QuickCopyButtons
                    lang={lang}
                    problem={{
                      frontendId: selectedSummary.questionFrontendId,
                      title: selectedSummary.title,
                      url: selectedSummary.url,
                      difficulty: selectedSummary.difficulty,
                      tags: selectedSummary.tags,
                      slug: selectedSummary.titleSlug,
                    }}
                    record={{
                      durationMinutes: null,
                      notes: selectedSummary.latestPracticeNotes,
                    }}
                    customNote={noteContent}
                  />

                  <ExportLink
                lang={lang}
                onExport={() => api.exportSingleMarkdown(selectedSummary.questionFrontendId, lang)}
                href={api.getSingleMarkdownUrl(selectedSummary.questionFrontendId, lang)}
                    className="btn btn-secondary btn-sm"
                    title={t.exportSingleMarkdown}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}
                  >
                    <Download size={13} />
                    <span>.md</span>
                  </ExportLink>
                </div>
              </div>

              {/* Practice timeline: Collapsible Accordion to save vertical height */}
              <div style={{ borderBottom: '1px solid var(--border-color)', paddingBottom: showTimeline ? '12px' : '0' }}>
                <button
                  type="button"
                  onClick={() => setShowTimeline((prev) => !prev)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    width: '100%',
                    padding: '6px 8px',
                    borderRadius: '6px',
                    backgroundColor: 'transparent',
                    border: 'none',
                    cursor: 'pointer',
                    color: 'var(--text-muted)',
                    transition: 'background-color 0.12s ease',
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = 'var(--muted-surface)')}
                  onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
                >
                  <span style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.8125rem', fontWeight: 500, color: 'var(--text-secondary)' }}>
                    <Clock size={13} />
                    <span>{t.practiceTimelineTitle} ({practices.length})</span>
                  </span>
                  <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                    {showTimeline ? (zh ? '收起 ▴' : 'Collapse ▴') : (zh ? '展开 ▾' : 'Expand ▾')}
                  </span>
                </button>

                {showTimeline && (
                  <div style={{ marginTop: '8px' }}>
                    {loadingPractices ? (
                      <div style={{ color: 'var(--text-muted)', fontSize: '0.8125rem', padding: '4px 8px' }}>Loading practice logs...</div>
                    ) : practices.length === 0 ? (
                      <div style={{ color: 'var(--text-muted)', fontSize: '0.8125rem', padding: '4px 8px' }}>
                        {zh ? '暂无打卡记录。' : 'No practice logs recorded yet.'}
                      </div>
                    ) : (
                      <div
                        style={{
                          display: 'flex',
                          flexDirection: 'column',
                          gap: '6px',
                          maxHeight: '130px',
                          overflowY: 'auto',
                          paddingRight: '4px',
                        }}
                      >
                        {practices.map((pr) => (
                          <div
                            key={pr.id}
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'space-between',
                              padding: '6px 10px',
                              backgroundColor: 'var(--muted-surface)',
                              borderRadius: '6px',
                              fontSize: '0.75rem',
                            }}
                          >
                            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                              <span>{pr.completed ? '✅' : '⚠️'}</span>
                              <span style={{ fontWeight: 500 }}>{pr.practicedAt.slice(0, 10)}</span>
                              {pr.durationMinutes && (
                                <span style={{ color: 'var(--text-muted)' }}>⏱️ {pr.durationMinutes}m</span>
                              )}
                            </div>
                            {pr.notes && (
                              <div
                                style={{
                                  color: 'var(--text-secondary)',
                                  fontStyle: 'italic',
                                  maxWidth: '280px',
                                  overflow: 'hidden',
                                  textOverflow: 'ellipsis',
                                  whiteSpace: 'nowrap',
                                }}
                              >
                                "{pr.notes}"
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Long-form Note Editor */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', flex: 1 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
                  <div
                    style={{
                      fontSize: '0.875rem',
                      fontWeight: 600,
                      color: 'var(--text-secondary)',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                    }}
                  >
                    <BookOpen size={15} />
                    <span>{t.solutionReflectionTitle}</span>

                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      onClick={() => setNoteContent(NOTE_TEMPLATES[lang])}
                      disabled={loadingNote || noteLoadError || noteContent.trim().length > 0}
                      title={t.insertTemplateTitle}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '4px',
                        fontSize: '0.75rem',
                        padding: '3px 8px',
                      }}
                    >
                      <FileText size={12} />
                      <span>{t.insertTemplate}</span>
                    </button>

                    {noteContent.trim().length > 0 && !hasMeaningfulNoteContent(noteContent) && (
                      <span
                        title={t.unfilledTemplateTooltip}
                        style={{
                          fontSize: '0.6875rem',
                          backgroundColor: 'var(--warning-bg, rgba(234, 179, 8, 0.15))',
                          color: 'var(--warning, #eab308)',
                          padding: '2px 8px',
                          borderRadius: '4px',
                          fontWeight: 500,
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '4px',
                          border: '1px solid var(--warning, #eab308)',
                        }}
                      >
                        ⚠️ {t.unfilledTemplateNotice}
                      </span>
                    )}
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    {saveSuccess && (
                      <span style={{ color: 'var(--primary)', fontSize: '0.75rem', display: 'flex', alignItems: 'center', gap: '4px' }}>
                        <Check size={13} />
                        <span>{noteContent.trim().length === 0 ? t.noteClearedSuccess : t.noteSaved}</span>
                      </span>
                    )}
                    {saveError && <span style={{ color: 'var(--danger)', fontSize: '0.75rem' }}>{saveError}</span>}

                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      onClick={handleSaveNote}
                      disabled={!canSave}
                      style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}
                      title={
                        !canSave
                          ? !isModified
                            ? zh ? '内容未修改' : 'No changes to save'
                            : isBlank
                            ? t.emptyNoteSaveDisabled
                            : t.unfilledTemplateNotice
                          : undefined
                      }
                    >
                      <Save size={13} />
                      <span>{savingNote ? t.savingNote : t.saveNote}</span>
                      <span style={{ fontSize: '0.6875rem', opacity: 0.75 }}>{/Mac/.test(navigator.platform) ? '(⌘S)' : '(Ctrl+S)'}</span>
                    </button>
                  </div>
                </div>

                {noteLoadError && (
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '8px 12px',
                      backgroundColor: 'var(--danger-bg, rgba(239, 68, 68, 0.1))',
                      color: 'var(--danger, #ef4444)',
                      borderRadius: '6px',
                      fontSize: '0.8125rem',
                      border: '1px solid var(--danger, #ef4444)',
                    }}
                  >
                    <span>{t.loadNoteError}</span>
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      onClick={handleRetryLoad}
                      style={{ fontSize: '0.75rem', padding: '2px 8px' }}
                    >
                      {t.retry}
                    </button>
                  </div>
                )}

                <textarea
                  rows={16}
                  disabled={loadingNote || noteLoadError}
                  value={noteContent}
                  onChange={(e) => setNoteContent(e.target.value)}
                  placeholder={t.noteEditorPlaceholder}
                  style={{
                    width: '100%',
                    padding: '12px 14px',
                    borderRadius: '8px',
                    border: '1px solid var(--border-color)',
                    backgroundColor: 'var(--canvas)',
                    color: 'var(--text-main)',
                    fontSize: '0.875rem',
                    lineHeight: 1.65,
                    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
                    resize: 'vertical',
                    minHeight: '340px',
                    outline: 'none',
                    boxSizing: 'border-box',
                  }}
                  onFocus={(e) => (e.currentTarget.style.borderColor = 'var(--focus)')}
                  onBlur={(e) => (e.currentTarget.style.borderColor = 'var(--border-color)')}
                />
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.6875rem', color: 'var(--text-muted)' }}>
                  <span>Markdown & LaTeX KaTeX math ($O(N)$) supported</span>
                  <span>{noteContent.length} chars</span>
                </div>
              </div>
            </>
          ) : (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                height: '100%',
                color: 'var(--text-muted)',
                gap: '12px',
                minHeight: '400px',
              }}
            >
              <BookOpen size={36} style={{ opacity: 0.5 }} />
              <div>{t.selectProblemToViewNotes}</div>
            </div>
          )}
        </div>
      </div>

      {/* Phase 30: Unsaved Note Changes Confirmation Dialog */}
      {showUnsavedModal && (
        <Dialog
          title={t.unsavedNoteModalTitle}
          lang={lang}
          onClose={handleCancelSwitch}
          footer={
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', width: '100%' }}>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={handleCancelSwitch}
              >
                {t.unsavedNoteStay}
              </button>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={handleDiscardAndSwitch}
                style={{
                  color: 'var(--danger, #ef4444)',
                  borderColor: 'var(--danger, #ef4444)',
                }}
              >
                {t.unsavedNoteDiscard}
              </button>
            </div>
          }
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <p style={{ margin: 0, color: 'var(--text-secondary)', fontSize: '0.875rem', lineHeight: 1.5 }}>
              {t.unsavedNoteModalDesc}
            </p>

            {pendingTargetId && (
              <div
                style={{
                  padding: '10px 12px',
                  backgroundColor: 'var(--muted-surface)',
                  borderRadius: '6px',
                  fontSize: '0.8125rem',
                  color: 'var(--text-main)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                }}
              >
                <span style={{ color: 'var(--text-muted)' }}>{t.unsavedNoteSwitchingTo}</span>
                <span style={{ fontWeight: 600 }}>
                  #{pendingTargetId}
                  {pendingTargetSummary ? ` · ${pendingTargetSummary.title}` : ''}
                </span>
              </div>
            )}
          </div>
        </Dialog>
      )}
    </div>
  );
}
