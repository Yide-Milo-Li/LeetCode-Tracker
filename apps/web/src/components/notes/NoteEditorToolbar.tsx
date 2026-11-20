/** Expanded Markdown formatting toolbar, language-selectable code block dropdown, AI format trigger and view mode switch. */
import { useCallback, type MouseEvent } from 'react';
import {
  Bold,
  ChevronDown,
  Code,
  Heading,
  Italic,
  Link2,
  List,
  ListOrdered,
  ListTodo,
  Quote,
  Sparkles,
  SquareCode,
  Strikethrough,
} from 'lucide-react';
import { translations, type Language } from '../../i18n.ts';
import type { ActionPopover } from '../ui.tsx';
import type { InlineMarker, LinePrefixKind } from './markdownCommands.ts';

export type NotesViewMode = 'split' | 'edit' | 'preview';

interface NoteEditorToolbarProps {
  lang: Language;
  isMac: boolean;
  /** Disables formatting while the note is loading or failed to load. */
  disabled: boolean;
  /** Disables AI format when the draft is blank, loading, failed to load or saving. */
  aiDisabled: boolean;
  onToggleInline: (marker: InlineMarker, placeholder: string) => void;
  onToggleLine: (kind: LinePrefixKind, placeholder: string) => void;
  onInsertLink: (placeholders: { textPlaceholder: string; urlPlaceholder: string }) => void;
  onInsertCodeBlock: (language: string, placeholder: string) => void;
  /** Code block language menu popover owned by the workspace (see `useActionPopover`). */
  codeMenu: ActionPopover;
  onOpenAiReview: () => void;
  canUndoFormat: boolean;
  onUndoFormat: () => void;
  viewMode: NotesViewMode;
  onViewModeChange: (mode: NotesViewMode) => void;
}

/** Preserve textarea focus/selection when clicking toolbar formatting buttons. */
function keepEditorSelection(event: MouseEvent<HTMLButtonElement>) {
  event.preventDefault();
}

