import { useMemo, useRef, useState, type CSSProperties, type Ref } from 'react';
import { Circle, ListOrdered, Pencil, Plus } from 'lucide-react';
import type { GoalList } from '../../../../packages/contracts/src/goal-lists.ts';
import { api } from '../api.ts';
import { localizeApiError } from '../error-i18n.ts';
import { formatCount, type Language } from '../i18n.ts';
import { useWorkspace } from '../workspace.tsx';
import { GoalListEditor } from './GoalListEditor.tsx';
import { GoalProblemActions } from './GoalProblemActions.tsx';
import { stopTimerFor, getPendingMinutes, clearPendingMinutes } from '../timer-service.ts';
import type { TodayGoals } from '../hooks/useTodayGoals.ts';
import { Feedback } from './ui.tsx';
import { COLLECTION_PICKER_PAGE_SIZE, CollectionPicker } from './CollectionPicker.tsx';
import { useProblemListWindow } from '../hooks/useProblemListWindow.ts';

const pendingKey = (row: { item: GoalList['items'][number] }) => row.item.frontendId;

export function TodayGoalLists({ lang, goals, nextTaskRef }: {
  lang: Language; goals: TodayGoals; nextTaskRef?: Ref<HTMLLIElement>;
}) {
  const zh = lang === 'zh';
  const { notifyMutation, openPractice } = useWorkspace();
  const { lists, selected, list, loaded, error, setError, selectGoal, saved, refresh } = goals;
  const pickerOptions = useMemo(() => lists.length > COLLECTION_PICKER_PAGE_SIZE ? lists.map(goal => ({
    id: goal.id, name: goal.name,
    detail: formatCount(goal.completedCount, lang) + ' / ' + formatCount(goal.total, lang),
  })) : [], [lists, lang]);
  const pendingRows = useMemo(() => list?.items.flatMap((item, i) => item.completed ? [] : [{ item, position: i + 1 }]) ?? [], [list]);
  const nextItem = pendingRows[0]?.item;
  const scrollList = useRef<HTMLOListElement>(null);
  // The overview's “Next” action must still be able to focus the first pending problem from any scroll position.
  const windowed = useProblemListWindow(pendingRows, pendingKey, scrollList, 52, 0);
  const [editing, setEditing] = useState<GoalList | null | undefined>();
  const [pending, setPending] = useState<string | null>(null);
  const [announcement, announce] = useState('');
  const section = useRef<HTMLElement>(null);
  const createButton = useRef<HTMLButtonElement>(null);
  const editButton = useRef<HTMLButtonElement>(null);
  const completing = useRef(false);

  async function changeItem(list: GoalList, frontendId: string, action: 'complete' | 'remove') {
    if (completing.current) return;
    completing.current = true;
    setPending(list.id);
    setError('');
    const original = document.activeElement;
    const elapsedMinutes = action === 'complete'
      ? stopTimerFor(frontendId)?.minutes ?? getPendingMinutes(frontendId) ?? undefined : undefined;
    try {
      const goal = await api.editGoalItem(list.id, { expectedVersion: list.version, edit: action === 'remove'
        ? { action: 'remove', frontendId } : { action: 'setCompleted', frontendId, completed: true, recordPractice: true } });
      saved(list.id, goal);
      announce(action === 'complete' ? (zh ? `#${frontendId} 已完成` : `Completed #${frontendId}`)
        : (zh ? `已从题单移除 #${frontendId}` : `Removed #${frontendId} from the list`));
      if (goal.linkedPractice !== undefined) notifyMutation(goal.linkedPractice ?? undefined);
      if (goal.linkedPractice) {
        if (elapsedMinutes !== undefined) clearPendingMinutes(frontendId);
        openPractice({ mode: 'enrich', record: goal.linkedPractice, elapsedMinutes, fallbackFocusRef: editButton });
        return;
      }
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
      <div className="action-row">
        <a href="#goal-lists" className="text-link">{zh ? '管理题单' : 'Manage lists'}</a>
        <button type="button" className="btn btn-secondary btn-sm" ref={createButton} disabled={!!pending} onClick={() => setEditing(null)}>
          <Plus aria-hidden="true" size={15} />{zh ? '新建题单' : 'New list'}
        </button>
      </div>
    </div>
    {error && <Feedback retry={{ label: zh ? '刷新题单' : 'Reload lists', run: refresh }}>{error}</Feedback>}
    {selected ? <div className="goal-list" data-goal={selected.id}>
        <div className="goal-list-tools">
          {pickerOptions.length > 0 ? <CollectionPicker options={pickerOptions}
            label={zh ? '切换题单' : 'Choose a goal list'} searchLabel={zh ? '搜索题单' : 'Search goal lists'}
            lang={lang} selected={selected.id} disabled={!!pending} onSelect={selectGoal} />
          : lists.length > 1 ? <label className="goal-list-switcher">
            <span className="visually-hidden">{zh ? `切换题单（${lists.length}）` : `Select list (${lists.length})`}</span>
            <select className="form-input" value={selected.id} title={selected.name} disabled={!!pending} onChange={e => selectGoal(e.target.value)}>
              {lists.map(goal => <option key={goal.id} value={goal.id}>{goal.name}</option>)}
            </select>
          </label> : <h3>{selected.name}</h3>}
          <button type="button" className="btn btn-secondary btn-sm goal-edit-button" aria-label={(zh ? '编辑 ' : 'Edit ') + selected.name}
            ref={editButton} disabled={!!pending || !list} onClick={() => setEditing(list)}><Pencil size={14} aria-hidden="true" />{zh ? '编辑' : 'Edit'}</button>
        </div>
        {!list ? (!error && <p role="status">{zh ? '正在读取题单…' : 'Loading checklist…'}</p>) : nextItem ? <ol key={selected.id} className="goal-items goal-pending-items" role="list" aria-label={list.name} ref={scrollList} {...windowed.listProps}
          style={{ ...windowed.listProps.style, '--goal-order-width': `${String(list.items.length).length + 1}ch` } as CSSProperties}>
          {windowed.renderRows(({ item, position }, i, rowProps) => <li key={item.frontendId} value={position} className="goal-item-line" {...rowProps}
            ref={i === 0 && nextTaskRef ? node => {
              rowProps.ref?.(node);
              if (typeof nextTaskRef === 'function') return nextTaskRef(node);
              nextTaskRef.current = node;
            } : rowProps.ref} tabIndex={i === 0 ? -1 : undefined}>
            <span className="goal-item-position">{position}.</span>
            <button type="button" className="completion-circle" data-problem={item.frontendId}
              aria-label={zh ? `完成 #${item.frontendId} ${item.title}` : `Complete #${item.frontendId} ${item.title}`}
              disabled={!!pending} onClick={() => void changeItem(list, item.frontendId, 'complete')}><Circle size={20} aria-hidden="true" /></button>
            {/^https?:\/\//i.test(item.url)
              ? <a className="goal-item-title problem-title-link" href={item.url} data-practice-id={item.frontendId} data-practice-title={item.title} target="_blank" rel="noopener noreferrer" title={zh ? '打开题目 ↗' : 'Open problem ↗'}>#{item.frontendId} {item.title}<span aria-hidden="true" className="problem-link-mark"> ↗</span></a>
              : <span className="goal-item-title">#{item.frontendId} {item.title}</span>}
            <GoalProblemActions lang={lang} frontendId={item.frontendId} title={item.title} disabled={!!pending} fallbackFocusRef={editButton}
              onRemove={() => void changeItem(list, item.frontendId, 'remove')} />
          </li>)}
        </ol> : <p className="text-muted">{list.items.length ? (zh ? '本单已全部完成。' : 'All problems completed.') : (zh ? '题单为空。' : 'This list is empty.')}</p>}
      </div> : loaded && !lists.length && !error ? <p className="text-muted">{zh ? '尚无目标题单。' : 'No goal lists yet.'}</p> : null}
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
