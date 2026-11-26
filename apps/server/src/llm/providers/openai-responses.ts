/**
 * Responses API transport for requests billed to a user's ChatGPT plan (Sign in with ChatGPT).
 *
 * The route only accepts streamed, unstored requests: `store: false`, `stream: true`, `input` as an
 * array, and no `system` role items. It rejects `max_output_tokens`, `temperature` and several
 * other fields, so the request body stays minimal. A response counts as successful only after the
 * `response.completed` event.
 *
 * Function tools must be grouped in a namespace on this route. Because nothing is stored, the
 * model's tool-call turn is sent back as the output items it arrived as, including the encrypted
 * reasoning that a reasoning model needs to continue from its own call.
 *
 * Reference: https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations
 */
import type { ReasoningEffort } from '../../../../../packages/contracts/src/sync.ts';
import type { ChatToolCall, ChatToolSpec, ChatToolStep } from '../../../../../packages/application/src/types.ts';
import { normalizeUsage, type LLMUsage } from '../usage.ts';
import { ProviderOutputError } from './base.ts';
import { sseData } from './sse.ts';

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
  /** Single user turn. Ignored when `messages` is given. */
  prompt?: string;
  /** Whole conversation, oldest first; the route keeps no history (`store: false`). */
  messages?: Array<{ role: 'user' | 'assistant'; content: string }>;
  /** Function tools the model may call; sent as one namespace. */
  tools?: ChatToolSpec[];
  /** Tool calls and results already exchanged for this answer; appended after `messages`. */
  steps?: ChatToolStep[];
  /** Called with each visible text fragment as it arrives. */
  onDelta?: (text: string) => void;
  reasoningEffort?: ReasoningEffort;
  /** Ask for a JSON object. The word "JSON" must then appear in `developer` or `prompt`. */
  json?: boolean;
  abortSignal?: AbortSignal;
}

export interface ResponsesResult {
  text: string;
  model: string;
  usage: LLMUsage;
  /** Non-empty when the response ended with function calls instead of an answer. */
  toolCalls?: ChatToolCall[];
  /** The output items to send back as input before the tool results. */
  replay?: unknown[];
}

/** Namespace that groups the function tools, as the plan route requires. */
const TOOL_NAMESPACE = {
  name: 'tracker',
  description: "Read-only lookups in the user's LeetCode Tracker data.",
};

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
      ...(request.messages ?? [{ role: 'user', content: request.prompt ?? '' }]),
      ...(request.steps ?? []).flatMap(step => step.role === 'assistant'
        ? step.replay as unknown[]
        : [{ type: 'function_call_output', call_id: step.callId, output: step.content }]),
    ],
    ...(request.tools?.length ? {
      tools: [{ type: 'namespace', ...TOOL_NAMESPACE, tools: request.tools.map(tool => ({ type: 'function', ...tool })) }],
      // Without stored responses, reasoning can only be continued from its encrypted form.
      include: ['reasoning.encrypted_content'],
    } : {}),
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

type OutputItem = Record<string, unknown>;

/**
 * Split a completed response's output into the function calls to run and the items to send back
 * with their results.
 *
 * Reasoning items are replayed only in encrypted form. Without one, the calls go back without
 * their ids: an id points at a reasoning item the unstored route can no longer find.
 */
function toolTurn(output: OutputItem[]): { toolCalls: ChatToolCall[]; replay: unknown[] } {
  const calls = output.filter(item => item.type === 'function_call' && typeof item.call_id === 'string' && typeof item.name === 'string');
  const reasoning = output.filter(item => item.type === 'reasoning' && typeof item.encrypted_content === 'string');
  return {
    toolCalls: calls.map(item => ({
      id: item.call_id as string,
      name: item.name as string,
      arguments: typeof item.arguments === 'string' ? item.arguments : '',
    })),
    replay: reasoning.length
      ? output.filter(item => reasoning.includes(item) || calls.includes(item))
      : calls.map(({ id: _id, ...item }) => item),
  };
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
  /** Finished output items, kept in case the terminal event carries no `output`. */
  const items: OutputItem[] = [];
  // Held in an object because the event handler below assigns it from a closure.
  const state: { completed: ResponsesResult | null } = { completed: null };

  /** Apply one decoded SSE event; returns after recording a terminal state or throwing. */
  const handle = (event: Record<string, unknown>): void => {
    const body = (event.response && typeof event.response === 'object' ? event.response : {}) as Record<string, unknown>;
    switch (event.type) {
      case 'response.output_text.delta':
        if (typeof event.delta === 'string' && event.delta) {
          text += event.delta;
          request.onDelta?.(event.delta);
        }
        return;
      case 'response.output_item.done':
        if (event.item && typeof event.item === 'object') items.push(event.item as OutputItem);
        return;
      case 'response.completed': {
        const output = Array.isArray(body.output) && body.output.length ? body.output as OutputItem[] : items;
        const turn = toolTurn(output);
        state.completed = {
          text: text || outputText(output),
          model: typeof body.model === 'string' && body.model ? body.model : request.model,
          usage: normalizeUsage('openai', body.usage),
          ...(turn.toolCalls.length ? turn : {}),
        };
        return;
      }
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

  for await (const data of sseData(response.body)) {
    if (data === '[DONE]') continue;
    let event: unknown;
    try { event = JSON.parse(data); } catch { continue; }
    if (event && typeof event === 'object') handle(event as Record<string, unknown>);
    // Leaving the loop cancels the reader, so nothing after the terminal event is read.
    if (state.completed) break;
  }
  if (!state.completed) throw new ResponsesApiError(502, null, 'The response stream ended before completion.');
  return state.completed;
}
