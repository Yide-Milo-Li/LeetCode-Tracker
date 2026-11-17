/** Markdown formatting toolbar, code snippet menu, template insertion and view mode switch. */
import { useCallback } from 'react';
import { Bold, Italic, Heading, List, CheckSquare, Code, ChevronDown, FileText } from 'lucide-react';
import { translations, type Language } from '../../i18n.ts';
import type { ActionPopover } from '../ui.tsx';

export type NotesViewMode = 'split' | 'edit' | 'preview';

interface NoteEditorToolbarProps {
  lang: Language;
  /** Disables formatting while the note is loading or failed to load. */
  disabled: boolean;
  /** Template insertion is only offered for an empty draft. */
  canInsertTemplate: boolean;
  /** Wrap the textarea selection (or a placeholder) with Markdown syntax. */
  onWrap: (prefix: string, suffix: string, defaultPlaceholder: string) => void;
  onInsertTemplate: () => void;
  /** Code menu popover owned by the workspace (see `useActionPopover`). */
  codeMenu: ActionPopover;
  viewMode: NotesViewMode;
  onViewModeChange: (mode: NotesViewMode) => void;
}

/** Render the toolbar. Choosing a code language inserts a fenced block and closes the menu. */
export function NoteEditorToolbar({
  lang,
  disabled,
  canInsertTemplate,
  onWrap,
  onInsertTemplate,
  codeMenu,
  viewMode,
  onViewModeChange,
}: NoteEditorToolbarProps) {
  const t = translations[lang];
  const zh = lang === 'zh';
  const closeCodeMenu = codeMenu.close;

  /** Insert language-agnostic code snippet block */
  const insertCodeBlock = useCallback(
    (codeLang: string = '') => {
      const placeholder = zh ? '// 在此编写代码...' : '// Write solution code here...';
      const prefix = `\n\`\`\`${codeLang}\n`;
      const suffix = '\n```\n';
      onWrap(prefix, suffix, placeholder);
      closeCodeMenu();
    },
    [onWrap, zh, closeCodeMenu]
  );

  return (
    <div className="notes-toolbar">
      <div className="notes-tool-group">
        <button
          type="button"
          className="notes-tool-btn"
          onClick={() => onWrap('**', '**', 'bold')}
          title={t.toolbarBold}
          disabled={disabled}
        >
          <Bold size={13} />
        </button>
        <button
          type="button"
          className="notes-tool-btn"
          onClick={() => onWrap('*', '*', 'italic')}
          title={t.toolbarItalic}
          disabled={disabled}
        >
          <Italic size={13} />
        </button>
        <button
          type="button"
          className="notes-tool-btn"
          onClick={() => onWrap('### ', '', 'Heading')}
          title={t.toolbarHeading}
          disabled={disabled}
        >
          <Heading size={13} />
        </button>
        <button
          type="button"
          className="notes-tool-btn"
          onClick={() => onWrap('- ', '', 'List item')}
          title={t.toolbarList}
          disabled={disabled}
        >
          <List size={13} />
        </button>
        <button
          type="button"
          className="notes-tool-btn"
          onClick={() => onWrap('- [ ] ', '', 'Task')}
          title={t.toolbarTask}
          disabled={disabled}
        >
          <CheckSquare size={13} />
        </button>
        <button
          type="button"
          className="notes-tool-btn nw-tool-math"
          onClick={() => onWrap('$', '$', 'O(N)')}
          title={t.toolbarMath}
          disabled={disabled}
        >
          $
        </button>

        <div className="notes-tool-sep" />

        {/* Multi-Language Code Snippet Dropdown */}
        <div className="notes-dropdown">
          <button
            type="button"
            className="notes-tool-btn"
            {...codeMenu.triggerProps}
            title={t.toolbarCode}
            disabled={disabled}
          >
            <Code size={13} />
            <span>{t.toolbarCode}</span>
            <ChevronDown size={11} />
          </button>

          {codeMenu.rendered && (
            <div {...codeMenu.panelProps} className="notes-dropdown-menu">
              <button type="button" className="notes-dropdown-item" onClick={() => insertCodeBlock('')}>
                <span>{t.codeGeneric}</span>
                <span className="notes-dropdown-hint is-code" aria-hidden="true">```</span>
              </button>
              <button type="button" className="notes-dropdown-item" onClick={() => insertCodeBlock('python')}>
                <span>{t.codePython}</span>
                <span className="notes-dropdown-hint is-code" aria-hidden="true">py</span>
              </button>
              <button type="button" className="notes-dropdown-item" onClick={() => insertCodeBlock('cpp')}>
                <span>{t.codeCpp}</span>
                <span className="notes-dropdown-hint is-code" aria-hidden="true">cpp</span>
              </button>
              <button type="button" className="notes-dropdown-item" onClick={() => insertCodeBlock('java')}>
                <span>{t.codeJava}</span>
                <span className="notes-dropdown-hint is-code" aria-hidden="true">java</span>
              </button>
              <button type="button" className="notes-dropdown-item" onClick={() => insertCodeBlock('go')}>
                <span>{t.codeGo}</span>
                <span className="notes-dropdown-hint is-code" aria-hidden="true">go</span>
              </button>
              <button type="button" className="notes-dropdown-item" onClick={() => insertCodeBlock('typescript')}>
                <span>{t.codeTypeScript}</span>
                <span className="notes-dropdown-hint is-code" aria-hidden="true">ts</span>
              </button>
            </div>
          )}
        </div>

        <div className="notes-tool-sep" />

        {/* Insert Template Button */}
        <button
          type="button"
          className="notes-tool-btn"
          onClick={onInsertTemplate}
          disabled={disabled || !canInsertTemplate}
          title={t.insertTemplateTitle}
        >
          <FileText size={12} />
          <span>{t.insertTemplate}</span>
        </button>
      </div>

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
