/**
 * Prompt Override Modal component.
 * Allows users to temporarily adjust today's recommendation plan using natural language
 * or manual fine-tuning, with live diff preview, candidate counts, and quota conflict detection.
 * Enforces integer difficulty quotas and explicit review modes.
 */
import React, { useState, useRef, useEffect } from 'react';
import { Sparkles, AlertTriangle, AlertCircle, CheckCircle2 } from 'lucide-react';
import { api, type DailyPlan, type OverridePreview, type RulePatch } from '../api.ts';
import { translations, type Language } from '../i18n.ts';
import { Dialog } from './ui.tsx';
import {
  difficulties,
  type Difficulty,
  type Rules,
} from '../../../../packages/contracts/src/recommendations.ts';
import {
  type CountInput,
  type ReviewMode,
  type DifficultyDraft,
  emptyDifficultyDraft,
  difficultyCounts,
  reviewCountForRules,
  reviewModeForRules,
  isCount,
  updateDifficultyDraft,
  percentagesForCounts,
  reviewPercentForCount,
} from '../strategy-counts.ts';

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

  // Manual rule state
  const [dailyCount, setDailyCount] = useState<CountInput>(currentPlan?.rules.dailyCount ?? '');
  const [difficultyDraft, setDifficultyDraft] = useState<DifficultyDraft>(() =>
    currentPlan?.rules
      ? { values: difficultyCounts(currentPlan.rules), automatic: null }
      : emptyDifficultyDraft(),
  );
  const [isDiffDraftModified, setIsDiffDraftModified] = useState(false);
  const [reviewMode, setReviewMode] = useState<ReviewMode>(() =>
    currentPlan?.rules ? reviewModeForRules(currentPlan.rules) : 'none',
  );
  const [reviewCount, setReviewCount] = useState<CountInput>(() =>
    currentPlan?.rules ? reviewCountForRules(currentPlan.rules) : '',
  );
  const [tagsText, setTagsText] = useState(currentPlan?.rules.tags.join(', ') ?? '');
  const [draft, setDraft] = useState<RulePatch>({});

  const requestVersion = useRef(0);
  const [prompt, setPrompt] = useState('');
  const [parsedPrompt, setParsedPrompt] = useState('');
  const [loading, setLoading] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [preview, setPreview] = useState<OverridePreview | null>(null);
  const [error, setError] = useState<string | null>(null);

  const editingSession = useRef<{ open: boolean; planId: string | null; version: number | null }>({
    open: false, planId: null, version: null,
  });

  // Polling returns fresh objects. Only a new editing session resets user-owned drafts;
  // an actual version change invalidates the preview while preserving those drafts.
  useEffect(() => {
    const previous = editingSession.current;
    const planId = currentPlan?.id ?? null;
    const version = currentPlan?.version ?? null;
    editingSession.current = { open: isOpen, planId, version };
    if (isOpen && previous.open && previous.planId === planId) {
      if (previous.version !== version) {
        requestVersion.current++;
        setPreview(null);
        setLoading(false);
      }
      return;
    }
    requestVersion.current++;
    setPreview(null);
    setLoading(false);
    setError(null);
    setPrompt('');
    setParsedPrompt('');

    if (currentPlan?.rules) {
      const r = currentPlan.rules;
      const initialCounts = difficultyCounts(r);
      const initialMode = reviewModeForRules(r);
      const initialR = reviewCountForRules(r);
      setDailyCount(r.dailyCount);
      setDifficultyDraft({ values: initialCounts, automatic: null });
      setIsDiffDraftModified(false);
      setReviewMode(initialMode);
      setReviewCount(initialR);
      setTagsText(r.tags.join(', '));
      setDraft({
        dailyCount: r.dailyCount,
        difficulty: r.difficulty,
        tags: r.tags,
        premium: r.premium,
        reviewMode: initialMode,
        reviewCount: initialR,
        reviewEnabled: r.reviewEnabled,
        reviewPercent: r.reviewPercent,
        preference: r.preference,
        focusWeakTags: r.focusWeakTags,
        adaptiveReviewEnabled: r.adaptiveReviewEnabled,
      });
    } else {
      setDailyCount('');
      setDifficultyDraft(emptyDifficultyDraft());
      setIsDiffDraftModified(false);
      setReviewMode('none');
      setReviewCount('');
      setTagsText('');
      setDraft({});
    }
  }, [isOpen, currentPlan]);

  if (!isOpen) return null;

  // Validation rules for manual input
  const counts = difficultyDraft.values;
  const hasDailyCount = isCount(dailyCount) && dailyCount >= 1 && dailyCount <= 50;
  const currentSum = difficulties.reduce(
    (sum, d) => sum + (typeof counts[d] === 'number' ? Number(counts[d]) : 0),
    0,
  );
  const hasDifficulties = difficulties.every((d) => isCount(counts[d]));
  const isSumValid = hasDifficulties && currentSum === dailyCount;
  const exceedsTotal =
    typeof dailyCount === 'number' &&
    (difficulties.some((d) => typeof counts[d] === 'number' && Number(counts[d]) > dailyCount) ||
      currentSum > dailyCount ||
      (reviewMode === 'partial' && typeof reviewCount === 'number' && Number(reviewCount) > dailyCount));
  const invalidCount = difficulties.some((d) => counts[d] !== '' && !isCount(counts[d]));
  const isReviewValid =
    reviewMode !== null &&
    (reviewMode !== 'partial' ||
      (isCount(reviewCount) &&
        Number(reviewCount) >= 1 &&
        typeof dailyCount === 'number' &&
        Number(reviewCount) <= dailyCount));

  const manualValidationMessage = exceedsTotal
    ? t.countExceedsTotal
    : dailyCount !== '' && !hasDailyCount
    ? t.dailyCountInvalid
    : invalidCount
    ? t.wholeCountsRequired
    : hasDifficulties && !isSumValid
    ? t.countsMustMatch
    : reviewMode === 'partial' && reviewCount !== '' && !isReviewValid
    ? t.reviewCountInvalid
    : '';

  const canPreviewManual = hasDailyCount && isSumValid && isReviewValid && !exceedsTotal && !invalidCount;

  function handleDailyCountChange(val: CountInput) {
    requestVersion.current++;
    setDailyCount(val);
    setPreview(null);
    setError(null);
    setLoading(false);

    if (!isDiffDraftModified && isCount(val) && val > 0) {
      const baseDiff =
        draft.difficulty ??
        currentPlan?.rules.difficulty ?? { Easy: 100, Medium: 0, Hard: 0 };
      const newCounts = difficultyCounts({ dailyCount: val, difficulty: baseDiff } as Rules);
      setDifficultyDraft({ values: newCounts, automatic: null });
      setDraft((prev) => ({
        ...prev,
        dailyCount: val,
        difficulty: baseDiff,
        ...(reviewMode === 'all' ? { reviewCount: val } : {}),
      }));
      if (reviewMode === 'all') {
        setReviewCount(val);
      }
    } else {
      const nextDiff = updateDifficultyDraft(difficultyDraft, val);
      setDifficultyDraft(nextDiff);
      const isFull =
        isCount(val) &&
        val > 0 &&
        difficulties.every((d) => isCount(nextDiff.values[d])) &&
        difficulties.reduce((sum, d) => sum + Number(nextDiff.values[d]), 0) === val;
      setDraft((prev) => ({
        ...prev,
        dailyCount: val === '' ? undefined : val,
        ...(isFull ? { difficulty: percentagesForCounts(val as number, nextDiff.values, currentPlan?.rules) } : {}),
        ...(reviewMode === 'all' && typeof val === 'number' ? { reviewCount: val } : {}),
      }));
      if (reviewMode === 'all' && typeof val === 'number') {
        setReviewCount(val);
      }
    }
  }

  function handleDiffCountChange(d: Difficulty, val: CountInput) {
    requestVersion.current++;
    setIsDiffDraftModified(true);
    const nextDiff = updateDifficultyDraft(difficultyDraft, dailyCount, { difficulty: d, value: val });
    setDifficultyDraft(nextDiff);
    const isFull =
      isCount(dailyCount) &&
      dailyCount > 0 &&
      difficulties.every((diff) => isCount(nextDiff.values[diff])) &&
      difficulties.reduce((sum, diff) => sum + Number(nextDiff.values[diff]), 0) === dailyCount;
    setDraft((prev) => ({
      ...prev,
      ...(isFull
        ? { difficulty: percentagesForCounts(dailyCount as number, nextDiff.values, currentPlan?.rules) }
        : {}),
    }));
    setPreview(null);
    setError(null);
    setLoading(false);
  }

  function handleReviewModeChange(mode: ReviewMode) {
    requestVersion.current++;
    setReviewMode(mode);
    let nextCount: CountInput = reviewCount;
    if (mode === 'none') {
      nextCount = 0;
    } else if (mode === 'all') {
      nextCount = typeof dailyCount === 'number' ? dailyCount : '';
    } else if (mode === 'partial' && (reviewCount === '' || reviewCount === 0)) {
      nextCount = 1;
    }
    setReviewCount(nextCount);
    setDraft((prev) => ({
      ...prev,
      reviewMode: mode,
      reviewCount: typeof nextCount === 'number' ? nextCount : undefined,
      reviewEnabled: mode !== 'none',
      ...(mode === 'none' ? { reviewPercent: null, adaptiveReviewEnabled: false } : {}),
      ...(mode === 'all' ? { reviewPercent: 100 } : {}),
    }));
    setPreview(null);
    setError(null);
    setLoading(false);
  }

  function handleReviewCountChange(val: CountInput) {
    requestVersion.current++;
    setReviewCount(val);
    setDraft((prev) => ({
      ...prev,
      reviewMode: 'partial',
      reviewCount: val === '' ? undefined : val,
      reviewEnabled: true,
      ...(isCount(val) && typeof dailyCount === 'number' && dailyCount > 0
        ? { reviewPercent: reviewPercentForCount(dailyCount, 'partial', val, currentPlan?.rules) }
        : {}),
    }));
    setPreview(null);
    setError(null);
    setLoading(false);
  }

  /** Edit other patch fields directly */
  function edit(patch: RulePatch) {
    requestVersion.current++;
    setDraft((previous) => ({ ...previous, ...patch }));
    setPreview(null);
    setError(null);
    setLoading(false);
  }

  /** Explicit manual correction replaces unverified natural-language requirements. */
  async function handleParse(manual = false) {
    const trimmed = prompt.trim();
    if (!trimmed && !manual) return;
    const version = ++requestVersion.current;
    setPreview(null);
    setLoading(true);
    setError(null);
    try {
      let patchToSend: RulePatch;
      if (manual) {
        if (exceedsTotal) {
          setError(t.countExceedsTotal);
          setLoading(false);
          return;
        }
        if (dailyCount !== '' && !hasDailyCount) {
          setError(t.dailyCountInvalid);
          setLoading(false);
          return;
        }
        if (isCount(dailyCount) && hasDifficulties && !isSumValid) {
          setError(t.countsMustMatch);
          setLoading(false);
          return;
        }
        if (reviewMode === 'partial' && reviewCount !== '' && !isReviewValid) {
          setError(t.reviewCountInvalid);
          setLoading(false);
          return;
        }

        const manualDifficulty =
          isCount(dailyCount) && isSumValid
            ? percentagesForCounts(dailyCount as number, counts, currentPlan?.rules)
            : draft.difficulty;
        const manualReviewPercent =
          isCount(dailyCount) && isReviewValid && reviewMode !== null
            ? reviewPercentForCount(dailyCount as number, reviewMode, reviewCount, currentPlan?.rules)
            : draft.reviewPercent;

        patchToSend = {
          ...draft,
          ...(isCount(dailyCount) ? { dailyCount: dailyCount as number } : {}),
          ...(manualDifficulty !== undefined ? { difficulty: manualDifficulty } : {}),
          ...(tagsText.trim().length > 0
            ? { tags: tagsText.split(',').map((v) => v.trim()).filter(Boolean) }
            : {}),
          ...(reviewMode !== null
            ? {
                reviewMode,
                reviewCount:
                  reviewMode === 'partial'
                    ? typeof reviewCount === 'number'
                      ? reviewCount
                      : undefined
                    : reviewMode === 'all' && typeof dailyCount === 'number'
                    ? dailyCount
                    : 0,
                reviewEnabled: reviewMode !== 'none',
                reviewPercent: manualReviewPercent,
              }
            : {}),
        };
      } else {
        patchToSend = {};
      }

      const prev = await api.previewDailyPlanOverride({
        ...(manual ? { rules: patchToSend } : { prompt: trimmed }),
        date: currentPlan?.date,
      });
      if (version !== requestVersion.current) return;
      const merged = { ...(prev.base ?? {}), ...prev.rules };
      setDraft(merged);
      if (merged.dailyCount !== undefined) {
        setDailyCount(merged.dailyCount);
      }
      if (merged.difficulty !== undefined) {
        setDifficultyDraft({
          values: difficultyCounts(merged as Rules),
          automatic: null,
        });
        setIsDiffDraftModified(false);
      }
      if (merged.tags !== undefined) {
        setTagsText(merged.tags.join(', '));
      }
      const newMode = reviewModeForRules(merged as Rules);
      setReviewMode(newMode);
      setReviewCount(reviewCountForRules(merged as Rules));
      setPreview(prev);
      if (!manual) {
        setParsedPrompt(trimmed);
      }
    } catch (err: any) {
      if (version === requestVersion.current) {
        setError(err.message || 'Failed to parse prompt with AI.');
      }
    } finally {
      if (version === requestVersion.current) {
        setLoading(false);
      }
    }
  }

  async function handleCommit() {
    if (
      !preview ||
      preview.changed.length === 0 ||
      preview.issues.length ||
      preview.unresolved.length ||
      loading ||
      committing
    ) {
      return;
    }
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

  const ruleLabels: Record<string, string> =
    lang === 'zh'
      ? {
          dailyCount: '每日题数',
          difficulty: '难度题数',
          tags: '标签',
          premium: '包含 Premium',
          reviewMode: '复习模式',
          reviewCount: '复习题数',
          preference: '软偏好',
          focusWeakTags: '自适应专题推荐',
          adaptiveReviewEnabled: '自适应复习',
        }
      : {
          dailyCount: 'Daily count',
          difficulty: 'Difficulty counts',
          tags: 'Tags',
          premium: 'Include Premium',
          reviewMode: 'Review mode',
          reviewCount: 'Review count',
          preference: 'Soft preference',
          focusWeakTags: 'Adaptive topic recommendations',
          adaptiveReviewEnabled: 'Adaptive review',
        };

  function formatRuleValue(key: string, value: any, baseRules?: Rules | null): React.ReactNode {
    if (value === undefined || value === null) return '—';
    if (key === 'difficulty') {
      const total = typeof draft.dailyCount === 'number' ? draft.dailyCount : baseRules?.dailyCount ?? 0;
      const countsObj =
        typeof value === 'object' && 'Easy' in value
          ? difficultyCounts({ dailyCount: total, difficulty: value } as Rules)
          : null;
      return countsObj
        ? `Easy: ${countsObj.Easy}, Medium: ${countsObj.Medium}, Hard: ${countsObj.Hard}`
        : JSON.stringify(value);
    }
    if (key === 'reviewMode') {
      return lang === 'zh'
        ? value === 'all'
          ? '全部复习'
          : value === 'partial'
          ? '部分复习'
          : '仅新题'
        : value === 'all'
        ? 'All review'
        : value === 'partial'
        ? 'Some review'
        : 'New only';
    }
    if (key === 'reviewCount') {
      return `${value} ${lang === 'zh' ? '题' : 'problem(s)'}`;
    }
    if (key === 'dailyCount') {
      return `${value} ${lang === 'zh' ? '题' : 'problem(s)'}`;
    }
    if (key === 'tags') {
      return Array.isArray(value) && value.length > 0 ? value.join(', ') : lang === 'zh' ? '不限' : 'Any';
    }
    if (key === 'premium' || key === 'focusWeakTags' || key === 'adaptiveReviewEnabled') {
      return value ? (lang === 'zh' ? '是' : 'Yes') : lang === 'zh' ? '否' : 'No';
    }
    return typeof value === 'string' ? value : JSON.stringify(value);
  }

  const displayKeys: (keyof RulePatch)[] = [
    'dailyCount',
    'difficulty',
    'tags',
    'premium',
    'reviewMode',
    'reviewCount',
    'preference',
    'focusWeakTags',
    'adaptiveReviewEnabled',
  ];

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
                  aria-label={lang === 'zh' ? '每日题数' : 'Daily count'}
                  type="number"
                  min="1"
                  max="50"
                  value={dailyCount}
                  onChange={(e) =>
                    handleDailyCountChange(e.target.value === '' ? '' : Number(e.target.value))
                  }
                  style={exceedsTotal ? { borderColor: 'var(--danger)' } : undefined}
                />
              </label>

              {(['Easy', 'Medium', 'Hard'] as const).map((d) => (
                <label key={d}>
                  {d} {lang === 'zh' ? '题数' : 'count'}
                  <input
                    aria-label={`${d} ${lang === 'zh' ? '题数' : 'count'}`}
                    type="number"
                    min="0"
                    max="50"
                    value={difficultyDraft.values[d]}
                    placeholder={
                      difficultyDraft.automatic === d ? (lang === 'zh' ? '自动' : 'Auto') : undefined
                    }
                    onChange={(e) =>
                      handleDiffCountChange(d, e.target.value === '' ? '' : Number(e.target.value))
                    }
                    style={
                      difficultyDraft.automatic === d
                        ? { fontStyle: 'italic', opacity: 0.85 }
                        : undefined
                    }
                  />
                </label>
              ))}

              {manualValidationMessage && (
                <div
                  className="alert alert-warning u-margin-top-0-5rem"
                  style={{ fontSize: '0.8125rem', padding: '6px 10px' }}
                >
                  <AlertCircle size={14} />
                  <span>{manualValidationMessage}</span>
                </div>
              )}

              <label>
                {lang === 'zh' ? '标签（逗号分隔，空白不限）' : 'Tags (comma separated; empty means any)'}
                <input
                  aria-label={lang === 'zh' ? '标签（逗号分隔，空白不限）' : 'Tags (comma separated; empty means any)'}
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
                  aria-label={lang === 'zh' ? '包含 Premium' : 'Include Premium'}
                  type="checkbox"
                  checked={draft.premium ?? currentPlan?.rules.premium ?? false}
                  onChange={(e) => edit({ premium: e.target.checked })}
                />
              </label>

              <label>
                {lang === 'zh' ? '复习模式' : 'Review mode'}
                <select
                  aria-label={lang === 'zh' ? '复习模式' : 'Review mode'}
                  value={reviewMode ?? 'none'}
                  onChange={(e) => handleReviewModeChange(e.target.value as ReviewMode)}
                >
                  <option value="none">{lang === 'zh' ? '仅新题' : 'New only'}</option>
                  <option value="partial">{lang === 'zh' ? '部分复习' : 'Some review'}</option>
                  <option value="all">{lang === 'zh' ? '全部复习' : 'All review'}</option>
                </select>
              </label>

              {reviewMode === 'partial' && (
                <label>
                  {lang === 'zh' ? '复习题数' : 'Review count'}
                  <input
                    aria-label={lang === 'zh' ? '复习题数' : 'Review count'}
                    type="number"
                    min="1"
                    max={typeof dailyCount === 'number' ? dailyCount : 50}
                    value={reviewCount}
                    onChange={(e) =>
                      handleReviewCountChange(e.target.value === '' ? '' : Number(e.target.value))
                    }
                  />
                </label>
              )}

              <label>
                {lang === 'zh' ? '软偏好' : 'Soft preference'}
                <input
                  aria-label={lang === 'zh' ? '软偏好' : 'Soft preference'}
                  value={draft.preference ?? ''}
                  onChange={(e) => edit({ preference: e.target.value })}
                />
              </label>

              <label>
                {t.focusWeakTags}
                <select
                  aria-label={t.focusWeakTags}
                  value={draft.focusWeakTags === undefined ? '' : String(draft.focusWeakTags)}
                  onChange={(e) =>
                    edit({ focusWeakTags: e.target.value === '' ? undefined : e.target.value === 'true' })
                  }
                >
                  <option value="">{lang === 'zh' ? '继承现有规则' : 'Inherit current rule'}</option>
                  <option value="true">{lang === 'zh' ? '开启' : 'On'}</option>
                  <option value="false">{lang === 'zh' ? '关闭' : 'Off'}</option>
                </select>
              </label>

              <label>
                {t.adaptiveReviewEnabled}
                <select
                  aria-label={t.adaptiveReviewEnabled}
                  value={
                    draft.adaptiveReviewEnabled === undefined ? '' : String(draft.adaptiveReviewEnabled)
                  }
                  onChange={(e) =>
                    edit({
                      adaptiveReviewEnabled:
                        e.target.value === '' ? undefined : e.target.value === 'true',
                    })
                  }
                >
                  <option value="">{lang === 'zh' ? '继承现有规则' : 'Inherit current rule'}</option>
                  <option value="true">{lang === 'zh' ? '开启' : 'On'}</option>
                  <option value="false">{lang === 'zh' ? '关闭' : 'Off'}</option>
                </select>
              </label>
              <p className="text-muted">{t.adaptiveReviewDescription}</p>

              <button
                className="btn btn-secondary"
                onClick={() => handleParse(true)}
                disabled={loading || committing}
              >
                {lang === 'zh' ? '预览校对后的规则' : 'Preview edited rules'}
              </button>
            </fieldset>
          </details>

          {/* Preview result */}
          {preview && (
            <div className="override-preview-card">
              <h4 className="preview-heading">{t.overridePreviewTitle}</h4>

              {/* Unchanged Rules Protection Notice */}
              {preview.changed.length === 0 && (
                <div className="alert alert-warning u-margin-bottom-1rem">
                  <AlertTriangle size={16} />
                  <div>
                    <strong>{t.rulesUnchanged}</strong>
                    <p style={{ margin: '4px 0 0', fontSize: '0.85rem' }}>{t.rulesUnchangedDesc}</p>
                  </div>
                </div>
              )}

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
                    {(preview.counts.Easy || 0) +
                      (preview.counts.Medium || 0) +
                      (preview.counts.Hard || 0)}
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
                  {displayKeys
                    .filter((key) => preview.base?.[key] !== undefined || draft[key] !== undefined)
                    .map((key) => (
                      <tr key={key}>
                        <td>{ruleLabels[key] ?? key}</td>
                        <td>{formatRuleValue(key, preview.base?.[key], preview.base)}</td>
                        <td>{formatRuleValue(key, draft[key] ?? preview.rules?.[key], preview.base)}</td>
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
                      {ruleLabels[field] ?? field}
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
              preview.changed.length === 0 ||
              preview.issues.length > 0 ||
              preview.unresolved.length > 0 ||
              loading ||
              (prompt.trim() !== '' && prompt.trim() !== parsedPrompt) ||
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
