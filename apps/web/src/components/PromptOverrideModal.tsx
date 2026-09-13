/**
 * Prompt Override Modal component.
 * Allows users to temporarily adjust today's recommendation plan using natural language
 * or manual fine-tuning, with live diff preview, candidate counts, and quota conflict detection.
 */
import React, { useState, useRef, useEffect } from 'react';
import { Sparkles, AlertTriangle, AlertCircle, CheckCircle2, X, ArrowRight } from 'lucide-react';
import { api, type DailyPlan, type OverridePreview, type RulePatch } from '../api.ts';
import { translations, type Language } from '../i18n.ts';
import { Dialog } from './ui.tsx';
import { useWorkspace } from '../workspace.tsx';

interface PromptOverrideModalProps {
  isOpen: boolean;
  onClose: () => void;
  onApplied: (plan: DailyPlan) => void;
  currentPlan: DailyPlan | null;
  lang: Language;
}

export const PromptOverrideModal: React.FC<PromptOverrideModalProps> = ({
  isOpen,
  onClose,
  onApplied,
  currentPlan,
  lang,
}) => {
  const t = translations[lang];

  const [tagsText, setTagsText] = useState('');
  const [draft, setDraft] = useState<RulePatch>({});
  const requestVersion = useRef(0);
  useEffect(() => {
    requestVersion.current++;
    setPreview(null);
    setLoading(false);
  }, [isOpen]);
  const [prompt, setPrompt] = useState('');
  const [parsedPrompt, setParsedPrompt] = useState('');
  const [loading, setLoading] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [preview, setPreview] = useState<OverridePreview | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  /** Explicit manual correction replaces unverified natural-language requirements. */
  async function handleParse(manual = false) {
    const trimmed = prompt.trim();
    if (!trimmed && !manual) return;
    const version = ++requestVersion.current;
    setPreview(null);
    setLoading(true);
    setError(null);
    try {
      const prev = await api.previewDailyPlanOverride({
        ...(manual ? { rules: draft } : { prompt: trimmed }),
        date: currentPlan?.date,
      });
      if (version !== requestVersion.current) return;
      const merged = { ...(prev.base ?? {}), ...prev.rules };
      setDraft(merged);
      setTagsText(merged.tags?.join(', ') ?? '');
      setPreview(prev);
      setParsedPrompt(trimmed);
    } catch (err: any) {
      if (version === requestVersion.current) setError(err.message || 'Failed to parse prompt with AI.');
    } finally {
      if (version === requestVersion.current) setLoading(false);
    }
  }

  async function handleCommit() {
    if (!preview || preview.issues.length || preview.unresolved.length || loading || committing) return;
    setCommitting(true);
    setError(null);
    try {
      const updated = await api.commitDailyPlanOverride(preview.id, preview.planVersion);
      onApplied(updated);
      onClose();
    } catch (err: any) {
      setError(err.message || 'Failed to apply prompt override.');
    } finally {
      setCommitting(false);
    }
  }

  /** Any rule edit invalidates the prior confirmation, including a pending response. */
  function edit(patch: RulePatch) {
    requestVersion.current++;
    setDraft((previous) => ({ ...previous, ...patch }));
    setPreview(null);
    setError(null);
    setLoading(false);
  }

  const ruleLabels: Record<keyof RulePatch, string> =
    lang === 'zh'
      ? {
          dailyCount: '每日题数',
          difficulty: '难度比例',
          tags: '标签',
          premium: '包含 Premium',
          reviewEnabled: '启用复习',
          reviewPercent: '复习占比',
          preference: '软偏好',
          focusWeakTags: '薄弱专项突击',
          adaptiveReviewEnabled: '自适应复习',
        }
      : {
          dailyCount: 'Daily count',
          difficulty: 'Difficulty',
          tags: 'Tags',
          premium: 'Include Premium',
          reviewEnabled: 'Include review',
          reviewPercent: 'Review share',
          preference: 'Soft preference',
          focusWeakTags: 'Focus weak topics',
          adaptiveReviewEnabled: 'Adaptive review',
        };

  return (
    <Dialog
      closeDisabled={committing}
      title={lang === 'zh' ? '调整今天' : 'Adjust today'}
      lang={lang}
      onClose={onClose}
      drawer
    >
      <div className="override-modal">
        <div className="modal-body">
          <div className="override-notice">{t.overrideWarning}</div>

          {/* Prompt input */}
          <div className="form-group">
            <label className="form-label">{t.promptOverride}</label>
            <textarea
              aria-label={t.promptOverride}
              className="form-textarea"
              rows={3}
              value={prompt}
              onChange={(e) => {
                setPrompt(e.target.value);
                setPreview(null);
                setError(null);
              }}
              placeholder={t.overridePromptPlaceholder}
              disabled={loading || committing}
            />
          </div>

          <div className="modal-actions-row">
            <button
              className="btn btn-primary"
              onClick={() => handleParse()}
              disabled={loading || committing || !prompt.trim()}
            >
              <Sparkles size={16} />
              {loading ? (lang === 'zh' ? '分析中…' : 'Analyzing…') : t.parsePrompt}
            </button>
          </div>

          {error && (
            <div className="alert alert-danger u-margin-top-1rem">
              <AlertCircle size={16} />
              <span>{error}</span>
            </div>
          )}

          <details className="form-group">
            <summary>{lang === 'zh' ? '手动校对规则' : 'Edit rules manually'}</summary>
            <p>
              {lang === 'zh'
                ? '这些字段是确认后的完整要求；未能解析的要求请在这里重新表达。软偏好不保证严格满足。'
                : 'These fields define your confirmed requirements. Restate unresolved requests here. Soft preferences are not guaranteed.'}
            </p>
            <fieldset disabled={loading || committing}>
              <label>
                {lang === 'zh' ? '每日题数' : 'Daily count'}
                <input
                  type="number"
                  min="1"
                  value={draft.dailyCount ?? ''}
                  onChange={(e) =>
                    edit({ dailyCount: e.target.value === '' ? undefined : Number(e.target.value) })
                  }
                />
              </label>
              {(['Easy', 'Medium', 'Hard'] as const).map((d) => (
                <label key={d}>
                  {d} %
                  <input
                    type="number"
                    min="0"
                    max="100"
                    value={draft.difficulty?.[d] ?? ''}
                    onChange={(e) =>
                      edit({
                        difficulty: {
                          Easy: 0,
                          Medium: 0,
                          Hard: 0,
                          ...draft.difficulty,
                          [d]: Number(e.target.value),
                        },
                      })
                    }
                  />
                </label>
              ))}
              <label>
                {lang === 'zh' ? '标签（逗号分隔，空白不限）' : 'Tags (comma separated; empty means any)'}
                <input
                  value={tagsText}
                  onChange={(e) => {
                    setTagsText(e.target.value);
                    edit({
                      tags: e.target.value
                        .split(',')
                        .map((v) => v.trim())
                        .filter(Boolean),
                    });
                  }}
                />
              </label>
              <label>
                {lang === 'zh' ? '包含 Premium' : 'Include Premium'}
                <input
                  type="checkbox"
                  checked={draft.premium ?? false}
                  onChange={(e) => edit({ premium: e.target.checked })}
                />
              </label>
              <label>
                {lang === 'zh' ? '复习模式' : 'Review mode'}
                <select
                  value={draft.reviewEnabled === undefined ? '' : String(draft.reviewEnabled)}
                  onChange={(e) =>
                    edit({
                      reviewEnabled: e.target.value === '' ? undefined : e.target.value === 'true',
                      reviewPercent: null,
                      ...(e.target.value==='false'?{adaptiveReviewEnabled:false}:{}),
                    })
                  }
                >
                  <option value="">{lang === 'zh' ? '请选择' : 'Choose explicitly'}</option>
                  <option value="false">{lang === 'zh' ? '仅新题' : 'New only'}</option>
                  <option value="true">{lang === 'zh' ? '包含复习' : 'Include review'}</option>
                </select>
              </label>
              {draft.reviewEnabled && (
                <label>
                  {lang === 'zh' ? '复习占比 %' : 'Review share %'}
                  <input
                    type="number"
                    min="1"
                    max="100"
                    value={draft.reviewPercent ?? ''}
                    onChange={(e) =>
                      edit({ reviewPercent: e.target.value === '' ? null : Number(e.target.value) })
                    }
                  />
                </label>
              )}
              <label>
                {lang === 'zh' ? '软偏好' : 'Soft preference'}
                <input
                  value={draft.preference ?? ''}
                  onChange={(e) => edit({ preference: e.target.value })}
                />
              </label>
              <label>
                {t.focusWeakTags}
                <select value={draft.focusWeakTags===undefined?'':String(draft.focusWeakTags)}
                  onChange={e=>edit({focusWeakTags:e.target.value===''?undefined:e.target.value==='true'})}>
                  <option value="">{lang==='zh'?'继承现有规则':'Inherit current rule'}</option>
                  <option value="true">{lang==='zh'?'开启':'On'}</option><option value="false">{lang==='zh'?'关闭':'Off'}</option>
                </select>
              </label>
              <label>
                {t.adaptiveReviewEnabled}
                <select value={draft.adaptiveReviewEnabled===undefined?'':String(draft.adaptiveReviewEnabled)}
                  onChange={e=>edit({adaptiveReviewEnabled:e.target.value===''?undefined:e.target.value==='true'})}>
                  <option value="">{lang==='zh'?'继承现有规则':'Inherit current rule'}</option>
                  <option value="true">{lang==='zh'?'开启':'On'}</option><option value="false">{lang==='zh'?'关闭':'Off'}</option>
                </select>
              </label>
              <p className="text-muted">{t.adaptiveReviewDescription}</p>
              <button className="btn btn-secondary" onClick={() => handleParse(true)}>
                {lang === 'zh' ? '预览校对后的规则' : 'Preview edited rules'}
              </button>
            </fieldset>
          </details>

          {/* Preview result */}
          {preview && (
            <div className="override-preview-card">
              <h4 className="preview-heading">{t.overridePreviewTitle}</h4>

              {/* Validation Issues */}
              {preview.issues.length > 0 && (
                <div className="alert alert-danger u-margin-bottom-1rem">
                  <AlertCircle size={16} />
                  <div>
                    <strong>{t.quotaValidationIssues}:</strong>
                    <ul className="u-padding-left-1-25rem u-margin-top-0-25rem">
                      {preview.issues.map((issue, idx) => (
                        <li key={idx}>{issue}</li>
                      ))}
                    </ul>
                  </div>
                </div>
              )}

              {/* Clarifications / Soft preferences */}
              {preview.unresolved.length > 0 && (
                <div className="alert alert-warning u-margin-bottom-1rem">
                  <AlertTriangle size={16} />
                  <div>
                    <strong>{t.unresolvedWarnings}:</strong>
                    <ul className="u-padding-left-1-25rem u-margin-top-0-25rem">
                      {preview.unresolved.map((unr, idx) => (
                        <li key={idx}>{unr}</li>
                      ))}
                    </ul>
                  </div>
                </div>
              )}

              {/* Quotas & Candidate Counts */}
              <div className="preview-metrics-grid">
                <div className="metric-box">
                  <span className="metric-label">{t.statTotal}</span>
                  <span className="metric-val">
                    {(preview.counts.Easy || 0) + (preview.counts.Medium || 0) + (preview.counts.Hard || 0)}
                  </span>
                </div>
                <div className="metric-box">
                  <span className="metric-label difficulty-easy">{t.statEasy}</span>
                  <span className="metric-val">{preview.counts.Easy || 0}</span>
                </div>
                <div className="metric-box">
                  <span className="metric-label difficulty-medium">{t.statMedium}</span>
                  <span className="metric-val">{preview.counts.Medium || 0}</span>
                </div>
                <div className="metric-box">
                  <span className="metric-label difficulty-hard">{t.statHard}</span>
                  <span className="metric-val">{preview.counts.Hard || 0}</span>
                </div>
                <div className="metric-box">
                  <span className="metric-label">{t.candidateCountLabel}</span>
                  <span
                    className="metric-val"
                    style={{ color: preview.candidateCount > 0 ? 'var(--success)' : 'var(--danger)' }}
                  >
                    {preview.candidateCount}
                  </span>
                </div>
              </div>

              <table>
                <thead>
                  <tr>
                    <th>{lang === 'zh' ? '规则' : 'Rule'}</th>
                    <th>{lang === 'zh' ? '原值' : 'Before'}</th>
                    <th>{lang === 'zh' ? '确认值' : 'After'}</th>
                  </tr>
                </thead>
                <tbody>
                  {(Object.keys(draft) as (keyof RulePatch)[]).map((key) => (
                    <tr key={key}>
                      <td>{ruleLabels[key]}</td>
                      <td>{JSON.stringify(preview.base?.[key]) ?? '—'}</td>
                      <td>{JSON.stringify(draft[key]) ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {/* Changed fields list */}
              {preview.changed.length > 0 && (
                <div className="changed-tags-row">
                  <span className="text-muted">{t.changedFields}:</span>
                  {preview.changed.map((field) => (
                    <span key={field} className="badge badge-primary">
                      {field}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose} disabled={committing}>
            {t.cancel}
          </button>
          <button
            className="btn btn-primary"
            onClick={handleCommit}
            disabled={
              !preview ||
              preview.issues.length > 0 ||
              preview.unresolved.length > 0 ||
              loading ||
              prompt.trim() !== parsedPrompt ||
              committing
            }
          >
            <CheckCircle2 size={16} />
            {committing ? (lang === 'zh' ? '应用中…' : 'Applying…') : t.confirmOverride}
          </button>
        </div>
      </div>
    </Dialog>
  );
};
