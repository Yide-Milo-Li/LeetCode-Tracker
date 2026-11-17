/** Confirmation shown before leaving a note with unsaved edits for another problem. */
import type { ProblemNoteSummary } from '../../api.ts';
import { translations, type Language } from '../../i18n.ts';
import { Dialog } from '../ui.tsx';

interface UnsavedChangesDialogProps {
  lang: Language;
  pendingTargetId: string | null;
  /** Summary of the pending target when it is on the current list page; adds its title. */
  pendingTargetSummary: ProblemNoteSummary | null;
  /** Stay on the current note. */
  onCancel: () => void;
  /** Drop the draft and switch to the pending target. */
  onDiscard: () => void;
}

/** Render the stay/discard dialog for a guarded problem switch. */
export function UnsavedChangesDialog({ lang, pendingTargetId, pendingTargetSummary, onCancel, onDiscard }: UnsavedChangesDialogProps) {
  const t = translations[lang];

  return (
    <Dialog
      title={t.unsavedNoteModalTitle}
      lang={lang}
      onClose={onCancel}
      footer={
        <div className="nw-unsaved-actions">
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={onCancel}
          >
            {t.unsavedNoteStay}
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-sm nw-discard-btn"
            onClick={onDiscard}
          >
            {t.unsavedNoteDiscard}
          </button>
        </div>
      }
    >
      <div className="nw-unsaved-body">
        <p className="nw-unsaved-desc">
          {t.unsavedNoteModalDesc}
        </p>

        {pendingTargetId && (
          <div className="nw-unsaved-target">
            <span className="nw-unsaved-target-label">{t.unsavedNoteSwitchingTo}</span>
            <span className="nw-unsaved-target-name">
              #{pendingTargetId}
              {pendingTargetSummary ? ` · ${pendingTargetSummary.title}` : ''}
            </span>
          </div>
        )}
      </div>
    </Dialog>
  );
}
