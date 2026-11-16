/** Standard MCP Apps transport with optional, feature-detected ChatGPT private widget state. */
import { App } from '@modelcontextprotocol/ext-apps';
import { createWorkspaceHost, type WorkspaceExpansionResult } from '../host.ts';
import { createToolTrackerClient, type ToolProtocol } from './tool-client.ts';

interface WidgetBridge {
  widgetState?: { privateContent?: Record<string, unknown> };
  setWidgetState?: (state: unknown) => void;
}
export interface WorkspaceLifecycle {
  /** Unmount the owner before disposing host services; invoked once for every exit path. */
  onDispose?: () => void | Promise<void>;
}
export function createChatGPTWorkspace(
  app = new App(
    { name: 'Tracker workspace', version: '1.2.0' },
    { availableDisplayModes: ['fullscreen'] },
    { strict: true },
  ),
  protocol: ToolProtocol = 'formal',
  lifecycle: WorkspaceLifecycle = {},
) {
  const bridge = () =>
    typeof window === 'undefined'
      ? undefined
      : (window as unknown as { openai?: WidgetBridge }).openai;
  let privateState = bridge()?.widgetState?.privateContent ?? {};
  const instance =
    typeof privateState.instanceId === 'string' ? privateState.instanceId : crypto.randomUUID();
  let disposed = false,
    connected = true;
  let initialized = false;
  const lifetime = new AbortController();
  const assertActive = () => {
    if (disposed) throw new Error('Workspace is disposed');
  };
  const recoveryAvailable = typeof bridge()?.setWidgetState === 'function';
  const canWrite = protocol === 'formal' && recoveryAvailable;
  let expansion:Promise<WorkspaceExpansionResult>|undefined;
  const host = createWorkspaceHost({
    id: instance,
    capabilities: {
      practice: canWrite,
      planEditing: canWrite,
      append: protocol === 'experimental' || canWrite,
      noteEditing: protocol === 'experimental' || canWrite,
      durableDrafts: canWrite,
    },
    recoveryState: () => privateState,
    saveRecoveryState: (state) => {
      if (disposed) return;
      privateState = { ...state, instanceId: instance };
      bridge()?.setWidgetState?.({ privateContent: privateState });
    },
    expand: () => {
      assertActive();
      if(expansion)return expansion;
      const available = app.getHostContext()?.availableDisplayModes;
      if(available && !available.includes('fullscreen')) {
        const result:WorkspaceExpansionResult={status:'unsupported',reason:'Host does not advertise fullscreen'};
        host.emit({type:'display',state:{...host.displayState(),availability:'unsupported',pending:false,result}});
        return Promise.resolve(result);
      }
      host.emit({type:'display',state:{...host.displayState(),pending:true}});
      expansion=(async()=>{
        let result:WorkspaceExpansionResult;
        try {
          const response=await app.requestDisplayMode({mode:'fullscreen'},{signal:lifetime.signal});
          result={status:response.mode==='fullscreen'?'accepted':'rejected',mode:response.mode,
            ...(response.mode==='fullscreen'?{}:{reason:'Host returned '+response.mode})};
        } catch(error) {result={status:'failed',reason:error instanceof Error?error.message:String(error)};}
        if(!disposed)host.emit({type:'display',state:{...host.displayState(),mode:result.mode??host.displayState().mode,pending:false,result}});
        return result;
      })().finally(()=>{expansion=undefined;});
      return expansion;
    },
    openExternal: async (url) => {
      assertActive();
      const result = await app.openLink({ url }, { signal: lifetime.signal });
      if (result.isError) throw new Error('Host rejected the link');
    },
  });
  const navigate = (value: unknown) => {
    if (disposed || !value || typeof value !== 'object') return;
    const data = value as Record<string, unknown>;
    if (['home', 'today', 'practice', 'notes'].includes(String(data.view))) {
      const target =
        typeof data.questionFrontendId === 'string'
          ? data.questionFrontendId
          : typeof data.practiceId === 'string'
            ? data.practiceId
            : undefined;
      if (!initialized)
        host.saveRecoveryState({
          ...host.recoveryState(),
          view: data.view,
          targetId: target ?? null,
          targetKind: typeof data.practiceId === 'string' ? 'practice' : 'problem',
        });
      host.navigate(
        String(data.view),
        target,
        typeof data.practiceId === 'string' ? 'practice' : 'problem',
      );
    }
  };
  app.ontoolresult = (result) => {
    if (disposed) return;
    navigate(result._meta?.workspace);
    host.emit({ type: 'refresh' });
  };
  let lastDeepLinkRoute: string | undefined;
  let lastTheme: 'light' | 'dark' | undefined;
  const context = () => {
    if (disposed) return;
    const ctx = app.getHostContext() as
      | (ReturnType<typeof app.getHostContext> & {
          theme?: 'light' | 'dark';
          ['openai/deepLink']?: { url?: string };
        })
      | undefined;
    const theme = ctx?.theme;
    const modes=ctx?.availableDisplayModes;
    host.emit({type:'display',state:{...host.displayState(),mode:ctx?.displayMode,
      availability:modes?(modes.includes('fullscreen')?'available':'unsupported'):'unknown'}});
    if ((theme === 'light' || theme === 'dark') && theme !== lastTheme) {
      lastTheme = theme;
      host.emit({ type: 'theme', theme });
    }
    const deep = ctx?.['openai/deepLink'];
    if (deep?.url) {
      let url: URL;
      try { url = new URL(deep.url, 'https://tracker.invalid'); }
      catch { return; }
      const view = url.pathname.slice(1) || 'home';
      if (!['home', 'today', 'practice', 'notes'].includes(view)) return;
      const questionFrontendId = url.searchParams.get('questionFrontendId');
      const practiceId = url.searchParams.get('practiceId');
      const route = JSON.stringify([view, questionFrontendId, practiceId]);
      // Global hosts resend the original deep link with unrelated context updates.
      // Only a changed route may override local navigation or request a dirty-editor guard.
      if (route === lastDeepLinkRoute) return;
      lastDeepLinkRoute = route;
      navigate({
        view,
        questionFrontendId,
        practiceId,
      });
    }
  };
  app.onhostcontextchanged = context;
  const client = createToolTrackerClient(
    async (name, args) => {
      assertActive();
      if (
        protocol === 'formal' &&
        !recoveryAvailable &&
        /^tracker_(create|save|update|revoke|append|remove|replace|apply)_/.test(name)
      )
        throw new Error(
          'This host cannot retain recovery handles. Use Tracker desktop for writes.',
        );
      try {
        const result = await app.callServerTool({ name, arguments: args }, { signal: lifetime.signal });
        assertActive();
        if (!connected) {
          connected = true;
          host.emit({ type: 'connection', connected: true });
        }
        return result;
      } catch (error) {
        if (!disposed && connected) {
          connected = false;
          host.emit({ type: 'connection', connected: false });
        }
        throw error;
      }
    },
    host,
    protocol,
  );
  const unsubscribe = host.subscribe((event) => {
    if (disposed || event.type !== 'selection') return;
    if (app.getHostCapabilities()?.updateModelContext)
      void app
        .updateModelContext({
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                view: event.view,
                targetId: event.targetId ?? null,
              }),
            },
          ],
        }, { signal: lifetime.signal })
        .catch(() => {});
  });
  let cleanupPromise: Promise<void> | undefined;
  let closePromise: Promise<void> | undefined;
  const cleanup = () => {
    if (!cleanupPromise) {
      disposed = true;
      lifetime.abort();
      cleanupPromise = (async () => {
        try { await lifecycle.onDispose?.(); }
        finally {
          unsubscribe();
          host.dispose();
          app.ontoolresult = undefined;
          app.onhostcontextchanged = undefined;
        }
      })();
    }
    return cleanupPromise;
  };
  const dispose = () => {
    closePromise ??= (async () => {
      try { await cleanup(); }
      finally { await app.close(); }
    })();
    return closePromise;
  };
  app.onteardown = async () => {
    // The SDK must send the teardown acknowledgement before the host destroys its frame.
    await cleanup();
    return {};
  };
  return {
    host,
    client,
    app,
    dispose,
    isDisposed: () => disposed,
    connect: async (transport?: Parameters<App['connect']>[0]) => {
      assertActive();
      await app.connect(transport);
      assertActive();
      host.saveRecoveryState(host.recoveryState());
      await client.initializeRecovery();
      assertActive();
      context();
      host.emit({ type: 'connection', connected: true });
      if (app.getHostContext()?.displayMode !== 'fullscreen') await host.expand?.();
    },
    renderReady: () => {
      assertActive();
      initialized = true;
    },
  };
}
