/**
 * Today's Plan view component.
 * Displays daily recommended problems, AI encouragement, completion status,
 * single & batch question replacement, and prompt temporary override controls.
 */
import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  Sparkles,
  Coffee,
  CheckCircle2,
  Circle,
  RefreshCw,
  Clock,
  Settings,
  AlertTriangle,
  History,
  ExternalLink,
  ChevronRight,
  ShieldCheck,
  Cpu,
} from 'lucide-react';
import {
  api,
  type DailyPlan,
  type PlanItem,
  type CatalogProblem,
  type EnsureResult,
} from '../api.ts';
import { translations, type Language } from '../i18n.ts';
import { PromptOverrideModal } from './PromptOverrideModal.tsx';
import { PracticeLogModal } from './PracticeLogModal.tsx';
import { useDailyPlan, type UseDailyPlanReturn } from '../hooks/useDailyPlan.ts';

interface TodayPlanViewProps {
  lang: Language;
  onNavigateToSettings: () => void;
  onNavigateToDashboard?: () => void;
  planController?: UseDailyPlanReturn;
}

export const TodayPlanView: React.FC<TodayPlanViewProps> = ({
  lang,
  onNavigateToSettings,
  onNavigateToDashboard,
  planController,
}) => {
  const t = translations[lang];
  const internalController = useDailyPlan();
  const controller = planController ?? internalController;

  const {
    loading,
    ensureResult,
    error: controllerError,
    replacingItemId,
    replacingBatch,
    replaceOne,
    replaceAllUnfinished,
    onOverrideCommitted,
    onPracticeLogged,
    refresh: loadDailyPlan,
  } = controller;

  const [localError, setLocalError] = useState<string | null>(null);
  const error = controllerError || localError;

  // Modals
  const [isOverrideOpen, setIsOverrideOpen] = useState(false);
  const [logModalProblem, setLogModalProblem] = useState<CatalogProblem | null>(null);
  const [showVersions, setShowVersions] = useState(false);
  const [versions, setVersions] = useState<DailyPlan[]>([]);

  async function handleReplaceOne(item: PlanItem) {
    setLocalError(null);
    try {
      await replaceOne(item);
    } catch (err: unknown) {
      setLocalError(err instanceof Error ? err.message : 'Failed to replace item.');
    }
  }

  async function handleReplaceAllUnfinished() {
    setLocalError(null);
    try {
      await replaceAllUnfinished();
    } catch (err: unknown) {
      setLocalError(err instanceof Error ? err.message : 'Failed to replace unfinished items.');
    }
  }

  async function loadVersions() {
    if (!ensureResult?.plan) return;
    try {
      const v = await api.getPlanVersions(ensureResult.plan.id);
      setVersions(v);
      setShowVersions(true);
    } catch (err: unknown) {
      setLocalError(err instanceof Error ? err.message : 'Failed to load version history.');
    }
  }

  if (loading) {
    return (
      <div className="empty-state">
        <RefreshCw size={28} className="spin primary-icon" />
        <p>{t.loadingCatalog}</p>
      </div>
    );
  }

  // 1. Timezone Setup Required View
  if (ensureResult?.status === 'setup') {
    return (
      <div className="plan-setup-card">
        <Clock size={40} className="warning-icon" />
        <h3 className="section-title">{t.setupTimezoneTitle}</h3>
        <p className="text-muted" style={{ maxWidth: '500px', margin: '0.5rem auto 1.5rem auto' }}>
          {t.setupTimezoneDesc}
        </p>
        <button className="btn btn-primary" onClick={onNavigateToSettings}>
          <Settings size={16} />
          {t.navSettings}
        </button>
      </div>
    );
  }

  // 2. Rest Day View
  if (ensureResult?.status === 'rest') {
    return (
      <div className="plan-rest-card">
        <Coffee size={44} className="primary-icon" />
        <h3 className="section-title">{t.restDayTitle}</h3>
        <p className="text-muted" style={{ maxWidth: '520px', margin: '0.5rem auto 1.5rem auto' }}>
          {t.restDayDesc}
        </p>
        <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'center' }}>
          <button className="btn btn-primary" onClick={() => setIsOverrideOpen(true)}>
            <Sparkles size={16} />
            {t.createTemporaryPlan}
          </button>
          <button className="btn btn-secondary" onClick={loadDailyPlan}>
            <RefreshCw size={16} />
            {t.retry}
          </button>
        </div>

        <PromptOverrideModal
          isOpen={isOverrideOpen}
          onClose={() => setIsOverrideOpen(false)}
          onApplied={(newPlan) => onOverrideCommitted(newPlan)}
          currentPlan={null}
          lang={lang}
        />
      </div>
    );
  }

  const plan = ensureResult?.plan;
  if (!plan) {
    return (
      <div className="empty-state">
        <p>{t.noPlans}</p>
        <button className="btn btn-primary" onClick={loadDailyPlan} style={{ marginTop: '1rem' }}>
          {t.retry}
        </button>
      </div>
    );
  }

  const completedCount = plan.items.filter((i) => i.completed).length;
  const totalCount = plan.items.length;
  const progressPercent = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;

  return (
    <div className="today-view-container">
      {/* Header bar */}
      <div className="view-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          {onNavigateToDashboard && (
            <button
              className="btn btn-secondary btn-sm"
              onClick={onNavigateToDashboard}
            >
              ← {t.navDashboard}
            </button>
          )}
          <div>
            <h2 className="view-title" style={{ margin: 0 }}>{t.todayTitle}</h2>
            <p className="view-subtitle">{t.todaySubtitle}</p>
          </div>
        </div>

        <div className="plan-meta-pills">
          <span className="badge badge-info">
            <Clock size={12} />
            {plan.date} ({plan.timezone})
          </span>
          <span className={`badge ${plan.source === 'gemini' ? 'badge-primary' : 'badge-secondary'}`}>
            {plan.source === 'gemini' ? <Cpu size={12} /> : <ShieldCheck size={12} />}
            {plan.source === 'gemini' ? (plan.model || t.sourceGemini) : t.sourceLocal}
          </span>
          <button className="badge badge-outline btn-badge" onClick={loadVersions} title="View version history">
            <History size={12} />
            v{plan.version}
          </button>
        </div>
      </div>

      {error && (
        <div className="alert alert-danger" style={{ marginBottom: '1.25rem' }}>
          <AlertTriangle size={16} />
          <span>{error}</span>
        </div>
      )}

      {/* Daily Encouragement Banner */}
      <div className="encouragement-banner">
        <div className="encouragement-header">
          <Sparkles size={18} className="primary-icon" />
          <span className="encouragement-title">{t.encouragementTitle}</span>
        </div>
        <p className="encouragement-quote">
          "{plan.encouragement[lang] || plan.encouragement.en}"
        </p>
      </div>

      {/* Progress & Quota Bar */}
      <div className="plan-progress-card">
        <div className="progress-header-row">
          <div className="progress-label-group">
            <span className="progress-title">{t.completedCount}</span>
            <span className="progress-stats">
              {completedCount} / {totalCount} ({progressPercent}%)
            </span>
          </div>
          <div className="action-buttons-row">
            <button
              className="btn btn-secondary btn-sm"
              onClick={handleReplaceAllUnfinished}
              disabled={replacingBatch || completedCount === totalCount}
              title={t.replaceAllUnfinished}
            >
              <RefreshCw size={14} className={replacingBatch ? 'spin' : ''} />
              {t.replaceAllUnfinished}
            </button>
            <button
              className="btn btn-primary btn-sm"
              onClick={() => setIsOverrideOpen(true)}
              title={t.promptOverride}
            >
              <Sparkles size={14} />
              {t.promptOverride}
            </button>
          </div>
        </div>

        <div className="progress-bar-bg">
          <div className="progress-bar-fill" style={{ width: `${progressPercent}%` }} />
        </div>
      </div>

      {/* Notices banner if present */}
      {plan.notices.length > 0 && (
        <div className="alert alert-warning" style={{ marginBottom: '1.5rem' }}>
          <AlertTriangle size={16} />
          <div>
            <strong>{t.noticesTitle}:</strong>
            <ul style={{ paddingLeft: '1.25rem', marginTop: '0.25rem' }}>
              {plan.notices.map((notice, idx) => (
                <li key={idx}>{notice[lang] || notice.en}</li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {/* Problem Cards List */}
      <div className="plan-items-grid">
        {plan.items.map((item, idx) => {
          const isReplacing = replacingItemId === item.id;
          const diffClass = `difficulty-${item.problem.difficulty.toLowerCase()}`;

          return (
            <div key={item.id} className={`plan-item-card ${item.completed ? 'completed' : ''}`}>
              <div className="item-header-row">
                <div className="item-index-badge">#{idx + 1}</div>
                <div className="item-badges-group">
                  <span className={`badge ${diffClass}`}>
                    {t[`stat${item.problem.difficulty}` as keyof typeof t] || item.problem.difficulty}
                  </span>
                  <span className={`badge ${item.kind === 'review' ? 'badge-warning' : 'badge-secondary'}`}>
                    {item.kind === 'review' ? t.kindReview : t.kindNew}
                  </span>
                  {item.problem.isPaidOnly && (
                    <span className="badge badge-warning">{t.statPremium}</span>
                  )}
                </div>

                <div className="item-status-indicator">
                  {item.completed ? (
                    <span className="status-tag status-solved">
                      <CheckCircle2 size={16} />
                      {t.alreadyCompleted}
                    </span>
                  ) : (
                    <span className="status-tag status-unsolved">
                      <Circle size={16} />
                      {t.statusUnsolved}
                    </span>
                  )}
                </div>
              </div>

              <div className="item-body">
                <h4 className="item-problem-title">
                  <a
                    href={item.problem.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="problem-link"
                  >
                    <span>{item.problem.questionFrontendId}. {item.problem.title}</span>
                    <ExternalLink size={14} className="ext-icon" />
                  </a>
                </h4>

                {/* Topic tags */}
                {item.problem.topicTags.length > 0 && (
                  <div className="item-tags-row">
                    {item.problem.topicTags.slice(0, 3).map((tag) => (
                      <span key={tag.slug} className="tag-chip">
                        {tag.name}
                      </span>
                    ))}
                  </div>
                )}

                {/* Reason */}
                <p className="item-reason-text">
                  {item.reason[lang] || item.reason.en}
                </p>
              </div>

              <div className="item-footer-actions">
                {!item.completed ? (
                  <>
                    <button
                      className="btn btn-secondary btn-sm"
                      onClick={() => handleReplaceOne(item)}
                      disabled={isReplacing || replacingBatch}
                    >
                      <RefreshCw size={13} className={isReplacing ? 'spin' : ''} />
                      {t.replaceOne}
                    </button>
                    <button
                      className="btn btn-primary btn-sm"
                      onClick={() => setLogModalProblem(item.problem)}
                    >
                      <CheckCircle2 size={13} />
                      {t.markComplete}
                    </button>
                  </>
                ) : (
                  <div className="completed-info-text">
                    <CheckCircle2 size={14} className="success-icon" />
                    <span>{t.alreadyCompleted}</span>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Version History Drawer / Modal */}
      {showVersions && (
        <div className="modal-backdrop" onClick={() => setShowVersions(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '600px' }}>
            <div className="modal-header">
              <h3 className="modal-title">{t.planVersions} ({plan.date})</h3>
              <button className="btn-icon" onClick={() => setShowVersions(false)}>✕</button>
            </div>
            <div className="modal-body">
              <div className="version-list">
                {versions.map((v) => (
                  <div key={v.version} className={`version-card ${v.version === plan.version ? 'current-ver' : ''}`}>
                    <div className="version-card-header">
                      <strong>v{v.version}</strong>
                      <span className="badge badge-secondary">{v.action}</span>
                      <span className="text-muted" style={{ fontSize: '0.8rem', marginLeft: 'auto' }}>
                        {new Date(v.updatedAt).toLocaleTimeString()}
                      </span>
                    </div>
                    <p className="text-muted" style={{ fontSize: '0.85rem', margin: '0.25rem 0' }}>
                      {v.items.length} items • {v.items.map((i) => `${i.problem.questionFrontendId} (${i.problem.difficulty})`).join(', ')}
                    </p>
                  </div>
                ))}
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setShowVersions(false)}>
                {t.cancel}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Prompt Override Modal */}
      <PromptOverrideModal
        isOpen={isOverrideOpen}
        onClose={() => setIsOverrideOpen(false)}
        onApplied={(updated) => onOverrideCommitted(updated)}
        currentPlan={plan}
        lang={lang}
      />

      {/* Manual Practice Record Modal */}
      {logModalProblem && (
        <PracticeLogModal
          problem={logModalProblem}
          lang={lang}
          onClose={() => {
            setLogModalProblem(null);
          }}
          onRecordSaved={() => {
            setLogModalProblem(null);
            onPracticeLogged();
          }}
        />
      )}
    </div>
  );
};
