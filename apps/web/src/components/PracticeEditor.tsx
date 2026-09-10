/**
 * Practice record editor form supporting manual logging, problem search, and details enrichment.
 */
import React, { useEffect, useRef, useState } from 'react';
import {
  api,
  type CatalogProblem,
  type PracticeRecord,
  type TimePrecision,
} from '../api.ts';
import type { Language } from '../i18n.ts';
import { useWorkspace, type PracticeDraft } from '../workspace.tsx';
import { createPractice, getPracticeIntent, fromZonedInput, zonedInput } from '../practice-service.ts';
import { Feedback, Field } from './ui.tsx';

/**
 * Validate and extract optional duration in minutes.
 * Unknown duration is null; only positive safe integers are persistable.
 */
export function durationValue(value: string): number | null {
  if (!value.trim()) return null;
  const minutes = Number(value);
  if (!Number.isSafeInteger(minutes) || minutes <= 0)
    throw new Error('Duration must be a positive whole number / 耗时须为正整数');
  return minutes;
}

export interface PracticeDetailsFieldsProps {
  lang: Language;
  duration: string;
  notes: string;
  setDuration: (s: string) => void;
  setNotes: (s: string) => void;
}

/**
 * The optional completion details intentionally contain only duration and notes.
 */
export function PracticeDetailsFields({
  lang,
  duration,
  notes,
  setDuration,
  setNotes,
}: PracticeDetailsFieldsProps) {
  return (
    <>
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
        <textarea rows={4} maxLength={2000} value={notes} onChange={(e) => setNotes(e.target.value)} />
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
  onSaved,
  onCancel,
}: PracticeEditorProps) {
  const zh = lang === 'zh';
  const workspace = useWorkspace();
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
  const [completed, setCompleted] = useState(
    draft?.completed ?? record?.completed ?? recovered?.completed ?? true,
  );
  const [duration, setDuration] = useState(
    draft?.duration ?? String(record?.durationMinutes ?? recovered?.durationMinutes ?? ''),
  );
  const [notes, setNotes] = useState(draft?.notes ?? record?.notes ?? recovered?.notes ?? '');
  const [saving, setSaving] = useState(false);
  const [uncertain, setUncertain] = useState(Boolean(recovered));
  const [error, setError] = useState('');
  const lock = useRef(false);
  const mounted = useRef(true);

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
            setSelected(result.items.find((p) => p.questionFrontendId === recovered.questionFrontendId));
        })
        .catch((err) => {
          if (active) setError(String(err.message));
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
    if (lock.current || (!record && !selected)) return;
    lock.current = true;
    setSaving(true);
    setError('');
    try {
      const metadata = { durationMinutes: durationValue(duration), notes: notes.trim() || null };
      const temporal = detailsOnly
        ? {}
        : {
            completed,
            practicedAt:
              precision === 'date'
                ? time.slice(0, 10)
                : timeEdited
                  ? fromZonedInput(time, zone)
                  : (record?.practicedAt ?? recovered?.practicedAt ?? new Date().toISOString()),
            timePrecision: precision,
            sourceTimezone: zone,
          };
      const saved = record
        ? await api.updatePracticeRecord(record.id, {
            ...metadata,
            ...temporal,
            expectedRevision: record.revision,
          })
        : await createPractice('manual', {
            questionFrontendId: selected!.questionFrontendId,
            completed,
            practicedAt: new Date().toISOString(),
            ...temporal,
            ...metadata,
            notes: metadata.notes ?? undefined,
          });
      workspace.notifyMutation(saved);
      if (mounted.current) onSaved(saved);
      else workspace.reportPracticeOutcome?.({});
    } catch (err) {
      if (mounted.current) {
        setError(err instanceof Error ? err.message : String(err));
        setUncertain(!record && Boolean(getPracticeIntent('manual')));
      } else {
        workspace.reportPracticeOutcome?.({
          error: err instanceof Error ? err.message : String(err),
          recovery: record
            ? {
                mode: detailsOnly ? 'enrich' : 'detail',
                record,
                full: !detailsOnly,
                draft: { duration, notes, completed, time, precision, zone, timeEdited },
              }
            : { mode: 'manual', problem: selected },
        });
      }
    } finally {
      lock.current = false;
      if (mounted.current) setSaving(false);
    }
  }

  return (
    <form className="practice-form" onSubmit={submit}>
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
                <span className={`difficulty ${p.difficulty.toLowerCase()}`}>{p.difficulty}</span>
              </button>
            ))
          )}
          {search.trim() && !searching && !matches.length && (
            <p className="muted">
              {zh ? '找不到题目？请先导入题库。' : 'No matching problem? Import your catalog first.'}
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
            {!detailsOnly && (
              <>
                <div className="form-grid">
                  <Field label={zh ? '本次结果' : 'Practice result'}>
                    <select
                      value={String(completed)}
                      onChange={(e) => setCompleted(e.target.value === 'true')}
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
            <PracticeDetailsFields
              lang={lang}
              duration={duration}
              notes={notes}
              setDuration={setDuration}
              setNotes={setNotes}
            />
          </fieldset>
        </>
      )}
      <div className="form-actions">
        <button type="button" className="btn btn-secondary" onClick={onCancel}>
          {detailsOnly ? (zh ? '跳过' : 'Skip') : zh ? '取消' : 'Cancel'}
        </button>
        <button className="btn btn-primary" type="submit" disabled={saving || (!record && !selected)}>
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
    </form>
  );
}
