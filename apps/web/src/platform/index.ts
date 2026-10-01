/**
 * Cross-platform desktop and browser abstraction layer.
 * Detects whether the UI is executing inside the native Tauri desktop shell or a standard browser,
 * routing API calls, external URL handling, and file export operations accordingly.
 */
/**
 * HTTP failure with a stable code; network failures remain distinguishable and retryable.
 */
import { ApiError } from '../../../../packages/workspace/src/client.ts';
export { ApiError };

/**
 * Determine whether the application is running inside the Tauri native desktop container.
 */
export function isTauri(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !== 'undefined'
  );
}

interface TauriApiResponse {
  status: number;
  body: string;
  headers: Record<string, string>;
}

/** Normalize API paths for both browser downloads and the authenticated native bridge. */
function apiPath(path: string): string {
  return path.startsWith('/api/v1/') ? path : `/api/v1${path.startsWith('/') ? '' : '/'}${path}`;
}

/** Cancel waiting without assuming an already dispatched write was rolled back on the server. */
function awaitResponse<T>(promise: Promise<T>, signal?: AbortSignal | null): Promise<T> {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) abort();
  });
}

/**
 * Dispatches an API request through the Tauri native IPC command 'api_request'.
 * Injects session security on the Rust side, validates loopback paths, and maintains
 * full error code and status parity with standard HTTP requests.
 */
export async function invokeTauriApi<T>(path: string, options: RequestInit = {}): Promise<T> {
  options.signal?.throwIfAborted();
  const tauri = (window as unknown as {
    __TAURI_INTERNALS__: { invoke: <R>(cmd: string, args?: unknown) => Promise<R> };
  }).__TAURI_INTERNALS__;

  const method = (options.method || 'GET').toUpperCase();
  const headers: Record<string, string> = {
    ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
    ...Object.fromEntries(new Headers(options.headers).entries()),
  };
  const body = typeof options.body === 'string' ? options.body : undefined;
  const fullPath = apiPath(path);

  try {
    const response = await awaitResponse(tauri.invoke<TauriApiResponse>('api_request', {
      method,
      path: fullPath,
      headers,
      body,
    }), options.signal);

    if (response.status < 200 || response.status >= 300) {
      let errorMsg = `HTTP ${response.status}`;
      let errorCode = 'HTTP_ERROR';
      try {
        const errJson = JSON.parse(response.body);
        if (errJson.message) errorMsg = errJson.message;
        if (errJson.error) errorCode = errJson.error;
      } catch {
        // Use default fallback error message
      }
      throw new ApiError(response.status, errorCode, errorMsg);
    }

    try {
      return JSON.parse(response.body) as T;
    } catch {
      return response.body as unknown as T;
    }
  } catch (err) {
    if (options.signal?.aborted) throw options.signal.reason;
    if (err instanceof ApiError) throw err;
    throw new ApiError(500, 'DESKTOP_IPC_ERROR', err instanceof Error ? err.message : String(err));
  }
}

/**
 * Opens a whitelisted external URL in the user's default system browser.
 */
