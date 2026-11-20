import { createContext, useContext, useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type Dispatch, type ReactNode, type RefObject, type SetStateAction } from 'react';
import { Flag, ListPlus } from 'lucide-react';
import type { GoalList, GoalListSummary } from '../../../../packages/contracts/src/goal-lists.ts';
import { api, ApiError } from '../api.ts';
import { localizeApiError } from '../error-i18n.ts';
import { useWorkspace, ViewVisible } from '../workspace.tsx';
import { useTodayGoals, type TodayGoals } from '../hooks/useTodayGoals.ts';
import { formatCount, type Language } from '../i18n.ts';
import { Dialog, Feedback, Field, Tooltip } from './ui.tsx';
import { CollectionChoices } from './CollectionPicker.tsx';

interface ProblemRef { frontendId: string; title: string; fallbackFocusRef?: RefObject<HTMLButtonElement | null> }
function createMembershipStore() {
  let values = new Map<string, string[]>();
  const listeners = new Map<string, Set<() => void>>();
  return {
    get: (id: string) => values.get(id),
    subscribe(id: string, notify: () => void) {
      const group = listeners.get(id) ?? new Set();
      listeners.set(id, group);
      group.add(notify);
      return () => {
        group.delete(notify);
        if (!group.size) listeners.delete(id);
      };
    },
    replace(next: Map<string, string[]>) {
      const previous = values;
      values = next;
      for (const [id, group] of listeners) {
        const before = previous.get(id);
        const after = next.get(id);
        if (before && after && before.length === after.length && before.every((list, i) => list === after[i])) {
          next.set(id, before);
        } else if (before !== after) {
          for (const notify of group) notify();
        }
      }
    },
    copy: () => new Map(values),
  };
}

type MembershipStore = ReturnType<typeof createMembershipStore>;
function useMembership(store: MembershipStore | undefined, id: string | undefined) {
  const subscribe = useCallback((notify: () => void) => id && store ? store.subscribe(id, notify) : () => {}, [store, id]);
  const read = useCallback(() => id ? store?.get(id) : undefined, [store, id]);
  return useSyncExternalStore(subscribe, read, read);
}

interface ButtonControls {
  lang: Language;
  loaded: boolean;
  memberships: MembershipStore;
  track(frontendId: string): () => void;
  open(problem: ProblemRef): void;
}
const ButtonContext = createContext<ButtonControls | null>(null);
const GoalContext = createContext<{
  goals: TodayGoals;
  updateFlags(frontendIds: string[], listIds: string[], append: boolean): void;
} | null>(null);

/** Standalone views own a store; the application shares one between all mounted views. */
export function GoalListsScope(props: { lang: Language; active?: boolean; showSelected?: boolean; onCreated?(): void; children: ReactNode }) {
  const shared = useContext(GoalContext);
  return shared ? props.children : <GoalListsOwner {...props} />;
}

export function useSharedGoalLists() {
  const shared = useContext(GoalContext);
  if (!shared) throw new Error('Goal lists require GoalListsScope.');
  return shared.goals;
}

