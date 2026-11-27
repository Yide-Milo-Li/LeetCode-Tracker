/**
 * Changes the AI proposes in chat: how one is tracked in a conversation and how its card reads.
 *
 * The server decides which changes exist and validates them; this module only displays what a
 * proposal will do, in the interface language, from the arguments that will be sent back.
 */
import type { ChatActionProposal, ChatUndo } from '../../../../packages/contracts/src/chat.ts';
import { localeFor } from '../date-format.ts';
import type { Language } from '../i18n.ts';

/**
 * A proposal and what became of it. `applying` and `undoing` are requests in flight; `failed`
 * keeps the refusal so the card can show it and offer another try; `undone` is an applied change
 * that was taken back.
 */
export interface ChatChange extends ChatActionProposal {
  state: 'pending' | 'applying' | 'applied' | 'undoing' | 'undone' | 'dismissed' | 'failed';
  /** Why the confirmation, or the undo of an applied change, was refused. */
  error?: { code: string; message: string };
  /** The user changed the proposed values before confirming. */
  edited?: boolean;
  /** The server applied this change under full access. */
  automatic?: boolean;
  /**
   * What takes the applied change back. Held for this session only: it can carry a whole note,
   * and the longer ago a change was made the less likely an undo still applies cleanly.
   */
  undo?: ChatUndo;
}

/** A proposal that needs no decision any more. */
export const isDecided = (change: ChatChange) => change.state === 'applied' || change.state === 'undoing' || change.state === 'undone' || change.state === 'dismissed';

/** One attempt of a practice proposal, as the edit form shows it. */
export interface AttemptDraft {
  frontendId: string;
  outcome: 'independent' | 'assisted' | 'unsolved';
  /** Text of the minutes field; empty means no duration. */
  minutes: string;
}

/** What the user may adjust before confirming, or `null` for a change that is confirmed as proposed. */
export type ChangeDraft = { kind: 'practices'; attempts: AttemptDraft[] } | { kind: 'note'; content: string };

/** The adjustable values of a proposal as it stands. */
export function draftOf(change: ChatActionProposal): ChangeDraft | null {
  if (change.name === 'tracker_create_practices') {
    return {
      kind: 'practices',
      attempts: (Array.isArray(change.args.records) ? change.args.records : []).map(object).map(record => ({
        frontendId: String(record.questionFrontendId ?? ''),
        outcome: record.outcome === 'assisted' ? 'assisted' : record.outcome === 'unsolved' || record.completed !== true ? 'unsolved' : 'independent',
        minutes: typeof record.durationMinutes === 'number' ? String(record.durationMinutes) : '',
      })),
    };
  }
  if (change.name === 'tracker_patch_note' && typeof change.args.content === 'string') return { kind: 'note', content: change.args.content };
  return null;
}

/**
 * The proposal's arguments with the user's adjustments applied, or `null` while the draft cannot
 * be sent (an empty note, minutes outside 1 to 1440). Everything the form does not show is kept,
 * and so is every field the user left as the form first showed it: a solved attempt with no
 * stated outcome is shown as solved independently, but stays without an outcome unless the user
 * picks one.
 */
export function applyDraft(change: ChatActionProposal, draft: ChangeDraft): Record<string, unknown> | null {
  if (draft.kind === 'note') return draft.content.trim() ? { ...change.args, content: draft.content } : null;
  const records = (Array.isArray(change.args.records) ? change.args.records : []).map(object);
  const shown = draftOf(change);
  const initial = shown?.kind === 'practices' ? shown.attempts : [];
  const next: Array<Record<string, unknown>> = [];
  for (const [index, attempt] of draft.attempts.entries()) {
    const minutes = attempt.minutes.trim() === '' ? null : Number(attempt.minutes);
    if (minutes !== null && (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440)) return null;
    const record = { ...records[index] };
    if (attempt.outcome !== initial[index]?.outcome) Object.assign(record, { completed: attempt.outcome !== 'unsolved', outcome: attempt.outcome });
    if (attempt.minutes.trim() !== initial[index]?.minutes.trim()) record.durationMinutes = minutes;
    next.push(record);
  }
  return { ...change.args, records: next };
}

/** What a change card shows. */
export interface ChangeView {
  /** The kind of change, as the card's heading. */
  title: string;
  /** What is changed, one target per line. */
  lines: string[];
  /** Markdown that will be written, for changes that carry text. */
  body?: string;
  /** Label of the confirming button. */
  confirm: string;
  /** Shown in place of the buttons once the change was applied. */
  done: string;
}

type Json = Record<string, unknown>;
const object = (value: unknown): Json => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {};
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

/**
 * Describe a proposal for its card.
 *
 * @param zone The profile's IANA time zone for practice times; `null` falls back to UTC.
 */
