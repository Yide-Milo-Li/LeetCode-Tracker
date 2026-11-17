/** Review dialog for an AI format proposal: scope and privacy notice, then original vs candidate. */
import { translations, type Language } from '../../i18n.ts';
import { Dialog, Feedback } from '../ui.tsx';
import type { AiReview } from './useNoteEditor.ts';

interface AiFormatReviewDialogProps {
  lang: Language;
  review: AiReview;
  onClose: () => void;
  /** Close the review and open Settings so a provider can be configured. */
  onOpenSettings: () => void;
  onGenerate: () => void;
  onApply: () => void;
}

/** Render the stage-specific body and footer actions of the AI format review. */
export function AiFormatReviewDialog({ lang, review, onClose, onOpenSettings, onGenerate, onApply }: AiFormatReviewDialogProps) {
  const t = translations[lang];

  return (
    <Dialog title={t.notesAiFormat} lang={lang} wide onClose={onClose}
      footer={<div className="action-row">
        <button type="button" className="btn btn-secondary" onClick={onClose}>{t.btnCancel}</button>
        {review.stage === 'ready' && !review.configured && (
          <button type="button" className="btn btn-secondary" onClick={onOpenSettings}>{t.notesAiSettings}</button>
        )}
        {review.stage === 'ready' && review.configured && (
          <button type="button" className="btn btn-primary" onClick={onGenerate}>{t.notesAiGenerate}</button>
        )}
        {review.stage === 'review' && (
          <button type="button" className="btn btn-primary" onClick={onApply}>{t.notesAiApply}</button>
        )}
      </div>}>
      {(review.stage === 'preparing' || review.stage === 'generating') && (
        <p role="status">{review.stage === 'preparing' ? t.notesAiPreparing : t.notesAiGenerating}</p>
      )}
      {review.stage === 'error' && <Feedback>{review.error ?? t.notesAiFailed}</Feedback>}
      {review.stage === 'ready' && (
        <div>
          <p><strong>{review.selection ? t.notesAiScopeSelection : t.notesAiScopeAll}</strong>
            {review.range && ` (${review.range.start}–${review.range.end})`}</p>
          {review.range && <pre className="notes-ai-scope">{review.source.slice(review.range.start, review.range.end)}</pre>}
          {review.configured ? <p>{t.notesAiPrivacy}{review.provider && ` (${review.provider})`}</p> : <p>{t.notesAiNotConfigured}</p>}
        </div>
      )}
      {review.stage === 'review' && review.result && (
        <div className="notes-ai-compare">
          <section><h3>{t.notesAiOriginal}</h3><pre>{review.source}</pre></section>
          <section><h3>{t.notesAiCandidate}</h3><pre>{review.result.content}</pre></section>
        </div>
      )}
    </Dialog>
  );
}
