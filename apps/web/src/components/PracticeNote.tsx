import React, { useLayoutEffect, useRef, useState } from 'react';
import { hasMeaningfulNoteContent } from '../api.ts';
import { translations, type Language } from '../i18n.ts';
import { AiFormatReviewDialog } from './notes/AiFormatReviewDialog.tsx';
import { NoteEditorPanel } from './notes/NoteEditorPanel.tsx';
import type { NotesViewMode } from './notes/NoteEditorToolbar.tsx';
import { ShortcutHelpModal } from './ShortcutHelpModal.tsx';
import { useActionPopover } from './ui.tsx';
import { useWorkspace } from '../workspace.tsx';
import { useNoteEditor } from './notes/useNoteEditor.ts';
import { useFormatOnSaveSetting } from './notes/useFormatOnSaveSetting.ts';

export type PracticeNoteStatus = 'clean' | 'dirty' | 'saving';

interface Props {
  frontendId: string;
  lang: Language;
  active: boolean;
  onOpenAiSettings(): void;
  onSaved?: () => void;
  excerpt: string | null;
  onExcerptUsed(): void;
  onStatus(frontendId: string, status: PracticeNoteStatus): void;
}

/** The side panel edits the same versioned Markdown note as the Notes workspace. */
export function PracticeNote({ frontendId, lang, active, onOpenAiSettings, onSaved, onStatus, excerpt, onExcerptUsed }: Props) {
  const zh = lang === 'zh';
  const t = translations[lang];
  const isMac = /Mac/.test(navigator.platform ?? '');
  const [viewMode, setViewMode] = useState<NotesViewMode>('edit');
  const [showHelp, setShowHelp] = useState(false);
  const codeMenu = useActionPopover();
  const { desktopAgentRevision } = useWorkspace();
  const formatSetting = useFormatOnSaveSetting(undefined);
  const editor = useNoteEditor({ selectedId: frontendId, lang, formatSetting, controlledFormatOnSave: undefined,
    externalRevision: desktopAgentRevision, loadTimeline: false, onSaved });
  const status = editor.savingNote ? 'saving' : editor.hasUnsavedChanges ? 'dirty' : 'clean';
  useLayoutEffect(() => { onStatus(frontendId, status); }, [frontendId, status, onStatus]);
  const { closeAiReview } = editor;
  const closeCodeMenu = codeMenu.close;
  useLayoutEffect(() => {
    if (active) return;
    closeAiReview();
    closeCodeMenu();
    setShowHelp(false);
  }, [active, closeCodeMenu, closeAiReview]);

  const inserted = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (excerpt === null) { inserted.current = null; return; }
    if (editor.loadingNote || editor.noteLoadError || inserted.current === excerpt) return;
    inserted.current = excerpt;
    const value = [editor.noteContent.trimEnd(), excerpt].filter(Boolean).join('\n\n');
    editor.applyEditorEdit({ value, selectionStart: value.length, selectionEnd: value.length }, { focus: false });
    onExcerptUsed();
  }, [excerpt, editor.loadingNote, editor.noteLoadError, editor.noteContent, editor.applyEditorEdit, onExcerptUsed]);

  return <div className="notes-workspace-view practice-note-editor" onKeyDown={event => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      event.stopPropagation();
      if (active && !editor.aiReview && !showHelp && editor.canSave) void editor.handleSaveNote();
    }
  }}>
    <NoteEditorPanel lang={lang} editor={editor} isMac={isMac} codeMenu={codeMenu}
      viewMode={viewMode} onViewModeChange={setViewMode} onOpenShortcutHelp={() => setShowHelp(true)} />
    {active && showHelp && <ShortcutHelpModal lang={lang} onClose={() => setShowHelp(false)} />}
    {active && editor.aiReview && <AiFormatReviewDialog lang={lang} review={editor.aiReview}
      onClose={closeAiReview} onOpenSettings={() => { closeAiReview(); onOpenAiSettings(); }}
      onGenerate={() => void editor.generateAiSuggestion()} onApply={editor.applyAiSuggestion} />}
    {editor.saveError && <p role="alert">{editor.saveError}</p>}
    <footer><span role="status">{editor.loadingNote ? (zh ? '正在读取…' : 'Loading…') : editor.savingNote ? (zh ? '保存中…' : 'Saving…')
      : editor.noteContent.trim() && !hasMeaningfulNoteContent(editor.noteContent) ? t.unfilledTemplateNotice
      : editor.hasUnsavedChanges ? (zh ? '未保存' : 'Unsaved changes') : editor.formatNotice || (editor.saveSuccess ? (zh ? '已保存' : 'Saved') : '')}</span>
      <button className="btn btn-primary btn-sm" disabled={!editor.canSave} onClick={() => void editor.handleSaveNote()}>{zh ? '保存笔记' : 'Save note'}</button>
    </footer>
  </div>;
}
