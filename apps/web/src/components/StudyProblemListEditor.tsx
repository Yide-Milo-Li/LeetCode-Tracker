import { useId, useLayoutEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Trash2 } from 'lucide-react';
import type { StudyPlanView } from '../../../../packages/contracts/src/study-plan.ts';
import type { Language } from '../i18n.ts';

export function parseGoalIds(text: string): string[] {
  return text.split(/[,，、\r\n]+/u).map(id => id.trim().replace(/^#\s*/, '')).filter(Boolean);
}

/** Both views edit the same draft. Pasting a long list takes effect even if saved directly from the textarea. */
export function StudyProblemListEditor({ goal, texts, onChange, lang }: {
  goal: StudyPlanView; texts: string[]; onChange: (next: string[]) => void; lang: Language;
}) {
  const zh = lang === 'zh';
  const id = useId();
  const [stage, setStage] = useState(0);
  const [open, setOpen] = useState(false);
  const [bulk, setBulk] = useState(false);
  const [announcement, announce] = useState('');
  const list = useRef<HTMLOListElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const focusAfter = useRef<{ problem?: string; action: string } | null>(null);
  const groups = texts.map(parseGoalIds);
  const ids = groups[stage];
  const byId = new Map(goal.nodes.map(node => [node.frontendId, node]));
  const total = groups.reduce((sum, group) => sum + group.length, 0);
  const duplicate = new Set(ids).size !== ids.length;
  const showText = bulk || duplicate;

  useLayoutEffect(() => {
    const wanted = focusAfter.current;
    if (!wanted) return;
    focusAfter.current = null;
    const row = Array.from(list.current?.children ?? []).find(el => (el as HTMLElement).dataset.problem === wanted.problem);
    const button = row?.querySelector<HTMLButtonElement>(`button[data-action="${wanted.action}"]:enabled`)
      ?? row?.querySelector<HTMLButtonElement>('button:enabled') ?? toggle.current;
    button?.focus();
  }, [texts, stage]);

  function move(index: number, step: -1 | 1) {
    const problem = ids[index];
    const position = index + step;
    const crossStage = position < 0 || position >= ids.length;
    const destination = crossStage ? stage + step : stage;
    const next = groups.map(group => [...group]);
    next[stage].splice(index, 1);
    const insertAt = crossStage ? (step < 0 ? next[destination].length : 0) : position;
    next[destination].splice(insertAt, 0, problem);
    focusAfter.current = { problem, action: step < 0 ? 'up' : 'down' };
    setStage(destination);
    onChange(next.map(group => group.join('\n')));
    announce(zh ? `#${problem} 已移至「${goal.stages[destination]}」第 ${insertAt + 1} 位。`
      : `#${problem} is now number ${insertAt + 1} in ${goal.stages[destination]}.`);
  }

  function remove(index: number) {
    focusAfter.current = { problem: ids[index + 1] ?? ids[index - 1], action: 'remove' };
    onChange(texts.map((text, i) => i === stage ? ids.filter((_, j) => j !== index).join('\n') : text));
    announce(zh ? `已从题单移除 #${ids[index]}。` : `Removed #${ids[index]} from the list.`);
  }

  return <details className="study-goal-options" onToggle={e => setOpen(e.currentTarget.open)}>
    <summary>{zh ? `编辑题目清单（${total} 道）` : `Edit problem list (${total})`}</summary>
    {open && <div className="study-goal-preferences">
      {texts.length > 1 && <label className="form-group">
        <span className="form-label">{zh ? '学习阶段' : 'Stage'}</span>
        <select className="form-input" value={stage} onChange={e => setStage(Number(e.target.value))}>
          {goal.stages.map((name, i) => <option key={i} value={i}>{name}</option>)}
        </select>
      </label>}
      <div><button type="button" className="btn btn-secondary" ref={toggle}
        onClick={() => setBulk(!showText)} disabled={duplicate}>
        {showText ? (zh ? '返回题目列表' : 'Show list') : (zh ? '添加或批量编辑题号' : 'Add or edit problem IDs')}
      </button></div>
      {showText ? <div className="form-group">
        <label className="form-label" htmlFor={id}>{zh ? '本阶段题号（按练习顺序）' : 'Stage problem IDs in practice order'}</label>
        <textarea className="form-textarea" id={id} value={texts[stage]} rows={6} spellCheck={false}
          aria-describedby={id + '-help'} onChange={e => onChange(texts.map((s, i) => i === stage ? e.target.value : s))} />
        <small className="text-muted" id={id + '-help'}>{duplicate
          ? (zh ? '此阶段有重复题号，每道题只能出现一次。' : 'There are duplicate IDs in this stage. Keep one copy of each.')
          : (zh ? '用逗号或换行分隔本地题号。可插入、删除或剪切换序，整份题单最多 150 道。'
            : 'Separate catalog IDs with commas or newlines. Insert, remove or rearrange them here, up to 150 per goal.')}</small>
      </div> : <ol ref={list} className="study-edit-list">
        {ids.map((problem, i) => {
          const node = byId.get(problem);
          const actions = [
            { action: 'up', icon: ArrowUp, label: zh ? `上移 #${problem}` : `Move #${problem} up`, disabled: i === 0 && stage === 0, run: () => move(i, -1) },
            { action: 'down', icon: ArrowDown, label: zh ? `下移 #${problem}` : `Move #${problem} down`, disabled: i === ids.length - 1 && stage === texts.length - 1, run: () => move(i, 1) },
            { action: 'remove', icon: Trash2, label: zh ? `移除 #${problem}` : `Remove #${problem}`, disabled: false, run: () => remove(i) },
          ];
          return <li key={problem} data-problem={problem}>
            <div className="study-edit-line">
              <span>#{problem} {node?.title}{node?.completed && <small> · {zh ? '已完成' : 'Completed'}</small>}
                {node?.optional && <small> · {zh ? '选做' : 'Optional'}</small>}</span>
              <div className="study-edit-actions">{actions.map(({ action, label, icon: Icon, disabled, run }) =>
                <button type="button" className="btn-icon" key={action} data-action={action} title={label} aria-label={label}
                  disabled={disabled} onClick={run}><Icon size={16} aria-hidden="true" /></button>)}</div>
            </div>
          </li>;
        })}
      </ol>}
      <small className="text-muted">{zh ? '移除题目会更新目标进度。练习记录和已生成的每日题单都会保留。'
        : 'Removing a problem updates goal progress and keeps its practice history and saved daily assignments.'}</small>
      <span role="status" className="visually-hidden">{announcement}</span>
    </div>}
  </details>;
}
