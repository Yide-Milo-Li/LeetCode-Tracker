/**
 * Responses API transport for requests billed to a user's ChatGPT plan (Sign in with ChatGPT).
 *
 * The route only accepts streamed, unstored requests: `store: false`, `stream: true`, `input` as an
 * array, and no `system` role items. It rejects `max_output_tokens`, `temperature` and several
 * other fields, so the request body stays minimal. A response counts as successful only after the
 * `response.completed` event.
 *
 * Reference: https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations
 */
import type { ReasoningEffort } from '../../../../../packages/contracts/src/sync.ts';
import { normalizeUsage, type LLMUsage } from '../usage.ts';
import { ProviderOutputError } from './base.ts';

type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** Official API base; ChatGPT plan usage is not available through other gateways. */
export const OPENAI_RESPONSES_BASE_URL = 'https://api.openai.com/v1';

/** HTTP status implied by a Responses error code that arrives inside the stream. */
const STREAM_ERROR_STATUS: Record<string, number> = {
  subscription_sharing_usage_limit_exceeded: 429,
  subscription_sharing_usage_unavailable: 503,
  subscription_sharing_user_unavailable: 503,
  subscription_sharing_user_not_eligible: 403,
  subscription_sharing_route_not_supported: 403,
  subscription_sharing_invalid_user: 401,
  subscription_sharing_unsupported_capability: 400,
  chatpass_v2_scope_not_authorized: 403,
  chatpass_v2_invalid_authorization_context: 403,
  rate_limit_exceeded: 429,
};

export interface ResponsesRequest {
  model: string;
  /** Sent as top-level `instructions`. */
  instructions: string;
  /** Extra developer message placed before the user prompt (for example the JSON schema). */
  developer?: string;
  prompt: string;
  reasoningEffort?: ReasoningEffort;
  /** Ask for a JSON object. The word "JSON" must then appear in `developer` or `prompt`. */
  json?: boolean;
  abortSignal?: AbortSignal;
}

export interface ResponsesResult {
  text: string;
  model: string;
  usage: LLMUsage;
}

/**
 * Failure whose message starts with `[status]`, the format the assistant's retry and quota
 * classification already reads from Chat Completions errors.
 */
export class ResponsesApiError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(status: number, code: string | null, detail: string) {
    super(`[${status}] ${code ? `${code}: ` : ''}${detail}`);
    this.name = 'ResponsesApiError';
    this.status = status;
    this.code = code;
  }
}

/** Build the request body; exported so tests can assert the route's required shape. */
export function buildResponsesBody(request: ResponsesRequest): Record<string, unknown> {
  return {
    model: request.model,
    instructions: request.instructions,
    input: [
      ...(request.developer ? [{ role: 'developer', content: request.developer }] : []),
      { role: 'user', content: request.prompt },
    ],
    store: false,
    stream: true,
    ...(request.reasoningEffort ? { reasoning: { effort: request.reasoningEffort } } : {}),
    ...(request.json ? { text: { format: { type: 'json_object' } } } : {}),
  };
}

/** Concatenate `output_text` parts when a completed response carried no delta events. */
function outputText(output: unknown): string {
  if (!Array.isArray(output)) return '';
  let text = '';
  for (const item of output as Array<{ type?: string; content?: unknown }>) {
    if (item?.type !== 'message' || !Array.isArray(item.content)) continue;
    for (const part of item.content as Array<{ type?: string; text?: unknown }>) {
      if (part?.type === 'output_text' && typeof part.text === 'string') text += part.text;
    }
  }
  return text;
}

/**
 * Read a pre-stream error. Admission failures may return `{"detail": "..."}` instead of the
 * standard `error` object, so the body shape is not assumed.
 */
