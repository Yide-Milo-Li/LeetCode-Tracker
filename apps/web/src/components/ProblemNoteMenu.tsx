import { BookMarked, BookOpen, PenLine } from 'lucide-react';
import { translations, type Language } from '../i18n.ts';
import { useWorkspace } from '../workspace.tsx';
import { Tooltip, useActionPopover } from './ui.tsx';

export function ProblemNoteMenu({ lang, frontendId, onQuickNote }: {
  lang: Language;
  frontendId: string;
  onQuickNote(): void;
}) {
  const t = translations[lang];
  const workspace = useWorkspace();
  const noteMenu = useActionPopover({ align: 'end' });
  return (
    <div className="notes-dropdown">
      <Tooltip text={t.noteButtonLabel} position="top" disabled={noteMenu.open}>
        <button
          type="button"
          className="btn-icon"
          aria-label={t.noteButtonLabel}
          {...noteMenu.triggerProps}
        >
          <BookMarked size={18} />
        </button>
      </Tooltip>

      {noteMenu.rendered && (
        <div
          {...noteMenu.panelProps}
          className="notes-dropdown-menu notes-dropdown-menu-right"
          style={{ minWidth: '180px' }}
        >
          <button
            type="button"
            className="notes-dropdown-item"
            onClick={() => {
              noteMenu.close();
              workspace.navigate('notes', frontendId);
            }}
          >
            <span className="notes-dropdown-label">
              <PenLine size={14} className="notes-dropdown-icon" aria-hidden="true" />
              <span>{t.writeNewNoteInWorkspace}</span>
            </span>
          </button>
          <button
            type="button"
            className="notes-dropdown-item"
            onClick={() => {
              noteMenu.close();
              onQuickNote();
            }}
          >
            <span className="notes-dropdown-label">
              <BookOpen size={14} className="notes-dropdown-icon is-secondary" aria-hidden="true" />
              <span>{t.quickCheckPastNotes}</span>
            </span>
          </button>
        </div>
      )}
    </div>
  );
}