/** Render the expanded Markdown toolbar. Preview mode hides editing tools while keeping the view switch anchored. */
export function NoteEditorToolbar({
  lang,
  isMac,
  disabled,
  aiDisabled,
  onToggleInline,
  onToggleLine,
  onInsertLink,
  onInsertCodeBlock,
  codeMenu,
  onOpenAiReview,
  canUndoFormat,
  onUndoFormat,
  viewMode,
  onViewModeChange,
}: NoteEditorToolbarProps) {
  const t = translations[lang];
  const zh = lang === 'zh';
  const mod = isMac ? '⌘' : 'Ctrl+';
  const shiftMod = isMac ? '⇧⌘' : 'Ctrl+Shift+';
  const closeCodeMenu = codeMenu.close;

  const insertCodeBlock = useCallback(
    (codeLang: string) => {
      const placeholder = zh ? '// 在此编写代码...' : '// Write solution code here...';
      onInsertCodeBlock(codeLang, placeholder);
      closeCodeMenu();
    },
    [onInsertCodeBlock, zh, closeCodeMenu],
  );

  const codeLanguages: Array<{ lang: string; label: string; hint: string }> = [
    { lang: '', label: t.codeGeneric, hint: '```' },
    { lang: 'python', label: t.codePython, hint: 'py' },
    { lang: 'cpp', label: t.codeCpp, hint: 'cpp' },
    { lang: 'java', label: t.codeJava, hint: 'java' },
    { lang: 'go', label: t.codeGo, hint: 'go' },
    { lang: 'typescript', label: t.codeTypeScript, hint: 'ts' },
    { lang: 'javascript', label: t.codeJavaScript, hint: 'js' },
    { lang: 'rust', label: t.codeRust, hint: 'rs' },
  ];

  return (
    <div className="notes-toolbar">
      {viewMode === 'preview' ? (
        <span className="nw-preview-mode-label">{zh ? '预览模式' : 'Preview mode'}</span>
      ) : (
        <div className="notes-tool-group">
          <button
            type="button"
            className="notes-tool-btn is-icon-only"
            onMouseDown={keepEditorSelection}
            onClick={() => onToggleLine('heading', zh ? '标题' : 'Heading')}
            title={t.toolbarHeading}
            aria-label={t.toolbarHeading}
            disabled={disabled}
          >
            <Heading size={13} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="notes-tool-btn is-icon-only"
            onMouseDown={keepEditorSelection}
            onClick={() => onToggleInline('**', zh ? '粗体' : 'bold')}
            title={`${t.toolbarBold} (${mod}B)`}
            aria-label={t.toolbarBold}
            disabled={disabled}
          >
            <Bold size={13} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="notes-tool-btn is-icon-only"
            onMouseDown={keepEditorSelection}
            onClick={() => onToggleInline('*', zh ? '斜体' : 'italic')}
            title={`${t.toolbarItalic} (${mod}I)`}
            aria-label={t.toolbarItalic}
            disabled={disabled}
          >
            <Italic size={13} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="notes-tool-btn is-icon-only"
            onMouseDown={keepEditorSelection}
            onClick={() => onToggleInline('~~', zh ? '删除线' : 'strikethrough')}
            title={`${t.toolbarStrikethrough} (${shiftMod}X)`}
            aria-label={t.toolbarStrikethrough}
            disabled={disabled}
          >
            <Strikethrough size={13} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="notes-tool-btn is-icon-only"
            onMouseDown={keepEditorSelection}
            onClick={() => onToggleInline('`', 'code')}
            title={`${t.toolbarInlineCode} (${mod}E)`}
            aria-label={t.toolbarInlineCode}
            disabled={disabled}
          >
            <Code size={13} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="notes-tool-btn is-icon-only"
            onMouseDown={keepEditorSelection}
            onClick={() => onInsertLink({ textPlaceholder: zh ? '链接文本' : 'link', urlPlaceholder: 'url' })}
            title={`${t.toolbarLink} (${mod}K)`}
            aria-label={t.toolbarLink}
            disabled={disabled}
          >
            <Link2 size={13} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="notes-tool-btn nw-tool-math"
            onMouseDown={keepEditorSelection}
            onClick={() => onToggleInline('$', 'O(n)')}
            title={`${t.toolbarMath} (${shiftMod}M)`}
            aria-label={t.toolbarMath}
            disabled={disabled}
          >
            <span className="nw-big-o-glyph" aria-hidden="true">
              <em>O</em>(<em>n</em>)
            </span>
          </button>

          <div className="notes-tool-sep" />

          <button
            type="button"
            className="notes-tool-btn is-icon-only"
            onMouseDown={keepEditorSelection}
            onClick={() => onToggleLine('ul', zh ? '列表项' : 'List item')}
            title={`${t.toolbarList} (${shiftMod}8)`}
            aria-label={t.toolbarList}
            disabled={disabled}
          >
            <List size={13} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="notes-tool-btn is-icon-only"
            onMouseDown={keepEditorSelection}
            onClick={() => onToggleLine('ol', zh ? '列表项' : 'List item')}
            title={`${t.toolbarOrderedList} (${shiftMod}7)`}
            aria-label={t.toolbarOrderedList}
            disabled={disabled}
          >
            <ListOrdered size={13} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="notes-tool-btn is-icon-only"
            onMouseDown={keepEditorSelection}
            onClick={() => onToggleLine('task', zh ? '待办事项' : 'Task')}
            title={`${t.toolbarTask} (${shiftMod}9)`}
            aria-label={t.toolbarTask}
            disabled={disabled}
          >
            <ListTodo size={13} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="notes-tool-btn is-icon-only"
            onMouseDown={keepEditorSelection}
            onClick={() => onToggleLine('quote', zh ? '引用内容' : 'Quote')}
            title={`${t.toolbarQuote} (${shiftMod}.)`}
            aria-label={t.toolbarQuote}
            disabled={disabled}
          >
            <Quote size={13} aria-hidden="true" />
          </button>

          <div className="notes-tool-sep" />

          {/* Dedicated Code Block Language Dropdown */}
          <div className="notes-dropdown">
            <button
              type="button"
              className="notes-tool-btn"
              {...codeMenu.triggerProps}
              title={t.toolbarCode}
              aria-label={t.toolbarCode}
              disabled={disabled}
            >
              <SquareCode size={13} aria-hidden="true" />
              <span>{t.toolbarCodeTrigger}</span>
              <ChevronDown size={11} aria-hidden="true" />
            </button>

            {codeMenu.rendered && (
              <div {...codeMenu.panelProps} className="notes-dropdown-menu">
                <div className="nw-menu-section-label">{t.toolbarCode}</div>
                {codeLanguages.map((item) => (
                  <button
                    key={item.lang || 'generic'}
                    type="button"
                    className="notes-dropdown-item"
                    onClick={() => insertCodeBlock(item.lang)}
                  >
                    <span>{item.label}</span>
                    <span className="notes-dropdown-hint is-code" aria-hidden="true">
                      {item.hint}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="notes-tool-sep" />

          <button
            type="button"
            className="notes-tool-btn nw-ai-btn"
            onClick={onOpenAiReview}
            disabled={aiDisabled}
            title={t.notesAiFormat}
          >
            <Sparkles size={13} aria-hidden="true" />
            <span>{t.notesAiFormat}</span>
          </button>

          {canUndoFormat && (
            <button
              type="button"
              className="notes-tool-btn nw-undo-btn"
              onClick={onUndoFormat}
            >
              {t.notesUndoFormat}
            </button>
          )}
        </div>
      )}

      {/* View Mode Segmented Control */}
      <div className="nw-view-mode">
        <div className="nw-view-toggle">
          <button
            type="button"
            className={`nw-view-btn ${viewMode === 'edit' ? 'is-active' : ''}`}
            onClick={() => onViewModeChange('edit')}
          >
            {t.viewModeEdit}
          </button>
          <button
            type="button"
            className={`nw-view-btn ${viewMode === 'split' ? 'is-active' : ''}`}
            onClick={() => onViewModeChange('split')}
          >
            {t.viewModeSplit}
          </button>
          <button
            type="button"
            className={`nw-view-btn ${viewMode === 'preview' ? 'is-active' : ''}`}
            onClick={() => onViewModeChange('preview')}
          >
            {t.viewModePreview}
          </button>
        </div>
      </div>
    </div>
  );
}
