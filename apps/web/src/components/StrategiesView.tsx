/**
 * Strategies & Weekly Schedule View component.
 * Allows users to configure recommendation strategies (daily count, difficulty mix,
 * topic tags, spaced repetition, premium) and map them across weekdays with conflict detection.
 */
import React, { useEffect, useState, useCallback } from 'react';
import {
  Calendar,
  Plus,
  Edit2,
  Trash2,
  CheckCircle2,
  AlertTriangle,
  AlertCircle,
  Clock,
  Layers,
  Sparkles,
  Tag,
  Shield,
  RotateCcw,
  X,
} from 'lucide-react';
import {
  api,
  type Strategy,
  type StrategyInput,
  type TopicTag,
} from '../api.ts';
import { translations, type Language } from '../i18n.ts';

interface StrategiesViewProps {
  lang: Language;
}

export const StrategiesView: React.FC<StrategiesViewProps> = ({ lang }) => {
  const t = translations[lang];

  const [strategies, setStrategies] = useState<Strategy[]>([]);
  const [schedule, setSchedule] = useState<{ weekday: number; strategy: Strategy | null }[]>([]);
  const [allTags, setAllTags] = useState<TopicTag[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Strategy Modal State
  const [modalOpen, setModalOpen] = useState(false);
  const [editingStrategy, setEditingStrategy] = useState<Strategy | null>(null);
  const [name, setName] = useState('');
  const [dailyCount, setDailyCount] = useState<number | ''>('');
  const [easyPercent, setEasyPercent] = useState<number | ''>('');
  const [medPercent, setMedPercent] = useState<number | ''>('');
  const [hardPercent, setHardPercent] = useState<number | ''>('');
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [premium, setPremium] = useState(false);
  const [reviewEnabled, setReviewEnabled] = useState<boolean | null>(null);
  const [reviewPercent, setReviewPercent] = useState<number | '' | null>(null);
  const [weekdays, setWeekdays] = useState<number[]>([]);
  const [preference, setPreference] = useState('');
  const [saving, setSaving] = useState(false);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [strats, sched, tagsRes] = await Promise.all([
        api.getStrategies(),
        api.getWeeklySchedule(),
        api.getAllTags(),
      ]);
      setStrategies(strats);
      setSchedule(sched);
      setAllTags(tagsRes.tags);
    } catch (err: any) {
      setError(err.message || 'Failed to load strategies and schedule.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  function openCreateModal() {
    setEditingStrategy(null);
    setName('');
    setDailyCount('');
    setEasyPercent('');
    setMedPercent('');
    setHardPercent('');
    setSelectedTags([]);
    setPremium(false);
    setReviewEnabled(null);
    setReviewPercent(null);
    setWeekdays([]);
    setPreference('');
    setError(null);
    setModalOpen(true);
  }

  function openEditModal(s: Strategy) {
    setEditingStrategy(s);
    setName(s.name);
    setDailyCount(s.rules.dailyCount);
    setEasyPercent(s.rules.difficulty.Easy);
    setMedPercent(s.rules.difficulty.Medium);
    setHardPercent(s.rules.difficulty.Hard);
    setSelectedTags(s.rules.tags);
    setPremium(s.rules.premium);
    setReviewEnabled(s.rules.reviewEnabled);
    setReviewPercent(s.rules.reviewPercent);
    setWeekdays(s.weekdays);
    setPreference(s.rules.preference);
    setError(null);
    setModalOpen(true);
  }

  const hasDailyCount = typeof dailyCount === 'number' && dailyCount > 0;
  const hasDifficulties =
    typeof easyPercent === 'number' &&
    typeof medPercent === 'number' &&
    typeof hardPercent === 'number';
  const currentSum = hasDifficulties
    ? Math.round(((easyPercent as number) + (medPercent as number) + (hardPercent as number)) * 100) / 100
    : 0;
  const isSumValid = hasDifficulties && Math.abs(currentSum - 100) < 1e-4;
  const isReviewValid =
    reviewEnabled !== null &&
    (!reviewEnabled || (typeof reviewPercent === 'number' && reviewPercent > 0 && reviewPercent <= 100));
  const isFormValid = name.trim().length > 0 && hasDailyCount && isSumValid && isReviewValid;

  async function handleSave() {
    if (!isFormValid) return;

    setSaving(true);
    setError(null);
    try {
      const payload: StrategyInput = {
        name: name.trim(),
        rules: {
          dailyCount: dailyCount as number,
          difficulty: {
            Easy: easyPercent as number,
            Medium: medPercent as number,
            Hard: hardPercent as number,
          },
          tags: selectedTags,
          premium,
          reviewEnabled: reviewEnabled as boolean,
          reviewPercent: reviewEnabled ? (reviewPercent as number) : null,
          preference: preference.trim(),
        },
        weekdays,
      };

      if (editingStrategy) {
        await api.updateStrategy(editingStrategy.id, {
          expectedVersion: editingStrategy.version,
          ...payload,
        });
      } else {
        await api.createStrategy(payload);
      }

      setModalOpen(false);
      await loadData();
    } catch (err: any) {
      setError(err.message || 'Failed to save strategy.');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(s: Strategy) {
    if (!window.confirm(t.confirmDeleteStrategy)) return;
    try {
      await api.deleteStrategy(s.id, s.version);
      await loadData();
    } catch (err: any) {
      setError(err.message || 'Failed to delete strategy.');
    }
  }

  function toggleWeekday(day: number) {
    if (weekdays.includes(day)) {
      setWeekdays(weekdays.filter((d) => d !== day));
    } else {
      setWeekdays([...weekdays, day].sort());
    }
  }

  function toggleTag(slug: string) {
    if (selectedTags.includes(slug)) {
      setSelectedTags(selectedTags.filter((t) => t !== slug));
    } else {
      setSelectedTags([...selectedTags, slug]);
    }
  }

  if (loading) {
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
          <p className="view-subtitle">{t.strategiesSubtitle}</p>
        </div>
        <button className="btn btn-primary" onClick={openCreateModal}>
          <Plus size={16} />
          {t.newStrategy}
        </button>
      </div>

      {error && (
        <div className="alert alert-danger" style={{ marginBottom: '1.5rem' }}>
          <AlertCircle size={16} />
          <span>{error}</span>
        </div>
      )}

      {/* Weekly Schedule Row */}
      <div className="section-card" style={{ marginBottom: '2rem' }}>
        <h3 className="section-title" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1rem' }}>
          <Calendar size={18} className="primary-icon" />
          {t.weekdayScheduleTitle}
        </h3>

        <div className="weekly-schedule-grid">
          {schedule.map(({ weekday, strategy }) => (
            <div key={weekday} className={`day-schedule-card ${strategy ? 'has-strategy' : 'is-rest'}`}>
              <div className="day-header">
                <span className="day-name">{t.weekdays[weekday]}</span>
                <span className="day-full-name">{t.weekdayFull[weekday]}</span>
              </div>
              <div className="day-body">
                {strategy ? (
                  <>
                    <div className="day-strat-name">{strategy.name}</div>
                    <div className="day-strat-meta">
                      <span>{strategy.rules.dailyCount} Qs</span>
                      <span>
                        E:{Math.round(strategy.rules.difficulty.Easy)}% M:{Math.round(strategy.rules.difficulty.Medium)}% H:{Math.round(strategy.rules.difficulty.Hard)}%
                      </span>
                    </div>
                  </>
                ) : (
                  <div className="day-rest-label">{t.noStrategyAssigned}</div>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Strategies List */}
      <div className="section-card">
        <h3 className="section-title" style={{ marginBottom: '1.25rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <Layers size={18} className="primary-icon" />
          {t.strategiesTitle} ({strategies.length})
        </h3>

        {strategies.length === 0 ? (
          <div className="empty-state" style={{ padding: '2rem' }}>
            <p className="text-muted">No strategies created yet. Create one to automate your daily schedule.</p>
            <button className="btn btn-primary" onClick={openCreateModal} style={{ marginTop: '1rem' }}>
              <Plus size={16} />
              {t.newStrategy}
            </button>
          </div>
        ) : (
          <div className="strategies-grid">
            {strategies.map((s) => (
              <div key={s.id} className="strategy-card">
                <div className="strategy-header">
                  <div>
                    <h4 className="strategy-name">{s.name}</h4>
                    <span className="badge badge-secondary" style={{ fontSize: '0.75rem', marginTop: '0.25rem' }}>
                      v{s.version}
                    </span>
                  </div>
                  <div className="strategy-actions">
                    <button className="btn-icon" onClick={() => openEditModal(s)} title={t.editStrategy}>
                      <Edit2 size={16} />
                    </button>
                    <button className="btn-icon danger-icon" onClick={() => handleDelete(s)} title={t.deleteStrategy}>
                      <Trash2 size={16} />
                    </button>
                  </div>
                </div>

                <div className="strategy-details">
                  <div className="strategy-detail-row">
                    <span className="text-muted">{t.dailyCount}:</span>
                    <strong>{s.rules.dailyCount} problems</strong>
                  </div>

                  <div className="strategy-detail-row">
                    <span className="text-muted">{t.difficultyDistribution}:</span>
                    <div className="diff-pills-group">
                      <span className="badge difficulty-easy">Easy: {s.rules.difficulty.Easy}%</span>
                      <span className="badge difficulty-medium">Med: {s.rules.difficulty.Medium}%</span>
                      <span className="badge difficulty-hard">Hard: {s.rules.difficulty.Hard}%</span>
                    </div>
                  </div>

                  <div className="strategy-detail-row">
                    <span className="text-muted">{t.assignedDays}:</span>
                    <div className="weekday-badges">
                      {s.weekdays.length > 0 ? (
                        s.weekdays.map((d) => (
                          <span key={d} className="badge badge-primary">
                            {t.weekdays[d]}
                          </span>
                        ))
                      ) : (
                        <span className="text-muted">Unassigned</span>
                      )}
                    </div>
                  </div>

                  <div className="strategy-detail-row">
                    <span className="text-muted">{t.enableReview}:</span>
                    <span>
                      {s.rules.reviewEnabled ? (
                        <span className="badge badge-success">Enabled ({s.rules.reviewPercent}%)</span>
                      ) : (
                        <span className="badge badge-secondary">Disabled</span>
                      )}
                    </span>
                  </div>

                  {s.rules.tags.length > 0 && (
                    <div className="strategy-detail-row">
                      <span className="text-muted">{t.allTags}:</span>
                      <div className="tags-preview-list">
                        {s.rules.tags.map((slug) => (
                          <span key={slug} className="tag-chip">
                            {slug}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  {s.rules.preference && (
                    <div className="strategy-detail-row">
                      <span className="text-muted">{t.studyPreferences}:</span>
                      <p className="pref-preview-text">"{s.rules.preference}"</p>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Strategy Editor Modal */}
      {modalOpen && (
        <div className="modal-backdrop" onClick={() => setModalOpen(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '650px' }}>
            <div className="modal-header">
              <h3 className="modal-title">
                {editingStrategy ? t.editStrategy : t.newStrategy}
              </h3>
              <button className="btn-icon" onClick={() => setModalOpen(false)}>
                <X size={18} />
              </button>
            </div>

            <div className="modal-body">
              {error && (
                <div className="alert alert-danger" style={{ marginBottom: '1rem' }}>
                  <AlertCircle size={16} />
                  <span>{error}</span>
                </div>
              )}

              {/* Name & Count */}
              <div className="form-grid-2">
                <div className="form-group">
                  <label className="form-label">{t.strategyName} *</label>
                  <input
                    type="text"
                    className="form-input"
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
                    placeholder="e.g. 3"
                    value={dailyCount}
                    onChange={(e) => {
                      const val = e.target.value;
                      setDailyCount(val === '' ? '' : Math.max(1, parseInt(val, 10) || 1));
                    }}
                    required
                  />
                </div>
              </div>

              {/* Difficulty mix */}
              <div className="form-group">
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.25rem' }}>
                  <label className="form-label">{t.difficultyDistribution} *</label>
                  <span
                    style={{
                      fontSize: '0.85rem',
                      fontWeight: 600,
                      color: isSumValid ? 'var(--success)' : 'var(--danger)',
                    }}
                  >
                    {t.currentSum.replace('{sum}', String(currentSum))}
                    {!isSumValid && ` (${t.sumMustBe100})`}
                  </span>
                </div>
                <div className="difficulty-inputs-row">
                  <div className="diff-input-group">
                    <span className="diff-input-label difficulty-easy">{t.statEasy} %</span>
                    <input
                      type="number"
                      className="form-input"
                      min="0"
                      max="100"
                      step="any"
                      placeholder="e.g. 33.33"
                      value={easyPercent}
                      onChange={(e) => {
                        const val = e.target.value;
                        setEasyPercent(val === '' ? '' : Math.max(0, parseFloat(val) || 0));
                      }}
                    />
                  </div>
                  <div className="diff-input-group">
                    <span className="diff-input-label difficulty-medium">{t.statMedium} %</span>
                    <input
                      type="number"
                      className="form-input"
                      min="0"
                      max="100"
                      step="any"
                      placeholder="e.g. 33.33"
                      value={medPercent}
                      onChange={(e) => {
                        const val = e.target.value;
                        setMedPercent(val === '' ? '' : Math.max(0, parseFloat(val) || 0));
                      }}
                    />
                  </div>
                  <div className="diff-input-group">
                    <span className="diff-input-label difficulty-hard">{t.statHard} %</span>
                    <input
                      type="number"
                      className="form-input"
                      min="0"
                      max="100"
                      step="any"
                      placeholder="e.g. 33.34"
                      value={hardPercent}
                      onChange={(e) => {
                        const val = e.target.value;
                        setHardPercent(val === '' ? '' : Math.max(0, parseFloat(val) || 0));
                      }}
                    />
                  </div>
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

              {/* Review & Premium settings */}
              <div className="form-grid-2">
                <div className="form-group">
                  <label className="form-label">{t.enableReview} *</label>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginTop: '0.25rem' }}>
                    <label className="form-checkbox-label" style={{ cursor: 'pointer' }}>
                      <input
                        type="radio"
                        name="reviewMode"
                        checked={reviewEnabled === true}
                        onChange={() => {
                          setReviewEnabled(true);
                          if (reviewPercent === null || reviewPercent === '') setReviewPercent(33);
                        }}
                      />
                      <span>{t.enableReview}</span>
                    </label>
                    <label className="form-checkbox-label" style={{ cursor: 'pointer' }}>
                      <input
                        type="radio"
                        name="reviewMode"
                        checked={reviewEnabled === false}
                        onChange={() => {
                          setReviewEnabled(false);
                          setReviewPercent(null);
                        }}
                      />
                      <span>{t.disableReview}</span>
                    </label>
                  </div>
                  {reviewEnabled && (
                    <div style={{ marginTop: '0.75rem' }}>
                      <label className="form-label" style={{ fontSize: '0.8rem' }}>{t.reviewPercentage} *</label>
                      <input
                        type="number"
                        className="form-input"
                        min="1"
                        max="100"
                        placeholder="e.g. 33"
                        value={reviewPercent ?? ''}
                        onChange={(e) => {
                          const val = e.target.value;
                          setReviewPercent(val === '' ? '' : Math.max(1, Math.min(100, parseInt(val, 10) || 1)));
                        }}
                        required
                      />
                    </div>
                  )}
                </div>

                <div className="form-group">
                  <label className="form-label">{t.includePremium}</label>
                  <label className="form-checkbox-label" style={{ marginTop: '0.5rem' }}>
                    <input
                      type="checkbox"
                      checked={premium}
                      onChange={(e) => setPremium(e.target.checked)}
                    />
                    <span>{t.includePremium}</span>
                  </label>
                </div>
              </div>

              {/* Topic tags selection */}
              <div className="form-group">
                <label className="form-label">{t.topicTagsFilter}</label>
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

              {/* Study Preferences */}
              <div className="form-group">
                <label className="form-label">{t.studyPreferences}</label>
                <textarea
                  className="form-textarea"
                  rows={2}
                  value={preference}
                  onChange={(e) => setPreference(e.target.value)}
                  placeholder={t.preferencesPlaceholder}
                />
              </div>
            </div>

            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setModalOpen(false)} disabled={saving}>
                {t.cancel}
              </button>
              <button
                className="btn btn-primary"
                onClick={handleSave}
                disabled={saving || !isFormValid}
              >
                <CheckCircle2 size={16} />
                {saving ? 'Saving...' : t.saveStrategy}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
