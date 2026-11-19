/**
 * Strategies & Weekly Schedule View component.
 * Allows users to configure recommendation strategies (daily count, review cap, new-problem mix,
 * topic tags, premium) and map them across weekdays with conflict detection. Review spacing is a
 * learner-wide setting (Settings › Practice), not part of a strategy.
 */
import React, { useEffect, useState, useCallback, useRef } from 'react';
import { Plus, CheckCircle2, AlertCircle, Clock } from 'lucide-react';
import { api, type Strategy, type StrategyInput, type TopicTag, type TagMastery } from '../api.ts';
import { localizeApiError } from '../error-i18n.ts';
import { translations, type Language } from '../i18n.ts';
import { Dialog } from './ui.tsx';
import { useWorkspace } from '../workspace.tsx';
import { difficulties, strategyInputSchema } from '../../../../packages/contracts/src/recommendations.ts';
import {
  emptyDifficultyDraft, difficultyCounts, reviewCountForRules, reviewModeForRules,
  updateDifficultyDraft, isCount, percentagesForCounts, reviewPercentForCount,
  unchangedReview, newCountsAtCap, type ReviewMode, type CountInput,
} from '../strategy-counts.ts';
import { WeeklyScheduleGrid } from './WeeklyScheduleGrid.tsx';
import { StrategyCard } from './StrategyCard.tsx';
import { TimeBudgetField } from './RecommendationOptions.tsx';
import type { Rules } from '../../../../packages/contracts/src/recommendations.ts';

/** Placeholder mix for review-only strategies, which never pick new problems. */
const REVIEW_ONLY_MIX: Rules['difficulty'] = { Easy: 0, Medium: 100, Hard: 0 };

/** One-line explanation of what each review mode does on a day with too few or too many due reviews. */
const REVIEW_MODE_HINT: Record<ReviewMode, { en: string; zh: string }> = {
  none: {
    en: 'Only new problems. Due reviews stay out of the plan.',
    zh: '只排新题，到期复习不会进入计划。',
  },
  partial: {
    en: 'Due reviews first, up to the cap. Unused review slots become new problems. Due reviews beyond the cap are listed on Today, where you can add them.',
    zh: '先排到期复习，最多到上限；到期题不足时，空出的名额改排新题。超出上限的到期复习会在今日页提示，可以一键加入。',
  },
  all: {
    en: 'Due reviews only, most overdue first. If fewer are due, the plan is shorter; no new problems are added.',
    zh: '只排到期复习，逾期最久的在前。到期题不足时计划会变短，不补新题。',
  },
};

interface StrategiesViewProps {
  lang: Language;
  focusRequest?: number;
}

