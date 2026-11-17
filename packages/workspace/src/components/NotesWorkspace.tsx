/**
 * Independent Notes Workspace providing Master-Detail browsing,
 * deep solution editing, practice history timeline, and Obsidian/Notion knowledge export.
 *
 * This module composes the workspace: it owns the selection (with the unsaved-changes switch
 * guard), zen/view modes and keyboard shortcuts. List loading lives in `notes/useNotesList`,
 * the note editor and its save/format/AI-review revision logic in `notes/useNoteEditor`, and
 * the panes and dialogs in `notes/*`.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Archive, Download, BookOpen } from 'lucide-react';
import { useWorkspaceEnvironment } from '../context.tsx';
import { translations, type Language } from '../i18n.ts';
import { PageHeader, useActionPopover } from './ui.tsx';
import { ExportLink } from './ExportLink.tsx';
import { useWorkspace } from '../workspace.tsx';
import { useFormatOnSaveSetting } from './notes/useFormatOnSaveSetting.ts';
import { useNotesList } from './notes/useNotesList.ts';
import { useNoteEditor } from './notes/useNoteEditor.ts';
import { NotesProblemListPane } from './notes/NotesProblemListPane.tsx';
import { NoteProblemHeader } from './notes/NoteProblemHeader.tsx';
import { PracticeTimeline } from './notes/PracticeTimeline.tsx';
import { NoteEditorPanel } from './notes/NoteEditorPanel.tsx';
import type { NotesViewMode } from './notes/NoteEditorToolbar.tsx';
import { AiFormatReviewDialog } from './notes/AiFormatReviewDialog.tsx';
import { UnsavedChangesDialog } from './notes/UnsavedChangesDialog.tsx';

export interface NotesWorkspaceProps {
  lang: Language;
  /** Controlled format-on-save preference from Settings (`null` while loading); falls back to settings API when omitted. */
  notesFormatOnSave?: boolean | null;
  initialFrontendId?: string | null;
  /** Clear external initial frontend ID once consumed to prevent deadlock on subsequent switches. */
  onClearInitialFrontendId?: () => void;
  /** Notify parent of active unsaved edits in current note. */
  onDirtyChange?: (dirty: boolean) => void;
  /** Register programmatic save handler for exit confirmation flow. */
  registerSaveHandler?: (handler: (() => Promise<boolean>) | null) => void;
}

