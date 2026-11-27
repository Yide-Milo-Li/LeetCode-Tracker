/** Desktop navigation, retained workspaces and the shared daily-plan controller. */
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  BookOpen,
  BookMarked,
  CalendarDays,
  ChartNoAxesCombined,
  Settings,
  Sun,
  Moon,
  Laptop,
  Plus,
  Upload,
  Keyboard,
  PanelLeftClose,
  PanelLeftOpen,
  Languages,
  RefreshCw,
} from 'lucide-react';
import { CatalogView } from './components/CatalogView.tsx';
import { GoalListsScope } from './components/ProblemGoalLists.tsx';
import { GoalListLibrary } from './components/GoalListLibrary.tsx';
import { ActivityRecords } from './components/ActivityRecords.tsx';
import { TodayPlanView } from './components/TodayPlanView.tsx';
import { PracticeWorkspace } from './components/PracticeWorkspace.tsx';
import { PracticeTimerPill } from './components/PracticeTimer.tsx';
import { DesktopUpdateNotice } from './components/DesktopUpdateNotice.tsx';
import { ShortcutHelpModal } from './components/ShortcutHelpModal.tsx';
import { ChatLauncher } from './components/ChatLauncher.tsx';
import type { ChatAsk, ChatAskRequest } from './chat/chat-context.ts';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts.ts';
import { SetupGate } from './components/SetupGate.tsx';
import { brandIconUrl } from './brand-icons.ts';
import { isTauri } from './platform/index.ts';
import type { SettingsSection } from './components/SettingsView.tsx';
import { Feedback, IconButton, PageHeader, Tooltip } from './components/ui.tsx';


/** Lazy-load heavy contextual workspaces and charting views to optimize desktop bundle size. */
const DashboardView = React.lazy(() =>
  import('./components/DashboardView.tsx').then((m) => ({ default: m.DashboardView })),
);
const CatalogImportWorkspace = React.lazy(() =>
  import('./components/CatalogImportWorkspace.tsx').then((m) => ({ default: m.CatalogImportWorkspace })),
);
const ProgressWorkbench = React.lazy(() =>
  import('./components/ProgressWorkbench.tsx').then((m) => ({ default: m.ProgressWorkbench })),
);
const StrategiesView = React.lazy(() =>
  import('./components/StrategiesView.tsx').then((m) => ({ default: m.StrategiesView })),
);
const SettingsView = React.lazy(() =>
  import('./components/SettingsView.tsx').then((m) => ({ default: m.SettingsView })),
);
const NotesWorkspace = React.lazy(() =>
  import('./components/NotesWorkspace.tsx').then((m) => ({ default: m.NotesWorkspace })),
);

/** Accessible lightweight placeholder while lazy-loading secondary workspaces. */
function WorkspaceFallback({ label }: { label: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '240px',
        color: 'var(--text-muted)',
        fontSize: '0.9375rem',
      }}
    >
      <span>{label}</span>
    </div>
  );
}
import { useDailyPlan } from './hooks/useDailyPlan.ts';
import { useDesktopAgent } from './hooks/useDesktopAgent.ts';
import { activityLabel } from './desktop-agent-copy.ts';
import type { DesktopAgentStatus } from '../../../packages/contracts/src/desktop-agent.ts';
import { usePreferences } from './hooks/usePreferences.ts';
import { api, type PracticeRecord } from './api.ts';
import { localizeApiError } from './error-i18n.ts';
import {
  WorkspaceContext,
  RetainedView,
  type PracticeOutcome,
  type PracticeRequest,
  type RecordsFilter,
  type RecordsFilterRequest,
  type View,
} from './workspace.tsx';

const libraryViews = ['problems', 'favorites', 'goal-lists'] as const;
const views: View[] = [
  'today',
  'schedule',
  'notes',
  ...libraryViews,
  'catalog-import',
  'records',
  'statistics',
  'progress-import',
  'settings',
];
/** Resolve only known local destinations; Today remains the default homepage. */
function initialView(): View {
  const value = location.hash.slice(1) as View;
  return views.includes(value) ? value : 'today';
}

