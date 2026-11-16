/** Explicit formal and lab adapters preserve business objects and durable operation identities. */
import { z } from 'zod';
import { createHttpTrackerClient } from '../client-http-adapter.ts';
import {
  ApiError,
  OperationStateError,
  type WorkspaceOperationState,
  type WorkspaceOperationStatus,
} from '../client.ts';
import type { WorkspaceHost } from '../host.ts';
import { problemNoteSchema, problemNoteSummarySchema } from '../../../contracts/src/notes.ts';
import { practiceRecordSchema } from '../../../contracts/src/practice.ts';
import type { DailyPlan } from '../../../contracts/src/recommendations.ts';
import { rulesSchema } from '../../../contracts/src/recommendations.ts';
import { catalogProblemSchema } from '../../../contracts/src/sync.ts';
import {
  workspaceDraftSchema,
  type WorkspaceDraftState,
} from '../../../contracts/src/agent-operations.ts';

export interface ToolResult {
  isError?: boolean;
  structuredContent?: unknown;
  content?: unknown[];
  _meta?: Record<string, unknown>;
}
export type CallTool = (name: string, args: Record<string, unknown>) => Promise<ToolResult>;
export type ToolProtocol = 'formal' | 'experimental';
const object = z.record(z.string(), z.unknown());
async function requestHash(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((v) => v.toString(16).padStart(2, '0')).join('');
}
function record(value: unknown): Record<string, unknown> {
  return object.parse(value);
}
function plan(value: unknown): DailyPlan {
  const parsed = record(value);
  const bilingual = z.object({ en: z.string(), zh: z.string() });
  z.object({
    id: z.string().min(1),
    date: z.string(),
    timezone: z.string(),
    version: z.number().int().positive(),
    strategyId: z.string().nullable(),
    strategyVersion: z.number().int().positive().nullable(),
    rules: rulesSchema,
    items: z.array(
      z.object({
        id: z.string(),
        completed: z.boolean(),
        problem: catalogProblemSchema.passthrough(),
        kind: z.enum(['new', 'review']),
        addedAt: z.number(),
        reason: bilingual,
        evidenceIds: z.array(z.string()),
      }),
    ),
    source: z.enum(['local', 'gemini', 'openai', 'deepseek']),
    model: z.string().nullable(),
    encouragement: bilingual,
    notices: z.array(bilingual),
    catalogRevision: z.number().int(),
    practiceRevision: z.number().int(),
    planningRevision: z.number().int(),
    algorithmVersion: z.string(),
    createdAt: z.number(),
    updatedAt: z.number(),
    action: z.string(),
  }).parse(parsed);
  return parsed as unknown as DailyPlan;
}
function detail(result: ToolResult): Record<string, unknown> {
  let value = result.structuredContent;
  if (value === undefined) {
    const block = result.content?.find(
      (item) => typeof item === 'object' && item !== null && 'type' in item && item.type === 'text',
    );
    if (
      typeof block === 'object' &&
      block !== null &&
      'text' in block &&
      typeof block.text === 'string'
    ) {
      try {
        value = JSON.parse(block.text);
      } catch {
        value = { error: block.text };
      }
    }
  }
  return record(value);
}
const statuses = z.enum(['pending', 'applied', 'rejected', 'cancelled', 'expired', 'failed']);
type Intent = {
  name: string;
  args: Record<string, unknown>;
  target: string;
  kind: 'note' | 'plan' | 'create' | 'practice';
  requestKey: string;
  state: WorkspaceOperationState;
  receipt?: Record<string, unknown>;
  running?: Promise<unknown>;
};

