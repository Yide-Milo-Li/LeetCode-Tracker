/** Current imported observations and their audit versions, kept separate from manual practices. */
import React, { useEffect, useState } from 'react';
import { api, type ProgressSnapshot, type ProgressSnapshotHistory, type RecentActivityItem } from '../api.ts';
import type { Language } from '../i18n.ts';
import { useWorkspace } from '../workspace.tsx';
import { Dialog, Feedback, Field, Pagination } from './ui.tsx';

/** Inspect/correct/revoke a current snapshot explicitly; history entries remain immutable audit observations. */
export function SnapshotDetails({
  questionId,
  event,
  lang,
  onClose,
}: {
  questionId: string;
  event?: RecentActivityItem;
  lang: Language;
  onClose: () => void;
}) {
  const zh = lang === 'zh';
  const workspace = useWorkspace();
  const [snapshot, setSnapshot] = useState<ProgressSnapshot | null>(null);
  const [history, setHistory] = useState<ProgressSnapshotHistory[]>([]);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [time, setTime] = useState('');
  const [result, setResult] = useState('');
  const [count, setCount] = useState(0);
  const [reason, setReason] = useState('');
  useEffect(() => {
    let active = true;
    Promise.all([api.getProgressSnapshot(questionId), api.getProgressSnapshotHistory(questionId)])
      .then(([current, audit]) => {
        if (active) {
          setSnapshot(current);
          setHistory(audit.items);
          setError('');
        }
      })
      .catch((err) => {
        if (active) setError(String(err.message));
      });
    return () => {
      active = false;
    };
  }, [questionId, retry]);
  /** Draft fields are populated only when the user begins editing, never by a background invalidation. */
  function edit() {
    if (!snapshot) return;
    setTime(snapshot.lastSubmittedAt);
    setResult(snapshot.lastResult);
    setCount(snapshot.totalSubmissions);
    setReason('');
    setEditing(true);
  }
  /** Existing snapshot validation and audit operations stay on the local server. */
  async function save(revoke = false) {
    if (saving) return;
    setSaving(true);
    setError('');
    try {
      const saved = revoke
        ? await api.revokeProgressSnapshot(questionId, reason || undefined)
        : await api.updateProgressSnapshot(questionId, {
            lastSubmittedAt: time,
            timePrecision: time.includes('T') ? 'datetime' : 'date',
            lastResult: result,
            totalSubmissions: count,
            reason: reason || undefined,
          });
      setSnapshot(saved);
      setEditing(false);
      setConfirming(false);
      workspace.notifyMutation();
      setRetry((n) => n + 1);
    } catch (err) {
      setError(String((err as Error).message));
    } finally {
      setSaving(false);
    }
  }
  return (
    <Dialog title={zh ? '导入快照详情' : 'Imported snapshot details'} lang={lang} onClose={onClose} drawer>
      {error && (
        <Feedback retry={{ label: zh ? '重试读取' : 'Reload', run: () => setRetry((n) => n + 1) }}>
          {error}
        </Feedback>
      )}
      {event && (
        <Feedback tone="info">
          {zh ? '所选观察日期：' : 'Selected observation: '}
          {event.timestamp} · {event.status === 'accepted' ? 'Accepted' : event.action}
        </Feedback>
      )}
      {!snapshot ? (
        <p role="status">…</p>
      ) : (
        <>
          <h3>
            #{snapshot.questionFrontendId} {snapshot.problemTitle}
          </h3>
          <p className="coverage-note">
            {zh
              ? '用户导入的累计进度。以下版本记录描述快照更改，不代表平台逐次提交。'
              : 'User-imported cumulative progress. Audit versions describe snapshot changes, not individual platform submissions.'}
          </p>
          <dl className="detail-grid">
            <dt>{zh ? '最新日期' : 'Latest date'}</dt>
            <dd>{snapshot.lastSubmittedAt}</dd>
            <dt>{zh ? '最近结果' : 'Latest result'}</dt>
            <dd>{snapshot.lastResult}</dd>
            <dt>{zh ? '累计提交数' : 'Cumulative submissions'}</dt>
            <dd>{snapshot.totalSubmissions}</dd>
            <dt>{zh ? '状态' : 'Status'}</dt>
            <dd>
              {snapshot.status} · v{snapshot.version}
            </dd>
          </dl>
          {snapshot.status === 'active' && !editing && (
            <div className="action-row">
              <button className="btn btn-secondary" onClick={edit}>
                {zh ? '更正快照' : 'Correct snapshot'}
              </button>
              <button
                className="btn btn-danger"
                onClick={() => {
                  setReason('');
                  setConfirming(true);
                }}
              >
                {zh ? '撤销此快照' : 'Revoke snapshot'}
              </button>
            </div>
          )}
          {editing && (
            <form
              className="practice-form"
              onSubmit={(e) => {
                e.preventDefault();
                void save();
              }}
            >
              <fieldset disabled={saving}>
                <Field label={zh ? '日期或带时差的 ISO 时间' : 'Date or ISO time with offset'}>
                  <input required value={time} onChange={(e) => setTime(e.target.value)} />
                </Field>
                <Field label={zh ? '结果' : 'Result'}>
                  <input required value={result} onChange={(e) => setResult(e.target.value)} />
                </Field>
                <Field label={zh ? '累计提交数' : 'Cumulative submissions'}>
                  <input
                    type="number"
                    min="0"
                    step="1"
                    required
                    value={count}
                    onChange={(e) => setCount(Number(e.target.value))}
                  />
                </Field>
                <Field label={zh ? '更正原因（可选）' : 'Correction reason (optional)'}>
                  <input maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} />
                </Field>
              </fieldset>
              <div className="form-actions">
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={saving}
                  onClick={() => setEditing(false)}
                >
                  {zh ? '取消' : 'Cancel'}
                </button>
                <button className="btn btn-primary" disabled={saving}>
                  {zh ? '保存更正' : 'Save correction'}
                </button>
              </div>
            </form>
          )}
          {confirming && (
            <div className="confirmation">
              <p>
                {zh
                  ? '确认撤销当前快照？历史审计和其他手动练习会保留。'
                  : 'Revoke this current snapshot? Audit history and other manual practices remain.'}
              </p>
              <Field label={zh ? '原因（可选）' : 'Reason (optional)'}>
                <input value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} />
              </Field>
              <div className="action-row">
                <button className="btn btn-secondary" disabled={saving} onClick={() => setConfirming(false)}>
                  {zh ? '取消' : 'Cancel'}
                </button>
                <button className="btn btn-danger" disabled={saving} onClick={() => void save(true)}>
                  {zh ? '确认撤销' : 'Confirm revoke'}
                </button>
              </div>
            </div>
          )}
          <h3 className="section-space">{zh ? '快照版本审计' : 'Snapshot version audit'}</h3>
          {history.map((item) => (
            <article className="version-card" key={item.id}>
              <strong>
                v{item.version} · {item.lastResult}
              </strong>
              <p>
                {item.lastSubmittedAt} · {item.totalSubmissions}{' '}
                {zh ? '次累计提交' : 'cumulative submissions'} · {item.status}
              </p>
              <small>
                {item.reason} ·{' '}
                {new Date(item.recordedAt).toLocaleString(zh ? 'zh-CN' : 'en-US', {
                  timeZone: workspace.timezone ?? 'UTC',
                })}
              </small>
            </article>
          ))}
        </>
      )}
    </Dialog>
  );
}