function GoalListsOwner({ lang, active = true, showSelected = true, onCreated, children }: {
  lang: Language; active?: boolean; showSelected?: boolean; onCreated?(): void; children: ReactNode;
}) {
  const goals = useTodayGoals(lang, active, showSelected);
  const { revision } = useWorkspace();
  const [problem, open] = useState<ProblemRef | null>(null);
  // Multiple controls may represent the same problem. Query their union once after React commits.
  const buttons = useRef(new Map<string, number>());
  const [changed, invalidate] = useState(0);
  const track = useCallback((id: string) => {
    const count = buttons.current.get(id) ?? 0;
    buttons.current.set(id, count + 1);
    if (!count) invalidate(n => n + 1);
    return () => {
      const remaining = buttons.current.get(id)! - 1;
      if (remaining) buttons.current.set(id, remaining);
      else { buttons.current.delete(id); invalidate(n => n + 1); }
    };
  }, []);
  const target = problem?.frontendId;
  const idsKey = useMemo(() => {
    const ids = new Set(buttons.current.keys());
    if (target) ids.add(target);
    return JSON.stringify([...ids].sort());
  }, [changed, target]);
  const [memberships] = useState(createMembershipStore);
  const selectedMembership = useMembership(memberships, target);
  const [lookupError, setLookupError] = useState<unknown>();
  const lookupEpoch = useRef(0);
  useEffect(() => {
    if (!active) return;
    const current = ++lookupEpoch.current;
    const ids: string[] = JSON.parse(idsKey);
    if (!ids.length) return;
    const controller = new AbortController();
    api.getGoalMemberships(ids, { signal: controller.signal }).then(items => {
      if (controller.signal.aborted || current !== lookupEpoch.current) return;
      const result = new Map(ids.map(id => [id, [] as string[]]));
      for (const item of items) result.set(item.frontendId, item.listIds);
      memberships.replace(result);
      setLookupError(undefined);
    }).catch(error => {
      if (!controller.signal.aborted && current === lookupEpoch.current) setLookupError(error);
    });
    return () => controller.abort();
  }, [active, idsKey, revision, goals.generation, memberships]);
  const updateFlags = useCallback((ids: string[], listIds: string[], append: boolean) => {
    lookupEpoch.current++;
    const updated = memberships.copy();
    for (const id of ids) {
      const existing = updated.get(id);
      if (existing) updated.set(id, append ? [...new Set([...existing, ...listIds])] : listIds);
    }
    memberships.replace(updated);
  }, [memberships]);
  const goalControls = useMemo(() => ({ goals, updateFlags }), [goals, updateFlags]);
  const buttonControls = useMemo(() => ({ lang, loaded: goals.loaded, memberships, track, open }),
    [lang, goals.loaded, memberships, track]);
  const zh = lang === 'zh';
  const close = () => open(null);
  return <GoalContext.Provider value={goalControls}><ButtonContext.Provider value={buttonControls}>
    {children}
    {problem && (goals.loaded && selectedMembership ? <ProblemGoalEditor key={problem.frontendId} problem={problem} lang={lang}
      lists={goals.lists} initialIds={selectedMembership} onRefresh={goals.refresh} onClose={close}
      onSaved={(listIds, update, created) => {
        updateFlags([problem.frontendId], listIds, false);
        goals.membershipSaved(listIds, update);
        close();
        if (created) onCreated?.();
      }} /> : <Dialog title={zh ? '选择目标题单' : 'Choose goal lists'} lang={lang} onClose={close}>
        {goals.error || lookupError ? <Feedback retry={{ label: zh ? '重试' : 'Retry', run: goals.refresh }}>{goals.error || localizeApiError(lookupError, lang)}</Feedback>
          : <p role="status">{zh ? '正在读取题单…' : 'Loading goal lists…'}</p>}
      </Dialog>)}
  </ButtonContext.Provider></GoalContext.Provider>;
}

export function ProblemGoalButton({ frontendId, title, fallbackFocusRef, withText = false, onOpen }: ProblemRef & {
  withText?: boolean; onOpen?(): void;
}) {
  const shared = useContext(ButtonContext);
  const visible = useContext(ViewVisible);
  const track = shared?.track;
  useEffect(() => { if (visible) return track?.(frontendId); }, [visible, track, frontendId]);
  const membership = useMembership(shared?.memberships, frontendId);
  if (!shared) return null;
  const zh = shared.lang === 'zh';
  const assigned = Boolean(membership?.length);
  const action = !shared.loaded || !membership ? (zh ? '选择目标题单' : 'Choose goal lists')
    : assigned ? (zh ? '管理目标题单' : 'Manage goal lists') : (zh ? '加入目标题单' : 'Add to goal lists');
  const button = <button type="button" className={(withText ? 'btn btn-secondary' : 'btn-icon') + (assigned ? ' is-goal-member' : '')}
    aria-label={`${action} #${frontendId} ${title}`} aria-haspopup="dialog" onClick={() => {
      onOpen?.();
      shared.open({ frontendId, title, fallbackFocusRef });
    }}>
    <Flag size={withText ? 16 : 18} fill={assigned ? 'currentColor' : 'none'} aria-hidden="true" />
    {withText && action}
  </button>;
  return withText ? button : <Tooltip text={action} position="top">{button}</Tooltip>;
}

