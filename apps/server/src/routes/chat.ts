/**
 * In-app AI chat routes.
 *
 * `POST /api/v1/chat/stream` answers with Server-Sent Events. Invalid input and a missing
 * provider are rejected with an ordinary JSON error before the stream opens; failures after
 * that arrive as an `error` event on a `200` stream.
 *
 * The stream can apply changes with full access. `POST /api/v1/chat/actions` applies one change
 * the user confirmed, and `POST /api/v1/chat/actions/undo` can take either kind of change back.
 */
import type { FastifyInstance } from 'fastify';
import { chatActionRequestSchema, chatRequestSchema, chatUndoSchema, type ChatStreamEvent } from '../../../../packages/contracts/src/chat.ts';
import { ChatActionError } from '../chat/chat-service.ts';
import type { RouteContext } from './types.ts';

/** Ample for the capped conversation in any encoding, far below the catalog import limit. */
const CHAT_BODY_LIMIT = 1024 * 1024;

export function registerChatRoutes(app: FastifyInstance, { chat }: RouteContext): void {
  app.get('/api/v1/chat/status', async () => chat.status());

  app.post('/api/v1/chat/stream', { bodyLimit: CHAT_BODY_LIMIT }, async (request, reply) => {
    const parsed = chatRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'INVALID_CHAT_REQUEST',
        message: parsed.error.issues.map(issue => [issue.path.join('.'), issue.message].filter(Boolean).join(': ')).join('; '),
      });
    }
    if (!chat.status().configured) {
      return reply.code(503).send({ error: 'CHAT_NOT_CONFIGURED', message: 'Configure an AI provider in Settings.' });
    }

    // Stop the provider request when the reader goes away; a finished response also closes.
    const controller = new AbortController();
    reply.raw.on('close', () => { if (!reply.raw.writableEnded) controller.abort(); });

    // Fastify must not buffer or serialize: each event is flushed as it is produced.
    reply.hijack();
    // Headers set by earlier hooks (CORS) are not applied to a hijacked reply automatically.
    for (const [name, value] of Object.entries(reply.getHeaders())) {
      if (value !== undefined) reply.raw.setHeader(name, value);
    }
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
    });
    const emit = (event: ChatStreamEvent) => {
      if (!reply.raw.writableEnded && !reply.raw.destroyed) reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    await chat.stream(parsed.data, emit, controller.signal);
    reply.raw.end();
  });

  app.post('/api/v1/chat/actions', { bodyLimit: CHAT_BODY_LIMIT }, async (request, reply) => {
    const parsed = chatActionRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'INVALID_CHAT_ACTION', message: 'Expected a change name and its arguments.' });
    }
    try {
      return await chat.apply(parsed.data);
    } catch (error) {
      if (!(error instanceof ChatActionError)) throw error;
      return reply.code(error.status).send({ error: error.code, message: error.message });
    }
  });

  app.post('/api/v1/chat/actions/undo', { bodyLimit: CHAT_BODY_LIMIT }, async (request, reply) => {
    const parsed = chatUndoSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'INVALID_CHAT_ACTION', message: 'Expected the undo details of an applied change.' });
    }
    try {
      return await chat.undo(parsed.data);
    } catch (error) {
      if (!(error instanceof ChatActionError)) throw error;
      return reply.code(error.status).send({ error: error.code, message: error.message });
    }
  });
}
