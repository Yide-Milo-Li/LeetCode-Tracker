/**
 * Contract for the in-app AI chat (`POST /api/v1/chat/stream`).
 *
 * The server keeps no conversation: every request carries the turns the model should see. The
 * response is a Server-Sent Events stream of {@link ChatStreamEvent} values, one JSON object per
 * `data:` line, ending with exactly one `done` or `error` event.
 *
 * While answering, the model may read the user's tracker through a fixed set of read tools. Each
 * lookup is reported as a `tool` event, and `dataAccess: false` turns the lookups off.
 */
import { z } from 'zod';
import { llmProviderSchema } from './sync.ts';
import { CHAT_MAX_MESSAGES, CHAT_MAX_MESSAGE_CHARS, CHAT_MAX_TOTAL_CHARS } from './chat-limits.ts';

export * from './chat-limits.ts';

export const chatMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().min(1).max(CHAT_MAX_MESSAGE_CHARS),
}).strict();
export type ChatTurn = z.infer<typeof chatMessageSchema>;

/**
 * Local data the server attaches to the conversation before calling the model.
 *
 * `frontendId` adds one problem with the user's practice history and note. An unknown problem is
 * skipped, never an error.
 */
export const chatContextSchema = z.object({
  frontendId: z.string().trim().min(1).max(100).optional(),
}).strict();
export type ChatContext = z.infer<typeof chatContextSchema>;

export const chatRequestSchema = z.object({
  messages: z.array(chatMessageSchema).min(1).max(CHAT_MAX_MESSAGES),
  context: chatContextSchema.optional(),
  /** Interface language; the model still answers in the language the user writes in. */
  lang: z.enum(['en', 'zh']).optional(),
  /**
   * `false` keeps the model from looking anything up, leaving only the attached `context`.
   * Omitted means allowed.
   */
  dataAccess: z.boolean().optional(),
}).strict().superRefine((value, ctx) => {
  // Refinements also run on input that already failed a field rule, such as an empty list.
  const last = value.messages.at(-1);
  if (last && last.role !== 'user') {
    ctx.addIssue({ code: 'custom', path: ['messages'], message: 'The last message must be from the user.' });
  }
  if (value.messages.reduce((total, message) => total + message.content.length, 0) > CHAT_MAX_TOTAL_CHARS) {
    ctx.addIssue({ code: 'custom', path: ['messages'], message: 'The conversation is too long.' });
  }
});
export type ChatRequest = z.infer<typeof chatRequestSchema>;

/** What the server attached, so the UI can show which local data the answer could use. */
export interface ChatContextSummary {
  problem?: { frontendId: string; title: string };
}

export type ChatStreamEvent =
  /** First event: the context that was resolved for this request. */
  | { type: 'context'; context: ChatContextSummary }
  | { type: 'delta'; text: string }
  /** The model is reading tracker data; `name` is the read tool, such as `tracker_list_practices`. */
  | { type: 'tool'; name: string }
  | { type: 'done'; provider: z.infer<typeof llmProviderSchema>; model: string }
  /** `error` is a stable code such as `CHAT_QUOTA`; `message` is an English fallback. */
  | { type: 'error'; error: string; message: string };

/** Whether chat can run, for enabling the composer without a request. */
export interface ChatStatus {
  configured: boolean;
  provider?: z.infer<typeof llmProviderSchema>;
  model: string;
}
