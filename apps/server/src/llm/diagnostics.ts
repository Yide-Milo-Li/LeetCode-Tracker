/** Bounded profile-local diagnostics. Persist allowlisted measurements, never request content. */
import { mkdir, open, writeFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { LLMUsage } from './usage.ts';

import type { DiagnosticSink } from '../../../../packages/application/src/telemetry.ts';
export type { LLMTrace, SelectionTrace, DiagnosticTrace, DiagnosticSink } from '../../../../packages/application/src/telemetry.ts';
export { emitDiagnostic } from '../../../../packages/application/src/telemetry.ts';
export const DIAGNOSTIC_RETENTION_DAYS = 30;
export const DIAGNOSTIC_MAX_BYTES = 5 * 1024 * 1024;

/** Serialize writes; failure is isolated from business operations and future writes. */
export function createDiagnosticSink(profileDirectory: string, maxBytes = DIAGNOSTIC_MAX_BYTES): DiagnosticSink {
  const directory = path.join(profileDirectory, 'diagnostics'), target = path.join(directory, 'llm-usage.jsonl');
  const byteLimit = Math.max(1, Math.min(DIAGNOSTIC_MAX_BYTES, Math.floor(maxBytes) || DIAGNOSTIC_MAX_BYTES));
  const safeUsage = (usage: LLMUsage) => ({ inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
    cachedInputTokens: usage.cachedInputTokens, reasoningTokens: usage.reasoningTokens,
    totalTokens: usage.totalTokens, source: usage.source });
  let queue = Promise.resolve();
  return trace => {
    const common = { version: 1, at: trace.at, purpose: trace.purpose, elapsedMs: Math.max(0, trace.elapsedMs) };
    // Construct a new object: extra fields supplied by a caller can never reach disk.
    const safe = 'usage' in trace ? { ...common, operationId: trace.operationId, attempt: trace.attempt,
      provider: trace.provider, model: trace.model.slice(0, 128), status: trace.status,
      usage: safeUsage(trace.usage), ...(trace.operationUsage ? { operationUsage: safeUsage(trace.operationUsage) } : {}) }
      : { ...common, reason: trace.reason, candidateCount: trace.candidateCount, choiceGroups: trace.choiceGroups,
        membershipChanged: trace.membershipChanged, orderChanged: trace.orderChanged };
    queue = queue.then(async () => {
      await mkdir(directory, { recursive: true });
      let prior = '';
      try {
        const handle = await open(target, 'r');
        try {
          const size = (await handle.stat()).size, offset = Math.max(0, size - byteLimit);
          const buffer = Buffer.alloc(Math.min(size, byteLimit));
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
          prior = buffer.subarray(0, bytesRead).toString('utf8');
          if (offset > 0) prior = prior.slice(prior.indexOf('\n') + 1);
        } finally { await handle.close(); }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const cutoff = trace.at - DIAGNOSTIC_RETENTION_DAYS * 86_400_000;
      const lines = prior.split('\n').filter(line => { try { return JSON.parse(line).at >= cutoff; } catch { return false; } });
      lines.push(JSON.stringify(safe));
      let bytes = lines.reduce((n, line) => n + Buffer.byteLength(line) + 1, 0);
      while (bytes > byteLimit && lines.length) bytes -= Buffer.byteLength(lines.shift()!) + 1;
      const temporary = target + '.' + randomUUID() + '.tmp';
      try {
        await writeFile(temporary, lines.length ? lines.join('\n') + '\n' : '', 'utf8');
        await rename(temporary, target);
      } finally { await rm(temporary, { force: true }).catch(() => {}); }
    }).catch(() => {});
    return queue;
  };
}
