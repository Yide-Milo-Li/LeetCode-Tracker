/** Provider lifetime owns subscriptions and stable instance services, never module globals. */
import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { TrackerClient } from './client.ts';
import type { WorkspaceHost } from './host.ts';
import { createPracticeService } from './practice-service.ts';
import { createTimerService } from './timer-service.ts';
import { WorkspaceContext } from './workspace.tsx';
import type { PracticeRequest } from './workspace.tsx';
import { PracticeWorkspace } from './components/PracticeWorkspace.tsx';
import type { Language } from './i18n.ts';
import { Feedback } from './components/ui.tsx';

export function createWorkspaceServices(client: TrackerClient, host: WorkspaceHost) {
  return {
    practice: createPracticeService(client, host),
    timer: createTimerService(host),
  };
}
export interface WorkspaceEnvironment {
  client: TrackerClient;
  host: WorkspaceHost;
  practice: ReturnType<typeof createPracticeService>;
  timer: ReturnType<typeof createTimerService>;
  revision: number;
  connected: boolean;
  root: React.RefObject<HTMLDivElement | null>;
}
const Environment = createContext<WorkspaceEnvironment | null>(null);
export function useOptionalWorkspaceEnvironment() {
  return useContext(Environment);
}
export function useWorkspaceEnvironment(): WorkspaceEnvironment {
  const value = useContext(Environment);
  if (!value) throw new Error('Shared workspace requires a WorkspaceProvider');
  return value;
}
export interface WorkspaceProviderProps {
  client: TrackerClient;
  host: WorkspaceHost;
  children: React.ReactNode;
  services?: ReturnType<typeof createWorkspaceServices>;
  theme?: 'light' | 'dark';
  palette?: string;
  language?: Language;
  timezone?: string | null;
}
export function WorkspaceProvider({
  client,
  host,
  children,
  services,
  theme = 'light',
  palette,
  language = 'en',
  timezone = null,
}: WorkspaceProviderProps) {
  const owned = useMemo(
    () => services ?? createWorkspaceServices(client, host),
    [client, host, services],
  );
  const root = useRef<HTMLDivElement>(null);
  const [revision, setRevision] = useState(0),
    [connected, setConnected] = useState(true);
  const [selectedNoteProblem, setSelectedNoteProblem] = useState<string | null>(null);
  const [practice, setPractice] = useState<PracticeRequest | null>(null);
  const [feedback, setFeedback] = useState('');
  const openPractice = (request: PracticeRequest) => {
    if (!host.capabilities.practice) throw new Error('Practice is unavailable in this host');
    setPractice(request);
    if (host.capabilities.durableDrafts && request.mode !== 'evidence')
      host.saveRecoveryState({
        ...host.recoveryState(),
        practiceEditor:
          request.mode === 'manual'
            ? {
                mode: 'manual',
                frontendId: request.problem?.questionFrontendId,
              }
            : { mode: request.mode, recordId: request.record.id },
      });
  };
  const closePractice = () => {
    setPractice(null);
    host.saveRecoveryState({ ...host.recoveryState(), practiceEditor: null });
  };
  useEffect(() => {
    const saved = host.recoveryState().practiceEditor;
    if (!host.capabilities.durableDrafts || !saved || typeof saved !== 'object') return;
    const handle = saved as {
      mode?: string;
      frontendId?: string;
      recordId?: string;
      editing?: boolean;
    };
    let active = true;
    void (async () => {
      const request: PracticeRequest =
        handle.mode === 'manual'
          ? {
              mode: 'manual',
              problem: handle.frontendId
                ? await client.getWorkspaceProblem?.(handle.frontendId)
                : undefined,
            }
          : {
              mode: 'detail',
              record: await client.getPracticeRecord(String(handle.recordId)),
              restoreEditing: handle.editing,
            };
      if (active) setPractice(request);
    })().catch((error) => {
      if (active) setFeedback(error.message);
    });
    return () => {
      active = false;
    };
  }, [client, host]);
  useEffect(
    () =>
      host.subscribe((event) => {
        if (event.type === 'refresh') setRevision((value) => value + 1);
        if (event.type === 'connection') setConnected(event.connected);
        if (event.type === 'operation') owned.practice.settlePracticeOperation(event.operation);
        if (event.type === 'navigate' && event.view === 'notes' && event.targetId)
          setSelectedNoteProblem(event.targetId);
      }),
    [host, owned],
  );
  // One provider owns recovery polling for both retained views; hidden frames stop checking.
  useEffect(() => {
    if (!client.recoverOperations) return;
    let active = true,
      checking = false;
    const check = async () => {
      if (
        !active ||
        checking ||
        document.visibilityState === 'hidden' ||
        root.current?.closest('[hidden]')
      )
        return;
      checking = true;
      try {
        await client.recoverOperations?.();
      } catch {
        /* Preserve input when the host is temporarily unavailable. */
      } finally {
        checking = false;
      }
    };
    const focus = () => {
      void check();
    };
    const unsubscribe = host.subscribe((event) => {
      if (event.type === 'connection' && event.connected) focus();
    });
    const interval = setInterval(focus, 2000);
    window.addEventListener('focus', focus);
    document.addEventListener('visibilitychange', focus);
    return () => {
      active = false;
      unsubscribe();
      clearInterval(interval);
      window.removeEventListener('focus', focus);
      document.removeEventListener('visibilitychange', focus);
    };
  }, [client, host]);
  const value = useMemo(
    () => ({ client, host, ...owned, revision, connected, root }),
    [client, host, owned, revision, connected],
  );
  const state = useMemo(
    () => ({
      revision,
      timezone,
      selectedNoteProblem,
      navigate: host.navigate,
      notifyMutation: () => host.emit({ type: 'refresh' }),
      openPractice,
      reportPracticeOutcome: (outcome: { recovery?: PracticeRequest; error?: string }) => {
        if (outcome.recovery) openPractice(outcome.recovery);
        if (outcome.error) setFeedback(outcome.error);
      },
    }),
    [revision, selectedNoteProblem, host, timezone],
  );
  return (
    <Environment.Provider value={value}>
      <WorkspaceContext.Provider value={state}>
        <div
          ref={root}
          className={`tracker-workspace${theme === 'dark' ? ' dark' : ''}`}
          data-workspace-id={host.id}
          data-palette={palette}
          onClick={(event) => {
            const anchor = (event.target as Element).closest<HTMLAnchorElement>('a[href]');
            if (
              anchor &&
              /^https?:/.test(anchor.href) &&
              anchor.origin !== window.location.origin
            ) {
              event.preventDefault();
              void host.openExternal(anchor.href);
            }
          }}
        >
          {!connected && <div role="alert">Disconnected / 连接已断开</div>}
          {feedback && <Feedback>{feedback}</Feedback>}
          {children}
          {practice && (
            <PracticeWorkspace
              key={'record' in practice ? practice.record.id : 'manual'}
              request={practice}
              lang={language}
              onClose={closePractice}
            />
          )}
        </div>
      </WorkspaceContext.Provider>
    </Environment.Provider>
  );
}
