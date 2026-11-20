/**
 * Shared tool registration: profile access per call, annotations, and coded
 * errors. Every tool module registers through this so the rules stay uniform.
 */
import { z } from 'zod';
import type { TrackerApplication } from '../../../packages/application/src/application.ts';
import { ApplicationError } from '../../../packages/application/src/errors.ts';
import { ProfileError } from './profile-error.ts';
import type { TrackerProfile } from './profile.ts';
import { DESKTOP_AGENT_PROTOCOL, type AgentResult } from '../../../packages/contracts/src/desktop-agent.ts';
import { forwardDesktopWrite } from './desktop-agent-client.ts';

export const READ_TOOL_NAMES = [
  'tracker_status',
  'tracker_search_problems',
  'tracker_get_today',
  'tracker_get_study_plan',
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
  'tracker_save_strategy',
  'tracker_create_today',
  'tracker_create_study_plan',
  'tracker_update_study_plan',
  'tracker_apply_today_rules',
  'tracker_create_practices',
  'tracker_patch_note',
  'tracker_save_notes',
  'tracker_edit_today',
  'tracker_export_notes',
  'tracker_import_problems',
  'tracker_delete_strategy',
  'tracker_set_timezone',
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
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

/** A tool-level refusal that is not an exception, e.g. bad input the schema cannot express. */
export function refuse(code: string, message: string): ToolResult {
  return { isError: true, content: [{ type: 'text', text: `${code}: ${message}` }] };
}

/** Convert any failure into a coded tool error the model can explain to the user. */
export function toolError(error: unknown): AgentResult {
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

function stripSchemaNoise(node: unknown): unknown {
  if (!node || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map(stripSchemaNoise);
  const out: Record<string, unknown> = {};
  const record = node as Record<string, unknown>;
  const isUuid = record.format === 'uuid';
  for (const [key, value] of Object.entries(record)) {
    if (key === '$schema') continue;
    if (key === 'maximum' && value === Number.MAX_SAFE_INTEGER) continue;
    if (isUuid && (key === 'pattern' || key === 'format')) continue;
    out[key] = stripSchemaNoise(value);
  }
  return out;
}

/**
 * Strip repetitive JSON Schema boilerplate ($schema, MAX_SAFE_INTEGER bounds,
 * and Zod's 170-char UUID regex) from tools/list while keeping runtime Zod
 * validation untouched.
 */
function compactInputSchema<S extends z.ZodObject>(schema: S): z.ZodObject {
  const std = schema['~standard'] as unknown as {
    jsonSchema?: {
      input: (opts: unknown) => unknown;
      output: (opts: unknown) => unknown;
    };
    [key: string]: unknown;
  };
  if (!std.jsonSchema) return schema;
  const originalJsonSchema = std.jsonSchema;
  return Object.create(schema, {
    '~standard': {
      value: {
        ...std,
        jsonSchema: {
          input: (opts: unknown) => stripSchemaNoise(originalJsonSchema.input(opts)),
          output: (opts: unknown) => stripSchemaNoise(originalJsonSchema.output(opts)),
        },
      },
    },
  }) as z.ZodObject;
}

type PreparedArgs = Record<string, unknown>;
type ToolAnnotations = {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
};

export interface RegisteredTool {
  name: ToolName;
  description: string;
  inputSchema: z.ZodObject;
  annotations: ToolAnnotations;
  prepare: (args: unknown) => Promise<PreparedArgs>;
  access: (args: PreparedArgs) => ToolAccess;
  invoke: (application: TrackerApplication, args: PreparedArgs) => Promise<AgentResult>;
}

export type Registrar = ReturnType<typeof createRegistrar>;
type ProfileContext = Pick<TrackerProfile, 'exists' | 'location'>;

export function createRegistrar(profile: ProfileContext) {
  const tools = new Map<string, RegisteredTool>();
  function register<S extends z.ZodObject, P extends z.ZodObject = S>(
    name: ToolName,
    config: {
      description: string;
      inputSchema: S;
      prepare?: { schema: P; map: (input: z.infer<S>) => Promise<z.input<P>> };
    },
    handler: (application: TrackerApplication, args: z.infer<NoInfer<P>>) => Promise<ToolResult>,
    access: ToolAccess | ((args: z.infer<NoInfer<P>>) => ToolAccess) = 'read',
    hints: WriteHints = { destructive: false, idempotent: false },
  ): void {
    const readOnly = access === 'read' || access === 'preview';
    const preparedSchema = config.prepare?.schema ?? config.inputSchema;
    const parse = (schema: z.ZodObject, input: unknown): PreparedArgs => {
      const parsed = schema.safeParse(input);
      if (parsed.success) return parsed.data;
      throw new ProfileError('INVALID_INPUT', parsed.error.issues.map(issue =>
        [issue.path.join('.'), issue.message].filter(Boolean).join(': ')).join('; '));
    };
    tools.set(name, {
      name,
      description: config.description,
      inputSchema: compactInputSchema(config.inputSchema),
      annotations: {
        readOnlyHint: readOnly,
        destructiveHint: !readOnly && hints.destructive,
        idempotentHint: readOnly || hints.idempotent,
        openWorldHint: false,
      },
      prepare: async (input) => {
        const args = parse(config.inputSchema, input);
        return config.prepare ? await config.prepare.map(args as z.infer<S>) as PreparedArgs : args;
      },
      access: (args) => {
        const parsed = parse(preparedSchema, args) as z.infer<P>;
        return typeof access === 'function' ? access(parsed) : access;
      },
      invoke: async (application, args) => {
        const result = await handler(application, parse(preparedSchema, args) as z.infer<P>);
        const text = result.content.find(item => item.type === 'text')?.text;
        if (!text || result.isError) {
          const match = text ? /^([A-Z][A-Z0-9_]+): (.*)$/s.exec(text) : null;
          return match ? { ...result, structuredContent: { error: match[1], message: match[2] } } : result;
        }
        return { ...result, structuredContent: JSON.parse(text) as Record<string, unknown> };
      },
    });
  }
  return { register, profile, tools };
}

export async function callTrackerTool(tool: RegisteredTool, profile: TrackerProfile, input: unknown): Promise<AgentResult> {
  try {
    const args = await tool.prepare(input);
    const run = (application: TrackerApplication) => tool.invoke(application, args);
    const mode = tool.access(args);
    if (mode === 'read' || mode === 'export') return await profile.read(run);
    if (mode === 'preview') return await profile.preview(run);
    try { return await profile.write(run); }
    catch (error) {
      if (!(error instanceof ProfileError) || error.code !== 'PROFILE_IN_USE') throw error;
    }
    const forwarded = await forwardDesktopWrite(profile.location.dbPath, { version: DESKTOP_AGENT_PROTOCOL, name: tool.name, args });
    // If the owner stopped before dispatch, retry ownership once.
    return forwarded ?? await profile.write(run);
  } catch (error) {
    return toolError(error);
  }
}
