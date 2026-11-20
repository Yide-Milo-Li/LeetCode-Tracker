import React, { useId, useRef, useState } from 'react';
import { ChevronDown, Target } from 'lucide-react';
import type { DailyPlan } from '../api.ts';
import type { Language } from '../i18n.ts';
import { Dialog } from './ui.tsx';

type GoalDay = DailyPlan & { studyPlan: NonNullable<DailyPlan['studyPlan']> };

export function TodayGoalList({ goals, lang, renderSource }: {
  goals: GoalDay[];
  lang: Language;
  renderSource: (plan: DailyPlan) => React.ReactNode;
}) {
  const zh = lang === 'zh';
  const [selected, setSelected] = useState<string | null>();
  const [picking, setPicking] = useState(false);
  const [search, setSearch] = useState('');
  const id = useId();
  const searchField = useRef<HTMLInputElement>(null);
  const active = goals.length === 1 ? goals[0] : selected === null ? undefined :
    goals.find(goal => goal.id === selected) ?? goals[0];
  const visible = goals.slice(0, 3);
  if (active && !visible.includes(active)) visible[2] = active;
  const progress = (goal: DailyPlan) => `${goal.items.filter(item => item.completed).length}/${goal.items.length}`;
  const matches = goals.filter(goal => goal.studyPlan.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  return (
    <section className="today-source-section" aria-labelledby="today-goals">
      <div className="today-source-heading">
        <h2 id="today-goals" tabIndex={-1}><Target size={17} />{zh ? '学习目标' : 'Study goals'}</h2>
        {goals.length > 3 && <button type="button" className="text-link" onClick={() => { setSearch(''); setPicking(true); }}>
          {zh ? `全部 ${goals.length} 个目标` : `All ${goals.length} goals`}
        </button>}
      </div>
      {visible.map(goal => {
        const open = active?.id === goal.id;
        const bodyId = id + goal.id;
        const content = <><strong>{goal.studyPlan.name}</strong><span>{zh ? '今日' : 'Today'} {progress(goal)}</span></>;
        return <div className="today-goal" key={goal.id}>
          {goals.length === 1 ? <div className="today-source-title">{content}</div> :
            <button type="button" className="today-source-title today-source-toggle" id={bodyId + '-toggle'}
              aria-expanded={open} aria-controls={bodyId} onClick={() => setSelected(open ? null : goal.id)}>
              <ChevronDown aria-hidden="true" size={16} />{content}
            </button>}
          <div id={bodyId} hidden={!open}>
            {open && (goal.studyPlan.stage || goal.studyPlan.deadline) && <p className="source-context">
              {[goal.studyPlan.stage, goal.studyPlan.deadline && (zh ? '截止 ' : 'Due ') + goal.studyPlan.deadline].filter(Boolean).join(' · ')}
            </p>}
            {open && renderSource(goal)}
          </div>
        </div>;
      })}
      {picking && <Dialog lang={lang} initialFocusRef={searchField} title={zh ? '今日学习目标' : 'Today’s study goals'} onClose={() => setPicking(false)}>
        <input className="form-input" ref={searchField} type="search" aria-label={zh ? '搜索目标' : 'Search goals'}
          placeholder={zh ? '搜索目标名称' : 'Search by name'} value={search} onChange={e => setSearch(e.target.value)} />
        <div className="today-goal-results">
          {matches.map(goal => <button className="today-source-title today-source-toggle" key={goal.id} onClick={() => {
            setSelected(goal.id); setPicking(false);
            window.requestAnimationFrame(() => document.getElementById(id + goal.id + '-toggle')?.focus());
          }}><strong>{goal.studyPlan.name}</strong><span>{progress(goal)}</span></button>)}
          {matches.length === 0 && <p className="text-muted">{zh ? '没有匹配的目标' : 'No matching goals'}</p>}
        </div>
      </Dialog>}
    </section>
  );
}
