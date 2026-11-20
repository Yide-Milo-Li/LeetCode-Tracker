import { useId, useRef, useState, type CSSProperties } from 'react';
import { ArrowDown, ArrowUp, Pencil, Trash2, Undo2 } from 'lucide-react';
import type { GoalList } from '../../../../packages/contracts/src/goal-lists.ts';
import { api, ApiError } from '../api.ts';
import type { Language } from '../i18n.ts';
import { localizeApiError } from '../error-i18n.ts';
import { Dialog } from './ui.tsx';
import { GoalProblemPicker } from './GoalProblemPicker.tsx';

function parseIds(text: string, known: ReadonlyMap<string, unknown>) {
  return text.split(/\r?\n/u).flatMap(line => {
    const trimmed = line.trim();
    if (known.has(trimmed)) return [trimmed];
    return trimmed.split(/[,，、]/u).map(id => id.trim().replace(/^#\s*/, '')).filter(Boolean);
  });
}

export function GoalListEditor({ goal, lang, onClose, onSaved, onRefresh }: {
  goal: GoalList | null;
  lang: Language;
  onClose(): void;
  onSaved(id: string, goal: GoalList | null): void;
  onRefresh(): void;
}) {
  const zh = lang === 'zh';
  const [id] = useState(() => goal?.id ?? crypto.randomUUID());
  const [name, setName] = useState(goal?.name ?? '');
  const [ids, setIds] = useState(() => goal?.items.map(item => item.frontendId) ?? []);
  const [text, setText] = useState('');
  const [details, setDetails] = useState(() => new Map(goal?.items.map(item => [item.frontendId, item])));
  const [bulk, setBulk] = useState(false);
  const [replace, setReplace] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [announcement, announce] = useState('');
  const formId = useId();
  const picker = useRef<HTMLDivElement>(null);
  const rows = useRef<HTMLOListElement>(null);
  const duplicate = new Set(ids).size !== ids.length;

  function focusRow(id?: string) {
    requestAnimationFrame(() => {
      const row = Array.from(rows.current?.children ?? []).find(el => (el as HTMLElement).dataset.id === id);
      (row?.querySelector<HTMLElement>('button:enabled') ?? picker.current?.querySelector('input'))?.focus();
    });
  }
  function move(index: number, step: number) {
    const next = [...ids];
    [next[index], next[index + step]] = [next[index + step], next[index]];
    setIds(next);
    announce(zh ? `#${ids[index]} 已移到第 ${index + step + 1} 位` : `Moved #${ids[index]} to position ${index + step + 1}`);
  }
  function remove(index: number) {
    setIds(ids.filter((_, i) => i !== index));
    if (replace === ids[index]) setReplace(null);
    setDetails(prev => { const next = new Map(prev); next.delete(ids[index]); return next; });
    focusRow(ids[index + 1] ?? ids[index - 1]);
  }

  async function submit() {
    if (busy) return;
    setBusy(true);
    setError('');
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
      setError(localizeApiError(e, lang));
      if (e instanceof ApiError && [404, 409].includes(e.status)) onRefresh();
    } finally {
      setBusy(false);
    }
  }
  const title = goal ? (zh ? '编辑题单' : 'Edit goal list') : (zh ? '新建题单' : 'New goal list');
  return <Dialog title={deleting ? (zh ? '删除题单' : 'Delete goal list') : title} lang={lang} onClose={onClose} closeDisabled={busy}>
    <form onSubmit={e => { e.preventDefault(); void submit(); }}>
      <fieldset className="goal-editor" disabled={busy}>
        {deleting ? <p>{zh ? `删除「${goal?.name}」及其勾选状态？练习记录会保留。` :
          `Delete “${goal?.name}” and its checkmarks? Your practice history will be kept.`}</p> : <>
          <label className="form-group">{zh ? '题单名称' : 'List name'}
            <input required maxLength={250} className="form-input" value={name} onChange={e => setName(e.target.value)} />
          </label>
          {!bulk && <div ref={picker}>
            <GoalProblemPicker key={replace ?? ''} lang={lang} selected={ids}
              label={replace ? (zh ? `替换 #${replace} 为` : `Replace #${replace} with`) : (zh ? '从题库添加' : 'Add from catalog')}
              onAdd={problem => {
                const value = problem.questionFrontendId;
                const next = replace ? ids.map(id => id === replace ? value : id) : [...ids, value];
                setIds(next);
                setDetails(prev => new Map(prev).set(value, { frontendId: value, title: problem.title, url: problem.url, completed: false }));
                setReplace(null);
                announce(zh ? `已加入 #${value}` : `Added #${value}`);
                if (replace) focusRow(value);
              }} />
            {replace && <button className="text-link" type="button" onClick={() => setReplace(null)}>{zh ? '取消替换' : 'Cancel replacement'}</button>}
          </div>}
          <div className="goal-list-heading">
            <strong>{zh ? `题目（${ids.length}）` : `Problems (${ids.length})`}</strong>
            <button className="text-link" type="button" disabled={duplicate} onClick={() => {
              setReplace(null);
              if (!bulk) setText(ids.join('\n'));
              setBulk(!bulk);
            }}>
              {bulk ? (zh ? '返回列表' : 'Show list') : (zh ? '批量编辑题号' : 'Edit IDs in bulk')}
            </button>
          </div>
          {bulk ? <label className="form-group">{zh ? '按顺序输入题号，用逗号或换行分隔' : 'Problem IDs in order, separated by commas or newlines'}
            <textarea className="form-textarea" rows={6} value={text} onChange={e => {
                setText(e.target.value);
                setIds(parseIds(e.target.value, details));
              }}
              aria-invalid={duplicate} aria-describedby={duplicate ? formId + '-duplicates' : undefined} />
            {duplicate && <small id={formId + '-duplicates'} role="alert">{zh ? '同一题号只能出现一次。' : 'Keep one entry per problem ID.'}</small>}
          </label> : <ol className="goal-items goal-edit-items" role="list" ref={rows}
            style={{ '--goal-order-width': `${String(ids.length).length + 1}ch` } as CSSProperties}>
            {ids.map((id, i) => {
              const item = details.get(id);
              const actions = [
                { label: zh ? `上移 #${id}` : `Move #${id} up`, icon: ArrowUp, disabled: i === 0, run: () => move(i, -1) },
                { label: zh ? `下移 #${id}` : `Move #${id} down`, icon: ArrowDown, disabled: i === ids.length - 1, run: () => move(i, 1) },
                { label: zh ? `替换 #${id}` : `Replace #${id}`, icon: Pencil, run: () => { setReplace(id); requestAnimationFrame(() => picker.current?.querySelector('input')?.focus()); } },
                { label: zh ? `移除 #${id}` : `Remove #${id}`, icon: Trash2, run: () => remove(i) },
              ];
              if (item?.completed) actions.unshift({
                label: zh ? `恢复待做 #${id}` : `Reopen #${id}`, icon: Undo2,
                run: () => { setDetails(prev => new Map(prev).set(id, { ...item, completed: false })); focusRow(id); },
              });
              return <li key={id} data-id={id} className="goal-edit-line">
                <span className="goal-item-position">{i + 1}.</span>
                <span className="goal-item-title">#{id} {item?.title} {item?.completed && <small>{zh ? '已完成' : 'Completed'}</small>}</span>
                <div className="goal-edit-actions">{actions.map(({ label, icon: Icon, disabled, run }) =>
                  <button type="button" key={label} className="btn-icon" disabled={disabled} aria-label={label} title={label} onClick={run}><Icon size={15} /></button>)}</div>
              </li>;
            })}
          </ol>}
        </>}
        {error && <p role="alert">{error}</p>}
        <div className="goal-editor-footer">
          {goal && !deleting && <button className="text-link" type="button" onClick={() => { setError(''); setDeleting(true); }}>{zh ? '删除题单' : 'Delete list'}</button>}
          <div className="action-row">
            <button type="button" className="btn btn-secondary" onClick={() => deleting ? setDeleting(false) : onClose()}>{zh ? '取消' : 'Cancel'}</button>
            <button className={deleting ? 'btn btn-danger' : 'btn btn-primary'} disabled={!deleting && (!name.trim() || duplicate)}>
              {deleting ? (zh ? '确认删除' : 'Confirm deletion') : (zh ? '保存题单' : 'Save list')}
            </button>
          </div>
        </div>
        <span role="status" className="visually-hidden">{announcement}</span>
      </fieldset>
    </form>
  </Dialog>;
}
