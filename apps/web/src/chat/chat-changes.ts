/**
 * Changes the AI proposes in chat: how one is tracked in a conversation and how its card reads.
 *
 * The server decides which changes exist and validates them; this module only displays what a
 * proposal will do, in the interface language, from the arguments that will be sent back.
 */
import type { ChatActionProposal } from '../../../../packages/contracts/src/chat.ts';
import { localeFor } from '../date-format.ts';
import type { Language } from '../i18n.ts';

/**
 * A proposal and what became of it. `applying` is a confirmation in flight; `failed` keeps the
 * refusal so the card can show it and offer another try.
 */
export interface ChatChange extends ChatActionProposal {
  state: 'pending' | 'applying' | 'applied' | 'dismissed' | 'failed';
  error?: { code: string; message: string };
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
  const outcome = change.state === 'applied' ? 'the user confirmed it and it was applied'
    : change.state === 'dismissed' ? 'the user dismissed it; nothing changed'
    : change.state === 'failed' ? `the user confirmed it but it failed (${change.error?.code ?? 'unknown'}); nothing changed`
    : 'not confirmed yet; nothing changed';
  return `[Proposed change ${change.name}: ${outcome}]`;
}
