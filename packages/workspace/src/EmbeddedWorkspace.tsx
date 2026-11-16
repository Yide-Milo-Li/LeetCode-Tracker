/** Branded desktop shell retains editors and guards conversation-driven navigation. */
import React, { useEffect, useRef, useState } from 'react';
import { TodayWorkspace } from './components/TodayWorkspace.tsx';
import { NotesWorkspace } from './components/NotesWorkspace.tsx';
import { useWorkspaceEnvironment } from './context.tsx';
import type { Language } from './i18n.ts';
import { useWorkspace } from './workspace.tsx';
import { Dialog, Feedback, Pagination } from './components/ui.tsx';
import { practiceTime } from './components/PracticeRecordCard.tsx';
import { useBusinessRefresh } from './hooks/useBusinessRefresh.ts';
import type { DailyPlan, PracticeRecord } from './api.ts';
import { OperationStateError, operationMessage, type WorkspaceOperationState } from './client.ts';
import { BookOpen, CalendarCheck, House, PenLine, ArrowUpRight } from 'lucide-react';

function PracticeList({
  lang,
  target,
  targetKind,
}: {
  lang: Language;
  target: string | null;
  targetKind?: 'problem' | 'practice';
}) {
  const { client, revision } = useWorkspaceEnvironment(),
    workspace = useWorkspace();
  const root = useRef<HTMLElement>(null),
    external = useBusinessRefresh(['practice', 'libraryGeneration'], root);
  const [items, setItems] = useState<PracticeRecord[]>([]),
    [page, setPage] = useState(1),
    [total, setTotal] = useState(0),
    [error, setError] = useState('');
  useEffect(() => {
    let active = true;
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
    <section ref={root} className="embedded-page">
      <div className="embedded-page-heading">
        <h1>{lang === 'zh' ? '练习记录' : 'Practice records'}</h1>
        <button
          className="btn btn-primary"
          onClick={() => workspace.openPractice({ mode: 'manual' })}
        >
          {lang === 'zh' ? '记录练习' : 'Record practice'}
        </button>
      </div>
      {error && <Feedback>{error}</Feedback>}
      {!items.length && (
        <p className="muted">
          {lang === 'zh'
            ? '暂无练习记录。从今日计划或本地题库开始。'
            : 'No practice records yet. Start from Today or your local catalog.'}
        </p>
      )}
      {items.map((record) => (
        <button
          className="history-row"
          key={record.id}
          onClick={() => workspace.openPractice({ mode: 'detail', record })}
        >
          <strong>
            #{record.questionFrontendId} {record.problemTitle}
          </strong>
          <span>{practiceTime(record, lang, workspace.timezone)}</span>
          <span>
            {record.status === 'revoked'
              ? lang === 'zh'
                ? '已撤销'
                : 'Revoked'
              : record.completed
                ? lang === 'zh'
                  ? '已完成'
                  : 'Completed'
                : lang === 'zh'
                  ? '未完成'
                  : 'Attempted'}
          </span>
        </button>
      ))}
      <Pagination page={page} total={total} limit={20} onPage={setPage} lang={lang} />
    </section>
  );
}

export function EmbeddedWorkspace({ lang = 'en' }: { lang?: Language }) {
  const { host, client, connected, revision } = useWorkspaceEnvironment();
  const initial = host.recoveryState(),
    zh = lang === 'zh';
  const [view, setView] = useState(String(initial.view ?? 'home')),
    [target, setTarget] = useState<string | null>(
      typeof initial.targetId === 'string' ? initial.targetId : null,
    );
  const [visited, setVisited] = useState(new Set([view]));
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
  const [plan, setPlan] = useState<DailyPlan | null>(null),
    [error, setError] = useState('');
  const active = useRef({ view, dirty });
  active.current = { view, dirty };
  const accept = (next: string, id?: string, kind?: 'problem' | 'practice') => {
    if (!['home', 'today', 'practice', 'notes'].includes(next)) {
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
        if (event.type !== 'navigate') return;
        if (active.current.view === 'notes' && active.current.dirty && event.view !== 'notes') {
          setPending({ view: event.view, target: event.targetId, targetKind: event.targetKind });
          return;
        }
        accept(event.view, event.targetId, event.targetKind);
      }),
    [host],
  );
  useEffect(() => {
    let active = true;
    client
      .getBusinessVersions()
      .then((v) => client.getPlans(v.today))
      .then((plans) => {
        if (active) {
          setPlan(plans[0] ?? null);
          setError('');
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [client, revision]);
  const links = [
    { id: 'home', label: zh ? '首页' : 'Home', Icon: House },
    { id: 'today', label: zh ? '今日计划' : 'Today', Icon: CalendarCheck },
    { id: 'practice', label: zh ? '练习' : 'Practice', Icon: PenLine },
    { id: 'notes', label: zh ? '笔记' : 'Notes', Icon: BookOpen },
  ];
  return (
    <div className="embedded-shell">
      <nav className="embedded-nav" aria-label="Tracker">
        <strong className="embedded-brand">LeetCode Tracker</strong>
        <div>
          {links
            .filter((link) => link.id !== 'practice' || host.capabilities.practice)
            .map(({ id, label, Icon }) => (
              <button
                key={id}
                className="btn btn-ghost"
                aria-current={view === id ? 'page' : undefined}
                onClick={() => host.navigate(id)}
              >
                <Icon size={17} />
                {label}
              </button>
            ))}
        </div>
        <span className="embedded-connection">
          {connected ? (zh ? '已连接' : 'Connected') : zh ? '已断开' : 'Disconnected'}
        </span>
      </nav>
      {error && <Feedback>{error}</Feedback>}
      {opState && opState.status !== 'applied' && (
        <Feedback>
          {operationMessage(new OperationStateError(opState), zh ? 'zh' : 'en')}
        </Feedback>
      )}
      <div hidden={view !== 'home'} className="embedded-home">
        <h1>{zh ? '让每次练习都有积累。' : 'Make each practice count.'}</h1>
        <p className="muted">
          {zh
            ? '你的今日计划、练习记录与题目笔记。'
            : 'Your daily plan, practice history, and problem notes.'}
        </p>
        <section className="embedded-summary">
          <h2>{zh ? '今天' : 'Today'}</h2>
          <strong>
            {plan
              ? `${plan.items.filter((i) => i.completed).length} / ${plan.items.length}`
              : zh
                ? '尚未创建计划'
                : 'No plan yet'}
          </strong>
          <p className="muted">
            {plan
              ? zh
                ? '已完成 / 计划题目'
                : 'Completed / planned problems'
              : zh
                ? '打开今日计划，按当前策略明确创建。'
                : 'Open Today to create a plan from your current strategy.'}
          </p>
          <button className="btn btn-primary" onClick={() => host.navigate('today')}>
            {zh ? '打开今日计划' : 'Open Today'}
            <ArrowUpRight size={16} />
          </button>
        </section>
        <div className="embedded-shortcuts">
          {links
            .filter(
              (link) =>
                link.id === 'notes' || (link.id === 'practice' && host.capabilities.practice),
            )
            .map(({ id, label, Icon }) => (
              <button key={id} className="embedded-shortcut" onClick={() => host.navigate(id)}>
                <Icon size={24} />
                <strong>{label}</strong>
                <span>
                  {id === 'notes'
                    ? zh
                      ? '整理思路，保留题解。'
                      : 'Keep your reasoning and solutions.'
                    : zh
                      ? '记录完成情况、耗时与反馈。'
                      : 'Log completion, time, and feedback.'}
                </span>
              </button>
            ))}
        </div>
      </div>
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