async function httpError(response: Response): Promise<ResponsesApiError> {
  const raw = await response.text().catch(() => '');
  let code: string | null = null;
  let detail = raw.slice(0, 300) || `HTTP ${response.status}`;
  try {
    const json = JSON.parse(raw) as { error?: { code?: unknown; message?: unknown }; detail?: unknown };
    if (typeof json.error?.code === 'string') code = json.error.code;
    if (typeof json.error?.message === 'string') detail = json.error.message;
    else if (typeof json.detail === 'string') detail = json.detail;
  } catch {
    // Keep the raw excerpt.
  }
  return new ResponsesApiError(response.status, code, detail);
}

/**
 * Send one Responses request and read its event stream through the terminal event.
 *
 * @param accessToken OAuth access token granted `chatgpt.tokens.use.direct`.
 * @throws ResponsesApiError for HTTP errors, `response.failed`, stream `error` events and a stream
 * that ends without `response.completed`.
 * @throws ProviderOutputError `truncated` when the model stopped early (`response.incomplete`).
 * @throws The abort reason when `abortSignal` fires.
 */
export async function createResponse(
  fetchFn: FetchFn,
  accessToken: string,
  request: ResponsesRequest,
  baseUrl: string = OPENAI_RESPONSES_BASE_URL
): Promise<ResponsesResult> {
  const response = await fetchFn(`${baseUrl}/responses`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(buildResponsesBody(request)),
    signal: request.abortSignal,
  });
  if (!response.ok) throw await httpError(response);
  if (!response.body) throw new ResponsesApiError(502, null, 'The response had no event stream.');

  let text = '';
  // Held in an object because the event handler below assigns it from a closure.
  const state: { completed: ResponsesResult | null } = { completed: null };

  /** Apply one decoded SSE event; returns after recording a terminal state or throwing. */
  const handle = (event: Record<string, unknown>): void => {
    const body = (event.response && typeof event.response === 'object' ? event.response : {}) as Record<string, unknown>;
    switch (event.type) {
      case 'response.output_text.delta':
        if (typeof event.delta === 'string') text += event.delta;
        return;
      case 'response.completed':
        state.completed = {
          text: text || outputText(body.output),
          model: typeof body.model === 'string' && body.model ? body.model : request.model,
          usage: normalizeUsage('openai', body.usage),
        };
        return;
      case 'response.incomplete':
        throw new ProviderOutputError('truncated', normalizeUsage('openai', body.usage));
      case 'response.failed': {
        const error = (body.error && typeof body.error === 'object' ? body.error : {}) as { code?: unknown; message?: unknown };
        const code = typeof error.code === 'string' ? error.code : null;
        throw new ResponsesApiError(
          (code && STREAM_ERROR_STATUS[code]) || 502,
          code,
          typeof error.message === 'string' ? error.message : 'The response failed.'
        );
      }
      case 'error': {
        const nested = (event.error && typeof event.error === 'object' ? event.error : event) as { code?: unknown; message?: unknown };
        const code = typeof nested.code === 'string' ? nested.code : null;
        throw new ResponsesApiError(
          (code && STREAM_ERROR_STATUS[code]) || 502,
          code,
          typeof nested.message === 'string' ? nested.message : 'The response stream reported an error.'
        );
      }
      default:
        return;
    }
  };

  /** Parse one SSE block; `data:` lines of a block are joined before JSON decoding. */
  const dispatch = (block: string): void => {
    const data = block.split('\n')
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).replace(/^ /, ''))
      .join('\n');
    if (!data || data === '[DONE]') return;
    let event: unknown;
    try { event = JSON.parse(data); } catch { return; }
    if (event && typeof event === 'object') handle(event as Record<string, unknown>);
  };

  const reader = response.body.getReader();
  // A streaming decoder keeps multi-byte characters intact when a chunk boundary splits them.
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  try {
    while (!state.completed) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      // A lone trailing CR waits for its LF in the next chunk instead of faking a blank line.
      buffer = buffer.replace(/\r\n/g, '\n');
      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1 && !state.completed) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        dispatch(block);
        boundary = buffer.indexOf('\n\n');
      }
      if (done) {
        if (!state.completed && buffer.trim()) dispatch(buffer);
        break;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  if (!state.completed) throw new ResponsesApiError(502, null, 'The response stream ended before completion.');
  return state.completed;
}
