/** Long-form note editor: conflict/load banners, expanded toolbar, full-height edit/preview canvas and compact footer. */
import { FileText, Keyboard } from 'lucide-react';
import { useEffect, useId, useRef, type ClipboardEvent, type KeyboardEvent } from 'react';
import { NOTE_TEMPLATES } from '../../api.ts';
import { translations, type Language } from '../../i18n.ts';
import type { ActionPopover } from '../ui.tsx';
import { NotesMarkdownPreview } from '../NotesMarkdownPreview.tsx';
import { NoteEditorToolbar, type NotesViewMode } from './NoteEditorToolbar.tsx';
import {
  cutCurrentLine,
  getCurrentLineText,
  handleEnterKey,
  handleTabIndent,
  pasteUrlOverSelection,
} from './markdownCommands.ts';
import type { NoteEditorState } from './useNoteEditor.ts';

interface NoteEditorPanelProps {
  lang: Language;
  editor: NoteEditorState;
  /** Selects the ⌘ or Ctrl shortcut label in the toolbar. */
  isMac: boolean;
  codeMenu: ActionPopover;
  viewMode: NotesViewMode;
  onViewModeChange: (mode: NotesViewMode) => void;
  onOpenShortcutHelp?: () => void;
}

/** Write plain text to the system clipboard, falling back when navigator.clipboard is unavailable. */
function writeClipboardText(text: string, restoreTarget?: HTMLTextAreaElement): void {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    void navigator.clipboard.writeText(text).catch(() => {});
    return;
  }
  if (typeof document !== 'undefined' && typeof document.execCommand === 'function') {
    const prevStart = restoreTarget?.selectionStart ?? null;
    const prevEnd = restoreTarget?.selectionEnd ?? null;
    const helper = document.createElement('textarea');
    helper.value = text;
    helper.setAttribute('readonly', '');
    helper.style.position = 'fixed';
    helper.style.opacity = '0';
    document.body.appendChild(helper);
    helper.select();
    try {
      document.execCommand('copy');
    } catch {
      // Ignore clipboard unavailability.
    } finally {
      helper.remove();
      if (restoreTarget && prevStart !== null && prevEnd !== null) {
        restoreTarget.focus();
        restoreTarget.setSelectionRange(prevStart, prevEnd);
      }
    }
  }
}