/** Browse and edit notes while keeping asynchronous responses owned by their selection visit. */
export function NotesWorkspace({
  lang,
  notesFormatOnSave: controlledFormatOnSave,
  initialFrontendId,
  onClearInitialFrontendId,
  onDirtyChange,
  registerSaveHandler,
}: NotesWorkspaceProps) {
  const environment = useWorkspaceEnvironment();
  const api = environment.client;

  const t = translations[lang];
  const workspace = useWorkspace();
  const zh = lang === 'zh';
  const isMac = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform ?? '');
  const zenModeTitle = isMac
    ? (zh ? '专注模式快捷键 (⌘\\)' : 'Zen Mode Shortcut (⌘\\)')
    : (zh ? '专注模式快捷键 (Ctrl+\\)' : 'Zen Mode Shortcut (Ctrl+\\)');

  // Selected problem state
  const [selectedId, setSelectedId] = useState<string | null>(initialFrontendId ?? null);
  // The host restores the selected note after reloads and mirrors it to embedded chat surfaces.
  useEffect(() => {
    if (!selectedId) return;
    const active = environment.host.recoveryState().view === 'notes';
    environment.host.saveRecoveryState({
      ...environment.host.recoveryState(),
      noteFrontendId: selectedId,
      ...(active ? { targetId: selectedId } : {}),
    });
    if (active) environment.host.emit({ type: 'selection', view: 'notes', targetId: selectedId });
  }, [selectedId, environment.host]);

  // Phase 30: Unsaved note switch guard state
  const [pendingTargetId, setPendingTargetId] = useState<string | null>(null);
  const [showUnsavedModal, setShowUnsavedModal] = useState(false);

  const rootRef = useRef<HTMLDivElement>(null);

  // Hook order keeps the original request order on mount: settings, summary lookup, list, then note.
  const formatSetting = useFormatOnSaveSetting(controlledFormatOnSave);
  const list = useNotesList({ selectedId, setSelectedId });
  const { items, selectedSummary } = list;
  const editor = useNoteEditor({
    lang,
    selectedId,
    controlledFormatOnSave,
    formatSetting,
    setSelectedSummary: list.setSelectedSummary,
    setItems: list.setItems,
    setListRevision: list.setListRevision,
    rootRef,
    onDirtyChange,
  });
  const { canSave, handleSaveNote, hasUnsavedChanges, aiReview, closeAiReview } = editor;

  useEffect(() => {
    onDirtyChange?.(hasUnsavedChanges || editor.savingNote);
  }, [hasUnsavedChanges, editor.savingNote, onDirtyChange]);

  useEffect(() => {
    if (registerSaveHandler) {
      registerSaveHandler(handleSaveNote);
      return () => registerSaveHandler(null);
    }
  }, [registerSaveHandler, handleSaveNote]);

  const [showTimeline, setShowTimeline] = useState(false);

  // Phase 31: Workbench view mode & toolbar state
  const [viewMode, setViewMode] = useState<NotesViewMode>('split');
  const [zenMode, setZenMode] = useState(false);
  // Native popover handles outside clicks, Escape and the top layer; see useActionPopover.
  const codeMenu = useActionPopover();

  // Ctrl+S / Cmd+S shortcut to save; Ctrl+\ / Cmd+\ shortcut to toggle Zen mode
  useEffect(() => {
    /** Route keyboard shortcuts for saving and focus mode. */
    function handleKeyDown(e: KeyboardEvent) {
      // Retained hidden views must not handle shortcuts intended for the active view.
      if (rootRef.current?.closest('[hidden]')) return;
      // Embedded hosts share the page; only handle keys that originate inside this workspace.
      if (environment.host.id !== 'desktop' && (!(e.target instanceof Node) || !environment.root.current?.contains(e.target))) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (canSave) {
          void handleSaveNote();
        }
      } else if ((e.ctrlKey || e.metaKey) && e.key === '\\') {
        e.preventDefault();
        setZenMode((z) => !z);
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [canSave, handleSaveNote, environment.host, environment.root]);

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

  const lastHandledInitialId = useRef<string | null>(null);
  useEffect(() => {
    if (initialFrontendId && initialFrontendId !== lastHandledInitialId.current) {
      lastHandledInitialId.current = initialFrontendId;
      if (initialFrontendId !== selectedId) {
        if (hasUnsavedChanges) {
          setPendingTargetId(initialFrontendId);
          setShowUnsavedModal(true);
        } else {
          setSelectedId(initialFrontendId);
        }
      }
      onClearInitialFrontendId?.();
    } else if (!initialFrontendId) {
      lastHandledInitialId.current = null;
    }
  }, [initialFrontendId, selectedId, hasUnsavedChanges, onClearInitialFrontendId]);

  /** Discard unsaved modifications and switch to the pending target problem. */
  const handleDiscardAndSwitch = useCallback(async () => {
    if (!pendingTargetId) return;
    if (!(await editor.discardDraft())) return;
    const target = pendingTargetId;
    setShowUnsavedModal(false);
    setPendingTargetId(null);
    setSelectedId(target);
  }, [pendingTargetId, editor.discardDraft]);

  /** Cancel switching and stay on the current problem note. */
  const handleCancelSwitch = useCallback(() => {
    setShowUnsavedModal(false);
    setPendingTargetId(null);
  }, []);

  const pendingTargetSummary = pendingTargetId
    ? items.find((it) => it.questionFrontendId === pendingTargetId) ?? null
    : null;

  return (
    <div ref={rootRef} className="notes-workspace-view">
      {editor.draftStatus && <div role="status" className="embedded-draft-status">{editor.draftStatus}</div>}
      {editor.externalChange && (
        <div
          role="status"
          style={{
            padding: '8px 16px',
            backgroundColor: 'var(--warning-bg)',
            borderBottom: '1px solid var(--warning, #f9ab00)',
            color: 'var(--text-primary)',
            fontSize: '0.875rem',
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
          }}
        >
          <span>{zh ? '⚠️ 外部数据已更新；未保存草稿已保留。' : '⚠️ External data changed; your unsaved draft was preserved.'}</span>
        </div>
      )}
      {editor.remoteNote && (
        <details className="notes-conflict-details" style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
          <summary>{zh ? '比较资料库当前内容与保留的草稿' : 'Compare current library content and preserved draft'}</summary>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginTop: '12px' }}>
            <section><strong>{zh ? '资料库当前内容' : 'Current library content'}</strong><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: '260px', overflow: 'auto' }}>{editor.remoteNote.content}</pre></section>
            <section><strong>{zh ? '保留的草稿' : 'Preserved draft'}</strong><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: '260px', overflow: 'auto' }}>{editor.noteContent}</pre></section>
          </div>
          <button type="button" className="btn btn-secondary btn-sm" onClick={editor.adoptRemoteBaseline}>
            {zh ? '确认比较，保留草稿并采用当前版本' : 'Keep draft and use this current version'}
          </button>
        </details>
      )}
      <PageHeader
        title={t.notesWorkspaceTitle}
        description={environment.host.capabilities.exports
          ? t.notesWorkspaceDesc
          : zh ? '整理题解、复杂度分析与练习反思。' : 'Solutions, complexity analysis, and practice reflections.'}
        actions={
          <div className="nw-header-actions">
            <ExportLink
              lang={lang}
              onExport={() => api.exportObsidianZip('all', lang)}
              href={api.getObsidianZipUrl('all', lang)}
              className="btn btn-secondary btn-sm nw-export-link"
              title={t.exportObsidianTitle}
            >
              <Archive size={14} />
              <span>{t.exportObsidianVault}</span>
            </ExportLink>
            <ExportLink
              lang={lang}
              onExport={() => api.exportNotionCsv('summary')}
              href={api.getNotionCsvUrl('summary')}
              className="btn btn-secondary btn-sm nw-export-link"
              title={t.exportNotionSummaryTitle}
            >
              <Download size={14} />
              <span>{zh ? 'Notion 题库表' : 'Notion CSV'}</span>
            </ExportLink>
          </div>
        }
      />

      {/* Master-Detail Grid */}
      <div className={`notes-master-detail nw-master-detail ${zenMode ? 'zen' : ''}`}>
        {/* Left Master Column: Problem List & Filters */}
        <NotesProblemListPane
          lang={lang}
          zenMode={zenMode}
          list={list}
          selectedId={selectedId}
          onSelectProblem={handleSelectProblem}
        />

        {/* Right Detail Column: Selected Problem Notes & Actions */}
        <div className="notes-detail-pane nw-detail-pane">
          {selectedSummary ? (
            <>
              {/* Problem header & copy/export bar */}
              <NoteProblemHeader
                lang={lang}
                summary={selectedSummary}
                noteContent={editor.noteContent}
                zenMode={zenMode}
                onToggleZen={() => setZenMode((z) => !z)}
                zenModeTitle={zenModeTitle}
              />

              {/* Practice timeline: Collapsible Accordion to save vertical height */}
              <PracticeTimeline
                lang={lang}
                practices={editor.practices}
                loading={editor.loadingPractices}
                open={showTimeline}
                onToggle={() => setShowTimeline((prev) => !prev)}
              />

              {/* Long-form Note Editor & Markdown Workbench */}
              <NoteEditorPanel
                lang={lang}
                editor={editor}
                isMac={isMac}
                codeMenu={codeMenu}
                viewMode={viewMode}
                onViewModeChange={setViewMode}
              />
            </>
          ) : (
            <div className="nw-detail-empty">
              <BookOpen size={36} className="nw-detail-empty-icon" />
              <div>{t.selectProblemToViewNotes}</div>
            </div>
          )}
        </div>
      </div>

      {aiReview && (
        <AiFormatReviewDialog
          lang={lang}
          review={aiReview}
          onClose={closeAiReview}
          onOpenSettings={() => { closeAiReview(); workspace.navigate('settings'); }}
          onGenerate={() => void editor.generateAiSuggestion()}
          onApply={editor.applyAiSuggestion}
        />
      )}

      {/* Phase 30: Unsaved Note Changes Confirmation Dialog */}
      {showUnsavedModal && (
        <UnsavedChangesDialog
          lang={lang}
          pendingTargetId={pendingTargetId}
          pendingTargetSummary={pendingTargetSummary}
          onCancel={handleCancelSwitch}
          onDiscard={handleDiscardAndSwitch}
        />
      )}
    </div>
  );
}
