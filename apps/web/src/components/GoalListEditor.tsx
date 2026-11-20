import { useEffect, useId, useMemo, useRef, useState, type CSSProperties } from 'react';
import { ArrowDown, ArrowUp, GripVertical, Pencil, Trash2, Undo2 } from 'lucide-react';
import type { GoalList } from '../../../../packages/contracts/src/goal-lists.ts';
import { api, ApiError, type CatalogProblem } from '../api.ts';
import { formatCount, type Language } from '../i18n.ts';
import { localizeApiError } from '../error-i18n.ts';
import { formatGoalIds, parseGoalIds } from '../goal-list-input.ts';
import { useGoalListDrag } from '../hooks/useGoalListDrag.ts';
import { useProblemListWindow } from '../hooks/useProblemListWindow.ts';
import { Dialog } from './ui.tsx';
import { GoalProblemPicker } from './GoalProblemPicker.tsx';

const problemKey = (id: string) => id;
const noRows: string[] = [];

export function GoalListEditor({ goal, initialItems = [], lang, onClose, onSaved, onRefresh }: {
  goal: GoalList | null;
  initialItems?: GoalList['items'];
  lang: Language;
  onClose(): void;
  onSaved(id: string, goal: GoalList | null): void;
  onRefresh?(): void;
}) {
  const zh = lang === 'zh';
  const [id] = useState(() => goal?.id ?? crypto.randomUUID());
  const [name, setName] = useState(goal?.name ?? '');
  const startingItems = goal?.items ?? initialItems;
  const [rowIds, setIds] = useState(() => startingItems.map(item => item.frontendId));
  const [text, setText] = useState('');
  const [details, setDetails] = useState(() => new Map(startingItems.map(item => [item.frontendId, item])));
  const [bulk, setBulk] = useState(false);
  const [replace, setReplace] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [catalogError, setCatalogError] = useState('');
  const [announcement, announce] = useState('');
  const formId = useId();
  const nameInput = useRef<HTMLInputElement>(null);
  const picker = useRef<HTMLDivElement>(null);
  const rows = useRef<HTMLOListElement>(null);
  const bulkField = useRef<HTMLTextAreaElement>(null);
  const saving = useRef(false);
  const parsed = useMemo(() => bulk ? parseGoalIds(text, lang) : null, [bulk, text, lang]);
  const ids = parsed?.ids ?? rowIds;
  const [dragIndex, setDragIndex] = useState(-1);
  const windowed = useProblemListWindow(bulk || deleting ? noRows : ids, problemKey, rows, 40, dragIndex);
  const inputError = parsed?.error || catalogError;
  const removedCount = parsed && !inputError ? goal?.items.filter(item => !parsed.seen.has(item.frontendId)).length ?? 0 : 0;
  useEffect(() => {
    if (bulk && catalogError) bulkField.current?.focus();
  }, [bulk, catalogError]);

  function revealRow(index: number, after?: (row: HTMLElement) => void) {
    const trigger = document.activeElement;
    const stillHere = () => document.activeElement === trigger || document.activeElement === document.body;
    requestAnimationFrame(() => {
      if (!rows.current || !stillHere()) return;
      if (index < 0) { picker.current?.querySelector('input')?.focus(); return; }
      windowed.virtual?.scrollToIndex(index, { align: 'auto' });
      const reveal = () => {
        if (!stillHere()) return true;
        const row = rows.current?.querySelector<HTMLElement>(`[data-index="${index}"]`);
        if (!row) return false;
        row.scrollIntoView?.({ block: 'nearest' });
        after?.(row);
        return true;
      };
      if (!reveal()) requestAnimationFrame(reveal);
    });
  }
  function focusRow(index: number) {
    revealRow(index, row => row.querySelector<HTMLElement>('button:enabled')?.focus());
  }
  function move(from: number, to: number, button?: HTMLButtonElement) {
    if (from === to || !ids[from] || !ids[to]) return;
    const next = [...ids];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    setIds(next);
    announce(zh ? `#${moved} 已移到第 ${to + 1} 位` : `Moved #${moved} to position ${to + 1}`);
    revealRow(to, row => {
      if (button) (button.disabled || !button.isConnected ? row.querySelector<HTMLElement>('[data-move]:enabled') : button)?.focus();
    });
  }
  const startDrag = useGoalListDrag(ids, busy || bulk || deleting, move, windowed.virtual, setDragIndex);

  function remove(index: number) {
    setIds(ids.filter((_, i) => i !== index));
    if (replace === ids[index]) setReplace(null);
    focusRow(Math.min(index, ids.length - 2));
  }
  function addProblem(problem: CatalogProblem) {
    const value = problem.questionFrontendId;
    if (ids.includes(value) || (replace && !ids.includes(replace))) return;
    setIds(replace ? ids.map(id => id === replace ? value : id) : [...ids, value]);
    setDetails(prev => new Map(prev).set(value, { frontendId: value, title: problem.title, url: problem.url,
      completed: prev.get(value)?.completed ?? false }));
    setReplace(null);
    announce(zh ? `已加入 #${value}` : `Added #${value}`);
    if (replace) focusRow(ids.indexOf(replace));
  }
  function toggleBulk() {
    if (parsed?.error) return;
    setReplace(null);
    setCatalogError('');
    if (parsed) setIds(parsed.ids);
    else setText(formatGoalIds(ids));
    setBulk(!bulk);
  }

  async function submit() {
    if (saving.current || (!deleting && (!name.trim() || parsed?.error))) return;
    saving.current = true;
    setBusy(true);
    setError('');
    setCatalogError('');
    try {
      if (deleting && goal) {
        await api.deleteGoalList(id, goal.version);
        onSaved(id, null);
      } else {
        const saved = goal
          ? await api.updateGoalList(id, { expectedVersion: goal.version, name: name.trim(),
              items: ids.map(frontendId => ({ frontendId, completed: details.get(frontendId)?.completed ?? false })) })
          : await api.createGoalList({ id, name: name.trim(), frontendIds: ids });
        onSaved(id, saved);
      }
    } catch (e) {
      if (!deleting && e instanceof ApiError && e.code === 'GOAL_UNKNOWN_PROBLEM') {
        if (!bulk) setText(formatGoalIds(ids));
        setBulk(true);
        setReplace(null);
        setCatalogError(localizeApiError(e, lang));
      } else setError(localizeApiError(e, lang));
      if (e instanceof ApiError && [404, 409].includes(e.status)) onRefresh?.();
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }

  const title = goal ? (zh ? '编辑题单' : 'Edit goal list') : (zh ? '新建题单' : 'New goal list');
  const footer = <div className="goal-editor-footer">
    {goal && !deleting && <button className="text-link" type="button" disabled={busy} onClick={() => { setError(''); setDeleting(true); }}>
      {zh ? '删除题单' : 'Delete list'}
    </button>}
    <div className="action-row">
      <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => deleting ? setDeleting(false) : onClose()}>
        {zh ? '取消' : 'Cancel'}
      </button>
      <button type="submit" form={formId} className={deleting ? 'btn btn-danger' : 'btn btn-primary'}
        disabled={busy || (!deleting && (!name.trim() || !!parsed?.error))}>
        {deleting ? (zh ? '确认删除' : 'Confirm deletion') : (zh ? '保存题单' : 'Save list')}
      </button>
    </div>
  </div>;
  return <Dialog title={deleting ? (zh ? '删除题单' : 'Delete goal list') : title} lang={lang} onClose={onClose}
    initialFocusRef={nameInput} closeDisabled={busy} wide={!deleting} footer={footer}>
    <form id={formId} className="goal-editor" onSubmit={e => { e.preventDefault(); void submit(); }}>
      <fieldset disabled={busy}>
        {deleting ? <p>{zh ? `删除「${goal?.name}」及其勾选状态？练习记录会保留。` :
          `Delete “${goal?.name}” and its checkmarks? Your practice history will be kept.`}</p> : <>
          <div className="goal-editor-fields">
            <label className="form-field"><span>{zh ? '题单名称' : 'List name'}</span>
              <input ref={nameInput} required maxLength={250} className="form-input" value={name} onChange={e => setName(e.target.value)} />
            </label>
            {!bulk && <div ref={picker}>
              <GoalProblemPicker key={replace ?? ''} lang={lang} selected={ids} replaceId={replace} onAdd={addProblem} />
              {replace && <button className="text-link" type="button" onClick={() => setReplace(null)}>{zh ? '取消替换' : 'Cancel replacement'}</button>}
            </div>}
          </div>
          <div className="goal-list-heading">
            <strong id={formId + '-count'}>{zh ? `题目（${formatCount(ids.length, lang)}）` : `Problems (${formatCount(ids.length, lang)})`}</strong>
            <button className="text-link" type="button" disabled={!!parsed?.error} onClick={toggleBulk}>
              {bulk ? (zh ? '返回列表' : 'Show list') : (zh ? '批量编辑题号' : 'Edit IDs in bulk')}
            </button>
          </div>
          {bulk ? <div className="form-field">
            <label htmlFor={formId + '-ids'}>{zh ? '按目标顺序输入要保留的题号，用逗号或换行分隔' : 'Enter the IDs to keep, in order, separated by commas or newlines'}</label>
            <textarea id={formId + '-ids'} ref={bulkField} className="form-textarea" rows={6} value={text} onChange={e => {
              setText(e.target.value);
              setCatalogError('');
            }} aria-invalid={!!inputError} aria-describedby={inputError || removedCount ? formId + '-ids-message' : undefined} />
            {inputError ? <small id={formId + '-ids-message'} role="alert">{inputError}</small> : removedCount > 0 &&
              <small id={formId + '-ids-message'}>{zh ? `保存后将从题单移除 ${formatCount(removedCount, lang)} 道题。`
                : `Saving will remove ${formatCount(removedCount, lang)} ${removedCount === 1 ? 'problem' : 'problems'} from this list.`}</small>}
          </div> : <ol className="goal-items goal-edit-items" ref={rows} role="list" aria-labelledby={formId + '-count'} {...windowed.listProps}
            style={{ ...windowed.listProps.style, '--goal-order-width': `${String(ids.length).length + 1}ch` } as CSSProperties}>
            {windowed.renderRows((id, i, rowProps) => {
              const item = details.get(id);
              const actions = [
                { label: zh ? `上移 #${id}` : `Move #${id} up`, icon: ArrowUp, disabled: i === 0,
                  run: (btn: HTMLButtonElement) => move(i, i - 1, btn) },
                { label: zh ? `下移 #${id}` : `Move #${id} down`, icon: ArrowDown, disabled: i === ids.length - 1,
                  run: (btn: HTMLButtonElement) => move(i, i + 1, btn) },
                { label: zh ? `替换 #${id}` : `Replace #${id}`, icon: Pencil, run: () => { setReplace(id); requestAnimationFrame(() => picker.current?.querySelector('input')?.focus()); } },
                { label: zh ? `移除 #${id}` : `Remove #${id}`, icon: Trash2, run: () => remove(i) },
              ];
              if (item?.completed) actions.unshift({
                label: zh ? `恢复待做 #${id}` : `Reopen #${id}`, icon: Undo2,
                run: () => { setDetails(prev => new Map(prev).set(id, { ...item, completed: false })); focusRow(i); },
              });
              return <li key={id} data-id={id} className="goal-edit-line" {...rowProps}>
                <span className="goal-drag-handle" aria-hidden="true" onPointerDown={e => startDrag(e, i)}>
                  <GripVertical size={16} />
                </span>
                <span className="goal-item-position">{i + 1}.</span>
                <span className="goal-item-title"><span>#{id}</span> {item?.title} {item?.completed && <small>{zh ? '已完成' : 'Completed'}</small>}</span>
                <div className="goal-edit-actions">{actions.map(({ label, icon: Icon, disabled, run }) =>
                  <button key={label} type="button" className={Icon === Trash2 ? 'btn-icon btn-icon-danger' : 'btn-icon'} disabled={disabled}
                    data-move={Icon === ArrowUp || Icon === ArrowDown ? '' : undefined} aria-label={label} onClick={e => run(e.currentTarget)}>
                    <Icon size={15} aria-hidden="true" />
                  </button>)}</div>
              </li>;
            })}
          </ol>}
        </>}
        {error && <p role="alert">{error}</p>}
        <span role="status" className="visually-hidden">{announcement}</span>
      </fieldset>
    </form>
  </Dialog>;
}
