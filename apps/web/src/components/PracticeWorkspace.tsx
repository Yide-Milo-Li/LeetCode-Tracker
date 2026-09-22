/**
 * Shared manual entry and exact-record details workspace.
 * Closing an overlay never rolls back a saved record.
 */
import React, { useEffect, useState } from 'react';
import {
  api,
  type PracticeRecord,
  type ProgressSnapshotHistory,
} from '../api.ts';
import type { Language } from '../i18n.ts';
import { useWorkspace, type PracticeRequest } from '../workspace.tsx';
import { Dialog, Feedback } from './ui.tsx';
import { PracticeEditor } from './PracticeEditor.tsx';
import { PracticeRecordCard } from './PracticeRecordCard.tsx';

// Re-export subcomponents and helpers for backward compatibility
export { PracticeEditor, PracticeDetailsFields, durationValue } from './PracticeEditor.tsx';
export { PracticeRecordCard, practiceTime } from './PracticeRecordCard.tsx';
export { PracticeHistory } from './PracticeHistory.tsx';

export interface PracticeWorkspaceProps {
  request: PracticeRequest;
  lang: Language;
  onClose: () => void;
}

/**
 * Resolve exact evidence IDs rather than assuming the latest practice is the one that completed a task.
 */
export function PracticeWorkspace({
  request,
  lang,
  onClose,
}: PracticeWorkspaceProps) {
  const zh = lang === 'zh';
  const [records, setRecords] = useState<PracticeRecord[]>('record' in request ? [request.record] : []);
  const [snapshots, setSnapshots] = useState<ProgressSnapshotHistory[]>([]);
  // Recovery belongs to one editing attempt; saving or cancelling must consume it.
  const [draft, setDraft] = useState('draft' in request ? request.draft : undefined);
  const [editing, setEditing] = useState<{ record: PracticeRecord } | null>(
    request.mode === 'enrich' || (request.mode === 'detail' && request.draft)
      ? { record: request.record }
      : null,
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
            ? '补充练习'
            : 'Add practice details'
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
            ? '完成已记录并保存。详情可跳过。'
            : 'Completion recorded and saved. Details can be skipped.'}
        </Feedback>
      )}
      {request.mode === 'manual' ? (
        <PracticeEditor lang={lang} problem={request.problem} onSaved={onClose} onCancel={onClose} />
      ) : editing ? (
        <PracticeEditor
          key={editing.record.id}
          lang={lang}
          record={editing.record}
          draft={draft}
          detailsOnly={request.mode === 'enrich'}
          initialDurationMinutes={request.mode === 'enrich' ? request.elapsedMinutes : undefined}
          onSaved={(record) => {
            setDraft(undefined);
            changed(record);
            if (request.mode === 'enrich') onClose();
            else setEditing(null);
          }}
          onCancel={() => {
            setDraft(undefined);
            if (request.mode === 'enrich') onClose();
            else setEditing(null);
          }}
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
            <PracticeRecordCard
              key={record.id}
              record={record}
              lang={lang}
              edit={() => setEditing({ record })}
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
