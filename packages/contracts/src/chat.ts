/**
 * Contract for the in-app AI chat (`POST /api/v1/chat/stream`).
 *
 * The server keeps no conversation: every request carries the turns the model should see. The
 * response is a Server-Sent Events stream of {@link ChatStreamEvent} values, one JSON object per
 * `data:` line, ending with exactly one `done` or `error` event.
 *
 * While answering, the model may read the user's tracker through a fixed set of read tools. Each
 * lookup is reported as a `tool` event, and `dataAccess: false` turns the lookups off.
 *
 * The model can also propose a change to the tracker. A proposal arrives as an `action` event and
 * changes nothing; the client shows it and, once the user confirms, sends it to
 * `POST /api/v1/chat/actions`. That route and `POST /api/v1/chat/actions/undo`, which takes an
 * applied change back, are the only chat routes that write.
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
  /**
   * The provider the user was told the question goes to. When another one is active, or the
   * active one changes while answering, the answer ends with `CHAT_PROVIDER_CHANGED` before
   * anything more is sent.
   */
  provider: llmProviderSchema.optional(),
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

/**
 * A change the model proposed, as the client must send it back to apply it.
 *
 * `args` are complete and already validated. The user may edit them before confirming; applying
 * validates them again.
 */
export interface ChatActionProposal {
  /** Unique per proposal, for tracking its state in the conversation. */
  id: string;
  /** The change tool, such as `tracker_create_practices`. */
  name: string;
  args: Record<string, unknown>;
  /** Display names for the identifiers in `args`, so the card can name what it changes. */
  labels: {
    /** Problem titles by frontend ID. */
    problems: Record<string, string>;
    /** Favorite folder names by ID. */
    folders: Record<string, string>;
    /** Goal list names by ID. */
    lists: Record<string, string>;
  };
}

/** Body of `POST /api/v1/chat/actions`: one confirmed proposal. */
export const chatActionRequestSchema = z.object({
  name: z.string().min(1).max(100),
  args: z.record(z.string(), z.unknown()),
}).strict();
export type ChatActionRequest = z.infer<typeof chatActionRequestSchema>;

const undoIds = z.array(z.string().min(1).max(100)).max(100);
const undoProblem = z.string().min(1).max(100);

/**
 * What takes one applied change back: the state before it and the state it left, so the undo can
 * be refused when the data has changed again since.
 */
export const chatUndoSchema = z.discriminatedUnion('kind', [
  /** Revoke the records the change created, each at the revision it was created with. */
  z.object({
    kind: z.literal('practices'),
    records: z.array(z.object({ id: z.string().min(1).max(100), revision: z.number().int().positive() }).strict()).min(1).max(50),
  }).strict(),
  /** Put the note's earlier text back, provided the note still is what the change wrote. */
  z.object({
    kind: z.literal('note'),
    frontendId: undoProblem,
    content: z.string().max(100_000),
    expectedContentHash: z.string().min(1).max(200),
  }).strict(),
  /** Restore each problem's folders (`null` is not starred) and drop the folder the change created. */
  z.object({
    kind: z.literal('favorites'),
    problems: z.array(z.object({ frontendId: undoProblem, before: undoIds.nullable(), after: undoIds }).strict()).max(100),
    createdFolder: z.object({ id: z.string().min(1).max(100), name: z.string().min(1).max(200) }).strict().optional(),
  }).strict(),
  /** Restore each problem's goal lists. */
  z.object({
    kind: z.literal('goal-lists'),
    problems: z.array(z.object({ frontendId: undoProblem, before: undoIds, after: undoIds }).strict()).min(1).max(100),
  }).strict(),
]);
export type ChatUndo = z.infer<typeof chatUndoSchema>;

/** Receipt of an applied change, as the change tool reported it. */
export interface ChatActionReceipt {
  result: Record<string, unknown>;
  /** Present when the change altered something; send it to `POST /api/v1/chat/actions/undo` to take it back. */
  undo?: ChatUndo;
}

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
  /** The model proposed a change; nothing is written until the user confirms it. */
  | { type: 'action'; action: ChatActionProposal }
  | { type: 'done'; provider: z.infer<typeof llmProviderSchema>; model: string }
  /** `error` is a stable code such as `CHAT_QUOTA`; `message` is an English fallback. */
  | { type: 'error'; error: string; message: string };

/** Whether chat can run, for enabling the composer without a request. */
export interface ChatStatus {
  configured: boolean;
  provider?: z.infer<typeof llmProviderSchema>;
  model: string;
}
