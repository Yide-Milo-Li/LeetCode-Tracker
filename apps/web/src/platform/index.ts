/**
 * Cross-platform desktop and browser abstraction layer.
 * Detects whether the UI is executing inside the native Tauri desktop shell or a standard browser,
 * routing API calls, external URL handling, and file export operations accordingly.
 */
/**
 * HTTP failure with a stable code; network failures remain distinguishable and retryable.
 */
export class ApiError extends Error {
  public status: number;
  public code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

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

/**
 * Dispatches an API request through the Tauri native IPC command 'api_request'.
 * Injects session security on the Rust side, validates loopback paths, and maintains
 * full error code and status parity with standard HTTP requests.
 */
export async function invokeTauriApi<T>(path: string, options: RequestInit = {}): Promise<T> {
  const tauri = (window as unknown as {
    __TAURI_INTERNALS__: { invoke: <R>(cmd: string, args?: unknown) => Promise<R> };
  }).__TAURI_INTERNALS__;

  const method = (options.method || 'GET').toUpperCase();
  const headers: Record<string, string> = {
    ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
    ...((options.headers as Record<string, string>) || {}),
  };
  const body = typeof options.body === 'string' ? options.body : undefined;
  const fullPath = path.startsWith('/api/v1') ? path : `/api/v1${path.startsWith('/') ? '' : '/'}${path}`;

  try {
    const response = await tauri.invoke<TauriApiResponse>('api_request', {
      method,
      path: fullPath,
      headers,
      body,
    });

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

    // Use Tauri dialog plugin if available, or invoke export directly
    const savePath = prompt(`Save as (desktop file path):`, defaultFilename);
    if (!savePath) return;

    await tauri.invoke('export_data_file', {
      apiPath,
      destinationPath: savePath,
    });
  } else if (typeof window !== 'undefined') {
    const link = document.createElement('a');
    link.href = apiPath;
    link.download = defaultFilename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }
}

/**
 * Initializes global desktop listeners (e.g. intercepting external links).
 */
export function initDesktopPlatform(): void {
  if (!isTauri() || typeof document === 'undefined') return;

  // Intercept external problem and documentation links to open in system default browser
  document.addEventListener('click', (e) => {
    const anchor = (e.target as HTMLElement).closest('a');
    if (anchor && anchor.href) {
      const href = anchor.href;
      if (
        href.startsWith('https://leetcode.com') ||
        href.startsWith('https://leetcode.cn') ||
        href.startsWith('https://github.com')
      ) {
        e.preventDefault();
        void openExternalUrl(href);
      }
    }
  });
}
