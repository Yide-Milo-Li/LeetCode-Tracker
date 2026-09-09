/** Shared manual entry and exact-record details. Closing an overlay never rolls back a saved record. */
import React, { useEffect, useRef, useState } from 'react';
import {
  api,
  type CatalogProblem,
  type PracticeRecord,
  type ProgressSnapshotHistory,
  type TimePrecision,
} from '../api.ts';
import type { Language } from '../i18n.ts';
import { useWorkspace, type PracticeDraft, type PracticeRequest } from '../workspace.tsx';
import { createPractice, getPracticeIntent, fromZonedInput, zonedInput } from '../practice-service.ts';
import { Dialog, Feedback, Field, Pagination } from './ui.tsx';

/** Date-only values remain civil dates rather than being converted through UTC midnight. */
export function practiceTime(
  record: Pick<PracticeRecord, 'practicedAt' | 'timePrecision'>,
  lang: Language,
  zone: string | null,
): string {
  return record.timePrecision === 'date'
    ? `${record.practicedAt} · ${lang === 'zh' ? '仅日期' : 'Date only'}`
    : new Intl.DateTimeFormat(lang === 'zh' ? 'zh-CN' : 'en-US', {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone: zone ?? 'UTC',
      }).format(new Date(record.practicedAt));
}

/** Unknown duration is null; only positive safe integers are persistable. */
function durationValue(value: string): number | null {
  if (!value.trim()) return null;
  const minutes = Number(value);
  if (!Number.isSafeInteger(minutes) || minutes <= 0)
    throw new Error('Duration must be a positive whole number / 耗时须为正整数');
  return minutes;
}

