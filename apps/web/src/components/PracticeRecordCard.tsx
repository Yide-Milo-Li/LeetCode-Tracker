/**
 * Practice record card with audit revocation flow and manual completion details.
 */
import { Pencil } from 'lucide-react';
import React, { useState } from 'react';
import { api, type PracticeRecord } from '../api.ts';
import type { Language } from '../i18n.ts';
import { useWorkspace } from '../workspace.tsx';
import { Feedback, IconButton } from './ui.tsx';

/**
 * Format practice record timestamp respecting date-only vs datetime precision.
 */
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

export interface PracticeRecordCardProps {
  record: PracticeRecord;
  lang: Language;
  edit: () => void;
  onChange: (record: PracticeRecord) => void;
}

/**
 * Revoke one manual record with an explicit second action; other completion evidence is untouched.
 */
export function PracticeRecordCard({
  record,
  lang,
  edit,
  onChange,
}: PracticeRecordCardProps) {
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
          <IconButton icon={Pencil} label={zh ? '编辑记录' : 'Edit record'} onClick={edit} />
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
