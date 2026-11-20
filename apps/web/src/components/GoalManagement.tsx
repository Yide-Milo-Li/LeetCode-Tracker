import { useId, useState } from 'react';
import type { GoalLifecycle, StudyPlanView } from '../../../../packages/contracts/src/study-plan.ts';
import { api } from '../api.ts';
import type { Language } from '../i18n.ts';
import { useWorkspace } from '../workspace.tsx';
import { localizeApiError } from '../error-i18n.ts';
import { Dialog } from './ui.tsx';

type Action = GoalLifecycle['action'] | 'rename';
export function GoalManagement({ goal, lang }: { goal: StudyPlanView; lang: Language }) {
  const zh = lang === 'zh';
  const workspace = useWorkspace();
  const id = useId();
  const [action, setAction] = useState<Action | null>(null);
  const [original, setOriginal] = useState(goal);
  const [name, setName] = useState('');
  const [deadline, setDeadline] = useState('');
  const [operation, setOperation] = useState('');
  const [preview, setPreview] = useState<StudyPlanView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const labels = zh
    ? {
        pause: '暂停目标',
        resume: '继续目标',
        archive: '归档目标',
        restore: '恢复归档目标',
        delete: '删除误建目标',
        rename: '修改目标名称',
      }
    : {
        pause: 'Pause goal',
        resume: 'Resume goal',
        archive: 'Archive goal',
        restore: 'Restore archived goal',
        delete: 'Delete unused goal',
        rename: 'Rename goal',
      };
  const actions: Action[] =
    goal.status === 'archived'
      ? ['restore', 'rename', 'delete']
      : goal.status === 'paused'
        ? ['resume', 'rename', 'archive', 'delete']
        : ['pause', 'rename', 'archive', 'delete'];
  const resuming = action === 'resume' || action === 'restore';
  function open(next: Action) {
    setOriginal(goal);
    setAction(next);
    setName(goal.name);
    setDeadline(goal.deadline ?? '');
    setError('');
    setPreview(null);
    setOperation(crypto.randomUUID());
  }
  async function submit(dryRun: boolean) {
    if (!action || busy) return;
    setBusy(true);
    setError('');
    try {
      const base = { id: original.id, expectedVersion: original.version, operationId: operation, dryRun };
      if (action === 'rename') await api.updateStudyPlan({ ...base, changes: { name: name.trim() } });
      else {
        const result = await api.goalLifecycle({
          ...base,
          action,
          ...(resuming && { deadline: deadline || null }),
        });
        if (dryRun) {
          setPreview(result.plan);
          return;
        }
      }
      setAction(null);
      workspace.notifyMutation();
    } catch (err) {
      setError(localizeApiError(err, lang));
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="study-goal-options">
      <summary>{zh ? '管理目标' : 'Manage goal'}</summary>
      <div className="action-row">
        {actions
          .filter((key) => key !== 'delete' || !goal.hasPractice)
          .map((key) => (
            <button key={key} type="button" className="btn btn-secondary btn-sm" onClick={() => open(key)}>
              {labels[key]}
            </button>
          ))}
      </div>
      {action && (
        <Dialog
          lang={lang}
          title={labels[action] + ' · ' + original.name}
          onClose={() => setAction(null)}
          closeDisabled={busy}
        >
          <form
            className="study-goal-preferences"
            onSubmit={(e) => {
              e.preventDefault();
              void submit(resuming && !preview);
            }}
          >
            {action === 'rename' && (
              <>
                <label htmlFor={id + '-name'}>{zh ? '目标名称' : 'Goal name'}</label>
                <input
                  id={id + '-name'}
                  className="form-input"
                  required
                  maxLength={250}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </>
            )}
            {resuming && (
              <>
                <label htmlFor={id + '-deadline'}>
                  {zh ? '恢复后的截止日（留空按日常题量）' : 'New deadline (leave empty for daily pacing)'}
                </label>
                <input
                  id={id + '-deadline'}
                  type="date"
                  className="form-input"
                  disabled={busy}
                  value={deadline}
                  onChange={(e) => {
                    setDeadline(e.target.value);
                    setPreview(null);
                    setOperation(crypto.randomUUID());
                  }}
                />
              </>
            )}
            {action === 'delete' && (
              <p>
                {zh
                  ? '删除后无法恢复。已有练习历史的目标可选择归档。'
                  : 'Deletion is permanent. Goals with practice history can be archived.'}
              </p>
            )}
            {(action === 'archive' || action === 'pause') && (
              <p>
                {zh
                  ? '停止生成后续题单，保留进度和已生成的每日题单。'
                  : 'Future generation stops. Progress and saved daily assignments are kept.'}
              </p>
            )}
            {preview && (
              <p role="status">
                {zh ? '已完成' : 'Completed'} {preview.completedCore}/{preview.totalCore} ·{' '}
                {zh ? '预计完成' : 'Estimated finish'} {preview.estimatedFinish ?? '—'} ·{' '}
                {zh ? '截止缺口' : 'Deadline shortfall'} {preview.deadlineShortfall ?? 0}
              </p>
            )}
            {error && <p role="alert">{error}</p>}
            <div className="action-row">
              <button className="btn btn-secondary" type="button" disabled={busy} onClick={() => setAction(null)}>
                {zh ? '取消' : 'Cancel'}
              </button>
              <button
                className={action === 'delete' ? 'btn btn-danger' : 'btn btn-primary'}
                disabled={busy || (action === 'rename' && !name.trim())}
              >
                {resuming && !preview
                  ? zh
                    ? '预览恢复安排'
                    : 'Preview resumed schedule'
                  : zh
                    ? '确认'
                    : 'Confirm'}
              </button>
            </div>
          </form>
        </Dialog>
      )}
    </details>
  );
}