function ProblemGoalEditor({ problem, lang, lists, initialIds, onClose, onSaved, onRefresh }: {
  problem: ProblemRef; lang: Language; lists: GoalListSummary[]; initialIds: string[];
  onClose(): void; onSaved(ids: string[], update: Awaited<ReturnType<typeof api.setProblemGoalMembership>>, created: boolean): void; onRefresh(): void;
}) {
  const zh = lang === 'zh';
  // Freeze the selection displayed when the editor opened for the server's concurrency check.
  const [baseline] = useState(initialIds);
  const [choices] = useState(() => lists.map(({ id, name }) => ({ id, name })));
  const [selected, setSelected] = useState(initialIds);
  const [newId] = useState(() => crypto.randomUUID());
  const [creating, setCreating] = useState(lists.length === 0);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef(false);
  const title = zh ? '选择目标题单' : 'Choose goal lists';
  async function save() {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      const newList = creating ? { id: newId, name: name.trim() } : undefined;
      const listIds = newList ? [...selected, newId] : selected;
      const update = await api.setProblemGoalMembership({ frontendId: problem.frontendId, expectedListIds: baseline, listIds, newList });
      onSaved(listIds, update, !!newList);
    } catch (cause) {
      setError(localizeApiError(cause, lang));
      if (cause instanceof ApiError && (cause.status === 409 || cause.status === 404)) onRefresh();
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  const formId = useId();
  const footer = <div className="favorite-form-actions">
    <button type="button" className="btn btn-secondary" disabled={busy} onClick={onClose}>{zh ? '取消' : 'Cancel'}</button>
    <button type="submit" form={formId} className="btn btn-primary" disabled={busy}>{zh ? '保存题单归属' : 'Save goal lists'}</button>
  </div>;
  return <Dialog title={title} lang={lang} onClose={onClose} closeDisabled={busy} fallbackFocusRef={problem.fallbackFocusRef} footer={footer}>
    <p className="favorite-problem-title">#{problem.frontendId} {problem.title}</p>
    <form id={formId} className="favorite-form" aria-label={title} onSubmit={event => { event.preventDefault(); void save(); }}>
      {choices.length > 0 && <GoalListChoices lists={choices} selected={selected} onChange={setSelected} lang={lang} disabled={busy} />}
      {choices.length > 0 && <button type="button" className="text-link" disabled={busy} aria-expanded={creating}
        onClick={() => setCreating(value => !value)}><ListPlus size={16} aria-hidden="true" />
        {creating ? (zh ? '取消新建' : 'Cancel new list') : (zh ? '新建题单' : 'New goal list')}
      </button>}
      {creating && <Field label={zh ? '新题单名称' : 'New goal list name'}>
        <input name="goalName" required maxLength={250} pattern={'.*\\S.*'} value={name} disabled={busy}
          onChange={event => setName(event.currentTarget.value)} />
      </Field>}
      {error && <Feedback>{error}</Feedback>}
    </form>
  </Dialog>;
}

function GoalListChoices({ lists, selected, onChange, lang, disabled }: {
  lists: Pick<GoalList, 'id' | 'name'>[]; selected: string[]; onChange: Dispatch<SetStateAction<string[]>>; lang: Language; disabled: boolean;
}) {
  return <CollectionChoices options={lists} selected={selected} onChange={onChange} lang={lang} disabled={disabled}
    name="goalList" label={lang === 'zh' ? '目标题单（可多选）' : 'Goal lists (select any)'}
    searchLabel={lang === 'zh' ? '搜索题单' : 'Search goal lists'} />;
}

export function AddToGoalListsDialog({ frontendIds, lang, onClose, onCreate, onAdded }: {
  frontendIds: string[]; lang: Language; onClose(): void; onCreate(): void; onAdded(listCount: number, added: number): void;
}) {
  const zh = lang === 'zh';
  const { goals, updateFlags } = useContext(GoalContext)!;
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const checked = new Set(selected);
  const listIds = goals.lists.filter(list => checked.has(list.id)).map(list => list.id);
  const title = zh ? '加入目标题单' : 'Add to goal lists';
  async function add() {
    if (pending.current || !listIds.length) return;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      const result = await api.addProblemsToGoalLists({ frontendIds, listIds });
      updateFlags(frontendIds, listIds, true);
      goals.refresh();
      onAdded(listIds.length, result.added);
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === 'GOAL_LIST_NOT_FOUND') {
        setError(zh ? '所选题单中有题单已被删除。请检查剩余选择后重试。'
          : 'A selected goal list was deleted. Review the remaining selection and try again.');
        goals.refresh();
      } else {
        setError(localizeApiError(cause, lang));
      }
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  const empty = goals.loaded && !goals.lists.length;
  const formId = useId();
  const footer = <div className="favorite-form-actions">
    <button type="button" className="btn btn-secondary" disabled={busy} onClick={onClose}>{zh ? '取消' : 'Cancel'}</button>
    {empty ? <button type="button" className="btn btn-primary" onClick={onCreate}>{zh ? '创建题单' : 'Create goal list'}</button>
      : <button type="submit" form={formId} className="btn btn-primary" disabled={busy || !listIds.length}>
          {zh ? '加入所选题单' : 'Add to selected lists'}
        </button>}
  </div>;
  return <Dialog title={title} lang={lang} onClose={onClose} closeDisabled={busy} footer={footer}>
    {goals.error && <Feedback retry={{ label: zh ? '重试' : 'Retry', run: goals.refresh }}>{goals.error}</Feedback>}
    <form id={formId} className="favorite-form" aria-label={title} onSubmit={event => { event.preventDefault(); void add(); }}>
      {!goals.loaded && !goals.error && <p role="status">{zh ? '正在读取题单…' : 'Loading goal lists…'}</p>}
      {empty && <p>{zh ? '还没有目标题单。可以用已选题目创建第一份题单。' : 'Create your first goal list with the selected problems.'}</p>}
      {goals.lists.length > 0 && <>
        <p>{zh ? `已选 ${formatCount(frontendIds.length, lang)} 道题。每个题单中缺少的题目会按题号追加到末尾。`
          : `${formatCount(frontendIds.length, lang)} ${frontendIds.length === 1 ? 'problem' : 'problems'} selected. Missing problems will be appended to each list in problem ID order.`}</p>
        <GoalListChoices lists={goals.lists} selected={listIds} lang={lang} disabled={busy}
          onChange={ids => { setSelected(ids); setError(''); }} />
      </>}
      {error && <Feedback>{error}</Feedback>}
    </form>
  </Dialog>;
}
