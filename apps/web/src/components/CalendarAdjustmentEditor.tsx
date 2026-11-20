import { useEffect, useId, useState } from 'react';
import { api, type Strategy } from '../api.ts';
import type { Language } from '../i18n.ts';
import { localizeApiError } from '../error-i18n.ts';
import {
  dateRuleFor,
  type CalendarDateView,
  type CalendarWeek,
  type DateWindow,
  type WeeklyDateRule,
} from '../../../../packages/contracts/src/calendar.ts';
import type { StudyPlanView } from '../../../../packages/contracts/src/study-plan.ts';
import { Dialog } from './ui.tsx';

export function windowLabel(rule: DateWindow, lang: Language) {
  if (rule.scope === 'range') return rule.startDate + ' – ' + rule.endDate;
  if (rule.scope === 'weekly') return (lang === 'zh' ? '每周 · 起始 ' : 'Weekly from ') + rule.startDate;
  return rule.startDate;
}

export function CalendarAdjustmentEditor({
  day,
  week,
  strategies,
  lang,
  onClose,
  onSaved,
}: {
  day: CalendarDateView;
  week: CalendarWeek;
  strategies: Strategy[];
  lang: Language;
  onClose(): void;
  onSaved(): void;
}) {
  const zh = lang === 'zh';
  const id = useId();
  const weekly = day.sources.find((source) => source.kind !== 'goal');
  const firstGoal = week.goals.find((goal) =>
    day.sources.some((source) => source.kind === 'goal' && source.id === goal.id)
  );
  const [source, setSource] = useState(!weekly && firstGoal ? firstGoal.id : 'weekly');
  const [scope, setScope] = useState<DateWindow['scope']>('day');
  const [end, setEnd] = useState(day.date);
  const [strategyId, setStrategyId] = useState(weekly?.id ?? '');
  const [count, setCount] = useState('1');
  const [goal, setGoal] = useState<StudyPlanView | null>(null);
  const [preview, setPreview] = useState<StudyPlanView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [operationId, setOperationId] = useState(() => crypto.randomUUID());
  const isWeekly = source === 'weekly';
  useEffect(() => {
    let active = true;
    setGoal(null);
    if (!isWeekly)
      api
        .getStudyPlan(source)
        .then((result) => {
          if (active && result.plan) {
            setGoal(result.plan);
            const rule = dateRuleFor(result.plan.dateAdjustments, day.date);
            setCount(
              String(rule?.count ?? day.sources.find((s) => s.id === source)?.count ?? result.plan.baseDailyCount)
            );
          }
        })
        .catch((err) => {
          if (active) setError(localizeApiError(err, lang));
        });
    return () => {
      active = false;
    };
  }, [source, isWeekly, day, lang]);
  function changed() {
    setPreview(null);
    setError('');
    setOperationId(crypto.randomUUID());
  }
  const rules = isWeekly ? week.weeklyRules : (goal?.dateAdjustments ?? []);
  const sameWindow = (rule: DateWindow) =>
    rule.startDate === day.date && rule.scope === scope && (scope !== 'range' || rule.endDate === end);
  const existing = rules.findLast(sameWindow);
  const dateWindow = { scope, startDate: day.date, ...(scope === 'range' && { endDate: end }) };
  const frozen = day.sources.some((s) => s.state === 'saved' && (isWeekly ? s.kind !== 'goal' : s.id === source));
  const number = Number(count);
  const max = !goal?.deadline && goal?.settings.adaptivePace === false ? 30 : (goal?.settings.maxDailyCount ?? 30);
  const valid =
    (scope !== 'range' || end >= day.date) &&
    (isWeekly || (!!goal && count !== '' && Number.isInteger(number) && number >= 0 && number <= max));
  async function submit(dryRun: boolean, remove?: string) {
    if (busy || (!valid && !remove)) return;
    setBusy(true);
    setError('');
    try {
      if (isWeekly) {
        const rule: WeeklyDateRule = {
          ...dateWindow,
          id: existing?.id ?? operationId,
          strategyId: strategyId || null,
        };
        await api.adjustWeeklyCalendar({
          expectedRevision: week.revision,
          change: remove ? { action: 'remove', id: remove } : { action: 'set', rule },
        });
      } else if (goal) {
        const retained = (goal.dateAdjustments ?? []).filter((rule) => rule.id !== (remove ?? existing?.id));
        const dates = remove
          ? retained
          : [...retained, { ...dateWindow, id: existing?.id ?? operationId, count: number }];
        const result = await api.updateStudyPlan({
          id: goal.id,
          expectedVersion: goal.version,
          changes: { dateAdjustments: dates },
          operationId: remove ? crypto.randomUUID() : operationId,
          dryRun,
        });
        if (dryRun) {
          setPreview(result.plan);
          return;
        }
      }
      onSaved();
    } catch (err) {
      setError(localizeApiError(err, lang));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      lang={lang}
      title={(zh ? '调整安排 · ' : 'Adjust schedule · ') + day.date}
      onClose={onClose}
      closeDisabled={busy}
    >
      <form
        className="study-goal-preferences"
        onSubmit={(e) => {
          e.preventDefault();
          void submit(false);
        }}
        onChange={changed}
      >
        <fieldset disabled={busy} className="study-goal-fields">
          <legend className="visually-hidden">{zh ? '日期调整' : 'Date adjustment'}</legend>
          <label htmlFor={id + '-source'}>{zh ? '调整对象' : 'Schedule to adjust'}</label>
          <select
            id={id + '-source'}
            className="form-input"
            value={source}
            onChange={(e) => setSource(e.target.value)}
          >
            <option value="weekly">{zh ? '周策略' : 'Weekly strategy'}</option>
            {week.goals.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
          <label htmlFor={id + '-scope'}>{zh ? '生效范围' : 'Applies to'}</label>
          <select
            id={id + '-scope'}
            className="form-input"
            value={scope}
            onChange={(e) => setScope(e.target.value as DateWindow['scope'])}
          >
            <option value="day">{zh ? '仅这一天' : 'This date only'}</option>
            <option value="range">{zh ? '指定日期范围' : 'Date range'}</option>
            <option value="weekly">{zh ? '从这天起，每周同一天' : 'This weekday from now on'}</option>
          </select>
          {scope === 'range' && (
            <label>
              {zh ? '结束日期（含）' : 'Through date (inclusive)'}
              <input
                className="form-input"
                type="date"
                min={day.date}
                required
                value={end}
                onChange={(e) => setEnd(e.target.value)}
              />
            </label>
          )}
          {isWeekly ? (
            <label>
              {zh ? '使用策略' : 'Use strategy'}
              <select className="form-input" value={strategyId} onChange={(e) => setStrategyId(e.target.value)}>
                <option value="">{zh ? '不安排周策略' : 'No weekly strategy'}</option>
                {strategies.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <label>
              {goal?.deadline
                ? zh
                  ? '当天题量上限（0 为跳过）'
                  : 'Daily limit (0 to skip)'
                : zh
                  ? '当天题量（0 为跳过）'
                  : 'Daily count (0 to skip)'}
              <input
                type="number"
                className="form-input"
                min={0}
                max={max}
                step={1}
                required
                value={count}
                onChange={(e) => setCount(e.target.value)}
              />
            </label>
          )}
          <p className="text-muted">
            {isWeekly
              ? zh
                ? '保存后，所选策略会接管范围内的未生成日期。'
                : 'The selected strategy takes over unsaved dates in this period.'
              : zh
                ? '范围调整只作用于学习日。临时调整不计入自适应题量。'
                : 'Ranges apply to study days. Temporary adjustments do not train your pace.'}
          </p>
          {rules.length > 0 && <small className="text-muted">{zh
            ? '单日和范围调整优先于每周安排。临时范围重叠时采用最后保存的调整。'
            : 'Dated exceptions take priority over weekly assignments. The last saved exception wins on overlapping dates.'}</small>}
          {frozen && (
            <p role="status">
              {zh
                ? '本日题单已经生成，可在今日页调整。此处的更改适用于尚未生成的日期。'
                : 'This list is already saved. Use Today to edit it. Schedule changes apply to unsaved dates.'}
            </p>
          )}
          {error && <p role="alert">{error}</p>}
          {preview && (
            <p role="status">
              {zh ? '预计完成' : 'Estimated finish'} {goal?.estimatedFinish ?? '—'} →{' '}
              {preview.estimatedFinish ?? '—'}{preview.deadline && <> · {zh ? '截止缺口' : 'Deadline shortfall'}{' '}
              {preview.deadlineShortfall ?? 0} ({zh ? '原为' : 'previously'} {goal?.deadlineShortfall ?? 0})</>}
            </p>
          )}
          <div className="action-row">
            {!isWeekly && (
              <button
                type="button"
                className="btn btn-secondary"
                disabled={!valid}
                onClick={() => void submit(true)}
              >
                {zh ? '预览重排' : 'Preview reschedule'}
              </button>
            )}
            <button className="btn btn-primary" disabled={!valid || (frozen && scope === 'day')}>
              {zh ? '保存调整' : 'Save adjustment'}
            </button>
          </div>
        </fieldset>
      </form>
      {rules.length > 0 && (
        <details>
          <summary>{zh ? '已设置的日期调整' : 'Scheduled adjustments'}</summary>
          <ul>
            {rules.map((rule) => (
              <li key={rule.id}>
                {windowLabel(rule, lang)} ·{' '}
                {'count' in rule
                  ? rule.count
                  : (strategies.find((item) => item.id === rule.strategyId)?.name ??
                    (zh ? '无周策略' : 'No weekly strategy'))}{' '}
                <button
                  type="button"
                  className="text-link"
                  disabled={busy}
                  onClick={() => void submit(false, rule.id)}
                >
                  {zh ? '撤销调整' : 'Remove adjustment'}
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </Dialog>
  );
}
