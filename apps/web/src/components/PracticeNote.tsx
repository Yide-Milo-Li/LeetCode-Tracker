import React, { useLayoutEffect, useRef } from 'react';
import type { Language } from '../i18n.ts';
import { useWorkspace } from '../workspace.tsx';
import { useNoteEditor } from './notes/useNoteEditor.ts';
import { useFormatOnSaveSetting } from './notes/useFormatOnSaveSetting.ts';

export type PracticeNoteStatus = 'clean' | 'dirty' | 'saving';

interface Props {
  frontendId: string;
  lang: Language;
  onSaved?: () => void;
  excerpt: string | null;
  onExcerptUsed(): void;
  onStatus(frontendId: string, status: PracticeNoteStatus): void;
}

/** The side panel edits the same versioned Markdown note as the Notes workspace. */
export function PracticeNote({ frontendId, lang, onSaved, onStatus, excerpt, onExcerptUsed }: Props) {
  const zh = lang === 'zh';
  const { desktopAgentRevision } = useWorkspace();
  const formatSetting = useFormatOnSaveSetting(undefined);
  const editor = useNoteEditor({ selectedId: frontendId, lang, formatSetting, controlledFormatOnSave: undefined,
    externalRevision: desktopAgentRevision, loadTimeline: false, onSaved });
  const status = editor.savingNote ? 'saving' : editor.hasUnsavedChanges ? 'dirty' : 'clean';
  useLayoutEffect(() => { onStatus(frontendId, status); }, [frontendId, status, onStatus]);

  const inserted = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (excerpt === null) { inserted.current = null; return; }
    if (editor.loadingNote || editor.noteLoadError || inserted.current === excerpt) return;
    inserted.current = excerpt;
    editor.setNoteContent([editor.noteContent.trimEnd(), excerpt].filter(Boolean).join('\n\n'));
    onExcerptUsed();
  }, [excerpt, editor.loadingNote, editor.noteLoadError, editor.noteContent, editor.setNoteContent, onExcerptUsed]);

  if (editor.noteLoadError) return <p role="alert">{zh ? '无法读取笔记。' : 'Could not load the note.'} <button className="text-link" onClick={editor.handleRetryLoad}>{zh ? '重试' : 'Retry'}</button></p>;
  return <div className="practice-note-editor" onKeyDown={event => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      event.stopPropagation();
      if (editor.canSave) void editor.handleSaveNote();
    }
  }}>
    <textarea aria-label={zh ? '本题笔记' : 'Problem note'} ref={editor.textareaRef} disabled={editor.loadingNote}
      placeholder={zh ? '记下思路、卡点或想再试的例子…' : 'Write down an idea, a sticking point, or an example to revisit…'}
      value={editor.noteContent} onChange={editor.handleEditorChange}
      onCompositionStart={editor.handleCompositionStart} onCompositionEnd={editor.handleCompositionEnd} />
    {editor.hasConflict && <div className="practice-note-conflict" role="alert">
      <p>{zh ? '已保存的笔记有更新。你的草稿仍在编辑框中。' : 'The saved note has changed. Your draft is still in the editor.'}</p>
      <button className="text-link" onClick={editor.reloadSavedVersion}>{zh ? '载入已保存版本' : 'Load saved version'}</button>
      <button className="text-link" disabled={!editor.canOverwrite} onClick={() => void editor.keepMyDraft()}>{zh ? '用我的草稿覆盖' : 'Replace with my draft'}</button>
    </div>}
    {editor.saveError && <p role="alert">{editor.saveError}</p>}
    <footer><span role="status">{editor.loadingNote ? (zh ? '正在读取…' : 'Loading…') : editor.savingNote ? (zh ? '保存中…' : 'Saving…')
      : editor.hasUnsavedChanges ? (zh ? '未保存' : 'Unsaved changes') : editor.saveSuccess ? (zh ? '已保存' : 'Saved') : ''}</span>
      <button className="btn btn-primary btn-sm" disabled={!editor.canSave} onClick={() => void editor.handleSaveNote()}>{zh ? '保存笔记' : 'Save note'}</button>
    </footer>
  </div>;
}
