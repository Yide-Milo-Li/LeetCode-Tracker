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
import { api } from '../api.ts';
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
}

/** Browse and edit notes while keeping asynchronous responses owned by their selection visit. */
export function NotesWorkspace({
  lang,
  notesFormatOnSave: controlledFormatOnSave,
  initialFrontendId,
  onClearInitialFrontendId,
}: NotesWorkspaceProps) {
  const t = translations[lang];
  const workspace = useWorkspace();
  const zh = lang === 'zh';
  const isMac = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform ?? '');
  const zenModeTitle = isMac
    ? (zh ? '专注模式快捷键 (⌘\\)' : 'Zen Mode Shortcut (⌘\\)')
    : (zh ? '专注模式快捷键 (Ctrl+\\)' : 'Zen Mode Shortcut (Ctrl+\\)');

  // Selected problem state
  const [selectedId, setSelectedId] = useState<string | null>(initialFrontendId ?? null);

  // Phase 30: Unsaved note switch guard state
  const [pendingTargetId, setPendingTargetId] = useState<string | null>(null);
  const [showUnsavedModal, setShowUnsavedModal] = useState(false);

  // Hook order keeps the original request order on mount: settings, summary lookup, list, then note.
  const formatSetting = useFormatOnSaveSetting(controlledFormatOnSave);
  const list = useNotesList({ selectedId, setSelectedId, externalRevision: workspace.desktopAgentRevision });
  const { items, selectedSummary } = list;
  const editor = useNoteEditor({
    lang,
    selectedId,
    externalRevision: workspace.desktopAgentRevision,
    controlledFormatOnSave,
    formatSetting,
    setSelectedSummary: list.setSelectedSummary,
    setItems: list.setItems,
    setListRevision: list.setListRevision,
  });
  const { canSave, handleSaveNote, hasUnsavedChanges, aiReview, closeAiReview } = editor;

  const [showTimeline, setShowTimeline] = useState(false);

  // Phase 31: Workbench view mode & toolbar state
  const [viewMode, setViewMode] = useState<NotesViewMode>('split');
  const [zenMode, setZenMode] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  // Native popover handles outside clicks, Escape and the top layer; see useActionPopover.
  const codeMenu = useActionPopover();

  // Ctrl+S / Cmd+S shortcut to save; Ctrl+\ / Cmd+\ shortcut to toggle Zen mode
  useEffect(() => {
    /** Route keyboard shortcuts for saving and focus mode. */
    function handleKeyDown(e: KeyboardEvent) {
      if (rootRef.current?.closest('[hidden]')) return;
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

  return (
    <div ref={rootRef} className="notes-workspace-view">
      <PageHeader
        title={t.notesWorkspaceTitle}
        description={t.notesWorkspaceDesc}
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
