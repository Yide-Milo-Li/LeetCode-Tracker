/**
 * Manual practice logging modal dialog.
 * Enables quick recording of manual practice sessions with datetime/date precision,
 * completed status, reflective notes, and viewing/revoking previous practice history.
 */
import React, { useState, useEffect } from 'react';
import { X, Calendar, CheckCircle2, History, AlertCircle, Trash2 } from 'lucide-react';
import { api, type CatalogProblem, type PracticeRecord, type TimePrecision } from '../api.ts';
import { translations, type Language } from '../i18n.ts';

interface PracticeLogModalProps {
  problem: CatalogProblem;
  lang: Language;
  onClose: () => void;
  onRecordSaved?: () => void;
}

export const PracticeLogModal: React.FC<PracticeLogModalProps> = ({
  problem,
  lang,
  onClose,
  onRecordSaved,
}) => {
  const t = translations[lang];

  // Precision & Timestamps
  const [precision, setPrecision] = useState<TimePrecision>('datetime');
  // Default to now in local ISO string for input
  const now = new Date();
  const defaultDatetime = new Date(now.getTime() - now.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
  const defaultDate = now.toISOString().slice(0, 10);

  const [practicedAtInput, setPracticedAtInput] = useState(defaultDatetime);
  const [completed, setCompleted] = useState(true);
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  // History for this problem
  const [records, setRecords] = useState<PracticeRecord[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(true);

  useEffect(() => {
    loadRecords();
  }, [problem.questionFrontendId]);

  async function loadRecords() {
    setLoadingHistory(true);
    try {
      const res = await api.getPracticeRecords({
        questionFrontendId: problem.questionFrontendId,
        status: 'all',
      });
      setRecords(res.items);
    } catch (err) {
      console.error('Failed to load practice history:', err);
    } finally {
      setLoadingHistory(false);
    }
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setErrorMsg(null);
    setSuccessMsg(null);

    try {
      let isoTimestamp: string;
      if (precision === 'datetime') {
        const parsedDate = new Date(practicedAtInput);
        if (Number.isNaN(parsedDate.getTime())) {
          throw new Error('Invalid datetime input');
        }
        isoTimestamp = parsedDate.toISOString();
      } else {
        isoTimestamp = practicedAtInput;
      }

      await api.createPracticeRecord({
        questionFrontendId: problem.questionFrontendId,
        completed,
        practicedAt: isoTimestamp,
        timePrecision: precision,
        notes: notes.trim() || undefined,
      });

      setSuccessMsg(t.practiceLoggedSuccess);
      setNotes('');
      await loadRecords();
      if (onRecordSaved) onRecordSaved();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to save practice record');
    } finally {
      setSaving(false);
    }
  }

  async function handleRevoke(recordId: string) {
    try {
      await api.revokePracticeRecord(recordId);
      await loadRecords();
      if (onRecordSaved) onRecordSaved();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to revoke practice record');
    }
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(0, 0, 0, 0.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
        padding: '1rem',
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="card"
        style={{
          width: '100%',
          maxWidth: '560px',
          maxHeight: '90vh',
          overflowY: 'auto',
          position: 'relative',
          marginBottom: 0,
        }}
      >
        <button
          onClick={onClose}
          style={{
            position: 'absolute',
            right: '1rem',
            top: '1rem',
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            color: 'var(--text-muted)',
          }}
          aria-label="Close"
        >
          <X size={20} />
        </button>

        <h3 className="card-title" style={{ paddingRight: '2rem' }}>
          <Calendar size={20} style={{ color: 'var(--primary)' }} />
          {t.quickLogTitle}: #{problem.questionFrontendId} {problem.title}
        </h3>

        {successMsg && (
          <div className="alert alert-success" role="status">
            <CheckCircle2 size={16} />
            <span>{successMsg}</span>
          </div>
        )}

        {errorMsg && (
          <div className="alert alert-danger" role="alert">
            <AlertCircle size={16} />
            <span>{errorMsg}</span>
          </div>
        )}

        <form onSubmit={handleSave} style={{ display: 'flex', flexDirection: 'column', gap: '1rem', marginTop: '1rem' }}>
          {/* Timestamp precision and input */}
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.25rem' }}>
              <label style={{ fontSize: '0.875rem', fontWeight: 600 }}>{t.practicedAtLabel}</label>
              <div style={{ display: 'flex', gap: '0.5rem', fontSize: '0.75rem' }}>
                <button
                  type="button"
                  className={`btn btn-sm ${precision === 'datetime' ? 'btn-primary' : 'btn-outline'}`}
                  onClick={() => {
                    setPrecision('datetime');
                    setPracticedAtInput(defaultDatetime);
                  }}
                  style={{ padding: '0.2rem 0.5rem' }}
                >
                  {t.precisionDatetime}
                </button>
                <button
                  type="button"
                  className={`btn btn-sm ${precision === 'date' ? 'btn-primary' : 'btn-outline'}`}
                  onClick={() => {
                    setPrecision('date');
                    setPracticedAtInput(defaultDate);
                  }}
                  style={{ padding: '0.2rem 0.5rem' }}
                >
                  {t.precisionDate}
                </button>
              </div>
            </div>
            <input
              type={precision === 'datetime' ? 'datetime-local' : 'date'}
              className="input-field"
              style={{ width: '100%' }}
              value={practicedAtInput}
              onChange={(e) => setPracticedAtInput(e.target.value)}
              required
            />
          </div>

          {/* Solved / Completed Toggle */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <input
              type="checkbox"
              id="completedCheckbox"
              checked={completed}
              onChange={(e) => setCompleted(e.target.checked)}
              style={{ width: '18px', height: '18px', cursor: 'pointer' }}
            />
            <label htmlFor="completedCheckbox" style={{ fontSize: '0.875rem', fontWeight: 500, cursor: 'pointer' }}>
              {t.completedLabel}
            </label>
          </div>

          {/* Notes textarea */}
          <div>
            <label style={{ display: 'block', fontSize: '0.875rem', fontWeight: 600, marginBottom: '0.25rem' }}>
              {t.notesLabel}
            </label>
            <textarea
              className="paste-textarea"
              style={{ height: '90px' }}
              placeholder={t.notesPlaceholder}
              value={notes}
              maxLength={2000}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>

          {/* Buttons */}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.75rem' }}>
            <button type="button" className="btn btn-outline btn-sm" onClick={onClose}>
              {t.btnCancel}
            </button>
            <button type="submit" className="btn btn-primary btn-sm" disabled={saving}>
              <CheckCircle2 size={16} />
              {saving ? t.savingPractice : t.btnSavePractice}
            </button>
          </div>
        </form>

        {/* Existing Practice History for this problem */}
        <div style={{ marginTop: '1.5rem', borderTop: '1px solid var(--border-color)', paddingTop: '1rem' }}>
          <h4 style={{ fontSize: '0.875rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
            <History size={16} style={{ color: 'var(--primary)' }} />
            {t.practiceHistory}
          </h4>

          {loadingHistory ? (
            <p style={{ fontSize: '0.8125rem', color: 'var(--text-muted)' }}>Loading history...</p>
          ) : records.length === 0 ? (
            <p style={{ fontSize: '0.8125rem', color: 'var(--text-muted)' }}>{t.noPracticeHistory}</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              {records.map((r) => (
                <div
                  key={r.id}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'flex-start',
                    padding: '0.5rem 0.75rem',
                    backgroundColor: 'var(--bg-card-muted)',
                    borderRadius: 'var(--radius)',
                    fontSize: '0.8125rem',
                    opacity: r.status === 'revoked' ? 0.6 : 1,
                  }}
                >
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.25rem' }}>
                      <span
                        className="badge"
                        style={{
                          backgroundColor: r.completed ? 'var(--success-bg)' : 'var(--bg-card)',
                          color: r.completed ? 'var(--easy)' : 'var(--text-muted)',
                        }}
                      >
                        {r.completed ? t.statusSolved : t.statusUnsolved}
                      </span>
                      <span style={{ color: 'var(--text-muted)' }}>
                        {new Date(r.practicedAt).toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-US')}
                      </span>
                      {r.status === 'revoked' && (
                        <span className="badge" style={{ backgroundColor: 'var(--danger-bg)', color: 'var(--danger)' }}>
                          {t.recordRevoked}
                        </span>
                      )}
                    </div>
                    {r.notes && (
                      <div style={{ color: 'var(--text-main)', marginTop: '0.25rem', whiteSpace: 'pre-wrap' }}>
                        {r.notes}
                      </div>
                    )}
                  </div>

                  {r.status === 'active' && (
                    <button
                      className="btn btn-outline btn-sm"
                      style={{ padding: '0.2rem 0.4rem', color: 'var(--danger)' }}
                      title={t.btnRevoke}
                      onClick={() => handleRevoke(r.id)}
                    >
                      <Trash2 size={13} />
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
