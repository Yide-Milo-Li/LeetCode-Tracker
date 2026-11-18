import type { FastifyReply, FastifyRequest } from 'fastify';
import { ApplicationError, type ExportArtifact } from '../../../../packages/application/src/errors.ts';

function isArtifact(value: unknown): value is ExportArtifact {
  return !!value && typeof value === 'object' && 'kind' in value && value.kind === 'export';
}

/** Preserve the HTTP response envelope while shared operations own validation and persistence. */
export function applicationRoute(run: (request: FastifyRequest) => Promise<unknown>, status = 200) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const result = await run(request);
      reply.code(status);
      if (isArtifact(result)) {
        return reply.header('Content-Type', result.mediaType)
          .header('Content-Disposition', `attachment; filename="${result.filename}"`)
          .send(result.content);
      }
      return reply.send(result);
    } catch (error) {
      if (error instanceof ApplicationError) return reply.code(error.status).send(error.details);
      throw error;
    }
  };
}
