import { GoalManagement } from './GoalManagement.tsx';
import { useEffect, useState } from 'react';
import type { StudyDay, StudyPlanView } from '../../../../packages/contracts/src/study-plan.ts';
import { useWorkspace } from '../workspace.tsx';
import { StudyGoalEditor } from './StudyGoalEditor.tsx';
import { api } from '../api.ts';
import type { Language } from '../i18n.ts';
import { localizeApiError } from '../error-i18n.ts';

export function useStudyPlan(refreshKey: string, lang: Language, id?: string, fallbackToLibrary = false) {
  const [view, setView] = useState<StudyPlanView | null>(null);
  const [error, setError] = useState('');
  const [goals, setGoals] = useState<{ id: string; name: string }[]>([]);
  const [archived, setArchived] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    let active = true;
    api
      .getStudyPlan(id)
      .then(async ({ plan, goals, archived }) => {
        if (active && fallbackToLibrary && !plan && id && goals?.[0]) plan = (await api.getStudyPlan(goals[0].id)).plan;
        if (active) {
          setView(plan ?? null);
          setArchived(archived ?? []);
          setGoals(goals ?? (plan ? [{ id: plan.id, name: plan.name }] : []));
          setError('');
        }
      })
      .catch((err) => {
        if (active) {
          setView(null);
          setError(localizeApiError(err, lang));
        }
      });
    return () => {
      active = false;
    };
  }, [refreshKey, lang, id, fallbackToLibrary]);
  return { view, goals, archived, error };
}

function Calendar({ days, zh }: { days: StudyDay[]; zh: boolean }) {
  return (
    <ol className="study-calendar">
      {days.map((day) => (
        <li key={day.date}>
          <time dateTime={day.date}>{day.date}</time>
          <span>
            {day.items
              .map((item) => {
                if (item.kind === 'new') return '#' + item.frontendId;
                const label = item.estimated ? (zh ? '预计复习' : 'projected review') : zh ? '复习' : 'review';
                return label + ' #' + item.frontendId;
              })
              .join(' · ') || (zh ? '当日无排题' : 'No scheduled problems')}
          </span>
        </li>
      ))}
    </ol>
  );
}

export function StudyPlanPanel({ view, lang }: { view: StudyPlanView; lang: Language }) {
  const zh = lang === 'zh';
  const workspace = useWorkspace();
  const [editing, setEditing] = useState<StudyPlanView | null>(null);
  const status = {
    upcoming: zh ? '尚未开始' : 'Upcoming',
    active: zh ? '进行中' : 'In progress',
    expired: zh ? '已到截止日' : 'Deadline passed',
    completed: zh ? '已完成' : 'Completed',
    paused: zh ? '已暂停' : 'Paused',
    archived: zh ? '已归档' : 'Archived',
  }[view.status];
  const byId = new Map(view.nodes.map((n) => [n.questionId, n.frontendId]));
  return (
    <section className="study-route" aria-label={zh ? '目标计划' : 'Study plan'}>
      <div className="u-display-flex u-justify-content-space-between u-gap-0-5rem">
        <h3>{view.name}</h3>
        {view.status !== 'archived' && view.status !== 'paused' &&
          <button type="button" className="btn btn-secondary" onClick={() => setEditing(view)}>
            {zh ? '调整安排' : 'Edit schedule'}
          </button>}
      </div>
      <GoalManagement key={view.id} goal={view} lang={lang} />
      {editing && <StudyGoalEditor lang={lang} timezone={workspace.timezone} editing={editing}
        onClose={() => setEditing(null)} onSaved={() => { setEditing(null); workspace.notifyMutation(); }} />}
      {view.goal && <p>{view.goal}</p>}
      <p>
        {status} · {zh ? '核心题' : 'Core problems'} {view.completedCore}/{view.totalCore}
        {view.estimatedFinish && (
          <>
            {' '}
            ·{' '}
            {zh
              ? view.status === 'completed'
                ? '完成于'
                : '预计完成'
              : view.status === 'completed'
                ? 'Finished'
                : 'Estimated finish'}{' '}
            <time>{view.estimatedFinish}</time>
          </>
        )}
        {view.deadline && (
          <>
            {' '}
            · {zh ? '截止' : 'Deadline'} <time>{view.deadline}</time>
          </>
        )}
      </p>
      {view.notices.map((n) => (
        <p key={n.en}>{n[lang]}</p>
      ))}
      <details>
        <summary>{zh ? '学习路线' : 'Learning route'}</summary>
        {view.stages.map((stage, i) => (
          <section key={i}>
            <h4>{stage}</h4>
            <ol>
              {view.nodes
                .filter((n) => n.stage === i)
                .map((n) => (
                  <li key={n.questionId}>
                    <strong>
                      #{n.frontendId} {n.title}
                    </strong>{' '}
                    · {n.optional ? (zh ? '选做' : 'Optional') : zh ? '核心' : 'Core'}
                    <div>{n.purpose}</div>
                    {n.requires.length > 0 && (
                      <div>
                        {zh ? '前置题' : 'Requires'} {n.requires.map((id) => '#' + byId.get(id)).join(', ')}
                      </div>
                    )}
                    <div>
                      {n.completed
                        ? (zh ? '已完成 ' : 'Completed ') + (n.completedDate ?? '')
                        : (zh ? '预计 ' : 'Scheduled ') + (n.scheduledDate ?? (zh ? '待安排' : 'unscheduled'))}
                      {n.originalDate && n.originalDate !== (n.completed ? n.completedDate : n.scheduledDate) && (
                        <>
                          {' '}
                          · {zh ? '原定' : 'Originally'} {n.originalDate}
                        </>
                      )}
                    </div>
                  </li>
                ))}
            </ol>
          </section>
        ))}
      </details>
      {view.calendar.length > 0 && (
        <details>
          <summary>{zh ? '当前日历' : 'Current calendar'}</summary>
          <Calendar days={view.calendar} zh={zh} />
        </details>
      )}
      <details>
        <summary>{zh ? '初始日历' : 'Original calendar'}</summary>
        <Calendar days={view.initialCalendar} zh={zh} />
      </details>
    </section>
  );
}