/** Preserve mounted workspaces for drafts/filters while sharing mutation invalidations and preferences. */
export function App() {
  const [view, setView] = useState<View>(initialView);
  const [visited, setVisited] = useState<Set<View>>(() => new Set([initialView()]));
  const {
    lang,
    theme,
    palette,
    promptSwapFeedback,
    notesFormatOnSave,
    resolvedDark,
    timezone,
    setTimezone,
    errorCause,
    persistPreference,
  } = usePreferences();
  const [revision, setRevision] = useState(0);
  const [favoriteRevision, setFavoriteRevision] = useState(0);
  const refreshFavorites = useCallback(() => setFavoriteRevision(value => value + 1), []);
  const [focusRequest,setFocusRequest]=useState(0);
  const [selectedNoteProblem, setSelectedNoteProblem] = useState<string | null>(null);
  const [recordsFilter, setRecordsFilter] = useState<RecordsFilterRequest | null>(null);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('general');
  const [syncAttention, setSyncAttention] = useState<{ key: string; fork: boolean } | null>(null);
  const [dismissedSync, dismissSync] = useState<string>();
  const viewingSync = view === 'settings' && settingsSection === 'sync';
  useEffect(() => {
    let current = true;
    let checking = false;
    async function checkForUpdates() {
      if (checking || document.visibilityState === 'hidden') return;
      checking = true;
      try {
        const status = await api.checkSyncOnForeground();
        if (!current) return;
        const classification = status?.classification;
        setSyncAttention(status && (classification === 'remote-ahead' || classification === 'fork')
          ? { key: `${classification}:${status.heads.map(head => head.snapshotId).join(',')}`, fork: classification === 'fork' }
          : null);
      } catch { /* Sync status and manual retry are available in Settings. */ }
      finally { checking = false; }
    }
    void checkForUpdates();
    window.addEventListener('focus', checkForUpdates);
    window.addEventListener('online', checkForUpdates);
    document.addEventListener('visibilitychange', checkForUpdates);
    return () => {
      current = false;
      window.removeEventListener('focus', checkForUpdates);
      window.removeEventListener('online', checkForUpdates);
      document.removeEventListener('visibilitychange', checkForUpdates);
    };
  }, []);
  useEffect(() => {
    if (viewingSync && syncAttention) dismissSync(syncAttention.key);
  }, [viewingSync, syncAttention]);
  const [noteNeedsSave, setNoteNeedsSave] = useState(false);
  const [practiceQueue, setPracticeQueue] = useState<PracticeRequest[]>([]);
  const practice = practiceQueue[0];
  const [outcomes, setOutcomes] = useState<PracticeOutcome[]>([]);
  /** Concurrent row saves retain the active draft and present subsequent details in order. */
  const openPractice = useCallback((request: PracticeRequest) => setPracticeQueue(queue => {
    if (request.mode === 'enrich' && queue.some(open => open.mode === 'enrich' && open.record.id === request.record.id)) return queue;
    return [...queue, request];
  }), []);
  const reportPracticeOutcome = useCallback((outcome: PracticeOutcome) => setOutcomes((items) => [...items, outcome]), []);
  const [chatAsk, setChatAsk] = useState<ChatAskRequest | null>(null);
  /** Hand a preset question to the chat. Practice dialogs close first: they are modal and would cover the panel. */
  const askAi = useCallback((ask: ChatAsk) => {
    setPracticeQueue([]);
    setChatAsk((prior) => ({ ...ask, id: (prior?.id ?? 0) + 1 }));
  }, []);
  const plan = useDailyPlan(lang, timezone);
  const [desktopAgentRevision, setDesktopAgentRevision] = useState(0);
  const [dismissedActivity, dismissActivity] = useState('');
  const applyAgentChange = useCallback((status: DesktopAgentStatus) => {
    setRevision(value => value + 1);
    setDesktopAgentRevision(value => value + 1);
    setTimezone(status.timezone);
    void plan.refresh();
  }, [setTimezone, plan.refresh]);
  const desktopAgent = useDesktopAgent(applyAgentChange);
  /** An AI chat change was written by the local service, outside every view's own state. */
  const refreshAfterChatChange = useCallback(() => {
    setRevision(value => value + 1);
    setDesktopAgentRevision(value => value + 1);
    refreshFavorites();
    void plan.refresh();
  }, [refreshFavorites, plan.refresh]);
  const latestActivity = desktopAgent?.activity[0];
  const activityId = latestActivity ? desktopAgent?.instance + ':' + latestActivity.revision : '';
  const current = useRef(view);
  const scrolls = useRef<Partial<Record<View, number>>>({});
  const priorTimezone = useRef<string | null>(null);
  /** Save outgoing scroll before moving; visited child views retain their unsaved input state. */
  const navigate = useCallback((next: View, targetId?: string) => {
    if (targetId !== undefined) {
      setSelectedNoteProblem(targetId);
    }
    if (next === current.current) return;
    setPracticeQueue([]);
    scrolls.current[current.current] = window.scrollY;
    current.current = next;
    setVisited((old) => new Set([...old, next]));
    setView(next);
    location.hash = next;
  }, []);

  const [sidebarExpanded, setSidebarExpanded] = useState<boolean>(() => {
    try {
      return localStorage.getItem('leetcode_tracker_sidebar_expanded') === 'true';
    } catch {
      return false;
    }
  });
  const [sidebarChatSlot, setSidebarChatSlot] = useState<HTMLDivElement | null>(null);

  // Commit layout once; a cancellable translation preserves continuity without animating width.
  const previousSidebar = useRef(sidebarExpanded);
  useLayoutEffect(() => {
    const wasExpanded = previousSidebar.current;
    previousSidebar.current = sidebarExpanded;
    if (wasExpanded === sidebarExpanded || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const content = document.getElementById('main-content');
    const animation = content?.animate?.(
      [{ transform: `translateX(${wasExpanded ? 152 : -152}px)` }, { transform: 'translateX(0)' }],
      { duration: 180, easing: 'cubic-bezier(0.2, 0, 0, 1)' },
    );
    return () => animation?.cancel();
  }, [sidebarExpanded]);

  const toggleSidebar = useCallback(() => {
    setSidebarExpanded((prev) => {
      const next = !prev;
      try {
        localStorage.setItem('leetcode_tracker_sidebar_expanded', String(next));
      } catch {}
      return next;
    });
  }, []);

  const [showShortcutHelp, setShowShortcutHelp] = useState(false);
  const openShortcutHelp = useCallback(() => setShowShortcutHelp(true), []);
  const closeShortcutHelp = useCallback(() => setShowShortcutHelp(false), []);

  const focusSearch = useCallback(() => {
    navigate('problems');
    setTimeout(() => {
      const searchInput = document.getElementById('catalog-search-input') as HTMLInputElement | null;
      searchInput?.focus();
      searchInput?.select();
    }, 50);
  }, [navigate]);

  useKeyboardShortcuts({
    onNavigateToday: () => navigate('today'),
    onNavigateProblems: () => navigate('problems'),
    onNavigateRecords: () => navigate('statistics'),
    onNavigateNotes: () => navigate('notes'),
    onNavigateFavorites: () => navigate('favorites'),
    onOpenManualPractice: () => openPractice({ mode: 'manual' }),
    onFocusSearch: focusSearch,
    onToggleHelp: () => setShowShortcutHelp((open) => !open),
  });
  useEffect(() => {
    const changed = () => navigate(initialView());
    window.addEventListener('hashchange', changed);
    return () => window.removeEventListener('hashchange', changed);
  }, [navigate]);
  useLayoutEffect(() => {
    window.scrollTo({ top: scrolls.current[view] ?? 0, behavior: 'instant' });
  }, [view]);
  useEffect(() => {
    if (priorTimezone.current !== timezone) {
      priorTimezone.current = timezone;
      setRevision((value) => value + 1);
    }
    if (!timezone) return;
    const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
    let date = formatter.format(new Date());
    /** Invalidate date-based projections on local midnight or when returning to a sleeping tab. */
    const refreshDate = () => {
      if (document.hidden) return;
      const next = formatter.format(new Date());
      if (next !== date) { date = next; setRevision((value) => value + 1); }
    };
    const timer = setInterval(refreshDate, 30000);
    document.addEventListener('visibilitychange', refreshDate);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', refreshDate); };
  }, [timezone]);
  /** Invalidate dependent data after durable mutations; the shared controller reconciles completion evidence. */
  const notifyMutation = useCallback(
    (record?: PracticeRecord) => {
      setRevision((n) => n + 1);
      void plan.onPracticeLogged(record);
    },
    [plan.onPracticeLogged],
  );
  /** Statistics drilldowns hand their filter to the Records tab instead of opening a nested drawer. */
  const openRecords = useCallback(
    (filter: RecordsFilter) => {
      setRecordsFilter((prior) => ({ ...filter, id: (prior?.id ?? 0) + 1 }));
      navigate('records');
    },
    [navigate],
  );
  const workspace = useMemo(
    () => ({ revision, favoriteRevision, desktopAgentRevision, timezone, selectedNoteProblem, navigate, openRecords, notifyMutation, openPractice, askAi, reportPracticeOutcome }),
    [revision, favoriteRevision, desktopAgentRevision, timezone, selectedNoteProblem, navigate, openRecords, notifyMutation, openPractice, askAi, reportPracticeOutcome],
  );
  const zh = lang === 'zh';
  const error = errorCause ? localizeApiError(errorCause, lang) : '';
  const progress = ['records', 'statistics', 'progress-import'].includes(view);
  const library = libraryViews.some(id => id === view);
  const primary =
    view === 'schedule' ? 'today' : library || view === 'catalog-import' ? 'problems' : progress ? 'statistics' : view;
  return (
    <WorkspaceContext.Provider value={workspace}>
      <GoalListsScope lang={lang} showSelected={view === 'today'} active={view === 'today' || library}
        onCreated={() => setRevision(value => value + 1)}>
      <div className="app-shell">
        <a
          className="skip-link"
          href="#main-content"
          onClick={(event) => {
            event.preventDefault();
            document.getElementById('main-content')?.focus();
          }}
        >
          {zh ? '跳到主要内容' : 'Skip to main content'}
        </a>
        <aside className={'sidebar ' + (sidebarExpanded ? 'expanded' : 'collapsed')}>
          <div className="sidebar-header">
            <a
              className="app-brand"
              href="#today"
              aria-label="LeetCode Tracker"
              onClick={(e) => {
                e.preventDefault();
                navigate('today');
              }}
            >
              <img className="brand-mark" src={brandIconUrl(palette, resolvedDark)} alt="" width="36" height="36" />
              {sidebarExpanded && (
                <span className="brand-title">
                  LeetCode<span>Tracker</span>
                </span>
              )}
            </a>
            <Tooltip
              text={sidebarExpanded ? (zh ? '折叠侧边栏' : 'Collapse sidebar') : (zh ? '展开侧边栏' : 'Expand sidebar')}
              position={sidebarExpanded ? 'bottom' : 'right'}
            >
              <button
                className="btn-icon sidebar-toggle"
                aria-expanded={sidebarExpanded}
                aria-label={sidebarExpanded ? (zh ? '折叠侧边栏' : 'Collapse sidebar') : (zh ? '展开侧边栏' : 'Expand sidebar')}
                onClick={toggleSidebar}
              >
                {sidebarExpanded ? <PanelLeftClose size={18} /> : <PanelLeftOpen size={18} />}
              </button>
            </Tooltip>
          </div>
          <nav aria-label={zh ? '主导航' : 'Main navigation'}>
            {(
              [
                { id: 'today', icon: CalendarDays, label: zh ? '今日' : 'Today', shortcut: '1' },
                { id: 'problems', icon: BookOpen, label: zh ? '题库' : 'Problems', shortcut: '2' },
                { id: 'statistics', icon: ChartNoAxesCombined, label: zh ? '进展' : 'Progress', shortcut: '3' },
                { id: 'notes', icon: BookMarked, label: zh ? '复盘' : 'Notes', shortcut: '4' },
              ] as const
            ).map((item) => {
              const navBtn = (
                <button
                  key={item.id}
                  className={'nav-item ' + (primary === item.id ? 'active' : '')}
                  aria-label={item.label}
                  aria-current={primary === item.id ? 'page' : undefined}
                  onClick={() => navigate(item.id)}
                >
                  <item.icon size={20} />
                  <span className="nav-label">{item.label}</span>
                </button>
              );
              return !sidebarExpanded ? (
                <Tooltip key={item.id} text={item.label} shortcut={item.shortcut} position="right">
                  {navBtn}
                </Tooltip>
              ) : (
                navBtn
              );
            })}
            <div className="sidebar-chat-slot" ref={setSidebarChatSlot} />
          </nav>
          <div className="sidebar-bottom">
            {!sidebarExpanded ? (
              <Tooltip text={zh ? '设置' : 'Settings'} position="right">
                <button
                  className={'nav-item ' + (view === 'settings' ? 'active' : '')}
                  aria-label={zh ? '设置' : 'Settings'}
                  aria-current={view === 'settings' ? 'page' : undefined}
                  onClick={() => navigate('settings')}
                >
                  <Settings size={20} />
                  <span className="nav-label">{zh ? '设置' : 'Settings'}</span>
                </button>
              </Tooltip>
            ) : (
              <button
                className={'nav-item ' + (view === 'settings' ? 'active' : '')}
                aria-label={zh ? '设置' : 'Settings'}
                aria-current={view === 'settings' ? 'page' : undefined}
                onClick={() => navigate('settings')}
              >
                <Settings size={20} />
                <span className="nav-label">{zh ? '设置' : 'Settings'}</span>
              </button>
            )}
            <div className="sidebar-tools">
              <Tooltip
                text={
                  theme === 'dark' || (theme === 'system' && typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches)
                    ? (zh ? '切换为明亮模式' : 'Switch to light mode')
                    : (zh ? '切换为暗色模式' : 'Switch to dark mode')
                }
                position={sidebarExpanded ? 'top' : 'right'}
              >
                <button
                  className="btn-icon"
                  aria-label={zh ? '切换主题' : 'Switch theme'}
                  onClick={() => {
                    const isDark = theme === 'dark' || (theme === 'system' && typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches);
                    const nextTheme: 'light' | 'dark' = isDark ? 'light' : 'dark';
                    const isCustomDark = palette !== 'default' && palette !== 'catppuccin-latte' && palette !== 'github-light';
                    const isCustomLight = palette === 'catppuccin-latte' || palette === 'github-light';
                    let nextPalette = palette;
                    if (nextTheme === 'light' && isCustomDark) {
                      nextPalette = 'default';
                    } else if (nextTheme === 'dark' && isCustomLight) {
                      nextPalette = 'default';
                    }
                    persistPreference({
                      theme: nextTheme,
                      palette: nextPalette,
                    });
                  }}
                >
                  {theme === 'dark' || (theme === 'system' && typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches) ? (
                    <Moon size={17} />
                  ) : (
                    <Sun size={17} />
                  )}
                </button>
              </Tooltip>
              <Tooltip text={zh ? '快捷键速查 (?)' : 'Keyboard shortcuts (?)'} position={sidebarExpanded ? 'top' : 'right'}>
                <button
                  className="btn-icon"
                  aria-label={zh ? '快捷键速查 (?)' : 'Keyboard shortcuts (?)'}
                  aria-haspopup="dialog"
                  onClick={(event) => {
                    event.currentTarget.focus();
                    openShortcutHelp();
                  }}
                >
                  <Keyboard size={17} />
                </button>
              </Tooltip>
              <Tooltip
                text={zh ? '切换语言为英文' : 'Switch language to Chinese'}
                position={sidebarExpanded ? 'top' : 'right'}
              >
                <button
                  className="btn-icon"
                  aria-label={zh ? '切换语言为英文' : 'Switch language to Chinese'}
                  onClick={() => persistPreference({ language: zh ? 'en' : 'zh' })}
                >
                  <Languages size={17} />
                </button>
              </Tooltip>
            </div>
          </div>
        </aside>
        <main id="main-content" className={view === 'notes' ? 'main-content is-notes-workspace' : 'main-content'} tabIndex={-1}>
          {!viewingSync && syncAttention && syncAttention.key !== dismissedSync && (
            <Feedback tone={syncAttention.fork ? 'warning' : 'info'}>
              {syncAttention.fork
                ? (zh ? '同步发现多个版本，需要你选择。' : 'Device sync found competing versions.')
                : (zh ? '有可接收的同步更新。' : 'A device sync update is available.')}{' '}
              <button className="text-link" onClick={() => {
                setSettingsSection('sync');
                navigate('settings');
              }}>{zh ? '查看同步' : 'Review sync'}</button>
              <button className="text-link" onClick={() => dismissSync(syncAttention.key)}>{zh ? '关闭提示' : 'Dismiss'}</button>
            </Feedback>
          )}
          {isTauri() && (
            <DesktopUpdateNotice
              lang={lang}
              visible={view !== 'settings' || settingsSection !== 'general'}
              onOpen={() => {
                setSettingsSection('general');
                navigate('settings');
              }}
            />
          )}
          {latestActivity && activityId !== dismissedActivity && (
            <Feedback tone="info">
              {activityLabel(latestActivity, lang)}{' '}
              <button className="text-link" onClick={() => dismissActivity(activityId)}>{zh ? '关闭提示' : 'Dismiss'}</button>
            </Feedback>
          )}
          {outcomes.map((outcome, index) => (
            <Feedback key={index} tone={outcome.error ? 'error' : 'success'}>
              {outcome.error
                ? `${zh ? '保存失败，已保留输入：' : 'Save failed. Your draft is retained: '}${localizeApiError(new Error(outcome.error), lang, outcome.error)}`
                : zh ? '练习更改已保存。' : 'Practice changes saved.'}
              {outcome.recovery && <button className="text-link" onClick={() => {
                openPractice(outcome.recovery!);
                setOutcomes((items) => items.filter((_, i) => i !== index));
              }}>{zh ? '恢复草稿' : 'Recover draft'}</button>}
              <button className="text-link" onClick={() => setOutcomes((items) => items.filter((_, i) => i !== index))}>{zh ? '关闭提示' : 'Dismiss'}</button>
            </Feedback>
          ))}
          {error && (
            <Feedback>
              {zh ? '偏好读取或保存失败：' : 'Could not load or save preferences: '}
              {error}
            </Feedback>
          )}
          <PracticeTimerPill lang={lang} />
          {library && (
            <nav className="page-tabs library-nav" aria-label={zh ? '题库视图' : 'Problem library'}>
              {libraryViews.map((id) => (
                <a key={id} href={'#' + id} aria-current={view === id ? 'page' : undefined}>
                  {id === 'problems' ? (zh ? '全部题目' : 'All problems')
                    : id === 'favorites' ? (zh ? '收藏夹' : 'Favorites') : (zh ? '目标题单' : 'Goal lists')}
                </a>
              ))}
            </nav>
          )}
          {(view === 'records' || view === 'statistics') && (
            <>
              <PageHeader
                title={zh ? '进展' : 'Progress'}
                actions={
                  <>
                    <IconButton
                      icon={RefreshCw}
                      label={zh ? '刷新进展数据' : 'Refresh progress data'}
                      onClick={() => setRevision((n) => n + 1)}
                    />
                    <button className="btn btn-secondary" onClick={() => navigate('progress-import')}>
                      <Upload size={16} />
                      {zh ? '导入进度' : 'Import progress'}
                    </button>
                    <button className="btn btn-primary" onClick={() => openPractice({ mode: 'manual' })}>
                      <Plus size={16} />
                      {zh ? '手动记录' : 'Manual record'}
                    </button>
                  </>
                }
              />
              <div className="page-tabs" role="tablist" aria-label={zh ? '进展视图' : 'Progress views'}>
                {(['statistics', 'records'] as const).map((tab) => (
                  <button
                    key={tab}
                    role="tab"
                    aria-selected={view === tab}
                    aria-controls={'view-' + tab}
                    id={'tab-' + tab}
                    onClick={() => navigate(tab)}
                    onKeyDown={(e) => {
                      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
                        e.preventDefault();
                        const next = tab === 'statistics' ? 'records' : 'statistics';
                        navigate(next);
                        setTimeout(() => document.getElementById('tab-' + next)?.focus(), 0);
                      }
                    }}
                    tabIndex={view === tab ? 0 : -1}
                  >
                    {tab === 'statistics' ? (zh ? '统计' : 'Statistics') : zh ? '记录' : 'Records'}
                  </button>
                ))}
              </div>
            </>
          )}
          <React.Suspense fallback={<WorkspaceFallback label={zh ? '加载中…' : 'Loading…'} />}>
            {visited.has('today') && (
              <RetainedView hidden={view !== 'today'} id="view-today">
                <SetupGate
                  lang={lang}
                  theme={theme}
                  palette={palette}
                  onLanguageChange={(language) => persistPreference({ language })}
                  onThemeChange={(theme) => persistPreference({ theme })}
                  onPaletteChange={(palette) => persistPreference({ palette })}
                  onTimezoneSaved={setTimezone}
                  onFinish={() => void plan.refresh()}
                  onOpenAiSettings={() => {
                    setSettingsSection('ai');
                    navigate('settings');
                  }}
                >
                  <TodayPlanView
                    lang={lang}
                    active={view === 'today'}
                    onFavoritesChanged={refreshFavorites}
                    planController={plan}
                    promptSwapFeedback={promptSwapFeedback}
                    onNavigateToSettings={() => {
                      setSettingsSection('general');
                      navigate('settings');
                    }}
                  />
                </SetupGate>
              </RetainedView>
            )}
            {visited.has('schedule') && (
              <RetainedView hidden={view !== 'schedule'} id="view-schedule">
                <PageHeader
                  title={zh ? '学习安排' : 'Study schedule'}
                  description={
                    zh
                      ? '星期安排决定每天的策略。调整今天只影响当前计划。'
                      : 'Your weekly schedule selects each day’s strategy. Adjust today changes only the current plan.'
                  }
                  back={{ label: zh ? '返回今日' : 'Back to Today', run: () => navigate('today') }}
                />
                <StrategiesView lang={lang} focusRequest={focusRequest} />
              </RetainedView>
            )}
            {visited.has('notes') && (
              <RetainedView hidden={view !== 'notes'} id="view-notes">
                <NotesWorkspace
                  lang={lang}
                  notesFormatOnSave={notesFormatOnSave ?? undefined}
                  initialFrontendId={selectedNoteProblem}
                  onClearInitialFrontendId={() => setSelectedNoteProblem(null)}
                  onNeedsSaveChange={setNoteNeedsSave}
                  onOpenShortcutHelp={openShortcutHelp}
                />
              </RetainedView>
            )}
            {visited.has('problems') && (
              <RetainedView hidden={view !== 'problems'} id="view-problems">
                <CatalogView lang={lang} onNavigateSettings={() => navigate('catalog-import')}
                  onGoalListCreated={() => setRevision(value => value + 1)}
                  onFavoritesChanged={refreshFavorites} />
              </RetainedView>
            )}
            {visited.has('favorites') && (
              <RetainedView hidden={view !== 'favorites'} id="view-favorites">
                <CatalogView lang={lang} onNavigateSettings={() => navigate('catalog-import')} favoritesOnly
                  onGoalListCreated={() => setRevision(value => value + 1)}
                  onFavoritesChanged={refreshFavorites} />
              </RetainedView>
            )}
            {visited.has('goal-lists') && (
              <RetainedView hidden={view !== 'goal-lists'} id="view-goal-lists">
                <GoalListLibrary lang={lang} active={view === 'goal-lists'} />
              </RetainedView>
            )}
            {visited.has('catalog-import') && (
              <RetainedView hidden={view !== 'catalog-import'} id="view-catalog-import">
                <CatalogImportWorkspace lang={lang} />
              </RetainedView>
            )}
            {visited.has('records') && (
              <RetainedView hidden={view !== 'records'} role="tabpanel" aria-labelledby="tab-records" id="view-records">
                <ActivityRecords lang={lang} filterRequest={recordsFilter} />
              </RetainedView>
            )}
            {visited.has('statistics') && (
              <RetainedView
                hidden={view !== 'statistics'}
                role="tabpanel"
                aria-labelledby="tab-statistics"
                id="view-statistics"
              >
                <DashboardView
                  lang={lang}
                  active={view === 'statistics'}
                  onNavigateToStrategies={() => {setFocusRequest(v=>v+1);navigate('schedule');}}
                />
              </RetainedView>
            )}
            {visited.has('progress-import') && (
              <RetainedView hidden={view !== 'progress-import'} id="view-progress-import">
                <ProgressWorkbench lang={lang} />
              </RetainedView>
            )}
            {visited.has('settings') && (
              <RetainedView hidden={view !== 'settings'} id="view-settings">
                <SettingsView
                  lang={lang}
                  desktopAgent={desktopAgent}
                  noteNeedsSave={noteNeedsSave}
                  onLanguageChange={(language) => persistPreference({ language })}
                  onThemeChange={(theme) => persistPreference({ theme })}
                  currentTheme={theme}
                  resolvedDark={resolvedDark}
                  onPaletteChange={(palette) => persistPreference({ palette })}
                  currentPalette={palette}
                  promptSwapFeedback={promptSwapFeedback}
                  onPromptSwapFeedbackChange={(enabled) => persistPreference({ promptSwapFeedback: enabled })}
                  notesFormatOnSave={notesFormatOnSave ?? undefined}
                  onNotesFormatOnSaveChange={(enabled) => persistPreference({ notesFormatOnSave: enabled })}
                  onTimezoneSaved={setTimezone}
                  section={settingsSection}
                  onSectionChange={setSettingsSection}
                />
              </RetainedView>
            )}
          </React.Suspense>
        </main>
        {practice && (
          <PracticeWorkspace
            key={
              'record' in practice
                ? practice.mode + practice.record.id
                : practice.mode === 'evidence'
                  ? practice.item.id
                  : 'manual'
            }
            request={practice}
            lang={lang}
            onClose={() => setPracticeQueue((queue) => queue.slice(1))}
          />
        )}
        {showShortcutHelp && (
          <ShortcutHelpModal lang={lang} onClose={closeShortcutHelp} />
        )}
        <ChatLauncher
          lang={lang}
          ask={chatAsk}
          sidebar={sidebarChatSlot ? { container: sidebarChatSlot, expanded: sidebarExpanded } : undefined}
          onDataChanged={refreshAfterChatChange}
          onOpenAiSettings={() => {
            setSettingsSection('ai');
            navigate('settings');
          }}
        />
      </div>
      </GoalListsScope>
    </WorkspaceContext.Provider>
  );
}
