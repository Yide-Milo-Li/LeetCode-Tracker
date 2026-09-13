/** Desktop application shell: three destinations, retained workspaces and one daily-plan controller. */
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
} from 'lucide-react';
import { CatalogView } from './components/CatalogView.tsx';
import { ActivityRecords } from './components/ActivityRecords.tsx';
import { TodayPlanView } from './components/TodayPlanView.tsx';
import { PracticeWorkspace } from './components/PracticeWorkspace.tsx';
import { ShortcutHelpModal } from './components/ShortcutHelpModal.tsx';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts.ts';
import { Feedback, PageHeader, Tooltip } from './components/ui.tsx';

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
import { api, type PracticeRecord } from './api.ts';
import type { Language } from './i18n.ts';
import { WorkspaceContext, type PracticeOutcome, type PracticeRequest, type View } from './workspace.tsx';

const views: View[] = [
  'today',
  'schedule',
  'notes',
  'problems',
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
  const [lang, setLang] = useState<Language>('en');
  const [theme, setTheme] = useState<'light' | 'dark' | 'system'>('system');
  const [timezone, setTimezone] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [focusRequest,setFocusRequest]=useState(0);
  const [selectedNoteProblem, setSelectedNoteProblem] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [practiceQueue, setPracticeQueue] = useState<PracticeRequest[]>([]);
  const practice = practiceQueue[0];
  const [outcomes, setOutcomes] = useState<PracticeOutcome[]>([]);
  /** Concurrent row saves retain the active draft and present subsequent details in order. */
  const openPractice = useCallback((request: PracticeRequest) => setPracticeQueue((queue) => [...queue, request]), []);
  const reportPracticeOutcome = useCallback((outcome: PracticeOutcome) => setOutcomes((items) => [...items, outcome]), []);
  const plan = useDailyPlan();
  const current = useRef(view);
  const scrolls = useRef<Partial<Record<View, number>>>({});
  const preferenceRevision = useRef(0);
  const preferenceQueue = useRef(Promise.resolve());
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
    onNavigateRecords: () => navigate('records'),
    onNavigateNotes: () => navigate('notes'),
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
    const version = preferenceRevision.current;
    let active = true;
    api
      .getSettings()
      .then((settings) => {
        if (active && version === preferenceRevision.current) {
          setLang(settings.language);
          setTheme(settings.theme);
          setTimezone(settings.timezone);
        }
      })
      .catch((err) => {
        if (active) setError(String(err.message));
      });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const dark = theme === 'dark' || (theme === 'system' && media.matches);
      document.documentElement.classList.toggle('dark', dark);
      document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
    };
    apply();
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [theme]);
  useEffect(() => {
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
  }, [lang]);
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
  /** Queue preference writes so a slow previous response cannot persist an older selection last. */
  function persistPreference(value: { language?: Language; theme?: 'light' | 'dark' | 'system' }) {
    preferenceRevision.current++;
    setError('');
    if (value.language) setLang(value.language);
    if (value.theme) setTheme(value.theme);
    preferenceQueue.current = preferenceQueue.current.then(async () => {
      try {
        await api.updateSettings(value);
      } catch (err) {
        setError(String((err as Error).message));
      }
    });
  }
  /** Invalidate dependent data after durable mutations; the shared controller reconciles completion evidence. */
  const notifyMutation = useCallback(
    (record?: PracticeRecord) => {
      setRevision((n) => n + 1);
      void plan.onPracticeLogged(record);
    },
    [plan.onPracticeLogged],
  );
  const workspace = useMemo(
    () => ({ revision, timezone, selectedNoteProblem, navigate, notifyMutation, openPractice, reportPracticeOutcome }),
    [revision, timezone, selectedNoteProblem, navigate, notifyMutation, openPractice, reportPracticeOutcome],
  );
  const zh = lang === 'zh';
  const progress = ['records', 'statistics', 'progress-import'].includes(view);
  const primary =
    view === 'schedule' ? 'today' : view === 'catalog-import' ? 'problems' : progress ? 'records' : view;
  return (
    <WorkspaceContext.Provider value={workspace}>
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
              <span className="brand-mark">
                <BookOpen size={21} />
              </span>
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
                { id: 'records', icon: ChartNoAxesCombined, label: zh ? '进展' : 'Progress', shortcut: '3' },
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
                  theme === 'light'
                    ? (zh ? '切换主题 (当前: 明亮)' : 'Switch theme (current: Light)')
                    : theme === 'dark'
                      ? (zh ? '切换主题 (当前: 暗色)' : 'Switch theme (current: Dark)')
                      : (zh ? '切换主题 (当前: 跟随系统)' : 'Switch theme (current: System)')
                }
                position={sidebarExpanded ? 'top' : 'right'}
              >
                <button
                  className="btn-icon"
                  aria-label={zh ? '切换主题' : 'Switch theme'}
                  onClick={() =>
                    persistPreference({
                      theme: theme === 'light' ? 'dark' : theme === 'dark' ? 'system' : 'light',
                    })
                  }
                >
                  {theme === 'light' ? (
                    <Sun size={17} />
                  ) : theme === 'dark' ? (
                    <Moon size={17} />
                  ) : (
                    <Laptop size={17} />
                  )}
                </button>
              </Tooltip>
              <Tooltip text={zh ? '快捷键速查 (?)' : 'Keyboard shortcuts (?)'} position={sidebarExpanded ? 'top' : 'right'}>
                <button
                  className="btn-icon"
                  aria-label={zh ? '快捷键速查 (?)' : 'Keyboard shortcuts (?)'}
                  onClick={() => setShowShortcutHelp(true)}
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
        <main id="main-content" className="main-content" tabIndex={-1}>
          {outcomes.map((outcome, index) => (
            <Feedback key={index} tone={outcome.error ? 'error' : 'success'}>
              {outcome.error
                ? `${zh ? '保存失败，已保留输入：' : 'Save failed. Your draft is retained: '}${outcome.error}`
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
          {(view === 'records' || view === 'statistics') && (
            <>
              <PageHeader
                title={zh ? '进展' : 'Progress'}
                actions={
                  <>
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
                {(['records', 'statistics'] as const).map((tab) => (
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
                        const next = tab === 'records' ? 'statistics' : 'records';
                        navigate(next);
                        setTimeout(() => document.getElementById('tab-' + next)?.focus(), 0);
                      }
                    }}
                    tabIndex={view === tab ? 0 : -1}
                  >
                    {tab === 'records' ? (zh ? '记录' : 'Records') : zh ? '统计' : 'Statistics'}
                  </button>
                ))}
              </div>
            </>
          )}
          <React.Suspense fallback={<WorkspaceFallback label={zh ? '加载中…' : 'Loading…'} />}>
            {visited.has('today') && (
              <div hidden={view !== 'today'} id="view-today">
                <TodayPlanView
                  lang={lang}
                  planController={plan}
                  onNavigateToSettings={() => navigate('settings')}
                />
              </div>
            )}
            {visited.has('schedule') && (
              <div hidden={view !== 'schedule'} id="view-schedule">
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
              </div>
            )}
            {visited.has('notes') && (
              <div hidden={view !== 'notes'} id="view-notes">
                <NotesWorkspace lang={lang} initialFrontendId={selectedNoteProblem} />
              </div>
            )}
            {visited.has('problems') && (
              <div hidden={view !== 'problems'} id="view-problems">
                <CatalogView lang={lang} onNavigateSettings={() => navigate('catalog-import')} />
              </div>
            )}
            {visited.has('catalog-import') && (
              <div hidden={view !== 'catalog-import'} id="view-catalog-import">
                <CatalogImportWorkspace lang={lang} />
              </div>
            )}
            {visited.has('records') && (
              <div hidden={view !== 'records'} role="tabpanel" aria-labelledby="tab-records" id="view-records">
                <ActivityRecords lang={lang} />
              </div>
            )}
            {visited.has('statistics') && (
              <div
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
              </div>
            )}
            {visited.has('progress-import') && (
              <div hidden={view !== 'progress-import'} id="view-progress-import">
                <ProgressWorkbench lang={lang} />
              </div>
            )}
            {visited.has('settings') && (
              <div hidden={view !== 'settings'} id="view-settings">
                <SettingsView
                  lang={lang}
                  onLanguageChange={(language) => persistPreference({ language })}
                  onThemeChange={(theme) => persistPreference({ theme })}
                  currentTheme={theme}
                  onTimezoneSaved={setTimezone}
                />
              </div>
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
          <ShortcutHelpModal lang={lang} onClose={() => setShowShortcutHelp(false)} />
        )}
      </div>
    </WorkspaceContext.Provider>
  );
}