/** The optional completion details intentionally contain only duration and notes. */
export function PracticeDetailsFields({
  lang,
  duration,
  notes,
  setDuration,
  setNotes,
}: {
  lang: Language;
  duration: string;
  notes: string;
  setDuration: (s: string) => void;
  setNotes: (s: string) => void;
}) {
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

/** Create with a durable operation identity, or patch the selected revision without overwriting newer edits. */
export function PracticeEditor({
  lang,
  problem,
  record,
  detailsOnly = false,
  draft,
  onSaved,
  onCancel,
}: {
  lang: Language;
  problem?: CatalogProblem;
  record?: PracticeRecord;
  detailsOnly?: boolean;
  draft?: PracticeDraft;
  onSaved: (record: PracticeRecord) => void;
  onCancel: () => void;
}) {
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
    draft?.zone ?? record?.sourceTimezone ??
      recovered?.sourceTimezone ??
      workspace.timezone ??
      Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  const [precision, setPrecision] = useState<TimePrecision>(
    draft?.precision ?? record?.timePrecision ?? recovered?.timePrecision ?? 'datetime',
  );
  const initialTime = record?.practicedAt ?? recovered?.practicedAt ?? new Date().toISOString();
  const [time, setTime] = useState(draft?.time ?? (initialTime.includes('T') ? zonedInput(initialTime, zone) : initialTime));
  const [timeEdited, setTimeEdited] = useState(draft?.timeEdited ?? false);
  const [completed, setCompleted] = useState(draft?.completed ?? record?.completed ?? recovered?.completed ?? true);
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
            ? { mode: detailsOnly ? 'enrich' : 'detail', record, full: !detailsOnly,
                draft: { duration, notes, completed, time, precision, zone, timeEdited } }
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

/** Revoke one manual record with an explicit second action; other completion evidence is untouched. */
function RecordCard({
  record,
  lang,
  edit,
  onChange,
}: {
  record: PracticeRecord;
  lang: Language;
  edit: (full: boolean) => void;
  onChange: (record: PracticeRecord) => void;
}) {
  const zh = lang === 'zh';
  const workspace = useWorkspace();
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  /** Preserve the audit row and let server reconciliation determine the remaining completion state. */
  async function revoke() {
    setSaving(true);
    setError('');
    try {
      const saved = await api.revokePracticeRecord(record.id, record.revision);
      workspace.notifyMutation(saved);
      onChange(saved);
      setConfirming(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }
  return (
    <section className="record-detail">
      <div className="section-heading">
        <h3>{zh ? '手动练习' : 'Manual practice'}</h3>
        <span className="badge">
          {record.status === 'revoked'
            ? zh
              ? '已撤销'
              : 'Revoked'
            : record.completed
              ? zh
                ? '已完成'
                : 'Completed'
              : zh
                ? '未完成'
                : 'Not completed'}
        </span>
      </div>
      <p>{practiceTime(record, lang, workspace.timezone)}</p>
      <dl className="detail-grid">
        <dt>{zh ? '耗时' : 'Duration'}</dt>
        <dd>
          {record.durationMinutes == null
            ? zh
              ? '未记录'
              : 'Not recorded'
            : `${record.durationMinutes} ${zh ? '分钟' : 'min'}`}
        </dd>
        <dt>{zh ? '备注' : 'Notes'}</dt>
        <dd className="preserve-lines">{record.notes || '—'}</dd>
        <dt>ID</dt>
        <dd className="break-anywhere">
          {record.id} · v{record.revision}
        </dd>
      </dl>
      {error && <Feedback>{error}</Feedback>}
      {record.status === 'active' && (
        <div className="action-row">
          <button className="btn btn-secondary" onClick={() => edit(false)}>
            {zh ? '补充详情' : 'Edit details'}
          </button>
          <button className="btn btn-secondary" onClick={() => edit(true)}>
            {zh ? '更正记录' : 'Correct record'}
          </button>
          <button className="btn btn-danger" onClick={() => setConfirming(true)}>
            {zh ? '撤销此记录' : 'Revoke this record'}
          </button>
        </div>
      )}
      {confirming && (
        <div className="confirmation">
          <p>
            {zh
              ? '仅撤销这次手动练习。其他练习与导入证据仍然保留。'
              : 'Revoke only this manual practice. Other practices and imported evidence remain.'}
          </p>
          <div className="action-row">
            <button className="btn btn-secondary" disabled={saving} onClick={() => setConfirming(false)}>
              {zh ? '保留记录' : 'Keep record'}
            </button>
            <button className="btn btn-danger" disabled={saving} onClick={revoke}>
              {saving ? '…' : zh ? '确认撤销' : 'Confirm revoke'}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

/** Resolve exact evidence IDs rather than assuming the latest practice is the one that completed a task. */
export function PracticeWorkspace({
  request,
  lang,
  onClose,
}: {
  request: PracticeRequest;
  lang: Language;
  onClose: () => void;
}) {
  const zh = lang === 'zh';
  const [records, setRecords] = useState<PracticeRecord[]>('record' in request ? [request.record] : []);
  const [snapshots, setSnapshots] = useState<ProgressSnapshotHistory[]>([]);
  const [editing, setEditing] = useState<{ record: PracticeRecord; full: boolean } | null>(
    request.mode === 'enrich' || (request.mode === 'detail' && request.draft)
      ? { record: request.record, full: request.full ?? false } : null,
  );
  const [loading, setLoading] = useState(request.mode === 'evidence');
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (request.mode !== 'evidence') return;
    let active = true;
    setLoading(true);
    setError('');
    const ids = request.item.evidenceIds;
    Promise.all([
      Promise.all(
        ids.filter((id) => id.startsWith('manual:')).map((id) => api.getPracticeRecord(id.slice(7))),
      ),
      ids.some((id) => id.startsWith('snapshot:'))
        ? api.getProgressSnapshotHistory(request.item.problem.questionId)
        : Promise.resolve({ items: [] as ProgressSnapshotHistory[] }),
    ])
      .then(([manual, history]) => {
        if (active) {
          setRecords(manual);
          setSnapshots(
            history.items.filter((item) => ids.includes(`snapshot:${item.questionId}:${item.version}`)),
          );
        }
      })
      .catch((err) => {
        if (active) setError(String(err.message));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [request, retry]);
  /** Replace the local selected record after a mutation; never create a second practice for details. */
  function changed(record: PracticeRecord) {
    setRecords((old) => old.map((r) => (r.id === record.id ? record : r)));
  }
  return (
    <Dialog
      lang={lang}
      onClose={onClose}
      drawer={request.mode === 'detail' || request.mode === 'evidence'}
      title={
        request.mode === 'enrich'
          ? zh
            ? '已记录完成，补充本次练习'
            : 'Completion recorded. Add practice details'
          : request.mode === 'manual'
            ? zh
              ? '手动记录'
              : 'Manual record'
            : zh
              ? '完成记录详情'
              : 'Completion record details'
      }
    >
      {request.mode === 'enrich' && (
        <Feedback tone="success">
          {zh
            ? '完成记录已保存。跳过或关闭窗口不会撤销。'
            : 'Your completion is saved. Skipping or closing keeps it.'}
        </Feedback>
      )}
      {request.mode === 'manual' ? (
        <PracticeEditor lang={lang} problem={request.problem} onSaved={onClose} onCancel={onClose} />
      ) : editing ? (
        <PracticeEditor
          key={editing.record.id}
          lang={lang}
          record={editing.record}
          draft={'draft' in request ? request.draft : undefined}
          detailsOnly={!editing.full}
          onSaved={(record) => {
            changed(record);
            if (request.mode === 'enrich') onClose();
            else setEditing(null);
          }}
          onCancel={() => (request.mode === 'enrich' ? onClose() : setEditing(null))}
        />
      ) : (
        <>
          {request.mode === 'evidence' && (
            <>
              <h3>
                #{request.item.problem.questionFrontendId} {request.item.problem.title}
              </h3>
              <p className="muted">
                {zh
                  ? '以下是支持完成状态的具体记录。撤销一条记录后，系统会重新核对其他有效依据。'
                  : 'These records support completion. Revoking one rechecks all remaining valid evidence.'}
              </p>
            </>
          )}
          {loading && <p role="status">{zh ? '读取记录…' : 'Loading records…'}</p>}
          {error && (
            <Feedback retry={{ label: zh ? '重试' : 'Retry', run: () => setRetry((n) => n + 1) }}>
              {error}
            </Feedback>
          )}
          {records.map((record) => (
            <RecordCard
              key={record.id}
              record={record}
              lang={lang}
              edit={(full) => setEditing({ record, full })}
              onChange={changed}
            />
          ))}
          {snapshots.map((snapshot) => (
            <section className="record-detail" key={snapshot.id}>
              <h3>
                {zh ? '导入快照' : 'Imported snapshot'} · v{snapshot.version}
              </h3>
              <p>
                {snapshot.lastResult} · {snapshot.lastSubmittedAt}
              </p>
              <p className="muted">
                {zh
                  ? '这是用户导入的累计进度观察，不是单次提交历史。'
                  : 'A user-imported observation of cumulative progress, not an individual submission.'}
              </p>
            </section>
          ))}
        </>
      )}
    </Dialog>
  );
}

/** Page through all manual practices for a catalog problem, including revoked audit records. */
export function PracticeHistory({ problem, lang }: { problem: CatalogProblem; lang: Language }) {
  const workspace = useWorkspace();
  const [page, setPage] = useState(1);
  const [records, setRecords] = useState<PracticeRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true;
    setLoading(true);
    api
      .getPracticeRecords({ questionFrontendId: problem.questionFrontendId, status: 'all', page, limit: 20 })
      .then((result) => {
        if (active) {
          setRecords(result.items);
          setTotal(result.total);
          setError('');
        }
      })
      .catch((err) => {
        if (active) setError(String(err.message));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [problem.questionFrontendId, page, workspace.revision]);
  return (
    <section>
      <h3>{lang === 'zh' ? '练习记录' : 'Practice history'}</h3>
      {error && <Feedback>{error}</Feedback>}
      {loading ? (
        <p role="status">…</p>
      ) : !records.length ? (
        <p className="muted">{lang === 'zh' ? '暂无已知记录' : 'No known records'}</p>
      ) : (
        records.map((record) => (
          <button
            className="history-row"
            key={record.id}
            onClick={() => workspace.openPractice({ mode: 'detail', record })}
          >
            <span>{practiceTime(record, lang, workspace.timezone)}</span>
            <span>
              {record.status === 'revoked'
                ? lang === 'zh'
                  ? '已撤销'
                  : 'Revoked'
                : record.completed
                  ? '✓'
                  : '—'}
            </span>
          </button>
        ))
      )}
      <Pagination page={page} total={total} limit={20} onPage={setPage} lang={lang} />
    </section>
  );
}