/** Browse one current snapshot per problem with server pagination and explicit failure feedback. */
export function SnapshotBrowser({ lang }: { lang: Language }) {
  const zh = lang === 'zh';
  const workspace = useWorkspace();
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<'active' | 'revoked'>('active');
  const [items, setItems] = useState<ProgressSnapshot[]>([]);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true);
    api
      .getProgressSnapshots(page, 20, status)
      .then((data) => {
        if (active) {
          setItems(data.items);
          setTotal(data.total);
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
  }, [page, status, workspace.revision, retry]);
  return (
    <section className="snapshot-browser">
      <div className="section-heading">
        <h2>{zh ? '当前已导入快照' : 'Current imported snapshots'}</h2>
        <select
          aria-label={zh ? '快照状态' : 'Snapshot status'}
          value={status}
          onChange={(e) => {
            setStatus(e.target.value as typeof status);
            setPage(1);
          }}
        >
          <option value="active">{zh ? '有效' : 'Active'}</option>
          <option value="revoked">{zh ? '已撤销' : 'Revoked'}</option>
        </select>
      </div>
      {error && (
        <Feedback retry={{ label: zh ? '重试' : 'Retry', run: () => setRetry((n) => n + 1) }}>
          {error}
        </Feedback>
      )}
      <div className="table-container">
        <table className="data-table">
          <thead>
            <tr>
              <th>{zh ? '题目' : 'Problem'}</th>
              <th>{zh ? '最新日期' : 'Latest date'}</th>
              <th>{zh ? '最近结果' : 'Latest result'}</th>
              <th>{zh ? '累计提交' : 'Submissions'}</th>
              <th>{zh ? '详情' : 'Details'}</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.questionId}>
                <td>
                  #{item.questionFrontendId} {item.problemTitle}
                </td>
                <td>{item.lastSubmittedAt}</td>
                <td>{item.lastResult}</td>
                <td>{item.totalSubmissions}</td>
                <td>
                  <button className="text-link" onClick={() => setSelected(item.questionId)}>
                    {zh ? '查看' : 'View'} · v{item.version}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {loading && <p role="status">…</p>}
      {!loading && !error && !items.length && <p className="muted">{zh ? '暂无快照' : 'No snapshots yet'}</p>}
      <Pagination lang={lang} page={page} total={total} limit={20} onPage={setPage} />
      {selected && <SnapshotDetails lang={lang} questionId={selected} onClose={() => setSelected(null)} />}
    </section>
  );
}
