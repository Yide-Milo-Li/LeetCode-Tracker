/** Map business results and failures without owning mutable application state. */
import type { FastifyReply } from 'fastify';
import { ApplicationError, type ExportArtifact } from '../../../../packages/application/src/errors.ts';

function isArtifact(value: unknown): value is ExportArtifact {
  return !!value && typeof value === 'object' && 'kind' in value && value.kind === 'export';
}
export async function invokeApplication(reply: FastifyReply, operation: () => unknown, status = 200) {
  try {
    const result = await operation();
    if (isArtifact(result)) return reply.code(status)
      .header('Content-Type', result.mediaType)
      .header('Content-Disposition', `attachment; filename="${result.filename}"`).send(result.content);
    return reply.code(status).send(result);
  } catch (error) {
    if (error instanceof ApplicationError) return reply.code(error.status).send(error.details);
    throw error;
  }
}
