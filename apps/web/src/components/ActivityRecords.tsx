/** Filterable activity records shared by Progress and the statistics drilldown. */
import { RotateCcw } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import { api, type DashboardActivityListResponse, type RecentActivityItem } from '../api.ts';
import type { Language } from '../i18n.ts';
import { useWorkspace } from '../workspace.tsx';
import { Feedback, IconButton, Field, Pagination } from './ui.tsx';
import { practiceTime } from './PracticeWorkspace.tsx';
import { SnapshotDetails } from './SnapshotBrowser.tsx';

/** Keep filters and pagination local; late requests cannot replace newer results or detail selections. */
export function ActivityRecords({
  lang,
  initialDate = null,
}: {
  lang: Language;
  initialDate?: string | null;
}) {
  const zh = lang === 'zh';
  const workspace = useWorkspace();
  const [date, setDate] = useState(initialDate ?? '');
  const [source, setSource] = useState<'all' | 'manual' | 'snapshot'>('all');
  const [pending, setPending] = useState<'all' | 'true' | 'false'>('all');
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(20);
  const [data, setData] = useState<DashboardActivityListResponse | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  const [snapshot, setSnapshot] = useState<RecentActivityItem | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const [dayNotes, setDayNotes] = useState<Array<{ id: string; title: string; notes: string }>>([]);

  useEffect(() => {
    if (!date) {
      setDayNotes([]);
      return;
    }
    let active = true;
    api
      .getPracticeRecords({ page: 1, limit: 100 })
      .then((res) => {
        if (!active) return;
        const matching = res.items.filter((r) => {
          const recDate =
            r.timePrecision === 'date'
              ? r.practicedAt
              : workspace.timezone
                ? new Intl.DateTimeFormat('en-CA', {
                    timeZone: workspace.timezone,
                    year: 'numeric',
                    month: '2-digit',
                    day: '2-digit',
                  }).format(new Date(r.practicedAt))
                : r.practicedAt.slice(0, 10);
          return recDate === date && Boolean(r.notes?.trim());
        });
        setDayNotes(
          matching.map((r) => ({
            id: r.id,
            title: `#${r.questionFrontendId} ${r.problemTitle}`,
            notes: r.notes || '',
          })),
        );
      })
      .catch(() => {
        if (active) setDayNotes([]);
      });
    return () => {
      active = false;
    };
  }, [date, workspace.timezone, workspace.revision]);
  useEffect(() => {
    setDate(initialDate ?? '');
    setPage(1);
  }, [initialDate]);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    api
      .getDashboardActivities({ date: date || undefined, source, pendingDate: pending, page, limit })
      .then((result) => {
        if (active) {
          setData(result);
          if (page > Math.max(1, result.totalPages)) setPage(Math.max(1, result.totalPages));
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
  }, [date, source, pending, page, limit, workspace.revision, retry]);
  /** Manual rows resolve exact IDs; snapshots open observations and version audits. */
  async function details(item: RecentActivityItem) {
    if (opening) return;
    if (item.source === 'snapshot') {
      setSnapshot(item);
      return;
    }
    setOpening(item.id);
    try {
      workspace.openPractice({ mode: 'detail', record: await api.getPracticeRecord(item.id) });
    } catch (err) {
      setError(String((err as Error).message));
    } finally {
      setOpening(null);
    }
  }
  return (
    <section className="activity-records">
      <div className="filter-toolbar">
        <Field label={zh ? '日期' : 'Date'}>
          <input
            aria-label={zh ? '日期筛选' : 'Date filter'}
            type="date"
            value={date}
            onChange={(e) => {
              setDate(e.target.value);
              setPage(1);
            }}
          />
        </Field>
        <Field label={zh ? '来源' : 'Source'}>
          <select
            value={source}
            onChange={(e) => {
              setSource(e.target.value as typeof source);
              setPage(1);
            }}
          >
            <option value="all">{zh ? '全部来源' : 'All sources'}</option>
            <option value="manual">{zh ? '手动练习' : 'Manual practice'}</option>
            <option value="snapshot">{zh ? '导入快照' : 'Imported snapshots'}</option>
          </select>
        </Field>
        <Field label={zh ? '日期状态' : 'Date status'}>
          <select
            value={pending}
            onChange={(e) => {
              setPending(e.target.value as typeof pending);
              setPage(1);
            }}
          >
            <option value="all">{zh ? '全部' : 'All'}</option>
            <option value="true">{zh ? '日期待确认' : 'Date pending'}</option>
            <option value="false">{zh ? '日期已确认' : 'Date confirmed'}</option>
          </select>
        </Field>
        <IconButton icon={RotateCcw} label={zh ? '重置筛选' : 'Reset filters'}
          onClick={() => {
            setDate('');
            setSource('all');
            setPending('all');
            setPage(1);
          }}
        />
      </div>
      <p className="coverage-note">
        {zh
          ? '手动练习是单次活动；导入快照是用户提供的进度观察，快照版本不代表真实提交历史。'
          : 'Manual practices are individual activities. Imported snapshots are user-provided progress observations; snapshot versions are not submission history.'}
      </p>
      {error && (
        <Feedback retry={{ label: zh ? '重试' : 'Retry', run: () => setRetry((n) => n + 1) }}>
          {error}
        </Feedback>
      )}
      {date && dayNotes.length > 0 && (
        <div className="day-notes-card">
          <div className="day-notes-header">
            <h4>{zh ? `📅 ${date} 做题复盘笔记` : `📅 ${date} Practice Notes & Reflection`}</h4>
            <span className="badge">{dayNotes.length} {zh ? '条笔记' : 'notes'}</span>
          </div>
          <div className="day-notes-list">
            {dayNotes.map((note) => (
              <div key={note.id} className="day-note-item">
                <div className="day-note-title">{note.title}</div>
                {note.notes && <p className="day-note-content">{note.notes}</p>}
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="table-container" aria-busy={loading}>
        <table className="data-table activity-table">
          <thead>
            <tr>
              <th>{zh ? '日期' : 'Date'}</th>
              <th>{zh ? '题目' : 'Problem'}</th>
              <th>{zh ? '结果' : 'Result'}</th>
              <th>{zh ? '来源' : 'Source'}</th>
              <th>{zh ? '详情' : 'Details'}</th>
            </tr>
          </thead>
          <tbody>
            {data?.items.map((item) => (
              <tr key={item.source + item.id}>
                <td>
                  {practiceTime(
                    { practicedAt: item.timestamp, timePrecision: item.timePrecision },
                    lang,
                    workspace.timezone,
                  )}
                  {item.isDatePending && (
                    <small className="pending-label">{zh ? '日期待确认' : 'Date pending'}</small>
                  )}
                </td>
                <td>
                  <strong>
                    #{item.questionFrontendId} {item.problemTitle}
                  </strong>
                  <span className={'difficulty ' + item.difficulty.toLowerCase()}>{zh ? { Easy: '简单', Medium: '中等', Hard: '困难' }[item.difficulty] : item.difficulty}</span>
                </td>
                <td>
                  {item.status === 'completed'
                    ? zh
                      ? '完成'
                      : 'Completed'
                    : item.status === 'uncompleted'
                      ? zh
                        ? '未完成'
                        : 'Not completed'
                      : item.status === 'accepted'
                        ? 'Accepted'
                        : item.action}
                </td>
                <td>
                  <span className="source-label">
                    {item.source === 'manual'
                      ? zh
                        ? '手动练习'
                        : 'Manual practice'
                      : zh
                        ? '导入快照'
                        : 'Imported snapshot'}
                  </span>
                </td>
                <td>
                  <button
                    className="text-link"
                    disabled={opening !== null}
                    onClick={() => void details(item)}
                  >
                    {opening === item.id ? '…' : zh ? '查看' : 'View'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {loading && (
        <p role="status" className="muted">
          {zh ? '读取记录…' : 'Loading records…'}
        </p>
      )}
      {!loading && !error && !data?.items.length && (
        <div className="empty-state">
          <h3>{zh ? '暂无符合条件的已知记录' : 'No known records match these filters'}</h3>
          <p>
            {zh ? '记录一次练习，或导入已有进度。' : 'Record a practice or import your existing progress.'}
          </p>
        </div>
      )}
      <Pagination
        page={page}
        total={data?.total ?? 0}
        limit={limit}
        onPage={setPage}
        onLimit={(n) => {
          setLimit(n);
          setPage(1);
        }}
        lang={lang}
      />
      {snapshot && (
        <SnapshotDetails
          questionId={snapshot.questionId}
          event={snapshot}
          lang={lang}
          onClose={() => setSnapshot(null)}
        />
      )}
    </section>
  );
}
