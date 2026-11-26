/**
 * Preset questions for the AI chat: the graded hint ladder and the practice review.
 *
 * A preset is an ordinary user message. The text shown in the conversation is exactly what the
 * model receives, so nothing is asked on the user's behalf that they cannot read. Each one names
 * its problem, because one conversation can move between problems while only the current one is
 * attached as data.
 */
import type { PracticeRecord } from '../api.ts';
import { localeFor } from '../date-format.ts';
import type { Language } from '../i18n.ts';
import type { ChatProblemRef } from './chat-context.ts';
import type { ChatEntry } from './useChat.ts';

/** Hints before the full solution: a direction, the key observation, then pseudocode. */
export const HINT_COUNT = 3;
/** The rung after the last hint asks for the full solution. */
export const SOLUTION_LEVEL = HINT_COUNT + 1;

/** How a preset names its problem, such as `#42 Trapping Rain Water`. */
const problemName = (problem: ChatProblemRef) => `#${problem.frontendId}${problem.title ? ` ${problem.title}` : ''}`;

const HINT_PROMPTS: Record<Language, ReadonlyArray<(name: string) => string>> = {
  en: [
    name => `Hint 1 of 3 for ${name}: point me in a direction, such as the kind of technique or data structure to consider. Leave out the key insight, pseudocode and code for now.`,
    name => `Hint 2 of 3 for ${name}: tell me the key observation that unlocks it. Leave out pseudocode and code for now.`,
    name => `Hint 3 of 3 for ${name}: outline the algorithm in pseudocode, without runnable code.`,
    name => `Show me the full solution to ${name} with code. Explain why it works and give its time and space complexity.`,
  ],
  zh: [
    name => `${name} 的提示 1/3：给我一个思考方向，比如该考虑哪类方法或数据结构。先不要说关键观察，也不要给伪代码或代码。`,
    name => `${name} 的提示 2/3：告诉我解开它的关键观察。先不要给伪代码或代码。`,
    name => `${name} 的提示 3/3：用伪代码列出算法步骤，不要给可运行的代码。`,
    name => `给我 ${name} 的完整解法和代码，说明为什么可行，以及时间和空间复杂度。`,
  ],
};

/** The message that asks for rung `level` (1 to {@link SOLUTION_LEVEL}) on `problem`. */
export function hintPrompt(level: number, lang: Language, problem: ChatProblemRef): string {
  return HINT_PROMPTS[lang][level - 1](problemName(problem));
}

/** Button text for asking for rung `level`, or `null` once the solution has been shown. */
export function hintLabel(level: number, lang: Language): string | null {
  const zh = lang === 'zh';
  if (level > SOLUTION_LEVEL) return null;
  if (level === SOLUTION_LEVEL) return zh ? '看完整解法' : 'Show the solution';
  if (level === 1) return zh ? '给个提示' : 'Give me a hint';
  return zh ? `下一个提示（${level}/${HINT_COUNT}）` : `Next hint (${level}/${HINT_COUNT})`;
}

/**
 * The rung to ask for next on one problem: one past the highest rung already answered in this
 * conversation. A rung whose answer never produced text does not count, so it is asked again.
 *
 * @returns 1 to {@link SOLUTION_LEVEL}, or `SOLUTION_LEVEL + 1` when nothing is left to ask.
 */
export function nextHintLevel(entries: readonly ChatEntry[], frontendId: string): number {
  let answered = 0;
  entries.forEach((entry, index) => {
    const hint = entry.role === 'user' ? entry.hint : undefined;
    const answer = entries[index + 1];
    // Entries come back from storage, so the tag's shape is not taken for granted.
    if (hint?.frontendId !== frontendId || !Number.isInteger(hint.level)) return;
    if (answer?.role === 'assistant' && answer.content.trim()) answered = Math.max(answered, hint.level);
  });
  return Math.min(answered, SOLUTION_LEVEL) + 1;
}

/**
 * The message that asks for a review of one attempt.
 *
 * @param attempt Display form of the attempt from {@link attemptLabel}; omitted reviews the latest one.
 */
export function reviewPrompt(lang: Language, problem: ChatProblemRef, attempt?: string): string {
  const name = problemName(problem);
  if (lang === 'zh') {
    return `${attempt ? `复盘我做 ${name} 的这次练习：${attempt}。` : `复盘我最近一次做 ${name} 的情况。`}结合我的练习记录和笔记，说说哪里做得好、卡在哪里、这道题考的是什么模式、下次要注意什么。`;
  }
  return `${attempt ? `Review this attempt of mine at ${name}: ${attempt}.` : `Review my latest attempt at ${name}.`} Using my practice records and note, tell me what went well, where I got stuck, which pattern the problem tests, and what to watch for next time.`;
}

/**
 * The message that asks the AI to put its last answer into the problem's note. The AI answers
 * with a proposed note change, which the user still confirms.
 */
export function saveNotePrompt(lang: Language, problem: ChatProblemRef): string {
  const name = problemName(problem);
  return lang === 'zh'
    ? `把你上一条回答里值得留下的内容整理进 ${name} 的笔记：放进合适的小节，写得简洁，笔记里已有的不要重复。`
    : `Save what is worth keeping from your last answer to my note for ${name}: put it in the section where it fits, keep it brief, and leave out what the note already says.`;
}

/** The message that asks for problems like this one from the user's own catalog. */
export function similarPrompt(lang: Language, problem: ChatProblemRef): string {
  const name = problemName(problem);
  return lang === 'zh'
    ? `在我的题库里找几道和 ${name} 考察同一模式的题，按由易到难排，并标出我做过哪些。`
    : `Find a few problems in my catalog that test the same pattern as ${name}, ordered from easier to harder, and mark the ones I have already practised.`;
}

/**
 * Describe one practice record so a review can name it: when it happened, how it went and how
 * long it took. Only the latest attempts are attached to a chat request, so the result and
 * duration are spelled out here rather than left for the model to look up.
 *
 * @param zone The profile's IANA time zone; `null` falls back to UTC, as the record card does.
 */
export function attemptLabel(
  record: Pick<PracticeRecord, 'practicedAt' | 'timePrecision' | 'completed' | 'outcome' | 'durationMinutes'>,
  lang: Language,
  zone: string | null,
): string {
  const zh = lang === 'zh';
  const when = record.timePrecision === 'date'
    ? record.practicedAt
    : new Intl.DateTimeFormat(localeFor(lang), { dateStyle: 'medium', timeStyle: 'short', timeZone: zone ?? 'UTC' })
        .format(new Date(record.practicedAt));
  const result = record.outcome === 'independent' ? (zh ? '独立完成' : 'solved independently')
    : record.outcome === 'assisted' ? (zh ? '借助提示或题解完成' : 'solved with help')
    : record.outcome === 'unsolved' || !record.completed ? (zh ? '未解出' : 'not solved')
    : '';
  const minutes = record.durationMinutes == null ? '' : zh ? `${record.durationMinutes} 分钟` : `${record.durationMinutes} min`;
  const details = [result, minutes].filter(Boolean).join(zh ? '，' : ', ');
  return details ? `${when}${zh ? `（${details}）` : ` (${details})`}` : when;
}
