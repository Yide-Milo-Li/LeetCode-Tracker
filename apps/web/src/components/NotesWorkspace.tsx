/**
 * Independent Notes Workspace providing Master-Detail browsing,
 * deep solution editing, practice history timeline, and Obsidian/Notion knowledge export.
 */
import React, { useCallback, useEffect, useState } from 'react';
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
} from '../api.ts';
import { translations, type Language } from '../i18n.ts';
import { PageHeader, Feedback, Field, Pagination } from './ui.tsx';
import { QuickCopyButtons } from './QuickCopyButtons.tsx';

const DEFAULT_NOTE_TEMPLATE = `## 💡 核心思路 (Key Idea & Approach)
- 

## ⏱️ 复杂度分析 (Complexity)
- 时间复杂度 (Time Complexity): $O(N)$
- 空间复杂度 (Space Complexity): $O(1)$

## 💻 最佳实现 (Clean Implementation)
\`\`\`python
class Solution:
    pass
\`\`\`

## ⚠️ 避坑与边界情况 (Edge Cases & Common Traps)
- 
`;

export interface NotesWorkspaceProps {
  lang: Language;
  initialFrontendId?: string | null;
}

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

  // Selected problem state
  const [selectedId, setSelectedId] = useState<string | null>(initialFrontendId ?? null);

  useEffect(() => {
    if (initialFrontendId) {
      setSelectedId(initialFrontendId);
    }
  }, [initialFrontendId]);

  const [selectedSummary, setSelectedSummary] = useState<ProblemNoteSummary | null>(null);
  const [noteContent, setNoteContent] = useState('');
  const [loadingNote, setLoadingNote] = useState(false);
  const [savingNote, setSavingNote] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [saveError, setSaveError] = useState('');

  // Selected problem practice timeline
  const [practices, setPractices] = useState<PracticeRecord[]>([]);
  const [loadingPractices, setLoadingPractices] = useState(false);

  // Load problem notes list
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
        if (!selectedId && res.items.length > 0) {
          setSelectedId(res.items[0].questionFrontendId);
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
  }, [scope, search, difficulty, hasNote, page, selectedId]);

  useEffect(() => {
    loadList();
  }, [loadList]);

  // Handle pre-selected problem or change of selectedId
  useEffect(() => {
    if (!selectedId) {
      setSelectedSummary(null);
      setNoteContent('');
      setPractices([]);
      return;
    }

    // Find summary in current list or fetch
    const matched = items.find((it) => it.questionFrontendId === selectedId);
    if (matched) {
      setSelectedSummary(matched);
    }

    let active = true;
    setLoadingNote(true);
    setSaveSuccess(false);
    setSaveError('');

    // Fetch note content
    api
      .getNote(selectedId)
      .then((res) => {
        if (!active) return;
        if (res.note && res.note.content.trim().length > 0) {
          setNoteContent(res.note.content);
        } else {
          setNoteContent(DEFAULT_NOTE_TEMPLATE);
        }
      })
      .catch(() => {
        if (active) setNoteContent(DEFAULT_NOTE_TEMPLATE);
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
  }, [selectedId, items]);

  // Save note handler
  async function handleSaveNote() {
    if (!selectedId) return;
    setSavingNote(true);
    setSaveSuccess(false);
    setSaveError('');

    try {
      await api.upsertNote(selectedId, noteContent);
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 2500);

      // Update local list item status
      setItems((prev) =>
        prev.map((it) =>
          it.questionFrontendId === selectedId
            ? { ...it, hasCustomNote: true, customNoteUpdatedAt: Date.now() }
            : it
        )
      );
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingNote(false);
    }
  }

  // Ctrl+S / Cmd+S shortcut to save
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        void handleSaveNote();
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleSaveNote]);

  const totalPages = Math.max(1, Math.ceil(total / limit));

  return (
    <div className="notes-workspace-view" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <PageHeader
        title={t.notesWorkspaceTitle}
        description={t.notesWorkspaceDesc}
        actions={
          <div style={{ display: 'flex', gap: '8px' }}>
            <a
              href={api.getObsidianZipUrl('all')}
              className="btn btn-secondary btn-sm"
              title="Download 4,000+ Obsidian markdown skeleton"
            >
              <Archive size={15} />
              <span>{t.exportObsidianVault}</span>
            </a>
            <a
              href={api.getNotionCsvUrl('summary')}
              className="btn btn-secondary btn-sm"
              title="Download Notion Problems Summary CSV"
            >
              <Download size={15} />
              <span>{zh ? '导出 Notion 题库表' : 'Notion CSV'}</span>
            </a>
          </div>
        }
      />

      {/* Master-Detail Grid */}
      <div
        className="notes-master-detail"
        style={{
          display: 'grid',
          gridTemplateColumns: '360px 1fr',
          gap: '20px',
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
            gap: '12px',
            backgroundColor: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: '12px',
            padding: '16px',
            height: '100%',
            maxHeight: 'calc(100vh - 160px)',
            overflow: 'hidden',
          }}
        >
          {/* Scope switch */}
          <div style={{ display: 'flex', borderRadius: '6px', border: '1px solid var(--border)', overflow: 'hidden' }}>
            <button
              type="button"
              className={`btn btn-sm ${scope === 'practiced' ? 'btn-primary' : 'btn-secondary'}`}
              style={{ flex: 1, borderRadius: 0, border: 'none' }}
              onClick={() => {
                setScope('practiced');
                setPage(1);
              }}
            >
              {t.practicedNotesScope}
            </button>
            <button
              type="button"
              className={`btn btn-sm ${scope === 'all' ? 'btn-primary' : 'btn-secondary'}`}
              style={{ flex: 1, borderRadius: 0, border: 'none' }}
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
              size={15}
              style={{
                position: 'absolute',
                left: '10px',
                top: '50%',
                transform: 'translateY(-50%)',
                color: 'var(--text-muted)',
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
                padding: '8px 12px 8px 32px',
                borderRadius: '6px',
                border: '1px solid var(--border)',
                backgroundColor: 'var(--surface-muted)',
                color: 'var(--text-primary)',
                fontSize: '0.875rem',
              }}
            />
          </div>

          {/* Filter row */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
            <select
              value={difficulty}
              onChange={(e) => {
                setDifficulty(e.target.value as typeof difficulty);
                setPage(1);
              }}
              style={{
                padding: '6px 8px',
                borderRadius: '6px',
                border: '1px solid var(--border)',
                backgroundColor: 'var(--surface-muted)',
                color: 'var(--text-primary)',
                fontSize: '0.8125rem',
              }}
            >
              <option value="all">{t.allDifficulties}</option>
              <option value="Easy">{t.statEasy}</option>
              <option value="Medium">{t.statMedium}</option>
              <option value="Hard">{t.statHard}</option>
            </select>

            <select
              value={hasNote}
              onChange={(e) => {
                setHasNote(e.target.value as typeof hasNote);
                setPage(1);
              }}
              style={{
                padding: '6px 8px',
                borderRadius: '6px',
                border: '1px solid var(--border)',
                backgroundColor: 'var(--surface-muted)',
                color: 'var(--text-primary)',
                fontSize: '0.8125rem',
              }}
            >
              <option value="all">{t.filterHasNote}: 全部</option>
              <option value="true">{t.hasNoteOnly}</option>
              <option value="false">{t.noNoteOnly}</option>
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
              gap: '6px',
              paddingRight: '4px',
            }}
          >
            {loadingList ? (
              <div style={{ padding: '24px', textAlign: 'center', color: 'var(--text-muted)' }}>
                Loading notes...
              </div>
            ) : items.length === 0 ? (
              <div style={{ padding: '32px 16px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.875rem' }}>
                {t.noNotesFound}
              </div>
            ) : (
              items.map((it) => {
                const isSelected = selectedId === it.questionFrontendId;
                return (
                  <button
                    key={it.questionId}
                    type="button"
                    onClick={() => setSelectedId(it.questionFrontendId)}
                    style={{
                      display: 'flex',
                      alignItems: 'flex-start',
                      justifyContent: 'space-between',
                      padding: '10px 12px',
                      borderRadius: '8px',
                      border: isSelected ? '1px solid var(--primary)' : '1px solid transparent',
                      backgroundColor: isSelected ? 'var(--primary-subtle)' : 'var(--surface-muted)',
                      textAlign: 'left',
                      cursor: 'pointer',
                      transition: 'background-color 0.15s',
                    }}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '2px' }}>
                        <span style={{ fontSize: '0.8125rem', fontWeight: 600, color: 'var(--text-muted)' }}>
                          #{it.questionFrontendId}
                        </span>
                        <span className={`badge badge-${it.difficulty.toLowerCase()}`} style={{ fontSize: '0.6875rem' }}>
                          {it.difficulty}
                        </span>
                        {it.hasAccepted && (
                          <span title="Solved" style={{ color: 'var(--success)', fontSize: '0.8125rem' }}>
                            ✓
                          </span>
                        )}
                        {it.hasCustomNote && (
                          <span title={t.hasNoteOnly} style={{ color: 'var(--primary)' }}>
                            <FileText size={12} />
                          </span>
                        )}
                      </div>
                      <div
                        style={{
                          fontSize: '0.875rem',
                          fontWeight: 500,
                          color: 'var(--text-primary)',
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                        }}
                      >
                        {it.title}
                      </div>
                    </div>
                  </button>
                );
              })
            )}
          </div>

          {/* Pagination */}
          {total > limit && (
            <div style={{ paddingTop: '8px', borderTop: '1px solid var(--border)' }}>
              <Pagination lang={lang} page={page} total={total} limit={limit} onPage={setPage} />
            </div>
          )}
        </div>

        {/* Right Detail Column: Selected Problem Notes & Actions */}
        <div
          className="notes-detail-pane"
          style={{
            backgroundColor: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: '12px',
            padding: '24px',
            display: 'flex',
            flexDirection: 'column',
            gap: '20px',
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
                  borderBottom: '1px solid var(--border)',
                  paddingBottom: '16px',
                }}
              >
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
                    <span style={{ fontSize: '0.875rem', fontWeight: 600, color: 'var(--text-muted)' }}>
                      #{selectedSummary.questionFrontendId}
                    </span>
                    <span className={`badge badge-${selectedSummary.difficulty.toLowerCase()}`}>
                      {selectedSummary.difficulty}
                    </span>
                    {selectedSummary.hasAccepted && (
                      <span className="badge" style={{ backgroundColor: 'var(--success-subtle)', color: 'var(--success)' }}>
                        Solved
                      </span>
                    )}
                    {selectedSummary.reviewStage && (
                      <span className="badge" style={{ backgroundColor: 'var(--accent-subtle)', color: 'var(--accent)' }}>
                        Review · Stage {selectedSummary.reviewStage}
                      </span>
                    )}
                  </div>

                  <h2 style={{ margin: '0 0 8px', fontSize: '1.375rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span>{selectedSummary.title}</span>
                    <a
                      href={selectedSummary.url}
                      target="_blank"
                      rel="noreferrer"
                      className="btn-icon"
                      title="Open on LeetCode ↗"
                      style={{ color: 'var(--text-muted)' }}
                    >
                      <ExternalLink size={16} />
                    </a>
                  </h2>

                  {/* Tags */}
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                    {selectedSummary.tags.map((tag) => (
                      <span
                        key={tag}
                        style={{
                          fontSize: '0.75rem',
                          backgroundColor: 'var(--surface-muted)',
                          padding: '2px 8px',
                          borderRadius: '4px',
                          color: 'var(--text-muted)',
                        }}
                      >
                        #{tag}
                      </span>
                    ))}
                  </div>
                </div>

                {/* Actions: Quick Copy and single Markdown download */}
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
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

                  <a
                    href={api.getSingleMarkdownUrl(selectedSummary.questionFrontendId)}
                    className="btn btn-secondary btn-sm"
                    title={t.exportSingleMarkdown}
                  >
                    <Download size={14} />
                    <span>.md</span>
                  </a>
                </div>
              </div>

              {/* Practice timeline */}
              <div>
                <div
                  style={{
                    fontSize: '0.875rem',
                    fontWeight: 600,
                    color: 'var(--text-secondary)',
                    marginBottom: '8px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                  }}
                >
                  <Clock size={16} />
                  <span>{t.practiceTimelineTitle} ({practices.length})</span>
                </div>

                {loadingPractices ? (
                  <div style={{ color: 'var(--text-muted)', fontSize: '0.875rem' }}>Loading practice logs...</div>
                ) : practices.length === 0 ? (
                  <div style={{ color: 'var(--text-muted)', fontSize: '0.875rem' }}>
                    {zh ? '暂无打卡记录。' : 'No practice logs recorded yet.'}
                  </div>
                ) : (
                  <div
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '8px',
                      maxHeight: '160px',
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
                          padding: '8px 12px',
                          backgroundColor: 'var(--surface-muted)',
                          borderRadius: '6px',
                          fontSize: '0.8125rem',
                          border: '1px solid var(--border)',
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
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
                              maxWidth: '300px',
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

              {/* Long-form Note Editor */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', flex: 1 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div
                    style={{
                      fontSize: '0.875rem',
                      fontWeight: 600,
                      color: 'var(--text-secondary)',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '6px',
                    }}
                  >
                    <BookOpen size={16} />
                    <span>{t.solutionReflectionTitle}</span>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    {saveSuccess && (
                      <span style={{ color: 'var(--success)', fontSize: '0.8125rem', display: 'flex', alignItems: 'center', gap: '4px' }}>
                        <Check size={14} />
                        <span>{t.noteSaved}</span>
                      </span>
                    )}
                    {saveError && <span style={{ color: 'var(--error)', fontSize: '0.8125rem' }}>{saveError}</span>}

                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      onClick={handleSaveNote}
                      disabled={savingNote}
                    >
                      <Save size={14} />
                      <span>{savingNote ? t.savingNote : t.saveNote}</span>
                      <span style={{ fontSize: '0.6875rem', opacity: 0.7 }}>(Ctrl+S)</span>
                    </button>
                  </div>
                </div>

                <textarea
                  rows={14}
                  value={noteContent}
                  onChange={(e) => setNoteContent(e.target.value)}
                  placeholder="Write your comprehensive solution, approach, and edge cases here..."
                  style={{
                    width: '100%',
                    padding: '12px 14px',
                    borderRadius: '8px',
                    border: '1px solid var(--border)',
                    backgroundColor: 'var(--surface-muted)',
                    color: 'var(--text-primary)',
                    fontSize: '0.9375rem',
                    lineHeight: 1.6,
                    fontFamily: 'Consolas, Monaco, "Courier New", monospace',
                    resize: 'vertical',
                    minHeight: '260px',
                  }}
                />
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
              }}
            >
              <BookOpen size={36} style={{ opacity: 0.5 }} />
              <div>{t.selectProblemToViewNotes}</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
