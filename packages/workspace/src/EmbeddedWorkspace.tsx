/**
 * Chat-host shell (ChatGPT, DSH). It mirrors the desktop app shell (collapsible sidebar,
 * page headers, shared Today/Notes/practice components) and adds conversation entry points
 * when the host exposes a conversation bridge. Editors stay mounted across navigation, and
 * conversation-driven navigation is guarded while a note has unsaved edits.
 */
import React, { useEffect, useRef, useState } from 'react';
import { TodayWorkspace } from './components/TodayWorkspace.tsx';
import { NotesWorkspace } from './components/NotesWorkspace.tsx';
import { useWorkspaceEnvironment } from './context.tsx';
import type { Language } from './i18n.ts';
import { useWorkspace } from './workspace.tsx';
import { Dialog, Feedback, PageHeader, Pagination, Tooltip } from './components/ui.tsx';
import { practiceTime } from './components/PracticeRecordCard.tsx';
import { useBusinessRefresh } from './hooks/useBusinessRefresh.ts';
import type { PracticeRecord } from './api.ts';
import { OperationStateError, operationMessage, type WorkspaceOperationState } from './client.ts';
import type { WorkspaceSafeArea } from './host.ts';
import { AssistantAskButton, AssistantDock, AssistantProvider, useAssistant } from './assistant.tsx';
import {
  BookMarked,
  BookOpen,
  CalendarDays,
  ChartNoAxesCombined,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Sparkles,
} from 'lucide-react';

type EmbeddedView = 'today' | 'practice' | 'notes';
const SIDEBAR_KEY = 'tracker_embedded_sidebar_expanded';

/** `home` remains a protocol alias (tool results, deep links); the desktop homepage is Today. */
function normalizeView(value: unknown): EmbeddedView | null {
  if (value === 'home' || value === 'today') return 'today';
  if (value === 'practice' || value === 'notes') return value;
  return null;
}

function resultLabel(record: PracticeRecord, zh: boolean): string {
  if (record.status === 'revoked') return zh ? '已撤销' : 'Revoked';
  return record.completed ? (zh ? '完成' : 'Completed') : zh ? '未完成' : 'Not completed';
}

