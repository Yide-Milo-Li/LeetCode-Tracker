/**
 * Catalog import preflight preview summary component with metrics, error tables, sample diffs, and commit action.
 */
import React from 'react';
import { CheckCircle2 } from 'lucide-react';
import type { ImportPreview } from '../api.ts';
import { translations, type Language } from '../i18n.ts';

interface CatalogPreviewSummaryProps {
  preview: ImportPreview;
  lang: Language;
  commitLoading: boolean;
  onCommit: () => void;
}

/**
 * Render preflight preview statistics, parse errors, item samples, and commit controls.
 */
export const CatalogPreviewSummary: React.FC<CatalogPreviewSummaryProps> = ({
  preview,
  lang,
  commitLoading,
  onCommit,
}) => {
  const t = translations[lang];

  return (
    <div className="u-margin-top-2rem u-border-top-1px-solid-border-color u-padding-top-1-5rem">
      <h3 className="card-title u-font-size-1rem u-margin-bottom-1rem">{t.previewTitle}</h3>

      {/* Metrics Row */}
      <div className="metrics-grid u-grid-template-columns-repeat-auto-fit-minmax-130px-1fr">
        <div className="metric-card u-padding-0-75rem-1rem">
          <div className="metric-label">{t.metricTotalLines}</div>
          <div className="metric-value u-font-size-1-25rem">{preview.totalLines}</div>
        </div>
        <div className="metric-card u-padding-0-75rem-1rem">
          <div className="metric-label">{t.metricValid}</div>
          <div className="metric-value u-font-size-1-25rem u-color-primary">{preview.validCount}</div>
        </div>
        <div className="metric-card u-padding-0-75rem-1rem">
          <div className="metric-label">{t.metricInsert}</div>
          <div className="metric-value u-font-size-1-25rem u-color-easy">{preview.insertCount}</div>
        </div>
        <div className="metric-card u-padding-0-75rem-1rem">
          <div className="metric-label">{t.metricUpdate}</div>
          <div className="metric-value u-font-size-1-25rem u-color-primary">{preview.updateCount}</div>
        </div>
        <div className="metric-card u-padding-0-75rem-1rem">
          <div className="metric-label">{t.metricUnchanged}</div>
          <div className="metric-value u-font-size-1-25rem u-color-text-muted">
            {preview.unchangedCount}
          </div>
        </div>
        <div className="metric-card u-padding-0-75rem-1rem">
          <div className="metric-label">{t.metricDuplicates}</div>
          <div className="metric-value u-font-size-1-25rem u-color-text-muted">
            {preview.duplicateCount}
          </div>
        </div>
        <div className="metric-card u-padding-0-75rem-1rem">
          <div className="metric-label">{t.metricErrors}</div>
          <div className="metric-value u-font-size-1-25rem u-color-hard">{preview.errorCount}</div>
        </div>
      </div>

      {/* Error Table if any */}
      {preview.errors.length > 0 && (
        <div className="u-margin-bottom-1-5rem">
          <div className="u-font-weight-600 u-color-danger u-margin-bottom-0-5rem u-font-size-0-875rem">
            {t.errorTableTitle.replace('{count}', String(preview.errors.length))}
          </div>
          <div className="table-container u-max-height-200px u-overflow-y-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th className="u-width-70px">{t.tableLine}</th>
                  <th>{t.tableError}</th>
                  <th>{t.tableSnippet}</th>
                </tr>
              </thead>
              <tbody>
                {preview.errors.map((err, idx) => (
                  <tr key={idx}>
                    <td className="u-font-weight-600 u-color-danger">#{err.line}</td>
                    <td className="u-color-danger">{err.message}</td>
                    <td className="u-font-family-monospace u-font-size-13px u-color-text-muted">
                      {err.snippet || '-'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Sample Changes Preview */}
      {preview.sampleItems.length > 0 && (
        <div className="u-margin-bottom-1-5rem">
          <div className="u-font-weight-600 u-color-text-main u-margin-bottom-0-5rem u-font-size-0-875rem">
            {t.sampleTitle.replace('{count}', String(preview.sampleItems.length))}
          </div>
          <div className="table-container u-max-height-240px u-overflow-y-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th className="u-width-70px">{t.tableId}</th>
                  <th>{t.tableTitle}</th>
                  <th className="u-width-90px">{t.tableDifficulty}</th>
                  <th className="u-width-100px">{t.tableAction}</th>
                  <th>{t.tableChanges}</th>
                </tr>
              </thead>
              <tbody>
                {preview.sampleItems.map((item, idx) => (
                  <tr key={idx}>
                    <td className="u-font-weight-600">#{item.frontendId}</td>
                    <td>{item.title}</td>
                    <td>
                      <span className={`badge badge-${item.difficulty.toLowerCase()}`}>
                        {item.difficulty}
                      </span>
                    </td>
                    <td>
                      <span
                        className="badge"
                        style={{
                          backgroundColor:
                            item.action === 'insert'
                              ? 'var(--success-bg)'
                              : item.action === 'update'
                                ? 'var(--selected)'
                                : 'var(--bg-card-muted)',
                          color:
                            item.action === 'insert'
                              ? 'var(--easy)'
                              : item.action === 'update'
                                ? 'var(--primary)'
                                : 'var(--text-muted)',
                        }}
                      >
                        {item.action === 'insert'
                          ? t.actionInsert
                          : item.action === 'update'
                            ? t.actionUpdate
                            : t.actionUnchanged}
                      </span>
                    </td>
                    <td className="u-font-size-13px u-color-text-muted">
                      {item.changes && item.changes.length > 0 ? item.changes.join(', ') : '-'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Commit Button */}
      <div className="u-display-flex u-align-items-center u-gap-1rem u-margin-top-1-25rem">
        <button
          className="btn btn-primary u-padding-0-625rem-1-25rem u-font-size-0-9375rem"
          onClick={onCommit}
          disabled={commitLoading || preview.validCount === 0}
        >
          <CheckCircle2 size={16} />
          {commitLoading ? (lang === 'zh' ? '正在导入…' : 'Importing…') : t.btnCommit}
        </button>
        <span className="u-font-size-0-8125rem u-color-text-muted">
          {preview.validCount > 0
            ? lang === 'zh'
              ? `将把 ${preview.validCount} 道有效题目导入本地题库`
              : `Will import ${preview.validCount} valid problems into your catalog`
            : lang === 'zh'
              ? '没有可提交的有效记录'
              : 'No valid records to commit'}
        </span>
      </div>
    </div>
  );
};
