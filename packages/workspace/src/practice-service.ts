/** Shared practice creation intent storage; uncertain retries preserve both ID and actual event time. */
import { ApiError, OperationStateError, type TrackerClient, type WorkspaceOperationState } from './client.ts';
import type { CreatePracticeRecordInput, PracticeRecord } from '../../contracts/src/index.ts';
import type { WorkspaceHost } from './host.ts';

/** Format an exact instant as editable wall-clock fields in the selected IANA timezone. */
export function zonedInput(iso: string, zone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(iso));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}:${values.second}`;
}

/** Resolve wall time only if unique; never guess a skipped or repeated DST time. */
export function fromZonedInput(value: string, zone: string): string {
  const normalized = value.length === 16 ? value + ':00' : value;
  const naive = Date.parse(normalized + 'Z');
  if (!Number.isFinite(naive)) throw new Error('Invalid date and time / 日期时间无效');
  const offsets = new Set<number>();
  for (const hours of [-36, -12, 0, 12, 36]) {
    const instant = naive + hours * 3600000;
    offsets.add(Date.parse(zonedInput(new Date(instant).toISOString(), zone) + 'Z') - instant);
  }
  const matches = [...offsets]
    .map((offset) => new Date(naive - offset).toISOString())
    .filter((iso) => zonedInput(iso, zone) === normalized);
  if (matches.length !== 1)
    throw new Error(
      'This local time is missing or ambiguous because of a clock change. Choose another time or date-only precision. / 此时间因夏令时切换而不存在或有歧义，请调整时间或仅记录日期。',
    );
  return matches[0];
}

/** Each provider owns immutable retry intents and in-flight requests. */
export function createPracticeService(api:TrackerClient, host:WorkspaceHost) {
type PracticeIntent = CreatePracticeRecordInput & { expectedLibraryGeneration?: number };
const pending = new Map<string, PracticeIntent>();
const inFlight = new Map<string, Promise<PracticeRecord>>();
const prefix = 'leetcode-practice-intent:';

/** A restored profile must not replay an unfinished operation from the previous database. */
function clearPracticeIntents(): void {
  pending.clear();
  inFlight.clear();
  try {
    for (let i = host.storage('session').length - 1; i >= 0; i--) {
      const key = host.storage('session').key(i);
      if (key?.startsWith(prefix)) host.storage('session').removeItem(key);
    }
  } catch { /* Reload still discards in-memory drafts when storage is unavailable. */ }
}

/** Recover an unresolved intent across page reload; storage denial still preserves in-memory safety. */
function getPracticeIntent(key: string): PracticeIntent | undefined {
  if (pending.has(key)) return pending.get(key);
  try {
    const raw = host.storage('session').getItem(prefix + key);
    if (raw) {
      const value = JSON.parse(raw) as PracticeIntent;
      if (value.operationId && value.practicedAt && value.questionFrontendId) {
        pending.set(key, value);
        return value;
      }
    }
  } catch {
    /* Storage is optional; the database operation remains the final duplicate guard. */
  }
  return undefined;
}

/** Submit exactly one immutable creation intent; preserve it until the server confirms the record. */
function createPractice(key: string, payload: CreatePracticeRecordInput, expectedLibraryGeneration?: number): Promise<PracticeRecord> {
  const running = inFlight.get(key);
  if (running) return running;
  const input = getPracticeIntent(key) ?? { ...payload, operationId: crypto.randomUUID(), ...(expectedLibraryGeneration === undefined ? {} : { expectedLibraryGeneration }) };
  pending.set(key, input);
  try {
    host.storage('session').setItem(prefix + key, JSON.stringify(input));
  } catch {
    /* In-memory fallback. */
  }
  const preconditions: [] | [number] = input.expectedLibraryGeneration === undefined ? [] : [input.expectedLibraryGeneration];
  const request = api
    .createPracticeRecord(input, ...preconditions)
    .then((record) => {
      pending.delete(key);
      try {
        host.storage('session').removeItem(prefix + key);
      } catch {
        /* No effect on saved data. */
      }
      return record;
    })
    .catch((error) => {
      // Explicit validation/not-found responses prove no row was written. Network/5xx failures do not.
      if ((error instanceof ApiError && ([400, 404, 422].includes(error.status) || error.code === 'LIBRARY_GENERATION_MISMATCH')) ||
        (error instanceof OperationStateError && ['rejected', 'cancelled', 'expired', 'failed'].includes(error.operation.status))) {
        pending.delete(key);
        try {
          host.storage('session').removeItem(prefix + key);
        } catch {
          /* In-memory fallback. */
        }
      }
      throw error;
    })
    .finally(() => inFlight.delete(key));
  inFlight.set(key, request);
  return request;
}


/** Polling may settle an operation after its original promise rejected; release only its matching identity. */
function settlePracticeOperation(operation: WorkspaceOperationState): void {
  if (!['applied', 'rejected', 'cancelled', 'expired', 'failed'].includes(operation.status)) return;
  for (const [key, input] of pending) {
    if (input.operationId !== operation.operationId) continue;
    pending.delete(key);
    try { host.storage('session').removeItem(prefix + key); } catch { /* In-memory state is already settled. */ }
  }
}
return {clearPracticeIntents,getPracticeIntent,createPractice,settlePracticeOperation};
}
