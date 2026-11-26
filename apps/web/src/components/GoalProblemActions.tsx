import { useEffect, useRef, useState, type RefObject } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { api, type CatalogProblem } from '../api.ts';
import { localizeApiError } from '../error-i18n.ts';
import type { Language } from '../i18n.ts';
import { useWorkspace } from '../workspace.tsx';
import { PracticeTimerButton } from './PracticeTimer.tsx';
import { ProblemNoteMenu } from './ProblemNoteMenu.tsx';
import { QuickNoteDrawer } from './QuickNoteDrawer.tsx';
import { Tooltip } from './ui.tsx';
import { TodayFavoriteStar } from './TodayFavorites.tsx';
import { ProblemGoalButton } from './ProblemGoalLists.tsx';
import { AskAiButton } from './AskAiButton.tsx';

export function GoalProblemActions({ lang, frontendId, title, disabled, onRemove, fallbackFocusRef }: {
  lang: Language;
  frontendId: string;
  title: string;
  disabled: boolean;
  onRemove(): void;
  fallbackFocusRef?: RefObject<HTMLButtonElement | null>;
}) {
  const zh = lang === 'zh';
  const workspace = useWorkspace();
  const [note, setNote] = useState<CatalogProblem | null>(null);
  const [error, setError] = useState('');
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);

  async function open(action: 'note' | 'practice') {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setError('');
    try {
      const { problem } = await api.getCatalogProblem(frontendId, { signal: controller.signal });
      if (controller.signal.aborted) return;
      if (!problem) throw new Error(zh ? '本地题库中找不到这道题。' : 'This problem is missing from the catalog.');
      if (action === 'note') setNote(problem);
      else workspace.openPractice({ mode: 'manual', problem });
    } catch (e) {
      if (!controller.signal.aborted) setError(localizeApiError(e, lang));
    }
  }

  const removeLabel = (zh ? '从当前题单移除 #' : 'Remove from this list: #') + frontendId;
  return <>
    <div className="goal-problem-actions" role="group" aria-label={zh ? `#${frontendId} 题目操作` : `Actions for #${frontendId}`}>
      <TodayFavoriteStar frontendId={frontendId} title={title} />
      <ProblemGoalButton frontendId={frontendId} title={title} fallbackFocusRef={fallbackFocusRef} />
      <ProblemNoteMenu lang={lang} frontendId={frontendId} onQuickNote={() => void open('note')} />
      <Tooltip text={zh ? '记录练习' : 'Record practice'} position="top">
        <button type="button" className="btn-icon" disabled={disabled} onClick={() => void open('practice')}
          aria-label={(zh ? '记录练习 #' : 'Record practice for #') + frontendId}><Plus size={18} aria-hidden="true" /></button>
      </Tooltip>
      <PracticeTimerButton lang={lang} frontendId={frontendId} title={title} disabled={disabled} />
      <AskAiButton lang={lang} frontendId={frontendId} title={title} />
      <Tooltip text={removeLabel} position="top">
        <button type="button" className="btn-icon btn-icon-danger" disabled={disabled} aria-label={removeLabel}
          onClick={onRemove}><Trash2 size={18} aria-hidden="true" /></button>
      </Tooltip>
    </div>
    {error && <p className="goal-action-error" role="alert">{error}</p>}
    {note && <QuickNoteDrawer lang={lang} problem={{ frontendId, title: note.title, url: note.url,
      difficulty: note.difficulty, tags: note.topicTags.map(tag => tag.name) }} onClose={() => setNote(null)}
      onOpenWorkspace={id => { setNote(null); workspace.navigate('notes', id); }} />}
  </>;
}
