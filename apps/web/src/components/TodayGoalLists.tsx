import { useRef, useState, type CSSProperties, type Ref } from 'react';
import { Circle, ListOrdered, Pencil, Plus } from 'lucide-react';
import type { GoalList } from '../../../../packages/contracts/src/goal-lists.ts';
import { api } from '../api.ts';
import { localizeApiError } from '../error-i18n.ts';
import type { Language } from '../i18n.ts';
import { useWorkspace } from '../workspace.tsx';
import { GoalListEditor } from './GoalListEditor.tsx';
import { GoalProblemActions } from './GoalProblemActions.tsx';
import { stopTimerFor, getPendingMinutes, clearPendingMinutes } from '../timer-service.ts';
import type { TodayGoals } from '../hooks/useTodayGoals.ts';
import { Feedback } from './ui.tsx';

export function TodayGoalLists({ lang, goals, nextTaskRef }: {
  lang: Language; goals: TodayGoals; nextTaskRef?: Ref<HTMLLIElement>;
}) {
  const zh = lang === 'zh';
  const { notifyMutation, openPractice } = useWorkspace();
  const { lists, list, loaded, error, setError, selectGoal, saved, refresh } = goals;
  const nextItem = list?.items.find(item => !item.completed);
  const [editing, setEditing] = useState<GoalList | null | undefined>();
  const [pending, setPending] = useState<string | null>(null);
  const [announcement, announce] = useState('');
  const section = useRef<HTMLElement>(null);
  const createButton = useRef<HTMLButtonElement>(null);
  const completing = useRef(false);

  async function changeItem(list: GoalList, frontendId: string, action: 'complete' | 'remove') {
    if (completing.current) return;
    completing.current = true;
    setPending(list.id);
    setError('');
    const original = document.activeElement;
    try {
      const goal = await api.editGoalItem(list.id, { expectedVersion: list.version, edit: action === 'remove'
        ? { action: 'remove', frontendId } : { action: 'setCompleted', frontendId, completed: true } });
      if (action === 'complete') {
        const elapsed = stopTimerFor(frontendId)?.minutes ?? getPendingMinutes(frontendId) ?? undefined;
        if (goal.linkedPractice !== undefined) {
          notifyMutation(goal.linkedPractice ?? undefined);
          if (goal.linkedPractice) {
            if (elapsed !== undefined) clearPendingMinutes(frontendId);
            openPractice({ mode: 'enrich', record: goal.linkedPractice, elapsedMinutes: elapsed });
          }
        }
      }
      saved(list.id, goal);
      announce(action === 'complete' ? (zh ? `#${frontendId} 已完成` : `Completed #${frontendId}`)
        : (zh ? `已从题单移除 #${frontendId}` : `Removed #${frontendId} from the list`));
      const position = list.items.findIndex(item => item.frontendId === frontendId);
      const next = list.items.slice(position + 1).find(item => !item.completed) ?? list.items.find(item => !item.completed && item.frontendId !== frontendId);
      requestAnimationFrame(() => {
        if (document.activeElement !== document.body && document.activeElement !== original) return;
        const group = section.current?.querySelector<HTMLElement>(`[data-goal="${list.id}"]`);
        const button = Array.from(group?.querySelectorAll<HTMLButtonElement>('[data-problem]') ?? []).find(el => el.dataset.problem === next?.frontendId);
        (button ?? group?.querySelector<HTMLButtonElement>('.goal-edit-button'))?.focus();
      });
    } catch (e) {
      setError(localizeApiError(e, lang));
    } finally {
      completing.current = false;
      setPending(null);
    }
  }

  return <section className="today-goal-lists" ref={section} aria-labelledby="goal-lists-title">
    <div className="goal-list-heading">
      <h2 id="goal-lists-title"><ListOrdered size={19} aria-hidden="true" />{zh ? '目标题单' : 'Goal lists'}</h2>
      <button type="button" className="btn btn-secondary btn-sm" ref={createButton} disabled={!!pending} onClick={() => setEditing(null)}>
        <Plus aria-hidden="true" size={15} />{zh ? '新建题单' : 'New list'}
      </button>
    </div>
    {error && <Feedback retry={{ label: zh ? '刷新题单' : 'Reload lists', run: refresh }}>{error}</Feedback>}
    {list ? <div className="goal-list" key={list.id} data-goal={list.id}>
        <div className="goal-list-tools">
          {lists.length > 1 ? <label className="goal-list-switcher">
            <span className="visually-hidden">{zh ? `切换题单（${lists.length}）` : `Select list (${lists.length})`}</span>
            <select className="form-input" value={list.id} title={list.name} disabled={!!pending} onChange={e => selectGoal(e.target.value)}>
              {lists.map(goal => <option key={goal.id} value={goal.id}>{goal.name}</option>)}
            </select>
          </label> : <h3>{list.name}</h3>}
          <button type="button" className="btn btn-secondary btn-sm goal-edit-button" aria-label={(zh ? '编辑 ' : 'Edit ') + list.name}
            disabled={!!pending} onClick={() => setEditing(list)}><Pencil size={14} aria-hidden="true" />{zh ? '编辑' : 'Edit'}</button>
        </div>
        {nextItem ? <ol className="goal-items goal-pending-items" role="list" aria-label={list.name}
          style={{ '--goal-order-width': `${String(list.items.length).length + 1}ch` } as CSSProperties}>
          {list.items.map((item, i) => item.completed ? null : <li key={item.frontendId} value={i + 1} className="goal-item-line"
            ref={item === nextItem ? nextTaskRef : undefined} tabIndex={item === nextItem ? -1 : undefined}>
            <span className="goal-item-position">{i + 1}.</span>
            <button type="button" className="completion-circle" data-problem={item.frontendId}
              aria-label={zh ? `完成 #${item.frontendId} ${item.title}` : `Complete #${item.frontendId} ${item.title}`}
              disabled={!!pending} onClick={() => void changeItem(list, item.frontendId, 'complete')}><Circle size={20} aria-hidden="true" /></button>
            {/^https?:\/\//i.test(item.url)
              ? <a className="goal-item-title problem-title-link" href={item.url} target="_blank" rel="noopener noreferrer" title={zh ? '打开题目 ↗' : 'Open problem ↗'}>#{item.frontendId} {item.title}<span aria-hidden="true" className="problem-link-mark"> ↗</span></a>
              : <span className="goal-item-title">#{item.frontendId} {item.title}</span>}
            <GoalProblemActions lang={lang} frontendId={item.frontendId} title={item.title} disabled={!!pending}
              onRemove={() => void changeItem(list, item.frontendId, 'remove')} />
          </li>)}
        </ol> : <p className="text-muted">{list.items.length ? (zh ? '本单已全部完成。' : 'All problems completed.') : (zh ? '题单为空。' : 'This list is empty.')}</p>}
      </div> : loaded && !error ? <p className="text-muted">{zh ? '尚无目标题单。' : 'No goal lists yet.'}</p> : null}
    <span className="visually-hidden" role="status">{announcement}</span>
    {editing !== undefined && <GoalListEditor goal={editing} lang={lang} onClose={() => setEditing(undefined)}
      onRefresh={refresh} onSaved={(id, list) => {
        selectGoal(list?.id ?? lists.find(goal => goal.id !== id)?.id ?? null);
        saved(id, list);
        setEditing(undefined);
        if (!list) requestAnimationFrame(() => createButton.current?.focus());
      }} />}
  </section>;
}