/** Render the editor canvas for the selected note; all state and actions come from `useNoteEditor`. */
export function NoteEditorPanel({ lang, editor, isMac, codeMenu, viewMode, onViewModeChange, onOpenShortcutHelp }: NoteEditorPanelProps) {
  const t = translations[lang];
  const conflictMessageId = useId();
  const zh = lang === 'zh';
  const suppressBeforeInputHistoryRef = useRef(false);
  const {
    noteContent,
    textareaRef,
    handleEditorChange,
    handleCompositionStart,
    handleCompositionEnd,
    markHistoryBoundary,
    applyEditorEdit,
    handleUndo,
    handleRedo,
    toggleInline,
    toggleLine,
    insertMarkdownLink,
    insertCodeBlock,
    insertTemplate,
    loadingNote,
    noteLoadError,
    handleRetryLoad,
    savingNote,
    canUndoFormat,
    handleUndoFormat,
    openAiReview,
  } = editor;

  const canInsertTemplate = noteContent.trim().length === 0 && !loadingNote && !noteLoadError;
  const wordCount = (noteContent.trim().match(/\S+/g) || []).length;

  // Intercept native Edit -> Undo/Redo (e.g. macOS WKWebView menu actions) on the textarea.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    const onBeforeInput = (event: Event) => {
      const inputEvent = event as InputEvent;
      if (inputEvent.inputType === 'historyUndo') {
        event.preventDefault();
        if (suppressBeforeInputHistoryRef.current) {
          suppressBeforeInputHistoryRef.current = false;
          return;
        }
        handleUndo();
      } else if (inputEvent.inputType === 'historyRedo') {
        event.preventDefault();
        if (suppressBeforeInputHistoryRef.current) {
          suppressBeforeInputHistoryRef.current = false;
          return;
        }
        handleRedo();
      }
    };
    el.addEventListener('beforeinput', onBeforeInput);
    return () => el.removeEventListener('beforeinput', onBeforeInput);
  }, [textareaRef, handleUndo, handleRedo]);

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (loadingNote || noteLoadError || e.nativeEvent.isComposing || e.keyCode === 229) {
      return;
    }

    const el = e.currentTarget;
    const mod = (e.ctrlKey || e.metaKey) && !e.altKey;
    const key = e.key.toLowerCase();

    if (mod && !e.shiftKey && key === 'z') {
      e.preventDefault();
      suppressBeforeInputHistoryRef.current = true;
      queueMicrotask(() => {
        suppressBeforeInputHistoryRef.current = false;
      });
      handleUndo();
      return;
    }

    if ((mod && e.shiftKey && key === 'z') || (!isMac && mod && !e.shiftKey && key === 'y')) {
      e.preventDefault();
      suppressBeforeInputHistoryRef.current = true;
      queueMicrotask(() => {
        suppressBeforeInputHistoryRef.current = false;
      });
      handleRedo();
      return;
    }

    if (mod && !e.shiftKey && key === 'b') {
      e.preventDefault();
      toggleInline('**');
      return;
    }

    if (mod && !e.shiftKey && key === 'i') {
      e.preventDefault();
      toggleInline('*');
      return;
    }

    if (mod && e.shiftKey && key === 'x') {
      e.preventDefault();
      toggleInline('~~');
      return;
    }

    if (mod && !e.shiftKey && key === 'e') {
      e.preventDefault();
      toggleInline('`');
      return;
    }

    if (mod && !e.shiftKey && key === 'k') {
      e.preventDefault();
      insertMarkdownLink();
      return;
    }

    if (mod && e.shiftKey && key === 'm') {
      e.preventDefault();
      toggleInline('$');
      return;
    }

    if (mod && e.shiftKey && (e.code === 'Digit7' || e.key === '7' || e.key === '&')) {
      e.preventDefault();
      toggleLine('ol');
      return;
    }

    if (mod && e.shiftKey && (e.code === 'Digit8' || e.key === '8' || e.key === '*')) {
      e.preventDefault();
      toggleLine('ul');
      return;
    }

    if (mod && e.shiftKey && (e.code === 'Digit9' || e.key === '9' || e.key === '(')) {
      e.preventDefault();
      toggleLine('task');
      return;
    }

    if (mod && e.shiftKey && (e.code === 'Period' || e.key === '.' || e.key === '>')) {
      e.preventDefault();
      toggleLine('quote');
      return;
    }

    if (mod && !e.shiftKey && key === 'c') {
      if (el.selectionStart === el.selectionEnd) {
        e.preventDefault();
        const lineText = getCurrentLineText(el.value, el.selectionStart);
        if (lineText.length > 0) {
          writeClipboardText(lineText, el);
        }
      }
      return;
    }

    if (mod && !e.shiftKey && key === 'x') {
      if (el.selectionStart === el.selectionEnd) {
        e.preventDefault();
        const cut = cutCurrentLine(el.value, el.selectionStart);
        if (cut) {
          if (cut.lineText.length > 0) {
            writeClipboardText(cut.lineText, el);
          }
          applyEditorEdit(cut.edit);
        }
      }
      return;
    }

    if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key === 'Tab') {
      e.preventDefault();
      applyEditorEdit(handleTabIndent(el.value, el.selectionStart, el.selectionEnd, e.shiftKey));
      return;
    }

    if (!e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && e.key === 'Enter') {
      const next = handleEnterKey(el.value, el.selectionStart, el.selectionEnd);
      if (next) {
        e.preventDefault();
        applyEditorEdit(next);
      }
    }
  };

  const handleCopy = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget;
    if (el.selectionStart !== el.selectionEnd) return;
    const lineText = getCurrentLineText(el.value, el.selectionStart);
    if (lineText.length > 0 && e.clipboardData) {
      e.clipboardData.setData('text/plain', lineText);
      e.preventDefault();
    }
  };

  const handleCut = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget;
    if (el.selectionStart !== el.selectionEnd) {
      markHistoryBoundary();
      return;
    }
    const cut = cutCurrentLine(el.value, el.selectionStart);
    if (!cut) return;
    e.preventDefault();
    if (cut.lineText.length > 0) {
      e.clipboardData?.setData('text/plain', cut.lineText);
    }
    applyEditorEdit(cut.edit);
  };

  const handlePaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget;
    const pasted = e.clipboardData?.getData('text/plain') ?? '';
    const linkEdit = pasteUrlOverSelection(el.value, el.selectionStart, el.selectionEnd, pasted);
    if (linkEdit) {
      e.preventDefault();
      applyEditorEdit(linkEdit);
      return;
    }
    markHistoryBoundary();
  };

  return (
    <div className="nw-editor">
      {editor.hasConflict && (
        <div className="nw-load-error">
          <span role="status" id={conflictMessageId}>
            {zh ? '已保存的笔记有更新。你的草稿仍在编辑器中。' : 'The saved note changed. Your draft is still in the editor.'}
          </span>
          <div className="nw-load-error-actions">
            <button type="button" className="btn btn-secondary btn-sm" disabled={savingNote || loadingNote} onClick={editor.reloadSavedVersion}>
              {zh ? '加载已保存版本' : 'Load saved version'}
            </button>
            <button type="button" className="btn btn-secondary btn-sm" disabled={!editor.canOverwrite} onClick={editor.keepMyDraft}>
              {zh ? '用我的草稿覆盖' : 'Overwrite with my draft'}
            </button>
          </div>
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

      {/* Markdown Formatting Toolbar + AI Format + View Switch */}
      <NoteEditorToolbar
        lang={lang}
        isMac={isMac}
        disabled={loadingNote || noteLoadError}
        aiDisabled={!noteContent.trim() || loadingNote || noteLoadError || savingNote}
        onToggleInline={toggleInline}
        onToggleLine={toggleLine}
        onInsertLink={insertMarkdownLink}
        onInsertCodeBlock={insertCodeBlock}
        codeMenu={codeMenu}
        onOpenAiReview={() => void openAiReview()}
        canUndoFormat={canUndoFormat}
        onUndoFormat={handleUndoFormat}
        viewMode={viewMode}
        onViewModeChange={onViewModeChange}
      />

      {/* Split / Canvas Grid */}
      <div className={`notes-canvas-grid ${viewMode === 'edit' ? 'edit-only' : viewMode === 'preview' ? 'preview-only' : ''}`}>
        <div className="notes-editor-pane">
          <textarea
            aria-describedby={editor.hasConflict ? conflictMessageId : undefined}
            ref={textareaRef}
            className="nw-editor-textarea"
            disabled={loadingNote || noteLoadError}
            value={noteContent}
            onChange={handleEditorChange}
            onCompositionStart={handleCompositionStart}
            onCompositionEnd={handleCompositionEnd}
            onBlur={markHistoryBoundary}
            onKeyDown={handleKeyDown}
            onCopy={handleCopy}
            onCut={handleCut}
            onPaste={handlePaste}
            placeholder={t.noteEditorPlaceholder}
          />
          {viewMode === 'edit' && canInsertTemplate && (
            <button
              type="button"
              className="btn btn-secondary btn-sm nw-editor-empty-template"
              onClick={() => insertTemplate(NOTE_TEMPLATES[lang])}
              title={t.insertTemplateTitle}
            >
              <FileText size={13} aria-hidden="true" />
              <span>{t.insertTemplate}</span>
            </button>
          )}
        </div>

        <NotesMarkdownPreview
          content={noteContent}
          lang={lang}
          showInsertTemplate={viewMode !== 'edit' && canInsertTemplate}
          onInsertTemplate={() => insertTemplate(NOTE_TEMPLATES[lang])}
        />
      </div>

      {/* Compact status footer */}
      <div className="nw-editor-footer">
        <span>{t.wordCountChars.replace('{chars}', String(noteContent.length)).replace('{words}', String(wordCount))}</span>
        {onOpenShortcutHelp && (
          <button
            className="btn-icon nw-editor-help"
            type="button"
            aria-haspopup="dialog"
            aria-label={zh ? '快捷键速查' : 'Keyboard shortcuts'}
            onClick={(event) => {
              event.currentTarget.focus();
              onOpenShortcutHelp();
            }}
          >
            <Keyboard size={16} aria-hidden="true" />
          </button>
        )}
      </div>
    </div>
  );
}