/** Edit explicit strategies and weekday ownership while preserving historical plans. */
export const StrategiesView: React.FC<StrategiesViewProps> = ({ lang, focusRequest }) => {
  const t = translations[lang];
  const workspace = useWorkspace();

  const [strategies, setStrategies] = useState<Strategy[]>([]);
  const [schedule, setSchedule] = useState<{ weekday: number; strategy: Strategy | null }[]>([]);
  const [allTags, setAllTags] = useState<TopicTag[]>([]);
  const [weakTags, setWeakTags] = useState<TagMastery[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Strategy Modal State
  const [modalOpen, setModalOpen] = useState(false);
  const [editingStrategy, setEditingStrategy] = useState<Strategy | null>(null);
  const [name, setName] = useState('');
  const [dailyCount, setDailyCount] = useState<number | ''>('');
  const [difficultyDraft, setDifficultyDraft] = useState(emptyDifficultyDraft);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [focusWeakTags, setFocusWeakTags] = useState(false);
  const [reviewScopeMatching, setReviewScopeMatching] = useState(false);
  const [timeBudget, setTimeBudget] = useState<number | null>(null);
  const [masteryLoading,setMasteryLoading]=useState(true);
  const [masteryError,setMasteryError]=useState(false);
  const [masteryRetry,setMasteryRetry]=useState(0);
  const [premium, setPremium] = useState(false);
  const [reviewMode, setReviewMode] = useState<ReviewMode | null>(null);
  const [reviewCount, setReviewCount] = useState<CountInput>('');
  const validationId = React.useId();
  const [weekdays, setWeekdays] = useState<number[]>([]);
  const [preference, setPreference] = useState('');
  const [saving, setSaving] = useState(false);

  const loadSequence = useRef(0);
  /** Ignore superseded library responses and never populate editor drafts during refresh. */
  const loadData = useCallback(async () => {
    const sequence = ++loadSequence.current;
    setLoading(true);
    setError(null);
    try {
      const [strats, sched, tagsRes] = await Promise.all([
        api.getStrategies(),
        api.getWeeklySchedule(),
        api.getAllTags(),
      ]);
      if (sequence !== loadSequence.current) return;
      setStrategies(strats);
      setSchedule(sched);
      setAllTags(tagsRes.tags);
    } catch (err: unknown) {
      if (sequence === loadSequence.current)
        setError(
          localizeApiError(
            err,
            lang,
            lang === 'zh' ? '加载策略与学习安排失败。' : 'Failed to load strategies and schedule.',
          ),
        );
    } finally {
      if (sequence === loadSequence.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
    return () => {
      loadSequence.current++;
    };
  }, [loadData, workspace.revision]);

  // Optional analytics must never delay loading the strategy library.
  useEffect(()=>{
    let active=true;
    setWeakTags([]);setMasteryLoading(true);setMasteryError(false);
    api.getMasteryReport().then(report=>{
      if(active)setWeakTags(report.tags.filter(t=>t.level==='needs_practice'));
    }).catch(()=>{if(active)setMasteryError(true);}).finally(()=>{if(active)setMasteryLoading(false);});
    return ()=>{active=false;};
  },[workspace.revision,workspace.timezone,masteryRetry]);

  const consumedFocusRequest=useRef(0);
  useEffect(()=>{
    if(focusRequest && focusRequest!==consumedFocusRequest.current){
      consumedFocusRequest.current=focusRequest;
      openCreateModal();
      setFocusWeakTags(true);
    }
  },[focusRequest]);

  /** Leave count, mix and review choice unset until the user selects them. */
  function openCreateModal() {
    setEditingStrategy(null);
    setName('');
    setDailyCount('');
    setDifficultyDraft(emptyDifficultyDraft());
    setSelectedTags([]);
    setFocusWeakTags(false);
    setReviewScopeMatching(false);
    setTimeBudget(null);
    setPremium(false);
    setReviewMode(null);
    setReviewCount('');
    setWeekdays([]);
    setPreference('');
    setError(null);
    setModalOpen(true);
  }

  /** Capture the selected revision for conflict-safe correction. */
  function openEditModal(s: Strategy) {
    setEditingStrategy(s);
    setName(s.name);
    setDailyCount(s.rules.dailyCount);
    setDifficultyDraft({ values: difficultyCounts(s.rules), automatic: null });
    setSelectedTags(s.rules.tags);
    setFocusWeakTags(!!s.rules.focusWeakTags);
    setReviewScopeMatching(s.rules.reviewScope === 'matching');
    setTimeBudget(s.rules.timeBudgetMinutes ?? null);
    setPremium(s.rules.premium);
    setReviewMode(reviewModeForRules(s.rules));
    setReviewCount(reviewCountForRules(s.rules));
    setWeekdays(s.weekdays);
    setPreference(s.rules.preference);
    setError(null);
    setModalOpen(true);
  }

  const counts = difficultyDraft.values;
  const hasDailyCount = isCount(dailyCount) && dailyCount >= 1 && dailyCount <= 50;
  const currentSum = difficulties.reduce((sum, d) => sum + (typeof counts[d] === 'number' ? counts[d] : 0), 0);
  const hasDifficulties = difficulties.every(d => isCount(counts[d]));
  const isSumValid = hasDifficulties && currentSum === dailyCount;
  // Review-only strategies never pick new problems, so the mix is neither shown nor required.
  const mixRequired = reviewMode !== 'all';
  const reviewUnchanged = unchangedReview(dailyCount, reviewMode, reviewCount, editingStrategy?.rules);
  const isReviewValid = reviewMode !== null && (reviewMode !== 'partial' || reviewUnchanged ||
    (isCount(reviewCount) && reviewCount >= 1 && typeof dailyCount === 'number' && reviewCount <= dailyCount));
  const exceedsTotal = typeof dailyCount === 'number' && (
    (mixRequired && (difficulties.some(d => typeof counts[d] === 'number' && counts[d] > dailyCount) || currentSum > dailyCount)) ||
    (reviewMode === 'partial' && typeof reviewCount === 'number' && reviewCount > dailyCount));
  const invalidCount = mixRequired && difficulties.some(d => counts[d] !== '' && !isCount(counts[d]));
  const invalidBudget = timeBudget !== null && (!Number.isInteger(timeBudget) || timeBudget < 1 || timeBudget > 1440);
  const validationMessage = exceedsTotal ? t.countExceedsTotal
    : dailyCount !== '' && !hasDailyCount ? t.dailyCountInvalid
    : invalidCount ? t.wholeCountsRequired
    : mixRequired && hasDifficulties && !isSumValid ? t.countsMustMatch
    : reviewMode === 'partial' && reviewCount !== '' && !isReviewValid ? t.reviewCountInvalid : '';
  const isFormValid = name.trim().length > 0 && name.trim().length <= 100 && preference.trim().length <= 2000 &&
    hasDailyCount && (!mixRequired || isSumValid) && isReviewValid && !exceedsTotal && !invalidCount && !invalidBudget;
  // Shown under the mix: the new-problem split on a day that uses the whole review cap.
  const capSplit = reviewMode === 'partial' && hasDailyCount && isSumValid && isCount(reviewCount) && reviewCount >= 1 && reviewCount <= Number(dailyCount)
    ? { newCount: Number(dailyCount) - reviewCount, cap: reviewCount, split: newCountsAtCap(Number(dailyCount), reviewCount, counts as Record<'Easy' | 'Medium' | 'Hard', number>) }
    : null;
  const reviewOn = reviewMode !== null && reviewMode !== 'none';

  /** Persist rules and weekday ownership atomically; conflicts retain the draft. */
  async function handleSave() {
    if (!isFormValid || saving) return;

    // Explain known conflicts before submission; the server still arbitrates stale/concurrent assignments.
    const knownConflicts = weekdays.flatMap((day) => {
      const owner = schedule.find((entry) => entry.weekday === day)?.strategy;
      return owner && owner.id !== editingStrategy?.id ? [`${t.weekdayFull[day]} — ${owner.name}`] : [];
    });
    if (knownConflicts.length) {
      setError(
        `${lang === 'zh' ? '以下日期已有学习安排' : 'Weekday already assigned'}: ${knownConflicts.join('; ')}`,
      );
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const legacy = editingStrategy?.rules;
      const payload: StrategyInput = {
        name: name.trim(),
        rules: {
          dailyCount: dailyCount as number,
          difficulty: isSumValid
            ? percentagesForCounts(dailyCount as number, counts, legacy)
            : legacy?.difficulty ?? REVIEW_ONLY_MIX,
          tags: selectedTags,
          premium,
          reviewEnabled: reviewMode !== 'none',
          reviewPercent: reviewPercentForCount(dailyCount as number, reviewMode, reviewCount, legacy),
          // Untouched legacy shares that round to zero remain readable without creating an invalid partial quota.
          ...(reviewUnchanged && !legacy?.reviewMode && reviewMode === 'partial' && reviewCount === 0
            ? {}
            : { reviewMode: reviewMode!, reviewCount: reviewMode === 'partial' ? Number(reviewCount) : null }),
          // Write the scope only when it differs from the default, so older builds can still edit most strategies.
          ...(reviewOn && reviewScopeMatching && selectedTags.length > 0
            ? { reviewScope: 'matching' as const }
            : legacy?.reviewScope !== undefined ? { reviewScope: 'all' as const } : {}),
          preference: preference.trim(),
          ...(timeBudget !== null
            ? { timeBudgetMinutes: timeBudget }
            : legacy?.timeBudgetMinutes != null ? { timeBudgetMinutes: null } : {}),
          // Legacy per-strategy spacing fields stay readable for older synced builds; planning now reads
          // Settings. Keep them consistent with the review switch so the contract still accepts them.
          ...(legacy?.reviewPolicy !== undefined ? { reviewPolicy: reviewOn ? legacy.reviewPolicy : 'fixed' as const } : {}),
          ...(legacy?.adaptiveReviewEnabled !== undefined
            ? { adaptiveReviewEnabled: reviewOn && (legacy.reviewPolicy ? legacy.reviewPolicy === 'duration-v1' : legacy.adaptiveReviewEnabled) }
            : {}),
          ...(legacy?.personalDurationCalibration !== undefined ? { personalDurationCalibration: legacy.personalDurationCalibration } : {}),
          ...(focusWeakTags
            ? { focusWeakTags: true }
            : editingStrategy?.rules.focusWeakTags !== undefined
              ? { focusWeakTags: false }
              : {}),
        },
        weekdays,
      };

      // The shared contract is the final gate before any mutation request leaves the browser.
      const validated = strategyInputSchema.safeParse(payload);
      if (!validated.success) {
        setError(t.invalidStrategy);
        return;
      }
      if (editingStrategy) {
        await api.updateStrategy(editingStrategy.id, {
          expectedVersion: editingStrategy.version,
          ...validated.data,
        });
      } else {
        await api.createStrategy(validated.data);
      }

      setModalOpen(false);
      workspace.notifyMutation();
      await loadData();
    } catch (err: unknown) {
      setError(
        localizeApiError(err, lang, lang === 'zh' ? '保存策略失败。' : 'Failed to save strategy.'),
      );
    } finally {
      setSaving(false);
    }
  }

  /** Delete only the selected strategy after confirmation; historical plans remain. */
  async function handleDelete(s: Strategy) {
    if (!window.confirm(t.confirmDeleteStrategy)) return;
    try {
      await api.deleteStrategy(s.id, s.version);
      workspace.notifyMutation();
      await loadData();
    } catch (err: unknown) {
      setError(
        localizeApiError(err, lang, lang === 'zh' ? '删除策略失败。' : 'Failed to delete strategy.'),
      );
    }
  }

  /** Edit local weekday intent without silently transferring existing assignments. */
  function toggleWeekday(day: number) {
    if (weekdays.includes(day)) {
      setWeekdays(weekdays.filter((d) => d !== day));
    } else {
      setWeekdays([...weekdays, day].sort());
    }
  }

  /** Toggle one existing tag in the local rule draft. */
  function toggleTag(slug: string) {
    if (selectedTags.includes(slug)) {
      setSelectedTags(selectedTags.filter((t) => t !== slug));
    } else {
      setSelectedTags([...selectedTags, slug]);
    }
  }

  if (loading && !modalOpen) {
    return (
      <div className="empty-state">
        <Clock size={28} className="spin primary-icon" />
        <p>{t.loadingCatalog}</p>
      </div>
    );
  }

  return (
    <div className="strategies-container">
      {/* Header bar */}
      <div className="view-header">
        <div>
          <h2 className="view-title">{t.strategiesTitle}</h2>
        </div>
        <button className="btn btn-primary" onClick={openCreateModal}>
          <Plus size={16} />
          {t.newStrategy}
        </button>
      </div>

      {error && (
        <div className="alert alert-danger u-margin-bottom-1-5rem">
          <AlertCircle size={16} />
          <span>{error}</span>
        </div>
      )}

      {/* Weekly Schedule Row */}
      <WeeklyScheduleGrid schedule={schedule} lang={lang} />

      {/* Strategies List */}
      <div className="strategy-library">


        {strategies.length === 0 ? (
          <div className="empty-state u-padding-2rem">
            <p className="text-muted">
              {lang === 'zh'
                ? '尚未创建策略，请先配置学习安排。'
                : 'No strategies yet. Create one to set your study schedule.'}
            </p>
            <button className="btn btn-primary u-margin-top-1rem" onClick={openCreateModal}>
              <Plus size={16} />
              {t.newStrategy}
            </button>
          </div>
        ) : (
          <div className="strategies-grid">
            {strategies.map((s) => (
              <StrategyCard
                key={s.id}
                strategy={s}
                lang={lang}
                onEdit={openEditModal}
                onDelete={handleDelete}
              />
            ))}
          </div>
        )}
      </div>

      {/* Strategy Editor Modal */}
      {modalOpen && (
        <Dialog
          closeDisabled={saving}
          title={editingStrategy ? t.editStrategy : t.newStrategy}
          lang={lang}
          onClose={() => setModalOpen(false)}
          drawer
        >
          <div className="modal-body">
            {error && (
              <div className="alert alert-danger u-margin-bottom-1rem">
                <AlertCircle size={16} />
                <span>{error}</span>
              </div>
            )}

            {/* 1. Basics */}
            <div className="strategy-form-section">
              {/* Name & Count */}
              <div className="form-grid-2">
                <div className="form-group">
                  <label className="form-label">{t.strategyName} *</label>
                  <input
                    type="text"
                    className="form-input"
                    aria-label={t.strategyName}
                    maxLength={100}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder={t.strategyNamePlaceholder}
                    required
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">{t.dailyCount} *</label>
                  <input
                    type="number"
                    className="form-input"
                    min="1"
                    max="50"
                    placeholder={lang === 'zh' ? '例如：3' : 'e.g. 3'}
                    aria-label={t.dailyCount}
                    value={dailyCount}
                    step="1"
                    aria-invalid={exceedsTotal || (dailyCount !== '' && !hasDailyCount)}
                    aria-describedby={validationMessage ? validationId : undefined}
                    onChange={(e) => {
                      const total = e.target.value === '' ? '' : Number(e.target.value);
                      setDailyCount(total);
                      setDifficultyDraft(draft => updateDifficultyDraft(draft, total));
                    }}
                    required
                  />
                </div>
              </div>

              {/* Weekday Assignment */}
              <div className="form-group">
                <label className="form-label">{t.assignedDays}</label>
                <div className="weekday-selector-row">
                  {Array.from({ length: 7 }, (_, day) => {
                    const isSelected = weekdays.includes(day);
                    const occupiedBy = schedule.find((s) => s.weekday === day)?.strategy;
                    const isConflict = occupiedBy && occupiedBy.id !== editingStrategy?.id;

                    return (
                      <button
                        key={day}
                        type="button"
                        className={`weekday-select-btn ${isSelected ? 'selected' : ''} ${isConflict ? 'conflict' : ''}`}
                        onClick={() => toggleWeekday(day)}
                        title={isConflict ? `${t.conflictWarning} (${occupiedBy.name})` : undefined}
                      >
                        {t.weekdays[day]}
                        {isConflict && <span className="conflict-dot" />}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="form-grid-2">
                <TimeBudgetField lang={lang} value={timeBudget} onChange={setTimeBudget} />
                <div className="form-group">
                  <label className="form-label">{t.includePremium}</label>
                  <label className="form-checkbox-label u-margin-top-0-5rem">
                    <input type="checkbox" checked={premium} onChange={(e) => setPremium(e.target.checked)} />
                    <span>{t.includePremium}</span>
                  </label>
                </div>
              </div>

              {/* Topic tags selection; applies to new problems, and to reviews only when asked below. */}
              <div className="form-group">
                <div className="u-display-flex u-justify-content-space-between u-margin-bottom-0-25rem">
                  <label className="form-label">{t.topicTagsFilter}</label>
                  {selectedTags.length > 0 && (
                    <button
                      type="button"
                      className="btn-link text-muted"
                      onClick={() => setSelectedTags([])}
                    >
                      {t.clearTags}
                    </button>
                  )}
                </div>
                <div className="tag-chips-scroll">
                  {allTags.slice(0, 40).map((tag) => {
                    const isSelected = selectedTags.includes(tag.slug);
                    return (
                      <button
                        key={tag.slug}
                        type="button"
                        className={`tag-chip selectable ${isSelected ? 'selected' : ''}`}
                        onClick={() => toggleTag(tag.slug)}
                      >
                        {tag.name}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* 2. Reviews */}
            <div className="strategy-form-section u-margin-top-1rem">
              <div className="form-group">
                <span className="form-label" id={`${validationId}-review-mode`}>{t.reviewMode} *</span>
                <div role="radiogroup" aria-labelledby={`${validationId}-review-mode`} className="u-display-flex u-flex-direction-column u-gap-0-5rem u-margin-top-0-25rem">
                  {(['none', 'partial', 'all'] as const).map((mode, index) => <label key={mode} className="form-checkbox-label u-cursor-pointer">
                    <input type="radio" name="reviewMode" checked={reviewMode === mode} onChange={() => setReviewMode(mode)} />
                    <span>{[t.disableReview, t.partialReview, t.allReview][index]}</span>
                  </label>)}
                </div>
                {reviewMode && <p className="text-muted u-margin-top-0-25rem">{REVIEW_MODE_HINT[reviewMode][lang]}</p>}
              </div>

              {reviewMode === 'partial' && (
                <div className="form-group u-margin-top-0-75rem">
                  <label className="form-label" htmlFor={`${validationId}-review`}>{t.reviewCount} *</label>
                  <input
                    id={`${validationId}-review`}
                    type="number"
                    className="form-input"
                    min="1"
                    max={dailyCount || undefined}
                    step="1"
                    aria-label={t.reviewCount}
                    value={reviewCount}
                    aria-invalid={reviewCount !== '' && !isReviewValid}
                    aria-describedby={validationMessage ? validationId : undefined}
                    onChange={e => setReviewCount(e.target.value === '' ? '' : Number(e.target.value))}
                    required
                  />
                </div>
              )}

              {reviewOn && selectedTags.length > 0 && (
                <div className="form-group u-margin-top-0-75rem">
                  <label className="form-checkbox-label">
                    <input type="checkbox" checked={reviewScopeMatching} onChange={e => setReviewScopeMatching(e.target.checked)} />
                    <span>{lang === 'zh' ? '只复习带所选标签的题' : 'Only review problems with the selected tags'}</span>
                  </label>
                  <p className="text-muted">{lang === 'zh'
                    ? '关闭时，其他专题的到期复习也会排进来，避免积压。'
                    : 'When off, due reviews from other topics are included too, so they do not pile up.'}</p>
                </div>
              )}
            </div>

            {/* 3. New problems (review-only strategies never pick any) */}
            {mixRequired && (
              <div className="strategy-form-section u-margin-top-1rem">
                {/* Counts remain explicit; only the system-owned third field tracks the remainder. */}
                <div className="form-group">
                  <div className="u-display-flex u-justify-content-space-between u-margin-bottom-0-25rem">
                    <span className="form-label">{t.difficultyCounts} *</span>
                    <span className="text-muted" aria-live="polite">{currentSum} / {dailyCount || '—'}</span>
                  </div>
                  <div className="difficulty-inputs-row">
                    {difficulties.map((difficulty, index) => {
                      const label = [t.easyCount, t.mediumCount, t.hardCount][index];
                      return <div className="diff-input-group" key={difficulty}>
                        <label className={`diff-input-label difficulty-${difficulty.toLowerCase()}`} htmlFor={`${validationId}-${difficulty}`}>{label}</label>
                        <input id={`${validationId}-${difficulty}`} type="number" className="form-input"
                          min="0" max={dailyCount || undefined} step="1" aria-label={label}
                          value={counts[difficulty]} aria-invalid={counts[difficulty] !== '' &&
                            (!isCount(counts[difficulty]) || (typeof dailyCount === 'number' && counts[difficulty] > dailyCount))}
                          aria-describedby={validationMessage ? validationId : undefined}
                          onChange={e => setDifficultyDraft(draft => updateDifficultyDraft(draft, dailyCount, {
                            difficulty, value: e.target.value === '' ? '' : Number(e.target.value),
                          }))} />
                      </div>;
                    })}
                  </div>
                  <p className="text-muted u-margin-top-0-25rem">
                    {lang === 'zh'
                      ? '按不排复习的一天填写；有复习时，按这个比例分配剩下的新题名额。'
                      : 'Fill this in for a day without reviews. On review days, the remaining new-problem slots follow the same ratio.'}
                    {capSplit && (lang === 'zh'
                      ? ` 复习排满 ${capSplit.cap} 道时：新题 ${capSplit.newCount} 道（简单 ${capSplit.split.Easy} / 中等 ${capSplit.split.Medium} / 困难 ${capSplit.split.Hard}）。`
                      : ` With all ${capSplit.cap} reviews: ${capSplit.newCount} new (Easy ${capSplit.split.Easy} / Medium ${capSplit.split.Medium} / Hard ${capSplit.split.Hard}).`)}
                  </p>
                </div>

                {/* Weak topics first */}
                <div className="form-group focus-session-box">
                  <label className="form-checkbox-label">
                    <input type="checkbox" checked={focusWeakTags} onChange={e=>setFocusWeakTags(e.target.checked)} />
                    <span>{t.focusWeakTags}</span>
                  </label>
                  <p className="text-muted">{t.focusWeakTagsDesc}</p>
                  {masteryLoading?<p role="status">{t.insightLoading}</p>:masteryError
                    ?<p role="status">{t.insightLoadError} <button type="button" className="btn btn-secondary" onClick={()=>setMasteryRetry(v=>v+1)}>{t.retry}</button></p>
                    :weakTags.length?<div className="top-tags-wrap">{weakTags.slice(0,3).map(tag=><span className="tag-chip" key={tag.tagSlug}>{tag.tagName}</span>)}</div>
                    :<p className="text-muted">{t.noWeakTopics}</p>}
                </div>
              </div>
            )}
            {validationMessage && <p id={validationId} role="alert" className="strategy-count-error">{validationMessage}</p>}

            {/* 4. Qualitative Study Preferences */}
            <div className="strategy-form-section u-margin-top-1rem">
              <div className="form-group">
                <label className="form-label">{t.studyPreferences}</label>
                <p className="text-muted u-margin-bottom-0-5rem">{t.studyPreferencesDesc}</p>
                <textarea
                  className="form-textarea"
                  rows={2}
                  aria-label={t.studyPreferences}
                  maxLength={2000}
                  value={preference}
                  onChange={(e) => setPreference(e.target.value)}
                  placeholder={t.preferencesPlaceholder}
                />
              </div>
            </div>
          </div>

          <div className="modal-footer">
            <button className="btn btn-secondary" onClick={() => setModalOpen(false)} disabled={saving}>
              {t.cancel}
            </button>
            <button className="btn btn-primary" onClick={handleSave} disabled={saving || !isFormValid}>
              <CheckCircle2 size={16} />
              {saving ? t.saving : t.saveStrategy}
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
};
