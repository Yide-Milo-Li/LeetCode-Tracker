/**
 * Shared tool registration: profile access per call, annotations, and coded
 * errors. Every tool module registers through this so the rules stay uniform.
 */
import { z } from 'zod';
import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import type { TrackerApplication } from '../../../packages/application/src/application.ts';
import { ApplicationError } from '../../../packages/application/src/errors.ts';
import { ProfileError, type TrackerProfile } from './profile.ts';

export const READ_TOOL_NAMES = [
  'tracker_status',
  'tracker_search_problems',
  'tracker_get_today',
  'tracker_list_practices',
  'tracker_list_notes',
  'tracker_get_progress',
  'tracker_get_strategies',
  'tracker_get_problems',
  'tracker_get_notes',
  'tracker_get_note_context',
  'tracker_catalog_coverage',
] as const;

export const WRITE_TOOL_NAMES = [
  'tracker_import_catalog',
  'tracker_update_practice',
  'tracker_revoke_practice',
  'tracker_create_strategy',
  'tracker_update_strategy',
  'tracker_create_today',
  'tracker_apply_today_rules',
  'tracker_create_practices',
  'tracker_patch_note',
  'tracker_save_notes',
  'tracker_edit_today',
  'tracker_export_notes',
  'tracker_import_problems',
] as const;

export const TOOL_NAMES = [...READ_TOOL_NAMES, ...WRITE_TOOL_NAMES] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

/**
 * read: short-lived read-only connection, no lease.
 * preview: like read, but an empty in-memory profile when none exists yet.
 * write: exclusive lease for the duration of the call.
 * export: reads the profile like read, but writes files outside it, so hosts
 *   still treat the tool as one that changes something.
 */
export type ToolAccess = 'read' | 'preview' | 'write' | 'export';

export interface WriteHints {
  /** The change removes or hides data the user may want back. */
  destructive: boolean;
  /** Repeating the same call (same operationId) has no additional effect. */
  idempotent: boolean;
}

/** Success payload; structuredContent is derived from the JSON text. */
export function json(value: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

/** A tool-level refusal that is not an exception, e.g. bad input the schema cannot express. */
export function refuse(code: string, message: string): ToolResult {
  return { isError: true, content: [{ type: 'text', text: `${code}: ${message}` }] };
}

/** Convert any failure into a coded tool error the model can explain to the user. */
function toolError(error: unknown): CallToolResult {
  let code = 'MCP_QUERY_FAILED';
  let message = 'The request failed. See the server log for details.';
  if (error instanceof ProfileError || error instanceof ApplicationError) {
    code = error.code;
    message = error.message;
    // Validation failures carry zod issues instead of a message.
    const issues = error instanceof ApplicationError ? error.details.issues : undefined;
    if (message === code && Array.isArray(issues)) {
      message = issues.map((issue: { path?: unknown[]; message?: string }) =>
        `${issue.path?.length ? `${issue.path.join('.')}: ` : ''}${issue.message ?? 'invalid'}`).join('; ');
    }
  } else {
    console.error('[leetcode-tracker-mcp] unexpected tool failure:', error);
  }
  return { isError: true, structuredContent: { error: code, message }, content: [{ type: 'text', text: `${code}: ${message}` }] };
}

export type Registrar = ReturnType<typeof createRegistrar>;

export function createRegistrar(rawServer: McpServer, profile: TrackerProfile) {
  function register<S extends z.ZodObject>(
    name: ToolName,
    config: { description: string; inputSchema: S },
    handler: (application: TrackerApplication, args: z.infer<S>) => Promise<ToolResult>,
    access: ToolAccess | ((args: z.infer<S>) => ToolAccess) = 'read',
    hints: WriteHints = { destructive: false, idempotent: false },
  ): void {
    const readOnly = access === 'read' || access === 'preview';
    const annotations = {
      readOnlyHint: readOnly,
      destructiveHint: !readOnly && hints.destructive,
      idempotentHint: readOnly || hints.idempotent,
      openWorldHint: false,
    };
    // Widen the schema so the SDK's conditional callback type resolves; args are validated by the SDK.
    const inputSchema: z.ZodObject = config.inputSchema;
    rawServer.registerTool(name, { description: config.description, inputSchema, annotations }, async (rawArgs: unknown): Promise<CallToolResult> => {
      try {
        const args = rawArgs as z.infer<S>;
        const run = (application: TrackerApplication) => handler(application, args);
        const mode = typeof access === 'function' ? access(args) : access;
        const result = await (mode === 'read' || mode === 'export' ? profile.read(run) : mode === 'preview' ? profile.preview(run) : profile.write(run));
        const text = result.content.find(item => item.type === 'text')?.text;
        if (!text || result.isError) {
          // Refusals carry "CODE: message" text; expose the code as structured content too.
          const match = text ? /^([A-Z][A-Z0-9_]+): (.*)$/s.exec(text) : null;
          return match ? { ...result, structuredContent: { error: match[1], message: match[2] } } : result;
        }
        return { ...result, structuredContent: JSON.parse(text) as Record<string, unknown> };
      } catch (error) {
        return toolError(error);
      }
    });
  }
  return { register, profile };
}
