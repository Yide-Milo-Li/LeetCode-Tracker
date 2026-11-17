import { useWorkspaceEnvironment } from '../context.tsx';
/**
 * Practice record editor form supporting manual logging, problem search, and details enrichment.
 */
import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown, Square } from 'lucide-react';
import { type CatalogProblem, type PracticeRecord, type TimePrecision } from '../api.ts';
import { formatDifficulty, translations, type Language } from '../i18n.ts';
import { localizeApiError } from '../error-i18n.ts';
import { useWorkspace, type PracticeDraft } from '../workspace.tsx';
import { fromZonedInput, zonedInput } from '../practice-service.ts';
import { formatElapsed, getElapsedSeconds } from '../timer-service.ts';
import { usePracticeTimer } from '../hooks/usePracticeTimer.ts';
import { Feedback, Field, DialogClosingContext } from './ui.tsx';
import { createDraftSession } from '../draft-session.ts';
import { OperationStateError, operationMessage } from '../client.ts';
import { catalogProblemSchema } from '../../../contracts/src/sync.ts';
import { z } from 'zod';

/**
 * Validate and extract optional duration in minutes.
 * Unknown duration is null; only positive safe integers are persistable.
 */
export function durationValue(value: string, lang: Language = 'en'): number | null {
  if (!value.trim()) return null;
  const minutes = Number(value);
  if (!Number.isSafeInteger(minutes) || minutes <= 0)
    throw new Error(lang === 'zh' ? '耗时须为正整数' : 'Duration must be a positive whole number');
  return minutes;
}

export interface PracticeDetailsFieldsProps {
  lang: Language;
  duration: string;
  notes: string;
  completed?: boolean;
  outcome?: 'independent' | 'assisted' | 'unsolved' | null;
  setDuration: (s: string) => void;
  setNotes: (s: string) => void;
  setOutcome?: (o: 'independent' | 'assisted' | 'unsolved' | null) => void;
}

/**
 * The optional completion details contain duration, notes, and practice outcome feedback.
 */
export function PracticeDetailsFields({
  lang,
  duration,
  notes,
  completed = true,
  outcome = null,
  setDuration,
  setNotes,
  setOutcome,
}: PracticeDetailsFieldsProps) {
  return (
    <>
      {setOutcome && (
        <Field label={lang === 'zh' ? '练习反馈（可选）' : 'Practice feedback (optional)'}>
          <select
            value={outcome ?? ''}
            onChange={(e) => setOutcome(e.target.value ? (e.target.value as any) : null)}
            aria-label={lang === 'zh' ? '练习反馈' : 'Practice feedback'}
          >
            <option value="">{lang === 'zh' ? '未记录' : 'Not recorded'}</option>
            {completed ? (
              <>
                <option value="independent">
                  {lang === 'zh' ? '独立完成' : 'Solved independently'}
                </option>
                <option value="assisted">
                  {lang === 'zh' ? '借助提示或题解完成' : 'Solved with assistance / hints'}
                </option>
              </>
            ) : (
              <option value="unsolved">
                {lang === 'zh' ? '尝试后未解决' : 'Attempted, unsolved'}
              </option>
            )}
          </select>
        </Field>
      )}
      <Field label={lang === 'zh' ? '耗时（分钟，可选）' : 'Duration (minutes, optional)'}>
        <input
          type="number"
          min="1"
          step="1"
          value={duration}
          onChange={(e) => setDuration(e.target.value)}
          placeholder={lang === 'zh' ? '未记录' : 'Not recorded'}
        />
      </Field>
      <Field label={lang === 'zh' ? '备注（可选）' : 'Notes (optional)'}>
        <textarea
          rows={4}
          maxLength={2000}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
      </Field>
    </>
  );
}

export interface PracticeEditorProps {
  lang: Language;
  problem?: CatalogProblem;
  record?: PracticeRecord;
  detailsOnly?: boolean;
  draft?: PracticeDraft;
  /** Whole minutes captured by the practice timer; used only when no duration exists yet. */
  initialDurationMinutes?: number | null;
  onSaved: (record: PracticeRecord) => void;
  onCancel: () => void;
}

/**
 * Create with a durable operation identity, or patch the selected revision without overwriting newer edits.
 */