export function describeChange(change: ChatActionProposal, lang: Language, zone: string | null): ChangeView {
  const zh = lang === 'zh';
  const { args, labels } = change;
  const sep = zh ? '、' : ', ';
  const problem = (id: string) => `#${id}${labels.problems[id] ? ` ${labels.problems[id]}` : ''}`;
  const problems = strings(args.frontendIds).map(problem);

  if (change.name === 'tracker_create_practices') {
    const records = (Array.isArray(args.records) ? args.records : []).map(object);
    return {
      title: zh ? (records.length > 1 ? `记录 ${records.length} 次练习` : '记录练习') : (records.length > 1 ? `Record ${records.length} attempts` : 'Record an attempt'),
      lines: records.map(record => {
        const completed = record.completed === true;
        const result = record.outcome === 'assisted' ? (zh ? '借助提示或题解完成' : 'solved with help')
          : record.outcome === 'unsolved' || !completed ? (zh ? '未解出' : 'not solved')
          : (zh ? '独立完成' : 'solved independently');
        const minutes = typeof record.durationMinutes === 'number' ? (zh ? `${record.durationMinutes} 分钟` : `${record.durationMinutes} min`) : '';
        const at = typeof record.practicedAt === 'string' ? record.practicedAt : '';
        const when = !at ? (zh ? '现在' : 'now')
          : /^\d{4}-\d{2}-\d{2}$/.test(at) || Number.isNaN(Date.parse(at)) ? at
          : new Intl.DateTimeFormat(localeFor(lang), { dateStyle: 'medium', timeStyle: 'short', timeZone: zone ?? 'UTC' }).format(new Date(at));
        const remark = typeof record.notes === 'string' && record.notes.trim() ? (zh ? `备注：${record.notes.trim()}` : `Remark: ${record.notes.trim()}`) : '';
        return [problem(String(record.questionFrontendId ?? '')), result, minutes, when, remark].filter(Boolean).join(' · ');
      }),
      confirm: zh ? '记录' : 'Record',
      done: zh ? '已记录' : 'Recorded',
    };
  }

  if (change.name === 'tracker_patch_note') {
    const replace = args.mode === 'replace';
    const heading = String(args.heading ?? '');
    return {
      title: zh ? (replace ? '替换笔记中的一节' : '写入笔记') : (replace ? 'Replace a note section' : 'Add to the note'),
      lines: [
        problem(String(args.frontendId ?? '')),
        zh ? `${replace ? '替换小节' : '加到小节'}：${heading}` : `${replace ? 'Replaces section' : 'Adds to section'}: ${heading}`,
      ],
      body: typeof args.content === 'string' ? args.content : undefined,
      confirm: zh ? (replace ? '替换' : '写入') : (replace ? 'Replace' : 'Add'),
      done: zh ? '已写入笔记' : 'Saved to the note',
    };
  }

  if (change.name === 'tracker_add_favorites') {
    const created = object(args.newFolder).id;
    const folders = strings(args.folderIds).map(id =>
      `${labels.folders[id] ?? id}${id === created ? (zh ? '（新建）' : ' (new)') : ''}`);
    return {
      title: zh ? '收藏题目' : 'Star problems',
      lines: [problems.join(sep), ...(folders.length ? [`${zh ? '收藏夹：' : 'Folders: '}${folders.join(sep)}`] : [])],
      confirm: zh ? '收藏' : 'Star',
      done: zh ? '已收藏' : 'Starred',
    };
  }

  if (change.name === 'tracker_add_to_goal_lists') {
    return {
      title: zh ? '加入目标题单' : 'Add to goal lists',
      lines: [problems.join(sep), `${zh ? '题单：' : 'Lists: '}${strings(args.listIds).map(id => labels.lists[id] ?? id).join(sep)}`],
      confirm: zh ? '加入' : 'Add',
      done: zh ? '已加入题单' : 'Added to the lists',
    };
  }

  // A change this build does not know: show exactly what would be sent.
  return { title: change.name, lines: [JSON.stringify(args)], confirm: zh ? '确认' : 'Confirm', done: zh ? '已完成' : 'Done' };
}

/**
 * What the model is told about a proposal on later questions, appended to the answer that made
 * it, so it never has to guess whether the user confirmed.
 */
export function changeStatusNote(change: ChatChange): string {
  if (change.state === 'applying') return `[Proposed change ${change.name}: confirmed, application in progress]`;
  if (change.state === 'undoing') return `[Change ${change.name}: applied, undo in progress]`;
  if (change.automatic) {
    const outcome = change.state === 'undone' ? 'applied automatically, then undone by the user' : 'applied automatically';
    return `[Change ${change.name}: ${outcome}]`;
  }
  const outcome = change.state === 'applied'
    ? `the user ${change.edited ? 'edited its values, then confirmed it' : 'confirmed it'} and it was applied`
    : change.state === 'undone' ? 'the user confirmed it, then undid it; nothing changed'
    : change.state === 'dismissed' ? 'the user dismissed it; nothing changed'
    : change.state === 'failed' ? `the user confirmed it but it failed (${change.error?.code ?? 'unknown'}); nothing changed`
    : 'not confirmed yet; nothing changed';
  return `[Proposed change ${change.name}: ${outcome}]`;
}
