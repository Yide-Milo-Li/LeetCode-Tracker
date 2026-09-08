/**
 * LeetCode Progress Ingestion & Gemini Assistant Workbench.
 * Provides raw text pasting, AI-assisted structured extraction via Gemini,
 * preflight preview diff inspection, conflict detection and explicit confirmation,
 * atomic commit execution, and overall practice statistics.
 */
import React, { useState, useEffect } from 'react';
import {
  Sparkles,
  Bot,
  AlertTriangle,
  CheckCircle2,
  AlertCircle,
  RotateCcw,
  Layers,
  Database,
  CheckSquare,
  Square,
  History,
  TrendingUp,
} from 'lucide-react';
import {
  api,
  type GeminiStatus,
  type ProgressCandidateInput,
  type ProgressImportPreview,
  type ProgressPreviewItem,
  type PracticeStats,
  type ProgressSnapshot,
} from '../api.ts';
import { translations, type Language } from '../i18n.ts';

interface ProgressWorkbenchProps {
  lang: Language;
}

export const ProgressWorkbench: React.FC<ProgressWorkbenchProps> = ({ lang }) => {
  const t = translations[lang];

  // Global Practice Stats
  const [stats, setStats] = useState<PracticeStats | null>(null);
  const [statsLoading, setStatsLoading] = useState(true);

  // Gemini Status
  const [geminiStatus, setGeminiStatus] = useState<GeminiStatus | null>(null);

  // Form State
  const [rawText, setRawText] = useState('');
  const [batchYear, setBatchYear] = useState<number>(new Date().getFullYear());
  const [candidates, setCandidates] = useState<ProgressCandidateInput[]>([]);
  const [unparsedSnippets, setUnparsedSnippets] = useState<string[]>([]);

  // Processing & Preview States
  const [parsingAI, setParsingAI] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [commitLoading, setCommitLoading] = useState(false);
  const [preview, setPreview] = useState<ProgressImportPreview | null>(null);
  const [confirmedConflicts, setConfirmedConflicts] = useState<Set<string>>(new Set());

  // Feedback Messages
  const [alertMsg, setAlertMsg] = useState<{ type: 'success' | 'danger' | 'info'; text: string } | null>(null);

  // Current Snapshots Browser
  const [snapshots, setSnapshots] = useState<ProgressSnapshot[]>([]);
  const [snapshotsTotal, setSnapshotsTotal] = useState(0);
  const [snapshotsPage, setSnapshotsPage] = useState(1);
  const [loadingSnapshots, setLoadingSnapshots] = useState(false);

  useEffect(() => {
    loadStats();
    loadGeminiStatus();
    loadSnapshots();
  }, []);

  async function loadStats() {
    setStatsLoading(true);
    try {
      const data = await api.getPracticeStats();
      setStats(data);
    } catch (err) {
      console.error('Failed to load practice stats:', err);
    } finally {
      setStatsLoading(false);
    }
  }

  async function loadGeminiStatus() {
    try {
      const status = await api.getProgressImportStatus();
      setGeminiStatus(status);
    } catch (err) {
      console.error('Failed to query Gemini status:', err);
    }
  }

  async function loadSnapshots(page = 1) {
    setLoadingSnapshots(true);
    try {
      const res = await api.getProgressSnapshots(page, 20);
      setSnapshots(res.items);
      setSnapshotsTotal(res.total);
      setSnapshotsPage(page);
    } catch (err) {
      console.error('Failed to load snapshots:', err);
    } finally {
      setLoadingSnapshots(false);
    }
  }

  // Handle Gemini AI Parsing
  async function handleFormatWithAI() {
    if (!rawText.trim()) return;
    setParsingAI(true);
    setAlertMsg(null);
    setPreview(null);
    setConfirmedConflicts(new Set());

    try {
      const res = await api.formatWithGemini(rawText, batchYear || undefined);
      setCandidates(res.candidates);
      setUnparsedSnippets(res.unparsedSnippets);
      setAlertMsg({
        type: 'info',
        text: t.formatSuccess.replace('{count}', String(res.candidates.length)) +
          (res.unparsedSnippets.length > 0
            ? ` (${t.unparsedWarning.replace('{count}', String(res.unparsedSnippets.length))})`
            : ''),
      });

      // Automatically generate preview for the structured candidates
      if (res.candidates.length > 0) {
        await generatePreview(res.candidates);
      }
    } catch (err) {
      setAlertMsg({ type: 'danger', text: err instanceof Error ? err.message : 'AI parsing failed' });
    } finally {
      setParsingAI(false);
    }
  }

  // Generate Preflight Preview
  async function generatePreview(cands = candidates) {
    if (cands.length === 0) return;
    setPreviewLoading(true);
    setAlertMsg(null);

    try {
      const p = await api.previewProgressImport(cands, undefined, batchYear || undefined);
      setPreview(p);
      setConfirmedConflicts(new Set());
    } catch (err) {
      setAlertMsg({ type: 'danger', text: err instanceof Error ? err.message : 'Preview generation failed' });
    } finally {
      setPreviewLoading(false);
    }
  }

  // Toggle single conflict confirmation
  function toggleConflictConfirmation(frontendId: string) {
    setConfirmedConflicts((prev) => {
      const next = new Set(prev);
      if (next.has(frontendId)) {
        next.delete(frontendId);
      } else {
        next.add(frontendId);
      }
      return next;
    });
  }

  // Confirm all conflicts
  function handleConfirmAllConflicts() {
    if (!preview) return;
    const allConflictIds = preview.items
      .filter((i) => i.action === 'conflict')
      .map((i) => i.frontendId);
    setConfirmedConflicts(new Set(allConflictIds));
  }

  // Commit Import
  async function handleCommit() {
    if (!preview) return;
    setCommitLoading(true);
    setAlertMsg(null);

    try {
      const confirmedIds = Array.from(confirmedConflicts);
      const summary = await api.commitProgressImport(preview.previewId, confirmedIds);

      setAlertMsg({
        type: 'success',
        text: t.progressCommitSuccess
          .replace('{inserted}', String(summary.insertedCount))
          .replace('{updated}', String(summary.updatedCount))
          .replace('{unchanged}', String(summary.unchangedCount)),
      });

      // Reset form
      setPreview(null);
      setCandidates([]);
      setRawText('');
      setConfirmedConflicts(new Set());

      // Refresh stats and snapshots
      await loadStats();
      await loadSnapshots(1);
    } catch (err) {
      setAlertMsg({ type: 'danger', text: err instanceof Error ? err.message : 'Commit failed' });
    } finally {
      setCommitLoading(false);
    }
  }

  function handleClear() {
    setRawText('');
    setCandidates([]);
    setUnparsedSnippets([]);
    setPreview(null);
    setAlertMsg(null);
    setConfirmedConflicts(new Set());
  }

  // Translate conflict types
  function getConflictLabel(type?: string): string {
    switch (type) {
      case 'older_date':
        return t.conflictOlderDate;
      case 'decreased_submissions':
        return t.conflictDecreasedSubmissions;
      case 'conflicting_result_same_date_count':
        return t.conflictSameDateDiffResult;
      case 'intra_batch_contradiction':
        return t.conflictIntraBatch;
      case 'unmatched_problem':
        return t.conflictUnmatched;
      default:
        return type || 'Conflict';
    }
  }

  return (
    <div>
      {/* 1. Overview Practice & Solved Metrics */}
      <div className="metrics-grid" style={{ marginBottom: '1.5rem' }}>
        <div className="metric-card">
          <div className="metric-label" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <TrendingUp size={16} style={{ color: 'var(--primary)' }} />
            {t.statSolvedProblems}
          </div>
          <div className="metric-value" style={{ color: 'var(--primary)' }}>
            {stats?.uniqueSolvedProblems ?? 0}
          </div>
          <div className="metric-sub">
            {stats?.acceptedSnapshots ?? 0} {t.statAcceptedSnapshots.toLowerCase()}
          </div>
        </div>

        <div className="metric-card">
          <div className="metric-label">{t.statManualPractices}</div>
          <div className="metric-value">{stats?.totalManualPractices ?? 0}</div>
          <div className="metric-sub">
            {stats?.completedManualPractices ?? 0} {t.statusSolved.toLowerCase()}
          </div>
        </div>

        <div className="metric-card">
          <div className="metric-label">{t.statSnapshots}</div>
          <div className="metric-value">{stats?.totalSnapshots ?? 0}</div>
          <div className="metric-sub">
            {stats?.acceptedSnapshots ?? 0} {t.statAcceptedSnapshots.toLowerCase()}
          </div>
        </div>

        <div className="metric-card">
          <div className="metric-label" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Bot size={16} style={{ color: geminiStatus?.configured ? 'var(--easy)' : 'var(--warning)' }} />
            {t.geminiStatus}
          </div>
          <div style={{ fontSize: '1rem', fontWeight: 600, marginTop: '0.5rem' }}>
            {geminiStatus?.configured
              ? t.geminiActive.replace('{model}', geminiStatus.model)
              : t.geminiNotConfigured}
          </div>
          <div className="metric-sub">Structured Outputs Engine</div>
        </div>
      </div>

      {/* 2. Ingestion Workbench Form */}
      <div className="card" style={{ marginBottom: '1.5rem' }}>
        <h2 className="card-title">
          <Sparkles size={20} style={{ color: 'var(--primary)' }} />
          {t.progressWorkbenchTitle}
        </h2>
        <p className="card-desc">{t.progressWorkbenchDesc}</p>

        {alertMsg && (
          <div className={`alert alert-${alertMsg.type}`} role="alert" style={{ marginBottom: '1rem' }}>
            {alertMsg.type === 'success' && <CheckCircle2 size={16} />}
            {alertMsg.type === 'danger' && <AlertCircle size={16} />}
            {alertMsg.type === 'info' && <Sparkles size={16} />}
            <span>{alertMsg.text}</span>
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.25rem' }}>
              <label style={{ fontSize: '0.875rem', fontWeight: 600 }}>{t.rawTextLabel}</label>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <label style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{t.batchYearLabel}:</label>
                <input
                  type="number"
                  className="input-field"
                  style={{ width: '80px', padding: '0.2rem 0.5rem', fontSize: '0.75rem' }}
                  value={batchYear}
                  min={1970}
                  max={2100}
                  onChange={(e) => setBatchYear(Number(e.target.value))}
                />
              </div>
            </div>
            <textarea
              className="paste-textarea"
              style={{ height: '140px' }}
              placeholder={t.rawTextPlaceholder}
              value={rawText}
              onChange={(e) => setRawText(e.target.value)}
            />
          </div>

          <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
            <button
              className="btn btn-primary"
              onClick={handleFormatWithAI}
              disabled={parsingAI || !rawText.trim() || !geminiStatus?.configured}
            >
              <Bot size={16} />
              {parsingAI ? t.parsingAI : t.btnFormatAI}
            </button>

            <button
              className="btn btn-outline"
              onClick={() => generatePreview()}
              disabled={previewLoading || candidates.length === 0}
            >
              <Layers size={16} />
              {previewLoading ? 'Previewing...' : t.btnPreviewProgress}
            </button>

            <button
              className="btn btn-outline"
              onClick={handleClear}
              disabled={!rawText && candidates.length === 0 && !preview}
            >
              <RotateCcw size={16} />
              {t.btnClear}
            </button>
          </div>
        </div>

        {/* 3. Preflight Preview Section */}
        {preview && (
          <div style={{ marginTop: '2rem', borderTop: '1px solid var(--border-color)', paddingTop: '1.5rem' }}>
            <h3 className="card-title" style={{ fontSize: '1.125rem' }}>
              <Layers size={18} style={{ color: 'var(--primary)' }} />
              {t.previewProgressTitle}
            </h3>

            {/* Metrics badges */}
            <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', margin: '1rem 0' }}>
              <span className="badge" style={{ backgroundColor: 'var(--bg-card-muted)' }}>
                {t.metricTotalLines}: {preview.totalCandidates}
              </span>
              <span className="badge" style={{ backgroundColor: 'var(--success-bg)', color: 'var(--easy)' }}>
                {t.metricInsert}: +{preview.insertCount}
              </span>
              <span className="badge" style={{ backgroundColor: '#dbeafe', color: '#1d4ed8' }}>
                {t.metricUpdate}: ~{preview.updateCount}
              </span>
              <span className="badge" style={{ backgroundColor: 'var(--bg-card-muted)', color: 'var(--text-muted)' }}>
                {t.metricUnchanged}: {preview.unchangedCount}
              </span>
              {preview.conflictCount > 0 && (
                <span className="badge" style={{ backgroundColor: 'var(--warning-bg)', color: 'var(--warning)' }}>
                  {t.metricConflicts}: {preview.conflictCount}
                </span>
              )}
              {preview.duplicateCount > 0 && (
                <span className="badge" style={{ backgroundColor: 'var(--bg-card-muted)' }}>
                  {t.metricDuplicates}: {preview.duplicateCount}
                </span>
              )}
              {preview.errorCount > 0 && (
                <span className="badge" style={{ backgroundColor: 'var(--danger-bg)', color: 'var(--danger)' }}>
                  {t.metricErrors}: {preview.errorCount}
                </span>
              )}
            </div>

            {/* Conflict Warning & Confirmation Header */}
            {preview.conflictCount > 0 && (
              <div
                className="alert alert-info"
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  backgroundColor: 'var(--warning-bg)',
                  borderColor: 'var(--warning)',
                  color: 'var(--text-main)',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <AlertTriangle size={18} style={{ color: 'var(--warning)' }} />
                  <span>
                    {lang === 'zh'
                      ? `检测到 ${preview.conflictCount} 项数据冲突。如需覆盖已有进度，请勾选对应行的复选框。`
                      : `Detected ${preview.conflictCount} conflict(s). Check the box on each conflict row to confirm override.`}
                  </span>
                </div>
                <button className="btn btn-outline btn-sm" onClick={handleConfirmAllConflicts}>
                  {t.confirmAllConflicts}
                </button>
              </div>
            )}

            {/* Candidate Diff Table */}
            <div className="table-container" style={{ maxHeight: '400px', overflowY: 'auto' }}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th style={{ width: '40px' }}></th>
                    <th style={{ width: '80px' }}>{t.tableId}</th>
                    <th>{t.tableTitle}</th>
                    <th>{t.tableAction}</th>
                    <th>{t.tableCurrent}</th>
                    <th>{t.tableIncoming}</th>
                    <th>{t.tableConflictReason}</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.items.map((item) => {
                    const isConflict = item.action === 'conflict';
                    const isConfirmed = confirmedConflicts.has(item.frontendId);

                    return (
                      <tr
                        key={item.frontendId}
                        style={{
                          backgroundColor: isConflict && !isConfirmed ? 'rgba(217, 119, 6, 0.05)' : undefined,
                        }}
                      >
                        <td>
                          {isConflict ? (
                            <button
                              type="button"
                              onClick={() => toggleConflictConfirmation(item.frontendId)}
                              style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
                              title={t.tableConfirmOverride}
                            >
                              {isConfirmed ? (
                                <CheckSquare size={16} style={{ color: 'var(--primary)' }} />
                              ) : (
                                <Square size={16} style={{ color: 'var(--text-muted)' }} />
                              )}
                            </button>
                          ) : null}
                        </td>
                        <td style={{ fontWeight: 600, color: 'var(--text-muted)' }}>
                          #{item.frontendId}
                        </td>
                        <td>
                          <div style={{ fontWeight: 500 }}>{item.problemTitle || '-'}</div>
                          {item.difficulty && (
                            <span className={`badge badge-${item.difficulty.toLowerCase()}`}>
                              {item.difficulty}
                            </span>
                          )}
                        </td>
                        <td>
                          <span
                            className="badge"
                            style={{
                              backgroundColor:
                                item.action === 'insert'
                                  ? 'var(--success-bg)'
                                  : item.action === 'update'
                                  ? '#dbeafe'
                                  : item.action === 'conflict'
                                  ? 'var(--warning-bg)'
                                  : 'var(--bg-card-muted)',
                              color:
                                item.action === 'insert'
                                  ? 'var(--easy)'
                                  : item.action === 'update'
                                  ? '#1d4ed8'
                                  : item.action === 'conflict'
                                  ? 'var(--warning)'
                                  : 'var(--text-muted)',
                            }}
                          >
                            {item.action === 'insert'
                              ? t.actionInsert
                              : item.action === 'update'
                              ? t.actionUpdate
                              : item.action === 'conflict'
                              ? t.actionConflict
                              : item.action === 'duplicate'
                              ? t.actionDuplicate
                              : item.action === 'error'
                              ? t.actionError
                              : t.actionUnchanged}
                          </span>
                        </td>
                        <td style={{ fontSize: '0.8125rem', color: 'var(--text-muted)' }}>
                          {item.currentSnapshot ? (
                            <div>
                              <div>{item.currentSnapshot.lastResult} ({item.currentSnapshot.totalSubmissions} subs)</div>
                              <div>{item.currentSnapshot.lastSubmittedAt.slice(0, 10)}</div>
                            </div>
                          ) : (
                            '-'
                          )}
                        </td>
                        <td style={{ fontSize: '0.8125rem' }}>
                          <div style={{ fontWeight: 500 }}>
                            {item.incomingSnapshot.lastResult} ({item.incomingSnapshot.totalSubmissions} subs)
                          </div>
                          <div style={{ color: 'var(--text-muted)' }}>
                            {item.incomingSnapshot.lastSubmittedAt.slice(0, 10)}
                          </div>
                        </td>
                        <td style={{ fontSize: '0.75rem', color: isConflict ? 'var(--warning)' : 'var(--text-muted)' }}>
                          {item.conflictReason || getConflictLabel(item.conflictType) || item.error || '-'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Commit Button */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginTop: '1.25rem' }}>
              <button
                className="btn btn-primary"
                onClick={handleCommit}
                disabled={commitLoading || preview.validCount === 0}
                style={{ padding: '0.625rem 1.25rem', fontSize: '0.9375rem' }}
              >
                <CheckCircle2 size={16} />
                {commitLoading ? (lang === 'zh' ? '正在写入数据库...' : 'Committing to SQLite...') : t.btnCommitProgress}
              </button>
              <span style={{ fontSize: '0.8125rem', color: 'var(--text-muted)' }}>
                {preview.conflictCount > 0 && confirmedConflicts.size < preview.conflictCount
                  ? (lang === 'zh'
                    ? `注意：${preview.conflictCount - confirmedConflicts.size} 个未确认的冲突项将被跳过`
                    : `Note: ${preview.conflictCount - confirmedConflicts.size} unconfirmed conflict(s) will be skipped`)
                  : (lang === 'zh'
                    ? '准备就绪，提交将原子写入本地数据库'
                    : 'Ready to persist changes atomically into local database')}
              </span>
            </div>
          </div>
        )}
      </div>

      {/* 4. Current Saved Snapshots List */}
      <div className="card">
        <h2 className="card-title">
          <Database size={20} style={{ color: 'var(--primary)' }} />
          {lang === 'zh' ? '当前已存储进度快照' : 'Persisted Progress Snapshots'}
        </h2>
        <p className="card-desc">
          {lang === 'zh'
            ? '每道题目在本地保留唯一样本快照与版本历史审计。'
            : 'Single current progress snapshot maintained per problem with version history.'}
        </p>

        {loadingSnapshots ? (
          <p style={{ color: 'var(--text-muted)', fontSize: '0.875rem' }}>Loading snapshots...</p>
        ) : snapshots.length === 0 ? (
          <p style={{ color: 'var(--text-muted)', fontSize: '0.875rem' }}>
            {lang === 'zh' ? '暂无存储的进度快照。' : 'No progress snapshots saved yet.'}
          </p>
        ) : (
          <div className="table-container">
            <table className="data-table">
              <thead>
                <tr>
                  <th style={{ width: '80px' }}>{t.tableId}</th>
                  <th>{t.tableTitle}</th>
                  <th>{t.tableDifficulty}</th>
                  <th>{t.tableLastResult}</th>
                  <th>{t.tableSubmissions}</th>
                  <th>{t.tableLastDate}</th>
                  <th>Version</th>
                </tr>
              </thead>
              <tbody>
                {snapshots.map((s) => (
                  <tr key={s.questionId}>
                    <td style={{ fontWeight: 600, color: 'var(--text-muted)' }}>#{s.questionFrontendId}</td>
                    <td style={{ fontWeight: 500 }}>{s.problemTitle}</td>
                    <td>
                      <span className={`badge badge-${s.difficulty.toLowerCase()}`}>
                        {s.difficulty}
                      </span>
                    </td>
                    <td>
                      <span
                        className="badge"
                        style={{
                          backgroundColor: s.hasAccepted ? 'var(--success-bg)' : 'var(--bg-card-muted)',
                          color: s.hasAccepted ? 'var(--easy)' : 'var(--text-muted)',
                        }}
                      >
                        {s.lastResult}
                      </span>
                    </td>
                    <td>{s.totalSubmissions}</td>
                    <td style={{ fontSize: '0.8125rem', color: 'var(--text-muted)' }}>
                      {s.lastSubmittedAt.slice(0, 10)}
                    </td>
                    <td style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>v{s.version}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Pagination */}
        {snapshotsTotal > 20 && (
          <div className="pagination-bar">
            <div style={{ fontSize: '0.875rem', color: 'var(--text-muted)' }}>
              {t.pageInfo
                .replace('{page}', String(snapshotsPage))
                .replace('{totalPages}', String(Math.ceil(snapshotsTotal / 20)))
                .replace('{total}', String(snapshotsTotal))}
            </div>
            <div className="pagination-controls">
              <button
                className="btn btn-outline btn-sm"
                disabled={snapshotsPage <= 1}
                onClick={() => loadSnapshots(snapshotsPage - 1)}
              >
                {t.prev}
              </button>
              <button
                className="btn btn-outline btn-sm"
                disabled={snapshotsPage >= Math.ceil(snapshotsTotal / 20)}
                onClick={() => loadSnapshots(snapshotsPage + 1)}
              >
                {t.next}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
