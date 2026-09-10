/**
 * Progress preview and conflict resolution section component for ProgressWorkbench.
 */
import React from 'react';
import type { ProgressImportPreview } from '../api.ts';
import type { Language } from '../i18n.ts';

interface ProgressPreviewSectionProps {
  step: number;
  steps: string[];
  preview: ProgressImportPreview;
  confirmed: Set<string>;
  setConfirmed: React.Dispatch<React.SetStateAction<Set<string>>>;
  frozen: boolean;
  busy: 'format' | 'preview' | 'commit' | null;
  uncertain: boolean;
  lang: Language;
  onBack: () => void;
  onContinueOrCommit: () => void;
}

/**
 * Render diff review table, conflict override checkboxes, and commit authorization controls.
 */
export const ProgressPreviewSection: React.FC<ProgressPreviewSectionProps> = ({
  step,
  steps,
  preview,
  confirmed,
  setConfirmed,
  frozen,
  busy,
  uncertain,
  lang,
  onBack,
  onContinueOrCommit,
}) => {
  const zh = lang === 'zh';

  const eligible =
    preview.items.filter(
      (item) => item.allowedToCommit || (item.action === 'conflict' && confirmed.has(item.frontendId)),
    ).length;

  return (
    <section className="import-stage">
      <h2>{steps[step]}</h2>
      <div className="summary-counts">
        <span>
          {zh ? '有效' : 'Valid'} <strong>{preview.validCount}</strong>
        </span>
        <span>
          {zh ? '冲突' : 'Conflicts'} <strong>{preview.conflictCount}</strong>
        </span>
        <span>
          {zh ? '错误' : 'Errors'} <strong>{preview.errorCount}</strong>
        </span>
        <span>
          {zh ? '重复' : 'Duplicates'} <strong>{preview.duplicateCount}</strong>
        </span>
      </div>
      <div className="preview-items">
        {preview.items.map((item, index) => (
          <article className={'preview-item ' + item.action} key={index}>
            <div className="section-heading">
              <h3>
                #{item.frontendId} {item.problemTitle}
              </h3>
              <span className="badge">
                {
                  {
                    insert: zh ? '新增' : 'Insert',
                    update: zh ? '更新' : 'Update',
                    unchanged: zh ? '未变' : 'Unchanged',
                    conflict: zh ? '冲突' : 'Conflict',
                    duplicate: zh ? '重复' : 'Duplicate',
                    error: zh ? '错误' : 'Error',
                  }[item.action]
                }
              </span>
            </div>
            <div className="snapshot-diff">
              {item.currentSnapshot && (
                <div>
                  <small>{zh ? '当前快照' : 'Current snapshot'}</small>
                  <p>
                    {item.currentSnapshot.lastSubmittedAt} · {item.currentSnapshot.lastResult} ·{' '}
                    {item.currentSnapshot.totalSubmissions}
                  </p>
                </div>
              )}
              <div>
                <small>{zh ? '导入值' : 'Incoming value'}</small>
                <p>
                  {item.incomingSnapshot.lastSubmittedAt} · {item.incomingSnapshot.lastResult} ·{' '}
                  {item.incomingSnapshot.totalSubmissions}
                </p>
              </div>
            </div>
            {(item.error || item.conflictReason) && (
              <p className="warning-text">{item.error || item.conflictReason}</p>
            )}
            {item.action === 'conflict' && !item.error && (
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  disabled={step === 3 || frozen}
                  checked={confirmed.has(item.frontendId)}
                  onChange={(e) => {
                    const checked = e.target.checked;
                    setConfirmed((old) => {
                      const next = new Set(old);
                      checked ? next.add(item.frontendId) : next.delete(item.frontendId);
                      return next;
                    });
                  }}
                />
                {zh
                  ? '我已核对，允许覆盖此题快照'
                  : 'I reviewed this problem and allow its snapshot to be replaced'}
              </label>
            )}
          </article>
        ))}
      </div>
      {preview.errors.length > 0 && (
        <details open>
          <summary>{zh ? '校验错误' : 'Validation errors'}</summary>
          <ul>
            {preview.errors.map((item, i) => (
              <li key={i}>
                #{item.index + 1} {item.message}
              </li>
            ))}
          </ul>
        </details>
      )}
      <p className="coverage-note">
        {zh
          ? '未确认的冲突、重复和无效行将跳过。有效集合一次提交，累计次数按快照替换，不进行累加。'
          : 'Unconfirmed conflicts, duplicates and invalid rows are skipped. The valid set commits together; cumulative counts replace snapshot values rather than adding to them.'}
      </p>
      <p>
        {zh ? '本次选中可处理行数：' : 'Selected processable rows: '}
        {eligible} · {zh ? '预览有效至 ' : 'Preview valid until '}
        {new Date(preview.expiresAt).toLocaleTimeString(zh ? 'zh-CN' : 'en-US')}
      </p>
      <div className="form-actions">
        <button className="btn btn-secondary" disabled={frozen} onClick={onBack}>
          {zh ? '返回修改' : 'Back to edit'}
        </button>
        <button
          className="btn btn-primary"
          disabled={busy !== null || eligible === 0}
          onClick={onContinueOrCommit}
        >
          {busy === 'commit'
            ? zh
              ? '导入中…'
              : 'Importing…'
            : step === 2
              ? zh
                ? '继续确认'
                : 'Continue to confirmation'
              : uncertain
                ? zh
                  ? '重试本次导入'
                  : 'Retry this import'
                : zh
                  ? '确认导入'
                  : 'Confirm import'}
        </button>
      </div>
    </section>
  );
};