export async function openExternalUrl(url: string): Promise<void> {
  if (isTauri()) {
    const tauri = (window as unknown as {
      __TAURI_INTERNALS__: { invoke: <R>(cmd: string, args?: unknown) => Promise<R> };
    }).__TAURI_INTERNALS__;
    await tauri.invoke('open_external', { url });
  } else if (typeof window !== 'undefined') {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}

/**
 * Triggers native file export in desktop mode, or initiates standard browser download.
 */
export async function exportDataFile(apiPath: string, defaultFilename: string): Promise<void> {
  if (isTauri()) {
    const tauri = (window as unknown as {
      __TAURI_INTERNALS__: { invoke: <R>(cmd: string, args?: unknown) => Promise<R> };
    }).__TAURI_INTERNALS__;

    // Rust owns the native dialog and the resulting path; the renderer supplies no destination.
    await tauri.invoke('export_data_file', {
      apiPath: apiPath.startsWith('/api/v1/') ? apiPath : `/api/v1${apiPath}`,
      defaultFilename,
    });
  } else if (typeof window !== 'undefined') {
    const link = document.createElement('a');
    link.href = apiPath.startsWith('/api/v1/') ? apiPath : `/api/v1${apiPath}`;
    link.download = defaultFilename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }
}

/**
 * Initializes global desktop listeners (e.g. intercepting external links).
 */
export function initDesktopPlatform(getLang?: () => 'en' | 'zh'): void {
  if (!isTauri() || typeof document === 'undefined') return;

  // Intercept external problem and documentation links to open in system default browser
  document.addEventListener('click', (e) => {
    if (e.defaultPrevented) return;
    const anchor = (e.target as HTMLElement).closest('a');
    if (anchor && anchor.href) {
      const href = anchor.href;
      const destination = new URL(href);
      if (['https:', 'http:'].includes(destination.protocol) && destination.origin !== window.location.origin) {
        e.preventDefault();
        void openExternalUrl(href).catch(() => {
          // Native validation remains authoritative; show a failure instead of an unhandled rejection.
          const zh = getLang ? getLang() === 'zh' : document.documentElement.lang.toLowerCase().startsWith('zh');
          window.alert(zh ? '无法打开此链接。' : 'Unable to open this link.');
        });
      }
    }
  });
}

/**
 * Listen for exit request event from the desktop host (e.g. system tray quit).
 */
export function listenDesktopExit(handler: () => void | Promise<void>): () => void {
  if (typeof window === 'undefined') return () => {};

  let lastTrigger = 0;
  const onExit = () => {
    const now = Date.now();
    if (now - lastTrigger < 300) return;
    lastTrigger = now;
    if (isTauri()) void (window as any).__TAURI_INTERNALS__.invoke('acknowledge_exit').catch(() => {});
    void handler();
  };

  window.addEventListener('desktop:request-exit', onExit);
  if (isTauri()) void (window as any).__TAURI_INTERNALS__.invoke('renderer_ready').catch(() => {});

  let unlistenTauri: (() => void) | null = null;
  if (isTauri()) {
    try {
      import('@tauri-apps/api/event')
        .then(({ listen }) => {
          listen('desktop:request-exit', onExit)
            .then((unlisten) => {
              unlistenTauri = unlisten;
            })
            .catch(() => {});
        })
        .catch(() => {});
    } catch {
      // Ignore in non-Tauri / test environments
    }
  }

  return () => {
    window.removeEventListener('desktop:request-exit', onExit);
    if (unlistenTauri) unlistenTauri();
  };
}

/**
 * Confirm termination and tear down the background runtime.
 */
export async function confirmExit(): Promise<void> {
  if (isTauri()) {
    const tauri = (window as unknown as {
      __TAURI_INTERNALS__: { invoke: <R>(cmd: string, args?: unknown) => Promise<R> };
    }).__TAURI_INTERNALS__;
    await tauri.invoke('confirm_exit');
  }
}

/**
 * Cancel exit request and keep the desktop runtime running.
 */
export async function cancelExit(): Promise<void> {
  window.dispatchEvent(new window.CustomEvent('desktop:exit-cancelled'));
  if (isTauri()) {
    const tauri = (window as unknown as {
      __TAURI_INTERNALS__: { invoke: <R>(cmd: string, args?: unknown) => Promise<R> };
    }).__TAURI_INTERNALS__;
    await tauri.invoke('cancel_exit');
  }
}

/**
 * Get whether login autostart is enabled.
 */
export async function getAutostartStatus(): Promise<boolean> {
  if (isTauri()) {
    const tauri = (window as unknown as {
      __TAURI_INTERNALS__: { invoke: <R>(cmd: string, args?: unknown) => Promise<R> };
    }).__TAURI_INTERNALS__;
    return await tauri.invoke<boolean>('get_autostart_status');
  }
  return false;
}

/**
 * Set login autostart enabled or disabled.
 */
export async function setAutostartStatus(enabled: boolean): Promise<void> {
  if (isTauri()) {
    const tauri = (window as unknown as {
      __TAURI_INTERNALS__: { invoke: <R>(cmd: string, args?: unknown) => Promise<R> };
    }).__TAURI_INTERNALS__;
    await tauri.invoke('set_autostart_status', { enabled });
  }
}

/**
 * Get whether AI access to MCP is paused.
 */
export async function getAiAccessStatus(): Promise<boolean> {
  if (isTauri()) {
    const tauri = (window as unknown as {
      __TAURI_INTERNALS__: { invoke: <R>(cmd: string, args?: unknown) => Promise<R> };
    }).__TAURI_INTERNALS__;
    return await tauri.invoke<boolean>('get_ai_access_status');
  }
  return false;
}

/**
 * Set AI access to MCP paused or resumed.
 */
export async function setAiAccessStatus(paused: boolean): Promise<void> {
  if (isTauri()) {
    const tauri = (window as unknown as {
      __TAURI_INTERNALS__: { invoke: <R>(cmd: string, args?: unknown) => Promise<R> };
    }).__TAURI_INTERNALS__;
    await tauri.invoke('set_ai_access_status', { paused });
  }
}