/** Formal failures never fall back to a tool with different authorization or result semantics. */
export function createToolTrackerClient(
  call: CallTool,
  host: WorkspaceHost,
  protocol: ToolProtocol = 'formal',
) {
  const plans = new Map<string, DailyPlan>();
  const planGenerations = new Map<string, number>();
  // UI metadata supplies a read stamp without changing strict business-object schemas.
  const queryGenerations = new WeakMap<object, number>();
  const readGenerations = new WeakMap<object, number>();
  const practiceGenerations = new Map<string, number>();
  const problemGenerations = new Map<string, number>();
  const intents = new Map<string, Intent>();
  const previews = new Map<
    string,
    {
      rules: unknown;
      planId: string;
      version: number | null;
      date: string;
      generation: number;
    }
  >();
  const journals = new Map<string, number>();
  const handles = () =>
    Array.isArray(host.recoveryState().operations)
      ? (host.recoveryState().operations as string[])
      : [];
  const saveHandles = (ids: string[]) =>
    host.saveRecoveryState({ ...host.recoveryState(), operations: ids });
  const settle = (intent: Intent) => {
    intents.delete(intent.target);
    if (host.capabilities.durableDrafts) {
      const id = String(intent.args.operationId);
      saveHandles(handles().filter((value) => value !== id));
      void drafts.delete('recovery', id, journals.get(id) ?? 0).catch(() => {});
    }
    http.forgetOperation(String(intent.args.operationId));
  };
  const emit = (intent: Intent, status: WorkspaceOperationStatus, data?: unknown) => {
    intent.state = {
      operationId: String(intent.args.operationId),
      target: intent.target,
      status,
      preview: intent.state.preview,
      submittedContent: typeof intent.args.content === 'string' ? intent.args.content : undefined,
      ...(data !== undefined ? { data } : {}),
    };
    host.emit({ type: 'operation', operation: intent.state });
  };
  async function invoke(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ result: ToolResult; data: Record<string, unknown> }> {
    const result = await call(name, args),
      data = detail(result);
    if (result.isError && !('status' in data && statuses.safeParse(data.status).success)) {
      throw new ApiError(
        typeof data.status === 'number' ? data.status : 500,
        String(data.error ?? 'HOST_TOOL_FAILED'),
        String(data.message ?? data.error ?? 'Host tool failed'),
      );
    }
    return { result, data };
  }
  /** Draft bodies never enter widget state or model-visible tool results. */
  async function draftCall(
    action: string,
    type: string,
    id: string,
    extra: Record<string, unknown> = {},
  ): Promise<WorkspaceDraftState> {
    const { result } = await invoke('tracker_workspace_draft', {
      action,
      entityType: type,
      entityId: id,
      workspaceInstanceId: host.id,
      ...extra,
    });
    const data = record(record(result._meta?.workspace).data);
    return {
      revision: z.number().int().nonnegative().parse(data.revision),
      draft: data.draft ? workspaceDraftSchema.parse(data.draft) : null,
    };
  }
  const drafts = {
    get: (type: 'note' | 'practice' | 'recovery', id: string) => draftCall('get', type, id),
    set: (
      type: 'note' | 'practice' | 'recovery',
      id: string,
      content: string,
      revision: number,
      baseRevision: number,
      generation: number,
    ) =>
      draftCall('set', type, id, {
        draftContent: content,
        expectedDraftRevision: revision,
        baseRevision,
        libraryGeneration: generation,
      }),
    delete: (type: 'note' | 'practice' | 'recovery', id: string, revision: number) =>
      draftCall('delete', type, id, { expectedDraftRevision: revision }),
  };
  async function query(
    kind: string,
    args: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    const names: Record<string, string> = {
      preferences: 'tracker_preferences',
      business_versions: 'tracker_business_versions',
      strategies: 'tracker_strategies',
      today: 'tracker_today',
      notes: 'tracker_notes',
      note: 'tracker_note',
      practices: 'tracker_practices',
    };
    if (protocol === 'experimental' && !names[kind])
      throw new ApiError(403, 'HOST_CAPABILITY_UNAVAILABLE', `Unsupported lab query: ${kind}`);
    const { result, data } = await invoke(
      protocol === 'formal' ? 'tracker_workspace_query' : names[kind],
      protocol === 'formal' ? { kind, ...args } : args,
    );
    const workspace = result._meta?.workspace;
    const generation =
      protocol === 'formal'
        ? z.number().int().positive().parse(record(workspace).libraryGeneration)
        : undefined;
    const value = protocol === 'formal' ? record(workspace).data : data.data;
    const payload = record(value);
    if (kind === 'note')
      z.object({
        note: problemNoteSchema.nullable(),
        libraryGeneration: z.number().int().positive(),
      }).parse(payload);
    else if (kind === 'practice') practiceRecordSchema.parse(payload);
    else if (kind === 'notes')
      z.object({
        items: z.array(problemNoteSummarySchema),
        total: z.number().int().nonnegative(),
      }).parse(payload);
    else if (kind === 'practices')
      z.object({
        items: z.array(practiceRecordSchema),
        total: z.number().int().nonnegative(),
      }).parse(payload);
    else if (kind === 'today' || kind === 'plan_versions') {
      for (const item of z.array(z.unknown()).parse(payload.items)) {
        const parsed = plan(item);
        // History is read-only: only the current-plan query establishes an editing baseline.
        if (kind === 'today') {
          plans.set(parsed.id, parsed);
          if (generation !== undefined)
            for (const item of parsed.items) {
              problemGenerations.set(item.problem.questionFrontendId, generation);
              readGenerations.set(item.problem, generation);
            }
          if (generation !== undefined) planGenerations.set(parsed.id, generation);
        }
      }
    } else if (kind === 'business_versions')
      z.object({
        libraryGeneration: z.number().int().positive(),
        today: z.string(),
        timezone: z.string(),
      }).parse(payload);
    else if (kind === 'preferences')
      z.object({
        timezone: z.string().nullable(),
        language: z.enum(['en', 'zh']),
        theme: z.enum(['light', 'dark', 'system']),
        palette: z.string(),
      }).parse(payload);
    else if (kind === 'strategies')
      z.object({
        items: z.array(
          z.object({
            id: z.string(),
            version: z.number().int().positive(),
            name: z.string(),
            rules: rulesSchema,
          }),
        ),
      }).parse(payload);
    else if (kind === 'progress')
      z.object({ overview: object, yearlyActivity: object }).parse(payload);
    if (generation !== undefined) queryGenerations.set(payload, generation);
    if (generation !== undefined && kind === 'practices')
      for (const item of payload.items as { id: string }[]) {
        practiceGenerations.set(item.id, generation);
        readGenerations.set(item, generation);
      }
    if (generation !== undefined && kind === 'practice') {
      practiceGenerations.set(String(payload.id), generation);
      readGenerations.set(payload, generation);
    }
    if (generation !== undefined && kind === 'problem' && payload.problem)
      problemGenerations.set(
        catalogProblemSchema.parse(payload.problem).questionFrontendId,
        generation,
      );
    if (generation !== undefined && kind === 'catalog')
      for (const item of payload.items as import('../../../contracts/src/sync.ts').CatalogProblem[]) {
        catalogProblemSchema.parse(item);
        problemGenerations.set(item.questionFrontendId, generation);
        readGenerations.set(item, generation);
      }
    return payload;
  }
  /** Hydration must agree with the receipt; later external edits cannot be labelled as this save. */
  async function hydrate(intent: Intent): Promise<unknown> {
    const receipt = intent.receipt!;
    const versions = await query('business_versions');
    if (versions.libraryGeneration !== receipt.libraryGeneration) {
      emit(intent, 'external_change');
      throw new OperationStateError(intent.state);
    }
    if (intent.kind === 'note') {
      const result = await query('note', {
        frontendId: intent.args.frontendId,
      });
      const note = result.note ? problemNoteSchema.parse(result.note) : null;
      if (
        !note ||
        note.revision !== receipt.revision ||
        note.libraryGeneration !== receipt.libraryGeneration ||
        result.libraryGeneration !== receipt.libraryGeneration ||
        queryGenerations.get(result) !== receipt.libraryGeneration ||
        note.content !== intent.args.content
      ) {
        emit(intent, 'external_change');
        throw new OperationStateError(intent.state);
      }
      return { note };
    }
    if (intent.kind === 'practice') {
      const result = await query('practice', {
        practiceId: receipt.recordId ?? receipt.id,
      });
      if (
        result.revision !== receipt.revision ||
        queryGenerations.get(result) !== receipt.libraryGeneration
      ) {
        emit(intent, 'external_change');
        throw new OperationStateError(intent.state);
      }
      const parsed = practiceRecordSchema.parse(result);
      readGenerations.set(parsed, queryGenerations.get(result)!);
      return parsed;
    }
    const result = await query('today', {
      date: receipt.date ?? intent.args.date,
    });
    const current = result.plan ? plan(result.plan) : null;
    if (
      !current ||
      current.id !== receipt.planId ||
      current.version !== receipt.version ||
      queryGenerations.get(result) !== receipt.libraryGeneration
    ) {
      emit(intent, 'external_change');
      throw new OperationStateError(intent.state);
    }
    return intent.kind === 'create' ? { status: 'ready', plan: current } : current;
  }
  async function finish(intent: Intent): Promise<unknown> {
    try {
      const data = await hydrate(intent);
      emit(intent, 'applied', data);
      settle(intent);
      host.emit({ type: 'refresh' });
      return data;
    } catch (error) {
      if (error instanceof OperationStateError) {
        settle(intent);
        throw error;
      }
      emit(intent, 'applied_refresh_required');
      throw new OperationStateError(intent.state);
    }
  }
  async function accept(intent: Intent, data: Record<string, unknown>): Promise<unknown> {
    const status = statuses.parse(data.status);
    intent.state.preview = data.preview;
    if (status === 'applied') {
      intent.receipt = data;
      return finish(intent);
    }
    emit(intent, status);
    if (status !== 'pending') settle(intent);
    throw new OperationStateError(intent.state);
  }
  async function recover(intent: Intent): Promise<unknown> {
    if (intent.receipt) return finish(intent);
    const { data } = await invoke('tracker_get_operation', {
      operationId: intent.args.operationId,
    });
    if (data.found === false) {
      if (intent.state.status === 'unknown')
        return accept(intent, (await invoke(intent.name, intent.args)).data);
      emit(intent, 'expired');
      settle(intent);
      throw new OperationStateError(intent.state);
    }
    return accept(intent, {
      ...record(data.result ?? {}),
      status: data.status,
      operationId: intent.args.operationId,
      preview: intent.state.preview,
    });
  }
  async function execute(intent: Intent, resumed: boolean): Promise<unknown> {
    try {
      return resumed
        ? await recover(intent)
        : await accept(intent, (await invoke(intent.name, intent.args)).data);
    } catch (error) {
      if (error instanceof OperationStateError) throw error;
      // A failed status lookup does not establish whether the original write committed.
      if (!resumed && error instanceof ApiError && error.status >= 400 && error.status < 500 && !error.code.startsWith('MCP_')) {
        emit(intent, 'failed');
        settle(intent);
        throw new OperationStateError(intent.state);
      }
      emit(intent, 'unknown');
      throw new OperationStateError(intent.state);
    }
  }
  async function mutate(
    name: string,
    args: Record<string, unknown>,
    target: string,
    kind: Intent['kind'],
    requestKey: string,
  ): Promise<unknown> {
    let intent = intents.get(target);
    if (intent && intent.requestKey !== requestKey) throw new OperationStateError(intent.state);
    const resumed = Boolean(intent);
    if (!intent) {
      const operationId =
        typeof args.operationId === 'string' ? args.operationId : crypto.randomUUID();
      intent = {
        name,
        args: { ...args, operationId },
        target,
        kind,
        requestKey,
        state: { operationId, target, status: 'unknown' },
      };
      intents.set(target, intent);
    }
    if (!intent.running) {
      const current = intent;
      // Install the shared promise before any await so two clicks cannot race journal persistence.
      const running = (async () => {
        // Until preflight and the journal both succeed, no recoverable intent may be admitted.
        try {
          if (!resumed && kind === 'practice') {
            const versions = await query('business_versions');
            const observed = current.args.expectedLibraryGeneration ?? (current.args.practiceId
              ? practiceGenerations.get(String(current.args.practiceId))
              : problemGenerations.get(String(current.args.questionFrontendId)));
            if (observed !== undefined && observed !== versions.libraryGeneration) {
              throw new ApiError(
                409,
                'LIBRARY_GENERATION_MISMATCH',
                'Reload the practice after a library change.',
              );
            }
            current.args.expectedLibraryGeneration = observed ?? versions.libraryGeneration;
          }
          if (!resumed && host.capabilities.durableDrafts) {
            const operationId = String(current.args.operationId);
            const versions = await query('business_versions');
            const saved = await drafts.set(
              'recovery',
              operationId,
              JSON.stringify({
                name: current.name,
                args: current.args,
                target,
                kind,
                requestKey: current.requestKey,
              }),
              0,
              0,
              Number(versions.libraryGeneration),
            );
            journals.set(operationId, saved.revision);
            saveHandles([...handles(), operationId]);
          }
        } catch (error) {
          if (intents.get(target) === current) intents.delete(target);
          throw error;
        }
        return execute(current, resumed);
      })();
      intent.running = running;
      void running
        .finally(() => {
          if (intent!.running === running) intent!.running = undefined;
        })
        .catch(() => {});
    }
    return intent.running;
  }
  const http = createHttpTrackerClient({
    baseUrl: '',
    exportDataFile: async () => {
      throw new ApiError(403, 'HOST_CAPABILITY_UNAVAILABLE', 'Exports are unavailable');
    },
    request: async <T>(path: string, options?: RequestInit): Promise<T> => {
      const url = new URL(path, 'http://workspace.invalid'),
        method = options?.method ?? 'GET';
      const args: Record<string, unknown> = Object.fromEntries(url.searchParams);
      for (const field of ['page', 'limit', 'year', 'expectedRevision', 'expectedLibraryGeneration'])
        if (args[field] !== undefined) {
          if (!/^\d+$/.test(String(args[field])))
            throw new ApiError(400, 'INVALID_INPUT', `Invalid ${field}`);
          args[field] = Number(args[field]);
        }
      const body = options?.body ? record(JSON.parse(String(options.body))) : {};
      const key = await requestHash(
        JSON.stringify([
          path,
          method,
          Object.fromEntries(Object.entries(body).filter(([k]) => k !== 'operationId')),
        ]),
      );
      const p = url.pathname;
      const existing =
        method === 'GET'
          ? undefined
          : [...intents.values()].find((intent) => intent.requestKey === key);
      if (existing)
        return (await mutate(
          existing.name,
          existing.args,
          existing.target,
          existing.kind,
          key,
        )) as T;
      let result: unknown;
      if (method === 'GET') {
        if (p === '/settings') result = await query('preferences');
        else if (p === '/catalog') result = await query('catalog', args);
        else if (/^\/progress-snapshots\/[^/]+\/history$/.test(p))
          result = await query('snapshot_history', {
            questionId: decodeURIComponent(p.split('/')[2]),
          });
        else if (p === '/business/versions') result = await query('business_versions');
        else if (p === '/strategies') result = await query('strategies');
        else if (p === '/daily-plans') result = await query('today', args);
        else if (/^\/daily-plans\/[^/]+\/versions$/.test(p))
          result = await query('plan_versions', {
            planId: decodeURIComponent(p.split('/')[2]),
          });
        else if (p === '/notes') result = await query('notes', args);
        else if (p.startsWith('/notes/'))
          result = await query('note', {
            frontendId: decodeURIComponent(p.slice(7)),
          });
        else if (p === '/practice-records') result = await query('practices', args);
        else if (p.startsWith('/practice-records/'))
          result = await query('practice', {
            practiceId: decodeURIComponent(p.slice(18)),
          });
        else if (p === '/dashboard') result = await query('progress', args);
        else
          throw new ApiError(403, 'HOST_CAPABILITY_UNAVAILABLE', `Unsupported host action: ${p}`);
      } else if (protocol === 'experimental') {
        let name: string, input: Record<string, unknown>;
        if (p.startsWith('/notes/') && method === 'PUT') {
          name = 'tracker_save_note';
          input = { ...body, frontendId: decodeURIComponent(p.slice(7)) };
        } else if (/^\/daily-plans\/[^/]+\/append$/.test(p)) {
          name = 'tracker_append';
          input = { ...body, planId: p.split('/')[2] };
        } else
          throw new ApiError(403, 'HOST_CAPABILITY_UNAVAILABLE', `Unsupported lab action: ${p}`);
        result = (await invoke(name, input)).data.data;
        host.emit({ type: 'refresh' });
      } else if (p === '/daily-plans/ensure' || p === '/daily-plans') {
        const versions = await query('business_versions');
        if (body.timezone !== undefined && body.timezone !== versions.timezone)
          throw new ApiError(400, 'INVALID_INPUT', 'Use the configured workspace timezone.');
        result = await mutate(
          'tracker_create_today',
          {
            ...body,
            date: body.date ?? versions.today,
            expectedLibraryGeneration: versions.libraryGeneration,
          },
          'plan:create',
          'create',
          key,
        );
      } else if (p.startsWith('/notes/') && method === 'PUT') {
        const frontendId = decodeURIComponent(p.slice(7));
        result = await mutate(
          'tracker_save_note',
          { ...body, frontendId },
          `note:${frontendId}`,
          'note',
          key,
        );
      } else if (p.startsWith('/practice-records')) {
        const id = decodeURIComponent(p.slice(18));
        const name =
          p === '/practice-records'
            ? 'tracker_create_practice'
            : method === 'DELETE'
              ? 'tracker_revoke_practice'
              : 'tracker_update_practice';
        const target =
          p === '/practice-records' ? `practice:new:${body.questionFrontendId}` : `practice:${id}`;
        result = await mutate(
          name,
          { ...args, ...body, ...(id ? { practiceId: id } : {}) },
          target,
          'practice',
          key,
        );
      } else if (/^\/daily-plans\/[^/]+\/(append|remove-item|replace|rules|override)$/.test(p)) {
        const id = decodeURIComponent(p.split('/')[2]);
        let current = plans.get(id);
        if (!current) {
          await query('today');
          current = plans.get(id);
        }
        if (!current || current.version !== body.expectedVersion)
          throw new ApiError(409, 'STALE_PLAN', 'Reload the plan before editing.');
        const versions = await query('business_versions');
        const generation = planGenerations.get(id);
        if (generation !== versions.libraryGeneration)
          throw new ApiError(
            409,
            'LIBRARY_GENERATION_MISMATCH',
            'Reload the plan after a library change.',
          );
        const input: Record<string, unknown> = {
          operationId: body.operationId,
          expectedPlanId: id,
          expectedVersion: current.version,
          date: current.date,
          expectedLibraryGeneration: generation,
        };
        const action = p.split('/')[3];
        const targetItem = current.items.find((i) => i.id === body.itemId);
        let name = 'tracker_append_today';
        if (action === 'remove-item') {
          if (!targetItem) throw new ApiError(409, 'ITEM_NOT_FOUND', 'Reload the plan item.');
          name = 'tracker_remove_today_item';
          input.frontendQuestionId = targetItem.problem.questionFrontendId;
          input.cascadeRevokePractice = body.cascadeRevokePractice ?? false;
        } else if (action === 'replace') {
          name = 'tracker_replace_today_items';
          const items =
            body.mode === 'all_unfinished'
              ? current.items.filter((i) => !i.completed)
              : targetItem
                ? [targetItem]
                : [];
          if (!items.length) throw new ApiError(409, 'ITEM_NOT_FOUND', 'Reload the plan items.');
          input.targetFrontendQuestionIds = items.map((i) => i.problem.questionFrontendId);
          input.mode = body.mode;
        } else if (action === 'rules' || action === 'override') {
          name = 'tracker_apply_today_rules';
          Object.assign(input, record(body.rules ?? {}));
        }
        result = await mutate(name, input, `plan:${id}`, 'plan', key);
      } else if (p === '/daily-plan-overrides/preview') {
        if (typeof body.prompt === 'string' && body.prompt.trim())
          throw new ApiError(
            403,
            'HOST_CAPABILITY_UNAVAILABLE',
            'Use structured rule controls in this host.',
          );
        const versions = await query('business_versions');
        const today = await query('today', {
          date: body.date ?? versions.today,
        });
        const current = today.plan ? plan(today.plan) : null;
        if (!current)
          throw new ApiError(
            403,
            'HOST_CAPABILITY_UNAVAILABLE',
            'Create today before changing its rules.',
          );
        const { result: toolResult, data } = await invoke(
          'tracker_preview_today_rules',
          record(body.rules ?? {}),
        );
        const preview = z
          .object({
            id: z.string().uuid(),
            date: z.string(),
            expiresAt: z.number(),
            base: rulesSchema.nullable(),
            rules: object,
            changed: z.array(z.string()),
            issues: z.array(z.string()),
            unresolved: z.array(z.string()),
            candidateCount: z.number(),
            counts: object,
            revision: object,
            planVersion: z.number().int().positive().nullable(),
          })
          .parse(record(toolResult._meta?.workspace).data);
        if (preview.planVersion !== current?.version || preview.date !== versions.today)
          throw new ApiError(409, 'STALE_PLAN', 'Preview the current plan again.');
        const generation = z
          .number()
          .int()
          .positive()
          .parse(record(toolResult._meta?.workspace).libraryGeneration);
        if (generation !== queryGenerations.get(today))
          throw new ApiError(
            409,
            'LIBRARY_GENERATION_MISMATCH',
            'Preview the plan after a library change.',
          );
        previews.set(String(data.previewId), {
          rules: preview.rules,
          planId: current.id,
          version: preview.planVersion,
          date: preview.date,
          generation,
        });
        result = preview;
      } else if (p === '/daily-plan-overrides/commit') {
        const preview = previews.get(String(body.previewId));
        if (!preview || preview.version !== body.expectedVersion || !preview.planId)
          throw new ApiError(409, 'STALE_PLAN', 'Preview the existing plan again.');
        const versions = await query('business_versions');
        if (preview.generation !== versions.libraryGeneration)
          throw new ApiError(
            409,
            'LIBRARY_GENERATION_MISMATCH',
            'Preview the plan after a library change.',
          );
        result = await mutate(
          'tracker_apply_today_rules',
          {
            ...record(preview.rules),
            operationId: body.operationId,
            expectedPlanId: preview.planId,
            expectedVersion: preview.version,
            date: preview.date,
            expectedLibraryGeneration: preview.generation,
          },
          `plan:${preview.planId}`,
          'plan',
          key,
        );
      } else
        throw new ApiError(403, 'HOST_CAPABILITY_UNAVAILABLE', `Unsupported host action: ${p}`);
      return result as T;
    },
  });
  const api = http.api;
  return Object.assign(api, {
    getReadGeneration: (value: object) => readGenerations.get(value),
    getWorkspaceProblem:
      protocol === 'formal'
        ? async (frontendId: string) => {
            const payload = await query('problem', { frontendId });
            if (!payload.problem)
              throw new ApiError(
                404,
                'PROBLEM_NOT_FOUND',
                'Problem not found in the local catalog.',
              );
            const problem = catalogProblemSchema.parse(payload.problem);
            readGenerations.set(problem, queryGenerations.get(payload)!);
            return problem;
          }
        : undefined,
    drafts: protocol === 'formal' && host.capabilities.durableDrafts ? drafts : undefined,
    initializeRecovery: async () => {
      if (!host.capabilities.durableDrafts) return;
      for (const id of handles()) {
        const recovered = await drafts.get('recovery', id);
        if (!recovered.draft) {
          saveHandles(handles().filter((value) => value !== id));
          continue;
        }
        const parsed = z
          .object({
            name: z.enum([
              'tracker_save_note',
              'tracker_create_practice',
              'tracker_update_practice',
              'tracker_revoke_practice',
              'tracker_create_today',
              'tracker_append_today',
              'tracker_remove_today_item',
              'tracker_replace_today_items',
              'tracker_apply_today_rules',
            ]),
            args: object,
            target: z.string(),
            kind: z.enum(['note', 'plan', 'create', 'practice']),
            requestKey: z.string(),
          })
          .parse(JSON.parse(recovered.draft.content));
        if (parsed.args.operationId !== id)
          throw new ApiError(409, 'RECOVERY_ID_MISMATCH', 'Cannot restore this operation.');
        journals.set(id, recovered.revision);
        intents.set(parsed.target, {
          ...parsed,
          state: { operationId: id, target: parsed.target, status: 'unknown' },
        });
      }
    },
    recoverOperations: async () => {
      if (protocol !== 'formal') return;
      await Promise.all(
        [...intents.values()].map(async (intent) => {
          if (intent.running) return;
          const running = execute(intent, true);
          intent.running = running;
          try {
            await running;
          } catch {
            /* The operation event carries its state; preserve uncertain identities. */
          } finally {
            if (intent.running === running) intent.running = undefined;
          }
        }),
      );
    },
  });
}
