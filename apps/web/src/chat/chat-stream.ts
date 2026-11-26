/**
 * Transport for `POST /api/v1/chat/stream`.
 *
 * A browser reads the response body directly. The desktop WebView cannot reach the loopback
 * service, so the native host forwards the body as raw byte chunks over a Tauri channel
 * (`api_stream`). Both paths feed the same incremental decoder.
 */
import { Channel, invoke } from '@tauri-apps/api/core';
import type { ChatRequest, ChatStreamEvent } from '../../../../packages/contracts/src/chat.ts';
import { ApiError, isTauri } from '../platform/index.ts';

const CHAT_STREAM_PATH = '/api/v1/chat/stream';
/** How long to wait for channel messages still in flight after the native call returned. */
const CHANNEL_DRAIN_MS = 2000;

/**
 * Incremental Server-Sent Events decoder for chat events.
 *
 * Chunks may split an event or a multi-byte character anywhere; `push` emits every event that
 * became complete and `end` flushes a final unterminated one. Malformed blocks are skipped.
 */
export function createChatEventDecoder(onEvent: (event: ChatStreamEvent) => void) {
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  const emit = (block: string) => {
    const data = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
    if (!data) return;
    try { onEvent(JSON.parse(data) as ChatStreamEvent); } catch { /* Skip a block that is not an event. */ }
  };
  const drain = () => {
    buffer = buffer.replace(/\r\n/g, '\n');
    for (let boundary = buffer.indexOf('\n\n'); boundary !== -1; boundary = buffer.indexOf('\n\n')) {
      emit(buffer.slice(0, boundary));
      buffer = buffer.slice(boundary + 2);
    }
  };
  return {
    push(chunk: Uint8Array): void {
      buffer += decoder.decode(chunk, { stream: true });
      drain();
    },
    end(): void {
      buffer += decoder.decode();
      drain();
      if (buffer.trim()) emit(buffer);
      buffer = '';
    },
  };
}

function httpError(status: number, body: string): ApiError {
  let details: { error?: string; message?: string } | undefined;
  try { details = JSON.parse(body); } catch { /* Not a JSON error body. */ }
  return new ApiError(status, details?.error || 'HTTP_ERROR', details?.message || `HTTP ${status}`, details);
}

const aborted = (signal: AbortSignal) => signal.reason ?? new DOMException('Aborted', 'AbortError');

/**
 * Send one chat request and deliver its events in order.
 *
 * Resolves when the stream ended, whether or not a terminal `done` or `error` event arrived; the
 * caller decides what a missing terminal event means.
 *
 * @throws ApiError when the request was refused before the stream opened (invalid input,
 * provider not configured) or the desktop bridge failed.
 * @throws The abort reason when `signal` fires; the server then stops the provider request.
 */
export async function streamChat(request: ChatRequest, onEvent: (event: ChatStreamEvent) => void, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  const body = JSON.stringify(request);

  if (!isTauri()) {
    const response = await fetch(`${window.location.origin}${CHAT_STREAM_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body,
      signal,
    });
    if (!response.ok) throw httpError(response.status, await response.text().catch(() => ''));
    if (!response.body) throw new ApiError(502, 'CHAT_INTERRUPTED', 'The chat response had no body.');
    const decoder = createChatEventDecoder(onEvent);
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      decoder.push(value);
    }
    decoder.end();
    return;
  }

  let finished: () => void = () => {};
  const terminal = new Promise<void>(resolve => { finished = resolve; });
  const decoder = createChatEventDecoder(event => {
    if (signal.aborted) return;
    onEvent(event);
    if (event.type === 'done' || event.type === 'error') finished();
  });
  const streamId = crypto.randomUUID();
  const onChunk = new Channel<number[]>(chunk => decoder.push(new Uint8Array(chunk)));
  const cancel = () => { void invoke('api_stream_cancel', { streamId }).catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    let response: { status: number; body: string };
    try {
      response = await invoke<{ status: number; body: string }>('api_stream', { path: CHAT_STREAM_PATH, body, streamId, onChunk });
    } catch (error) {
      if (signal.aborted) throw aborted(signal);
      throw new ApiError(500, 'DESKTOP_IPC_ERROR', error instanceof Error ? error.message : String(error));
    }
    if (signal.aborted) throw aborted(signal);
    if (response.status < 200 || response.status >= 300) throw httpError(response.status, response.body);
    // The call's result and the last channel messages travel separately; let the tail arrive.
    await Promise.race([terminal, new Promise(resolve => setTimeout(resolve, CHANNEL_DRAIN_MS))]);
    decoder.end();
  } finally {
    signal.removeEventListener('abort', cancel);
  }
}
