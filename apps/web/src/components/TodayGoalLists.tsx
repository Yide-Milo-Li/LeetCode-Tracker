import { useEffect, useRef, useState } from 'react';
import { Circle, Plus } from 'lucide-react';
import type { GoalList } from '../../../../packages/contracts/src/goal-lists.ts';
import { api } from '../api.ts';
import { localizeApiError } from '../error-i18n.ts';
import type { Language } from '../i18n.ts';
import { useWorkspace } from '../workspace.tsx';
import { GoalListEditor } from './GoalListEditor.tsx';
import { GoalProblemActions } from './GoalProblemActions.tsx';
import { stopTimerFor, getPendingMinutes, clearPendingMinutes } from '../timer-service.ts';
import { Feedback } from './ui.tsx';

const SELECTED_GOAL_KEY = 'leetcode_tracker_selected_goal_list';

export function TodayGoalLists({ lang }: { lang: Language }) {
  const zh = lang === 'zh';
  const { revision, notifyMutation, openPractice } = useWorkspace();
  const [lists, setLists] = useState<GoalList[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(() => {
    try { return window.localStorage.getItem(SELECTED_GOAL_KEY); } catch { return null; }
  });
  const list = lists.find(goal => goal.id === selectedId) ?? lists[0];
  const remaining = list?.items.filter(item => !item.completed).length ?? 0;
  function selectGoal(id: string | null) {
    setSelectedId(id);
    try {
      if (id) window.localStorage.setItem(SELECTED_GOAL_KEY, id);
      else window.localStorage.removeItem(SELECTED_GOAL_KEY);
    } catch { /* Keep the selection in memory when storage is unavailable. */ }
  }
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [editing, setEditing] = useState<GoalList | null | undefined>();
  const [pending, setPending] = useState<string | null>(null);
  const [announcement, announce] = useState('');
  const read = useRef(0);
  const section = useRef<HTMLElement>(null);
  const createButton = useRef<HTMLButtonElement>(null);
  const completing = useRef(false);

  useEffect(() => {
    const request = ++read.current;
    api.getGoalLists().then(items => {
      if (request !== read.current) return;
      setLists(items);
      setSelectedId(previous => items.some(goal => goal.id === previous) ? previous : items[0]?.id ?? null);
      setLoaded(true);
      setError('');
    }).catch(e => {
      if (request === read.current) setError(localizeApiError(e, lang));
    });
    return () => { ++read.current; };
  }, [revision, retry, lang]);

  function saved(id: string, goal: GoalList | null) {
    ++read.current;
    setLists(previous => {
      if (!goal) return previous.filter(list => list.id !== id);
      if (!previous.some(list => list.id === id)) return [...previous, goal];
      return previous.map(list => list.id === id ? goal : list);
    });
    setError('');
    setRetry(n => n + 1);
  }
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
      <h2 id="goal-lists-title">{zh ? '目标题单' : 'Goal lists'}</h2>
      <button type="button" className="btn btn-secondary btn-sm" ref={createButton} disabled={!!pending} onClick={() => setEditing(null)}>
        <Plus aria-hidden="true" size={15} />{zh ? '新建题单' : 'New list'}
      </button>
    </div>
    {error && <Feedback retry={{ label: zh ? '刷新题单' : 'Reload lists', run: () => setRetry(n => n + 1) }}>{error}</Feedback>}
    {lists.length > 1 && <label className="goal-list-switcher">
      <span>{zh ? `切换题单（${lists.length}）` : `Select list (${lists.length})`}</span>
      <select className="form-input" value={list.id} title={list.name} disabled={!!pending} onChange={e => selectGoal(e.target.value)}>
        {lists.map(goal => <option key={goal.id} value={goal.id}>{goal.name}</option>)}
      </select>
    </label>}
    {list ? <div className="goal-list" key={list.id} data-goal={list.id}>
        <div className="goal-list-heading">
          {lists.length === 1 && <h3>{list.name}</h3>}
          <span className="goal-progress">{zh ? '已完成' : 'Completed'} {list.items.length - remaining}/{list.items.length}</span>
          <button type="button" className="text-link goal-edit-button" aria-label={(zh ? '编辑 ' : 'Edit ') + list.name}
            disabled={!!pending} onClick={() => setEditing(list)}>{zh ? '编辑' : 'Edit'}</button>
        </div>
        {remaining ? <ol className="goal-items goal-pending-items" aria-label={list.name}>
          {list.items.map((item, i) => item.completed ? null : <li key={item.frontendId} value={i + 1}>
            <div className="goal-item-line">
              <button type="button" className="completion-circle" data-problem={item.frontendId}
                aria-label={zh ? `完成 #${item.frontendId} ${item.title}` : `Complete #${item.frontendId} ${item.title}`}
                disabled={!!pending} onClick={() => void changeItem(list, item.frontendId, 'complete')}><Circle size={20} aria-hidden="true" /></button>
              {/^https?:\/\//i.test(item.url)
                ? <a className="problem-title-link" href={item.url} target="_blank" rel="noopener noreferrer" title={zh ? '打开题目 ↗' : 'Open problem ↗'}>#{item.frontendId} {item.title}<span aria-hidden="true" className="problem-link-mark"> ↗</span></a>
                : <span>#{item.frontendId} {item.title}</span>}
              <GoalProblemActions lang={lang} frontendId={item.frontendId} title={item.title} disabled={!!pending}
                onRemove={() => void changeItem(list, item.frontendId, 'remove')} />
            </div>
          </li>)}
        </ol> : <p className="text-muted">{list.items.length ? (zh ? '本单已全部完成。' : 'All problems completed.') : (zh ? '题单为空。' : 'This list is empty.')}</p>}
      </div> : loaded && !error ? <p className="text-muted">{zh ? '尚无目标题单。' : 'No goal lists yet.'}</p> : null}
    <span className="visually-hidden" role="status">{announcement}</span>
    {editing !== undefined && <GoalListEditor goal={editing} lang={lang} onClose={() => setEditing(undefined)}
      onRefresh={() => setRetry(n => n + 1)} onSaved={(id, list) => {
        selectGoal(list?.id ?? lists.find(goal => goal.id !== id)?.id ?? null);
        saved(id, list);
        setEditing(undefined);
        if (!list) requestAnimationFrame(() => createButton.current?.focus());
      }} />}
  </section>;
}