/** Practice records rendered with the desktop Progress → Records table. */
function PracticeList({
  lang,
  target,
  targetKind,
}: {
  lang: Language;
  target: string | null;
  targetKind?: 'problem' | 'practice';
}) {
  const zh = lang === 'zh';
  const { client, revision } = useWorkspaceEnvironment(),
    workspace = useWorkspace();
  const root = useRef<HTMLElement>(null),
    external = useBusinessRefresh(['practice', 'libraryGeneration'], root);
  const [items, setItems] = useState<PracticeRecord[]>([]),
    [page, setPage] = useState(1),
    [total, setTotal] = useState(0),
    [loading, setLoading] = useState(true),
    [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    setLoading(true);
    client
      .getPracticeRecords({ page, limit: 20, status: 'all' })
      .then((data) => {
        if (active) {
          setItems(data.items);
          setTotal(data.total);
          setError('');
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [client, page, revision, external]);
  useEffect(() => {
    if (!target) return;
    let active = true;
    const open = async () => {
      if (targetKind !== 'practice') {
        const problem = await client.getWorkspaceProblem?.(target);
        if (!problem) throw new Error('Problem lookup is unavailable');
        if (active) workspace.openPractice({ mode: 'manual', problem });
      } else {
        const record = await client.getPracticeRecord(target);
        if (active) workspace.openPractice({ mode: 'detail', record });
      }
    };
    void open().catch((e) => {
      if (active) setError(e.message);
    });
    return () => {
      active = false;
    };
  }, [target, targetKind, client]);
  return (
    <section ref={root}>
      <PageHeader
        title={zh ? '进展' : 'Progress'}
        description={zh ? '在对话中记录的练习也会出现在这里。' : 'Practices recorded from the conversation appear here too.'}
        actions={
          <button className="btn btn-primary" onClick={() => workspace.openPractice({ mode: 'manual' })}>
            <Plus size={16} />
            {zh ? '记录练习' : 'Record practice'}
          </button>
        }
      />
      {error && <Feedback>{error}</Feedback>}
      {items.length > 0 && (
        <div className="table-container" aria-busy={loading}>
          <table className="data-table activity-table">
            <thead>
              <tr>
                <th>{zh ? '日期' : 'Date'}</th>
                <th>{zh ? '题目' : 'Problem'}</th>
                <th>{zh ? '结果' : 'Result'}</th>
                <th>{zh ? '详情' : 'Details'}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((record) => (
                <tr key={record.id} className={record.status === 'revoked' ? 'revoked' : undefined}>
                  <td>{practiceTime(record, lang, workspace.timezone)}</td>
                  <td>
                    <strong>
                      #{record.questionFrontendId} {record.problemTitle}
                    </strong>
                  </td>
                  <td>{resultLabel(record, zh)}</td>
                  <td>
                    <span className="embedded-row-actions">
                      <button
                        className="text-link"
                        aria-label={`${zh ? '查看' : 'View'} #${record.questionFrontendId} ${record.problemTitle}`}
                        onClick={() => workspace.openPractice({ mode: 'detail', record })}
                      >
                        {zh ? '查看' : 'View'}
                      </button>
                      <AssistantAskButton
                        lang={lang}
                        subject={{ kind: 'practice', questionFrontendId: record.questionFrontendId, title: record.problemTitle }}
                      />
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {loading && !items.length && (
        <p role="status" className="muted">
          {zh ? '读取记录…' : 'Loading records…'}
        </p>
      )}
      {!loading && !error && !items.length && (
        <div className="empty-state">
          <h3>{zh ? '暂无练习记录' : 'No practice records yet'}</h3>
          <p>
            {zh
              ? '从今日计划开始，或直接在对话中告诉助手你完成了哪道题。'
              : 'Start from Today, or tell the assistant which problem you just finished.'}
          </p>
        </div>
      )}
      <Pagination page={page} total={total} limit={20} onPage={setPage} lang={lang} />
    </section>
  );
}

/** Sidebar footer: host conversation presence plus the Tracker connection state. */
function HostPresence({ expanded, connected, zh }: { expanded: boolean; connected: boolean; zh: boolean }) {
  const assistant = useAssistant();
  const state = connected ? (zh ? '已连接' : 'Connected') : zh ? '已断开' : 'Disconnected';
  const name = assistant?.label ?? 'Tracker';
  const text = `${name} · ${state}`;
  const badge = (
    <span className={`host-presence${connected ? ' online' : ''}`} role="status" aria-label={text}>
      <span className="host-presence-mark" aria-hidden="true">
        {assistant ? <Sparkles size={16} /> : <BookOpen size={16} />}
      </span>
      {expanded && (
        <span className="host-presence-text">
          <strong>{name}</strong>
          <span>{state}</span>
        </span>
      )}
    </span>
  );
  return expanded ? badge : <Tooltip text={text} position="right">{badge}</Tooltip>;
}

export function EmbeddedWorkspace({ lang = 'en' }: { lang?: Language }) {
  return (
    <AssistantProvider>
      <EmbeddedShell lang={lang} />
    </AssistantProvider>
  );
}

function EmbeddedShell({ lang }: { lang: Language }) {
  const { host, connected } = useWorkspaceEnvironment();
  const initial = host.recoveryState(),
    zh = lang === 'zh';
  const [view, setView] = useState<EmbeddedView>(() => normalizeView(initial.view) ?? 'today'),
    [target, setTarget] = useState<string | null>(
      typeof initial.targetId === 'string' ? initial.targetId : null,
    );
  const [visited, setVisited] = useState(() => new Set<EmbeddedView>([view]));
  const [targetKind, setTargetKind] = useState<'problem' | 'practice' | undefined>(
    initial.targetKind === 'practice' ? 'practice' : 'problem',
  );
  const [pending, setPending] = useState<{
      view: string;
      target?: string;
      targetKind?: 'problem' | 'practice';
    } | null>(null),
    [dirty, setDirty] = useState(false);
  const [opState, setOpState] = useState<WorkspaceOperationState | null>(null);
  const [error, setError] = useState('');
  const [safeArea, setSafeArea] = useState<WorkspaceSafeArea | undefined>(() => host.displayState().safeArea);
  const [expanded, setExpanded] = useState(() => {
    try {
      return host.storage('persistent').getItem(SIDEBAR_KEY) === 'true';
    } catch {
      return false;
    }
  });
  const active = useRef({ view, dirty });
  active.current = { view, dirty };
  const accept = (requested: string, id?: string, kind?: 'problem' | 'practice') => {
    const next = normalizeView(requested);
    if (!next) {
      setError(zh ? '请在 Tracker 桌面端打开该视图。' : 'Open this view in Tracker desktop.');
      return;
    }
    const target =
      id ??
      (next === 'notes' ? (host.recoveryState().noteFrontendId as string | undefined) : undefined);
    setView(next);
    setTarget(target ?? null);
    setTargetKind(kind);
    setVisited((old) => new Set([...old, next]));
    host.saveRecoveryState({
      ...host.recoveryState(),
      view: next,
      // Notes owns its dirty-target guard; persist the selected note only after that guard accepts.
      targetId: next === 'notes' ? host.recoveryState().noteFrontendId ?? target ?? null : target ?? null,
      targetKind: kind ?? 'problem',
    });
    host.emit({ type: 'selection', view: next, targetId: next === 'notes' ? host.recoveryState().noteFrontendId as string | undefined : target });
  };
  useEffect(
    () =>
      host.subscribe((event) => {
        if (event.type === 'operation') {
          setOpState(event.operation);
          return;
        }
        if (event.type === 'display') {
          setSafeArea(event.state.safeArea);
          return;
        }
        if (event.type !== 'navigate') return;
        if (active.current.view === 'notes' && active.current.dirty && normalizeView(event.view) !== 'notes') {
          setPending({ view: event.view, target: event.targetId, targetKind: event.targetKind });
          return;
        }
        accept(event.view, event.targetId, event.targetKind);
      }),
    [host],
  );
  const toggleSidebar = () =>
    setExpanded((value) => {
      try {
        host.storage('persistent').setItem(SIDEBAR_KEY, String(!value));
      } catch {}
      return !value;
    });
  const links = [
    { id: 'today', label: zh ? '今日' : 'Today', Icon: CalendarDays },
    { id: 'practice', label: zh ? '进展' : 'Progress', Icon: ChartNoAxesCombined },
    { id: 'notes', label: zh ? '复盘' : 'Notes', Icon: BookMarked },
  ] as const;
  const toggleLabel = expanded ? (zh ? '折叠侧边栏' : 'Collapse sidebar') : zh ? '展开侧边栏' : 'Expand sidebar';
  const insets = {
    '--host-safe-top': `${safeArea?.top ?? 0}px`,
    '--host-safe-bottom': `${safeArea?.bottom ?? 0}px`,
  } as React.CSSProperties;
  return (
    <div className="app-shell embedded-shell" style={insets}>
      <aside className={'sidebar ' + (expanded ? 'expanded' : 'collapsed')}>
        <div className="sidebar-header">
          <a
            className="app-brand"
            href="#today"
            aria-label="LeetCode Tracker"
            onClick={(event) => {
              event.preventDefault();
              host.navigate('today');
            }}
          >
            <span className="brand-mark">
              <BookOpen size={21} />
            </span>
            {expanded && (
              <span className="brand-title">
                LeetCode<span>Tracker</span>
              </span>
            )}
          </a>
          <Tooltip text={toggleLabel} position={expanded ? 'bottom' : 'right'}>
            <button className="btn-icon sidebar-toggle" aria-expanded={expanded} aria-label={toggleLabel} onClick={toggleSidebar}>
              {expanded ? <PanelLeftClose size={18} /> : <PanelLeftOpen size={18} />}
            </button>
          </Tooltip>
        </div>
        <nav aria-label={zh ? '主导航' : 'Main navigation'}>
          {links
            .filter((link) => link.id !== 'practice' || host.capabilities.practice)
            .map(({ id, label, Icon }) => {
              const button = (
                <button
                  key={id}
                  className={'nav-item ' + (view === id ? 'active' : '')}
                  aria-label={label}
                  aria-current={view === id ? 'page' : undefined}
                  onClick={() => host.navigate(id)}
                >
                  <Icon size={20} />
                  <span className="nav-label">{label}</span>
                </button>
              );
              return expanded ? button : <Tooltip key={id} text={label} position="right">{button}</Tooltip>;
            })}
        </nav>
        <div className="sidebar-bottom">
          <HostPresence expanded={expanded} connected={connected} zh={zh} />
        </div>
      </aside>
      <main className="main-content">
        {error && <Feedback>{error}</Feedback>}
        {opState && opState.status !== 'applied' && (
          <Feedback>
            {operationMessage(new OperationStateError(opState), zh ? 'zh' : 'en')}
          </Feedback>
        )}
        {visited.has('today') && (
          <div hidden={view !== 'today'}>
            <TodayWorkspace
              lang={lang}
              onNavigateToSettings={() =>
                setError(
                  zh
                    ? '请在 Tracker 桌面设置中配置时区和策略。'
                    : 'Configure timezone and strategies in Tracker desktop Settings.',
                )
              }
            />
          </div>
        )}
        {visited.has('practice') && (
          <div hidden={view !== 'practice'}>
            <PracticeList
              lang={lang}
              targetKind={targetKind}
              target={view === 'practice' ? target : null}
            />
          </div>
        )}
        {visited.has('notes') && (
          <div hidden={view !== 'notes'}>
            <NotesWorkspace
              lang={lang}
              initialFrontendId={view === 'notes' ? target : null}
              onClearInitialFrontendId={() => setTarget(null)}
              onDirtyChange={setDirty}
            />
          </div>
        )}
        <SubjectSync view={view} />
        <AssistantDock view={view} lang={lang} />
      </main>
      {pending && (
        <Dialog
          title={zh ? '保留未保存修改' : 'Keep unsaved changes'}
          lang={lang}
          onClose={() => setPending(null)}
        >
          <p>
            {zh
              ? '当前笔记有未保存修改。切换视图会保留编辑器与草稿。'
              : 'Your note has unsaved changes. Switching views keeps the editor and draft.'}
          </p>
          <button className="btn btn-secondary" onClick={() => setPending(null)}>
            {zh ? '继续编辑' : 'Keep editing'}
          </button>
          <button
            className="btn btn-primary"
            onClick={() => {
              accept(pending.view, pending.target, pending.targetKind);
              setPending(null);
            }}
          >
            {zh ? '保留并切换' : 'Keep draft and switch'}
          </button>
        </Dialog>
      )}
    </div>
  );
}

/**
 * Keeps the composer subject tied to the visible view: Notes follows the selected note so
 * suggestions such as "Review my note" refer to it, and switching views drops a subject
 * attached elsewhere (for example a Today problem).
 */
function SubjectSync({ view }: { view: EmbeddedView }) {
  const { host } = useWorkspaceEnvironment();
  const assistant = useAssistant();
  const stored = () => {
    const value = host.recoveryState().noteFrontendId;
    return typeof value === 'string' ? value : null;
  };
  const [noteId, setNoteId] = useState<string | null>(stored);
  useEffect(
    () =>
      host.subscribe((event) => {
        if (event.type === 'selection' && event.view === 'notes') setNoteId(event.targetId ?? null);
      }),
    [host],
  );
  // Notes records its selection even while hidden; re-read it whenever Notes becomes active.
  useEffect(() => {
    if (view === 'notes') setNoteId(stored());
  }, [view]);
  const attached = assistant?.subject;
  const shownView = useRef(view);
  useEffect(() => {
    if (shownView.current === view) return;
    shownView.current = view;
    if (assistant?.subject && assistant.subject.kind !== 'note') assistant.detach();
  }, [view]);
  useEffect(() => {
    if (!assistant) return;
    if (view === 'notes' && noteId) {
      if (attached?.kind !== 'note' || attached.questionFrontendId !== noteId)
        assistant.setContextSubject({ kind: 'note', questionFrontendId: noteId });
    } else if (attached?.kind === 'note') assistant.detach();
  }, [view, noteId, attached?.kind, attached?.questionFrontendId, Boolean(assistant)]);
  return null;
}