export function PracticeEditor({
  lang,
  problem,
  record,
  detailsOnly = false,
  draft,
  initialDurationMinutes,
  onSaved,
  onCancel,
}: PracticeEditorProps) {
  const environment = useWorkspaceEnvironment();
  const api = environment.client;
  const createPractice = environment.practice.createPractice;
  const getPracticeIntent = environment.practice.getPracticeIntent;
  const clearPendingMinutes = environment.timer.clearPendingMinutes;
  const getPendingMinutes = environment.timer.getPendingMinutes;

  const zh = lang === 'zh';
  const t = translations[lang];
  const timer = usePracticeTimer();
  const workspace = useWorkspace();
  const closing = React.useContext(DialogClosingContext);
  const recovered = useRef(record ? undefined : getPracticeIntent('manual')).current;
  const [selected, setSelected] = useState(
    recovered && problem?.questionFrontendId !== recovered.questionFrontendId ? undefined : problem,
  );
  const [search, setSearch] = useState(recovered?.questionFrontendId ?? '');
  const [matches, setMatches] = useState<CatalogProblem[]>([]);
  const [searching, setSearching] = useState(false);
  const [zone, setZone] = useState(
    draft?.zone ??
      record?.sourceTimezone ??
      recovered?.sourceTimezone ??
      workspace.timezone ??
      Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  const [precision, setPrecision] = useState<TimePrecision>(
    draft?.precision ?? record?.timePrecision ?? recovered?.timePrecision ?? 'datetime',
  );
  const initialTime = record?.practicedAt ?? recovered?.practicedAt ?? new Date().toISOString();
  const [time, setTime] = useState(
    draft?.time ?? (initialTime.includes('T') ? zonedInput(initialTime, zone) : initialTime),
  );
  const [timeEdited, setTimeEdited] = useState(draft?.timeEdited ?? false);
  const [correctionOpen, setCorrectionOpen] = useState(
    draft?.correctionOpen ?? Boolean(draft?.timeEdited),
  );
  const correctionId = React.useId();
  const [completed, setCompleted] = useState(
    draft?.completed ?? record?.completed ?? recovered?.completed ?? true,
  );
  const [outcome, setOutcome] = useState<'independent' | 'assisted' | 'unsolved' | null>(
    draft?.outcome ?? record?.outcome ?? null,
  );

  function handleCompletedChange(nextCompleted: boolean) {
    setCompleted(nextCompleted);
    if (nextCompleted && outcome === 'unsolved') {
      setOutcome(null);
    } else if (!nextCompleted && (outcome === 'independent' || outcome === 'assisted')) {
      setOutcome(null);
    }
  }

  const [duration, setDuration] = useState(
    draft?.duration ??
      String(record?.durationMinutes ?? recovered?.durationMinutes ?? initialDurationMinutes ?? ''),
  );
  const [durationTouched, setDurationTouched] = useState(false);
  const [timerFilledMinutes, setTimerFilledMinutes] = useState<number | null>(() =>
    !draft?.duration &&
    (record?.durationMinutes ?? recovered?.durationMinutes) == null &&
    initialDurationMinutes != null
      ? initialDurationMinutes
      : null,
  );
  const currentFrontendId =
    record?.questionFrontendId ??
    selected?.questionFrontendId ??
    recovered?.questionFrontendId ??
    null;
  const activeForCurrent =
    timer.active != null &&
    currentFrontendId != null &&
    timer.active.frontendId === currentFrontendId;

  /** Adopt pending timer minutes once per problem until the user types their own value. */
  useEffect(() => {
    if (durationTouched || !currentFrontendId) return;
    if (duration.trim()) return;
    const pending = getPendingMinutes(currentFrontendId);
    if (pending != null) {
      setDuration(String(pending));
      setTimerFilledMinutes(pending);
    }
  }, [currentFrontendId, duration, durationTouched]);

  function handleDurationChange(value: string) {
    setDurationTouched(true);
    setTimerFilledMinutes(null);
    setDuration(value);
  }

  /** Stop the running timer for this problem and fill its minutes into the form. */
  function stopTimerAndFill() {
    const stopped = timer.stop();
    if (!stopped) return;
    setDurationTouched(false);
    setDuration(String(stopped.minutes));
    setTimerFilledMinutes(stopped.minutes);
  }
  const [notes, setNotes] = useState(draft?.notes ?? record?.notes ?? recovered?.notes ?? '');
  const correctionChanged = Boolean(
    record && (timeEdited || completed !== record.completed || outcome !== record.outcome),
  );
  const [saving, setSaving] = useState(false);
  const [uncertain, setUncertain] = useState(Boolean(recovered));
  const [error, setError] = useState('');
  const lock = useRef(false);
  const mounted = useRef(true);
  const recoverySession = useRef<ReturnType<typeof createDraftSession> | null>(null);
  const [restoring, setRestoring] = useState(Boolean(api.drafts)),
    [recoveryConflict, setRecoveryConflict] = useState(false),
    [draftStatus, setDraftStatus] = useState('');
  const generation = useRef(0);
  useEffect(() => {
    if (record && api.drafts)
      environment.host.saveRecoveryState({
        ...environment.host.recoveryState(),
        practiceEditor: { mode: 'detail', recordId: record.id, editing: true },
      });
  }, [record?.id, api, environment.host]);
  const notified = useRef(false);
  /** A committed record remains successful even when recovery-file cleanup fails. */
  async function finishSaved(saved: PracticeRecord) {
    if (notified.current) return;
    notified.current = true;
    try {
      await recoverySession.current?.closeAndDelete();
    } catch {
      workspace.reportPracticeOutcome?.({
        error: zh
          ? '练习已保存，但恢复草稿未清除；重开时请比较记录。'
          : 'Practice saved, but the recovery draft could not be cleared. Compare it with the record when reopening.',
      });
    }
    clearPendingMinutes(saved.questionFrontendId);
    if (mounted.current && !closing.current) onSaved(saved);
    else workspace.reportPracticeOutcome?.({});
  }
  useEffect(() => {
    if (!api.drafts) return;
    let active = true;
    const session = createDraftSession(api.drafts, 'practice', record?.id ?? 'manual');
    void Promise.all([session.read(), api.getBusinessVersions()])
      .then(async ([state, versions]) => {
        if (!active) return;
        generation.current = api.getReadGeneration?.(record ?? selected ?? {}) ?? versions.libraryGeneration;
        recoverySession.current = session;
        if (state.draft) {
          const value = z
            .object({
              duration: z.string(),
              notes: z.string(),
              completed: z.boolean(),
              time: z.string(),
              precision: z.enum(['date', 'datetime']),
              zone: z.string(),
              timeEdited: z.boolean(),
              outcome: z.enum(['independent', 'assisted', 'unsolved']).nullable(),
              selectedFrontendId: z.string().optional(),
              selected: catalogProblemSchema.optional(),
            })
            .parse(JSON.parse(state.draft.content));
          const frontendId = value.selectedFrontendId ?? value.selected?.questionFrontendId;
          const selectedProblem =
            !record && frontendId
              ? ((await api.getWorkspaceProblem?.(frontendId)) ?? value.selected)
              : undefined;
          if (!active) return;
          generation.current = api.getReadGeneration?.(record ?? selectedProblem ?? {}) ?? versions.libraryGeneration;
          setDuration(value.duration);
          setNotes(value.notes);
          setCompleted(value.completed);
          setTime(value.time);
          setPrecision(value.precision);
          setZone(value.zone);
          setTimeEdited(value.timeEdited);
          setOutcome(value.outcome);
          if (!record) setSelected(selectedProblem);
          setRecoveryConflict(
            state.draft.libraryGeneration !== generation.current ||
              generation.current !== versions.libraryGeneration ||
              state.draft.baseRevision !== (record?.revision ?? 0),
          );
        }
        setRestoring(false);
      })
      .catch((e) => {
        if (active) {
          setError(e.message);
          setRestoring(false);
          setRecoveryConflict(true);
        }
      });
    return () => {
      active = false;
    };
  }, [api, record?.id]);
  useEffect(() => {
    if (record || !selected) return;
    const stamp = api.getReadGeneration?.(selected);
    if (stamp !== undefined) generation.current = stamp;
  }, [api, record, selected]);
  useEffect(() => {
    if (restoring || recoveryConflict || !recoverySession.current) return;
    let active = true;
    setDraftStatus(zh ? '草稿尚未保留' : 'Draft not yet retained');
    const session = recoverySession.current;
    const timer = setTimeout(() => {
      void session
        .write(
          JSON.stringify({
            duration,
            notes,
            completed,
            time,
            precision,
            zone,
            timeEdited,
            outcome,
            selectedFrontendId: selected?.questionFrontendId,
          }),
          record?.revision ?? 0,
          generation.current,
        )
        .then(() => {
          if (active) setDraftStatus(zh ? '草稿已保留' : 'Draft retained');
        })
        .catch((e) => {
          if (active) setDraftStatus(e.message);
        });
    }, 250);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [
    restoring,
    recoveryConflict,
    duration,
    notes,
    completed,
    time,
    precision,
    zone,
    timeEdited,
    outcome,
    selected,
    record?.revision,
    zh,
  ]);
  useEffect(
    () =>
      environment.host.subscribe((event) => {
        if (
          event.type !== 'operation' ||
          event.operation.target !==
            (record ? `practice:${record.id}` : `practice:new:${currentFrontendId}`)
        )
          return;
        if (event.operation.status === 'applied' && event.operation.data) {
          if (!lock.current) void finishSaved(event.operation.data as PracticeRecord);
        } else {
          setError(operationMessage(new OperationStateError(event.operation), lang));
          if (!record)
            setUncertain(
              ['pending', 'unknown', 'applied_refresh_required'].includes(event.operation.status),
            );
        }
      }),
    [environment.host, currentFrontendId, record, lang],
  );

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (selected || record || !search.trim()) {
      setMatches([]);
      setSearching(false);
      return;
    }
    setMatches([]);
    setSearching(true);
    let active = true;
    const timer = setTimeout(() => {
      setSearching(true);
      api
        .getCatalog({ search, limit: 20 })
        .then((result) => {
          if (!active) return;
          setMatches(result.items);
          if (recovered)
            setSelected(
              result.items.find((p) => p.questionFrontendId === recovered.questionFrontendId),
            );
        })
        .catch((err) => {
          if (active) setError(localizeApiError(err, lang));
        })
        .finally(() => {
          if (active) setSearching(false);
        });
    }, 180);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [search, selected, record, recovered]);

  /** Late success still invalidates application data even if the user already closed this form. */
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (lock.current || restoring || recoveryConflict || (!record && !selected)) return;
    lock.current = true;
    setSaving(true);
    setError('');
    try {
      const metadata = {
        durationMinutes: durationValue(duration, lang),
        notes: notes.trim() || null,
        outcome,
      };
      // Expanding the editor is not a data change. Metadata-only saves must never rewrite
      // original timestamp precision, timezone, or completion evidence.
      const temporal = detailsOnly
        ? {}
        : {
            ...(!record || completed !== record.completed ? { completed } : {}),
            ...(!record || timeEdited
              ? {
                  practicedAt:
                    precision === 'date'
                      ? time.slice(0, 10)
                      : timeEdited
                        ? fromZonedInput(time, zone, lang)
                        : (recovered?.practicedAt ?? new Date().toISOString()),
                  timePrecision: precision,
                  sourceTimezone: zone,
                }
              : {}),
          };
      const readGeneration = api.getReadGeneration?.(record ?? selected!);
      const preconditions: [] | [number] = readGeneration === undefined ? [] : [readGeneration];
      const saved = record
        ? await api.updatePracticeRecord(record.id, {
            ...metadata,
            ...temporal,
            expectedRevision: record.revision,
          }, ...preconditions)
        : await createPractice('manual', {
            questionFrontendId: selected!.questionFrontendId,
            completed,
            practicedAt: new Date().toISOString(),
            ...temporal,
            ...metadata,
            notes: metadata.notes ?? undefined,
          }, ...preconditions);
      workspace.notifyMutation(saved);
      await finishSaved(saved);
    } catch (err) {
      if (mounted.current && !closing.current) {
        setError(
          err instanceof OperationStateError
            ? operationMessage(err, lang)
            : localizeApiError(err, lang),
        );
        setUncertain(!record && Boolean(getPracticeIntent('manual')));
      } else {
        workspace.reportPracticeOutcome?.({
          error: err instanceof OperationStateError ? operationMessage(err, lang) : localizeApiError(err, lang),
          recovery: record
            ? {
                mode: detailsOnly ? ('enrich' as const) : ('detail' as const),
                record,
                ...(detailsOnly
                  ? { elapsedMinutes: initialDurationMinutes ?? timerFilledMinutes ?? undefined }
                  : {}),
                draft: {
                  duration,
                  notes,
                  completed,
                  time,
                  precision,
                  zone,
                  timeEdited,
                  correctionOpen,
                  outcome,
                },
              }
            : { mode: 'manual', problem: selected },
        });
      }
    } finally {
      lock.current = false;
      if (mounted.current && !closing.current) setSaving(false);
    }
  }

  return (
    <form className="practice-form" onSubmit={submit}>
      {restoring && <p role="status">{zh ? '恢复草稿…' : 'Restoring draft…'}</p>}
      {draftStatus && <p role="status">{draftStatus}</p>}
      {recoveryConflict && (
        <Feedback>
          <p>
            {zh
              ? '草稿来自其他版本，请比较当前记录后决定。'
              : 'The draft belongs to another version. Compare the current record before continuing.'}
          </p>
          <pre>{JSON.stringify(record ?? null, null, 2)}</pre>
          <button type="button" onClick={() => setRecoveryConflict(false)}>
            {zh ? '保留字段并采用当前版本' : 'Keep fields and use current version'}
          </button>
        </Feedback>
      )}
      <fieldset
        disabled={restoring || recoveryConflict}
        style={{ border: 0, padding: 0, margin: 0 }}
      >
        {error && <Feedback>{error}</Feedback>}
        {uncertain && (
          <Feedback tone="warning">
            {zh
              ? '上次提交结果尚未确认。重试将核对同一条记录；原内容暂时冻结。'
              : 'The last submission is unconfirmed. Retry checks the same record; its original fields are frozen.'}
          </Feedback>
        )}
        {!record && !selected && (
          <div className="search-picker">
            <Field label={zh ? '搜索本地题库' : 'Search local problems'}>
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={zh ? '输入题号或名称' : 'Problem number or title'}
              />
            </Field>
            {searching ? (
              <p role="status">{zh ? '搜索中…' : 'Searching…'}</p>
            ) : (
              matches.map((p) => (
                <button
                  type="button"
                  className="picker-option"
                  key={p.questionId}
                  onClick={() => setSelected(p)}
                >
                  #{p.questionFrontendId} {p.title}
                  <span className={`difficulty ${p.difficulty.toLowerCase()}`}>{formatDifficulty(p.difficulty, lang)}</span>
                </button>
              ))
            )}
            {search.trim() && !searching && !matches.length && (
              <p className="muted">
                {zh
                  ? '找不到题目？请先导入题库。'
                  : 'No matching problem? Import your catalog first.'}
                {environment.host.capabilities.autoEnsure && (
                  <button
                    type="button"
                    className="text-link"
                    onClick={() => {
                      workspace.navigate('catalog-import');
                      onCancel();
                    }}
                  >
                    {zh ? '导入题库' : 'Import problems'}
                  </button>
                )}
              </p>
            )}
          </div>
        )}
        {(selected || record) && (
          <>
            <div className="selected-problem">
              <strong>
                #{record?.questionFrontendId ?? selected?.questionFrontendId}{' '}
                {record?.problemTitle ?? selected?.title}
              </strong>
              {!record && !problem && !uncertain && (
                <button type="button" className="text-link" onClick={() => setSelected(undefined)}>
                  {zh ? '更换题目' : 'Change problem'}
                </button>
              )}
            </div>
            <fieldset disabled={saving || uncertain}>
              {activeForCurrent && timer.active && (
                <div className="timer-inline-row">
                  <span className="muted num-tabular" aria-live="off">
                    ⏱ {formatElapsed(getElapsedSeconds(timer.active))}
                  </span>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={stopTimerAndFill}
                  >
                    <Square size={14} aria-hidden="true" />
                    {t.timerStopAndFill}
                  </button>
                </div>
              )}
              {timerFilledMinutes != null && (
                <p className="muted timer-hint" role="status">
                  {t.timerFilled.replace('{minutes}', String(timerFilledMinutes))}
                </p>
              )}
              {record && (
                <PracticeDetailsFields
                  lang={lang}
                  completed={completed}
                  duration={duration}
                  notes={notes}
                  outcome={outcome}
                  setDuration={handleDurationChange}
                  setNotes={setNotes}
                  setOutcome={setOutcome}
                />
              )}
              {record && !detailsOnly && (
                <button
                  type="button"
                  className="record-correction-toggle"
                  aria-expanded={correctionOpen}
                  aria-controls={correctionId}
                  onClick={() => setCorrectionOpen((open) => !open)}
                >
                  <ChevronDown size={16} aria-hidden="true" />
                  {zh ? '修改完成状态或时间' : 'Change completion or time'}
                  {correctionChanged && (
                    <span className="muted">{zh ? '（已修改）' : ' (modified)'}</span>
                  )}
                </button>
              )}
              <div id={correctionId}>
                {!detailsOnly && (!record || correctionOpen) && (
                  <>
                    <div className="form-grid">
                      <Field label={zh ? '本次结果' : 'Practice result'}>
                        <select
                          value={String(completed)}
                          onChange={(e) => handleCompletedChange(e.target.value === 'true')}
                        >
                          <option value="true">{zh ? '完成' : 'Completed'}</option>
                          <option value="false">{zh ? '未完成' : 'Not completed'}</option>
                        </select>
                      </Field>
                      <Field label={zh ? '时间精度' : 'Time precision'}>
                        <select
                          value={precision}
                          onChange={(e) => {
                            const next = e.target.value as TimePrecision;
                            setPrecision(next);
                            setTime(
                              next === 'date'
                                ? time.slice(0, 10)
                                : time.includes('T')
                                  ? time
                                  : time + 'T12:00:00',
                            );
                            setTimeEdited(true);
                          }}
                        >
                          <option value="datetime">{zh ? '日期与时间' : 'Date and time'}</option>
                          <option value="date">{zh ? '仅日期' : 'Date only'}</option>
                        </select>
                      </Field>
                    </div>
                    <Field label={zh ? '练习时间' : 'Practiced at'}>
                      <input
                        required
                        type={precision === 'date' ? 'date' : 'datetime-local'}
                        step="1"
                        value={time}
                        onChange={(e) => {
                          setTime(e.target.value);
                          setTimeEdited(true);
                        }}
                      />
                    </Field>
                    <Field
                      label={zh ? '记录时区' : 'Source timezone'}
                      hint={
                        zh
                          ? '补录是否完成今日题目由有效证据规则判定。'
                          : 'Existing evidence rules determine whether a backfill completes today’s task.'
                      }
                    >
                      <input
                        required
                        value={zone}
                        onChange={(e) => {
                          setZone(e.target.value);
                          setTimeEdited(true);
                        }}
                      />
                    </Field>
                  </>
                )}
              </div>
              {!record && (
                <PracticeDetailsFields
                  lang={lang}
                  completed={completed}
                  duration={duration}
                  notes={notes}
                  outcome={outcome}
                  setDuration={handleDurationChange}
                  setNotes={setNotes}
                  setOutcome={setOutcome}
                />
              )}
            </fieldset>
          </>
        )}
        <div className="form-actions">
          <button
            type="button"
            className="btn btn-secondary"
            disabled={saving}
            onClick={() => {
            if(!recoverySession.current){onCancel();return;}
              void (async () => {
                try {
                  await recoverySession.current?.closeAndDelete();
                  onCancel();
                } catch (e) {
                  setError(String(e));
                }
              })();
            }}
          >
            {detailsOnly ? (zh ? '跳过' : 'Skip') : zh ? '取消' : 'Cancel'}
          </button>
          <button
            className="btn btn-primary"
            type="submit"
            disabled={saving || (!record && !selected)}
          >
            {saving
              ? zh
                ? '保存中…'
                : 'Saving…'
              : detailsOnly
                ? zh
                  ? '保存详情'
                  : 'Save details'
                : zh
                  ? '保存记录'
                  : 'Save record'}
          </button>
        </div>
      </fieldset>
    </form>
  );
}
