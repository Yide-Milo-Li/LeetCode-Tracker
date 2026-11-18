/** Long-form note editor: status/actions header, load error, toolbar, edit/preview canvas and footer. */
import { BookOpen, Check, Save } from 'lucide-react';
import { useId } from 'react';
import { NOTE_TEMPLATES, hasMeaningfulNoteContent } from '../../api.ts';
import { translations, type Language } from '../../i18n.ts';
import type { ActionPopover } from '../ui.tsx';
import { NotesMarkdownPreview } from '../NotesMarkdownPreview.tsx';
import { NoteEditorToolbar, type NotesViewMode } from './NoteEditorToolbar.tsx';
import type { NoteEditorState } from './useNoteEditor.ts';

interface NoteEditorPanelProps {
  lang: Language;
  editor: NoteEditorState;
  /** Selects the ⌘ or Ctrl shortcut label. */
  isMac: boolean;
  codeMenu: ActionPopover;
  viewMode: NotesViewMode;
  onViewModeChange: (mode: NotesViewMode) => void;
}

/** Render the editor for the selected note; all state and actions come from `useNoteEditor`. */
export function NoteEditorPanel({ lang, editor, isMac, codeMenu, viewMode, onViewModeChange }: NoteEditorPanelProps) {
  const t = translations[lang];
  const conflictMessageId = useId();
  const zh = lang === 'zh';
  const {
    noteContent, setNoteContent, textareaRef, wrapTextareaSelection,
    loadingNote, noteLoadError, handleRetryLoad, savingNote, saveSuccess, saveError, formatNotice,
    canUndoFormat, handleUndoFormat, isModified, isBlank, canSave, handleSaveNote, openAiReview,
  } = editor;

  return (
    <div className="nw-editor">
      {/* Header row: Title + Actions */}
      <div className="nw-editor-header">
        <div className="nw-editor-title">
          <BookOpen size={15} />
          <span>{t.solutionReflectionTitle}</span>

          {noteContent.trim().length > 0 && !hasMeaningfulNoteContent(noteContent) && (
            <span title={t.unfilledTemplateTooltip} className="nw-template-warning">
              ⚠️ {t.unfilledTemplateNotice}
            </span>
          )}
        </div>

        <div className="nw-editor-actions">
          {saveSuccess && (
            <span className="nw-save-success">
              <Check size={13} />
              <span>{noteContent.trim().length === 0 ? t.noteClearedSuccess : t.noteSaved}</span>
            </span>
          )}
          {saveError && <span className="nw-save-error" role="alert">{saveError}</span>}
          {formatNotice && <span role="status" className="nw-format-notice">{formatNotice}</span>}
          {canUndoFormat && (
            <button type="button" className="btn btn-secondary btn-sm" onClick={handleUndoFormat}>
              {t.notesUndoFormat}
            </button>
          )}

          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => void openAiReview()}
            disabled={!noteContent.trim() || loadingNote || noteLoadError || savingNote}
          >
            {t.notesAiFormat}
          </button>

          <button
            type="button"
            className="btn btn-primary btn-sm nw-save-btn"
            onClick={handleSaveNote}
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
            <Save size={13} />
            <span>{savingNote ? t.savingNote : t.saveNote}</span>
            <span className="nw-shortcut-hint">
              {isMac ? '(⌘S)' : '(Ctrl+S)'}
            </span>
          </button>
        </div>
      </div>

      {editor.hasConflict && (
        <div className="nw-load-error">
          <span role="status" id={conflictMessageId}>
            {zh ? '已保存的笔记有更新。你的草稿仍在编辑器中。' : 'The saved note changed. Your draft is still in the editor.'}
          </span>
          <button type="button" className="btn btn-secondary btn-sm" disabled={savingNote || loadingNote} onClick={editor.reloadSavedVersion}>
            {zh ? '加载已保存版本' : 'Load saved version'}
          </button>
          <button type="button" className="btn btn-secondary btn-sm" disabled={!editor.canOverwrite} onClick={editor.keepMyDraft}>
            {zh ? '用我的草稿覆盖' : 'Overwrite with my draft'}
          </button>
        </div>
      )}
      {noteLoadError && (
        <div className="nw-load-error">
          <span>{t.loadNoteError}</span>
          <button
            type="button"
            className="btn btn-secondary btn-sm nw-retry-btn"
            onClick={handleRetryLoad}
          >
            {t.retry}
          </button>
        </div>
      )}

      {/* Phase 31: Markdown Formatting Toolbar */}
      <NoteEditorToolbar
        lang={lang}
        disabled={loadingNote || noteLoadError}
        canInsertTemplate={noteContent.trim().length === 0}
        onWrap={wrapTextareaSelection}
        onInsertTemplate={() => setNoteContent(NOTE_TEMPLATES[lang])}
        codeMenu={codeMenu}
        viewMode={viewMode}
        onViewModeChange={onViewModeChange}
      />

      {/* Split / Canvas Grid */}
      <div className={`notes-canvas-grid ${viewMode === 'edit' ? 'edit-only' : viewMode === 'preview' ? 'preview-only' : ''}`}>
        <div className="notes-editor-pane">
          <textarea
            aria-describedby={editor.hasConflict ? conflictMessageId : undefined}
            ref={textareaRef}
            rows={16}
            className="nw-editor-textarea"
            disabled={loadingNote || noteLoadError}
            value={noteContent}
            onChange={(e) => setNoteContent(e.target.value)}
            placeholder={t.noteEditorPlaceholder}
          />
        </div>

        <NotesMarkdownPreview content={noteContent} lang={lang} />
      </div>

      {/* Footer status line */}
      <div className="nw-editor-footer">
        <span>{t.markdownMathSupported}</span>
        <span>{t.wordCountChars.replace('{chars}', String(noteContent.length)).replace('{words}', String((noteContent.trim().match(/\S+/g) || []).length))}</span>
      </div>
    </div>
  );
}
