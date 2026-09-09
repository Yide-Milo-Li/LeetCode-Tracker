/**
 * Activity History Drawer component.
 * Displays a slide-over panel with paginated, filterable activity history
 * (by calendar date, source type, and pending date status) with full keyboard accessibility.
 */
import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  X,
  Calendar,
  Filter,
  ExternalLink,
  ChevronLeft,
  ChevronRight,
  Clock,
  AlertTriangle,
  CheckCircle2,
  Circle,
  FileText,
  RotateCcw,
} from 'lucide-react';
import {
  api,
  type RecentActivityItem,
  type DashboardActivityListResponse,
} from '../api.ts';
import { translations, type Language } from '../i18n.ts';

interface ActivityHistoryDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  lang: Language;
  initialDate?: string | null;
}

export const ActivityHistoryDrawer: React.FC<ActivityHistoryDrawerProps> = ({
  isOpen,
  onClose,
  lang,
  initialDate = null,
}) => {
  const t = translations[lang];

  const [dateFilter, setDateFilter] = useState<string>(initialDate || '');
  const [sourceFilter, setSourceFilter] = useState<'all' | 'manual' | 'snapshot'>('all');
  const [pendingDateFilter, setPendingDateFilter] = useState<'all' | 'true' | 'false'>('all');
  const [page, setPage] = useState<number>(1);
  const [loading, setLoading] = useState<boolean>(false);
  const [data, setData] = useState<DashboardActivityListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const seqRef = useRef(0);
  const drawerRef = useRef<HTMLDivElement>(null);
  const previousActiveElement = useRef<HTMLElement | null>(null);

  // Sync initial date if passed from parent (e.g. clicked on a heatmap cell or cleared)
  useEffect(() => {
    setDateFilter(initialDate || '');
    setPage(1);
  }, [initialDate]);

  const fetchActivities = useCallback(async () => {
    if (!isOpen) return;
    const seq = ++seqRef.current;
    setLoading(true);
    setError(null);
    try {
      const res = await api.getDashboardActivities({
        page,
        limit: 20,
        date: dateFilter || undefined,
        source: sourceFilter,
        pendingDate: pendingDateFilter,
      });
      if (seq !== seqRef.current) return;
      setData(res);
    } catch (err: unknown) {
      if (seq !== seqRef.current) return;
      setError(err instanceof Error ? err.message : 'Failed to load activity history.');
    } finally {
      if (seq === seqRef.current) {
        setLoading(false);
      }
    }
  }, [isOpen, page, dateFilter, sourceFilter, pendingDateFilter]);

  useEffect(() => {
    fetchActivities();
  }, [fetchActivities]);

  // Focus management: Store previous active element and trap focus
  useEffect(() => {
    if (isOpen) {
      previousActiveElement.current = document.activeElement as HTMLElement | null;
      setTimeout(() => {
        const closeBtn = drawerRef.current?.querySelector('button[aria-label]') as HTMLElement | null;
        closeBtn?.focus();
      }, 0);
    } else {
      previousActiveElement.current?.focus();
    }
  }, [isOpen]);

  // Keyboard accessibility: Close on Escape key and trap tab focus
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isOpen) return;

      if (e.key === 'Escape') {
        onClose();
        return;
      }

      if (e.key === 'Tab' && drawerRef.current) {
        const focusable = drawerRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        );
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];

        if (e.shiftKey) {
          if (document.activeElement === first) {
            e.preventDefault();
            last.focus();
          }
        } else {
          if (document.activeElement === last) {
            e.preventDefault();
            first.focus();
          }
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const handleResetFilters = () => {
    setDateFilter('');
    setSourceFilter('all');
    setPendingDateFilter('all');
    setPage(1);
  };

  return (
    <div
      className="drawer-backdrop"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="drawer-title"
    >
      <div
        ref={drawerRef}
        className="drawer-content"
        onClick={e => e.stopPropagation()}
      >
        {/* Drawer Header */}
        <div className="drawer-header">
          <div className="flex items-center gap-2">
            <Clock className="w-5 h-5 text-indigo-500" />
            <h2 id="drawer-title" className="text-lg font-bold text-gray-900 dark:text-white">
              {t.activityDrawerTitle}
            </h2>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
            aria-label={t.closeDrawer}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Filters Bar */}
        <div className="drawer-filters p-4 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            {/* Date filter */}
            <div>
              <label htmlFor="activity-date-filter" className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
                {t.filterDate}
              </label>
              <input
                id="activity-date-filter"
                type="date"
                value={dateFilter}
                onChange={e => {
                  setDateFilter(e.target.value);
                  setPage(1);
                }}
                className="w-full text-xs px-2.5 py-1.5 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 text-gray-900 dark:text-white focus:ring-1 focus:ring-indigo-500"
              />
            </div>

            {/* Source filter */}
            <div>
              <label htmlFor="activity-source-filter" className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
                {t.filterSource}
              </label>
              <select
                id="activity-source-filter"
                value={sourceFilter}
                onChange={e => {
                  setSourceFilter(e.target.value as 'all' | 'manual' | 'snapshot');
                  setPage(1);
                }}
                className="w-full text-xs px-2.5 py-1.5 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 text-gray-900 dark:text-white focus:ring-1 focus:ring-indigo-500"
              >
                <option value="all">{t.sourceAll}</option>
                <option value="manual">{t.sourceManual}</option>
                <option value="snapshot">{t.sourceSnapshot}</option>
              </select>
            </div>

            {/* Pending Date filter */}
            <div>
              <label htmlFor="activity-pending-filter" className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
                {t.filterPendingDate}
              </label>
              <select
                id="activity-pending-filter"
                value={pendingDateFilter}
                onChange={e => {
                  setPendingDateFilter(e.target.value as 'all' | 'true' | 'false');
                  setPage(1);
                }}
                className="w-full text-xs px-2.5 py-1.5 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 text-gray-900 dark:text-white focus:ring-1 focus:ring-indigo-500"
              >
                <option value="all">{t.pendingDateAll}</option>
                <option value="true">{t.pendingDateOnly}</option>
                <option value="false">{t.confirmedDateOnly}</option>
              </select>
            </div>
          </div>

          {(dateFilter || sourceFilter !== 'all' || pendingDateFilter !== 'all') && (
            <div className="flex justify-end">
              <button
                onClick={handleResetFilters}
                className="inline-flex items-center gap-1 text-xs text-indigo-600 dark:text-indigo-400 hover:underline"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                {t.clearFilters}
              </button>
            </div>
          )}
        </div>

        {/* Activity List Content */}
        <div className="drawer-body flex-1 overflow-y-auto p-4 space-y-2.5">
          {loading && (
            <div className="py-12 text-center text-sm text-gray-500 dark:text-gray-400">
              <div className="animate-spin w-6 h-6 border-2 border-indigo-500 border-t-transparent rounded-full mx-auto mb-2" />
              {t.loadingOverview}
            </div>
          )}

          {error && (
            <div className="p-3 text-xs bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 rounded-lg border border-red-200 dark:border-red-800">
              {error}
            </div>
          )}

          {!loading && !error && data?.items.length === 0 && (
            <div className="py-16 text-center text-sm text-gray-500 dark:text-gray-400">
              <FileText className="w-8 h-8 mx-auto text-gray-300 dark:text-gray-600 mb-2" />
              {t.drawerNoResults}
            </div>
          )}

          {!loading &&
            data?.items.map((item: RecentActivityItem) => {
              const isAccepted = item.status === 'completed' || item.status === 'accepted';
              return (
                <div
                  key={`${item.source}-${item.id}`}
                  className="p-3 bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 shadow-sm hover:border-gray-300 dark:hover:border-gray-600 transition-colors"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap mb-1">
                        <span className="text-xs font-semibold text-gray-500 dark:text-gray-400">
                          #{item.questionFrontendId}
                        </span>
                        <span className="text-sm font-medium text-gray-900 dark:text-white truncate">
                          {item.problemTitle}
                        </span>
                        <span
                          className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
                            item.difficulty === 'Easy'
                              ? 'bg-emerald-100 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-300'
                              : item.difficulty === 'Medium'
                              ? 'bg-amber-100 dark:bg-amber-950/60 text-amber-700 dark:text-amber-300'
                              : 'bg-rose-100 dark:bg-rose-950/60 text-rose-700 dark:text-rose-300'
                          }`}
                        >
                          {item.difficulty}
                        </span>
                      </div>

                      <div className="flex items-center gap-3 text-xs text-gray-500 dark:text-gray-400 flex-wrap">
                        <span className="flex items-center gap-1">
                          {isAccepted ? (
                            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
                          ) : (
                            <Circle className="w-3.5 h-3.5 text-gray-400" />
                          )}
                          <span className={isAccepted ? 'text-emerald-600 dark:text-emerald-400 font-medium' : ''}>
                            {item.action}
                          </span>
                        </span>

                        <span className="text-gray-300 dark:text-gray-600">•</span>

                        <span className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300">
                          {item.source === 'manual' ? t.sourceManual : t.sourceSnapshot}
                        </span>

                        {item.isDatePending && (
                          <span
                            className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-950/60 text-amber-700 dark:text-amber-300 font-medium"
                            title={t.pendingDatesNotice.replace('{count}', '1')}
                          >
                            <AlertTriangle className="w-3 h-3 text-amber-500" />
                            {t.filterPendingDate}
                          </span>
                        )}
                      </div>
                    </div>

                    <div className="text-right flex-shrink-0">
                      <div className="text-xs font-mono text-gray-500 dark:text-gray-400">
                        {item.timePrecision === 'datetime' ? item.timestamp.slice(0, 16).replace('T', ' ') : item.timestamp}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
        </div>

        {/* Drawer Footer / Pagination */}
        {data && data.totalPages > 1 && (
          <div className="drawer-footer p-3 border-t border-gray-200 dark:border-gray-700 flex items-center justify-between bg-gray-50 dark:bg-gray-800/50">
            <span className="text-xs text-gray-500 dark:text-gray-400">
              {t.pageInfo
                .replace('{page}', String(data.page))
                .replace('{totalPages}', String(data.totalPages))
                .replace('{total}', String(data.total))}
            </span>

            <div className="flex items-center gap-1">
              <button
                onClick={() => setPage(p => Math.max(1, p - 1))}
                disabled={page <= 1}
                className="p-1.5 rounded border border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed"
                aria-label={t.prev}
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <button
                onClick={() => setPage(p => Math.min(data.totalPages, p + 1))}
                disabled={page >= data.totalPages}
                className="p-1.5 rounded border border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed"
                aria-label={t.next}
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
