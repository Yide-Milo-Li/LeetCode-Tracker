import { CHAT_MAX_MESSAGE_CHARS } from '../../../../packages/contracts/src/chat-limits.ts';
import type { ChatTurn } from '../../../../packages/contracts/src/chat.ts';
import { changeStatusNote } from './chat-changes.ts';
import { CHAT_STORED_ENTRIES } from './chat-threads.ts';
import type { ChatEntry } from './useChat.ts';

// Three recent exchanges, two recalled exchanges, the opening question and the current question.
const RECENT_EXCHANGES = 3;
const RECALLED_EXCHANGES = 2;
export const CHAT_REQUEST_TURNS = 2 * (RECENT_EXCHANGES + RECALLED_EXCHANGES) + 2;
const OMITTED = '\n[…]\n';
const steering = /\b(?:actually|correction|instead|only|must|avoid|never|do not|don't|prefer|without)\b|更正|纠正|改用|改成|只用|只给|只要|不要|必须|不能|说错|别给/iu;

interface Exchange {
  question: ChatEntry;
  answer?: ChatEntry;
}

// Score literal references, including identifiers and adjacent Han characters in unspaced text.
const commonWords = new Set('the and for how why can you that this what does with should would please from about'.split(' '));
function references(question: string): RegExp[] {
  const terms = new Set<string>();
  for (const match of question.toLowerCase().matchAll(/\p{Script=Han}+|#?[\p{Script=Latin}\p{N}_]+/gu)) {
    const word = match[0];
    if (/^\p{Script=Han}/u.test(word)) {
      const chars = Array.from(word);
      for (let i = 1; i < chars.length && terms.size < 32; i++) terms.add(chars[i - 1] + chars[i]);
    } else if (word.length <= 100 && (word.length >= 3 || /\d/.test(word)) && !commonWords.has(word)) {
      terms.add(word.replace(/^#/, ''));
    }
    if (terms.size >= 32) break;
  }
  return [...terms].sort((a, b) => b.length - a.length).map(term => {
    // The tokenizer admits only letters, digits and underscores here. Match #42 and 42, but
    // keep #420 and longer code identifiers out. Han pairs can occur anywhere in a phrase.
    if (/^\p{Script=Han}/u.test(term)) return new RegExp(term, 'u');
    return new RegExp(`(?<![\\p{Script=Latin}\\p{N}_])${term}(?![\\p{Script=Latin}\\p{N}_])`, 'iu');
  });
}

/** Among older turns keep the latest explicit constraint or correction, then prefer referenced evidence. */
function recall(older: Exchange[], terms: RegExp[]): Set<Exchange> {
  const selected = new Set<Exchange>();
  const correction = older.findLast(({ question }) => steering.test(question.content));
  if (correction && correction !== older[0]) selected.add(correction);
  // The opening question and the correction already travel with the request. Prefer a second
  // source that explains a different reference over another turn that repeats the same words.
  const covered = [older[0]?.question.content, correction?.question.content].join('\n');
  const weights = terms.map(term => ({ term, weight: term.test(covered) ? 1 : 5 }));
  const ranked = older.map((exchange, index) => {
    const text = [index ? exchange.question.content : '', exchange.answer?.content].join('\n');
    const hasOutcome = Boolean(exchange.answer?.changes?.length || exchange.answer?.writeOutcomeUnknown);
    let score = Number(hasOutcome);
    for (const { term, weight } of weights) if (term.test(text)) score += weight;
    return { exchange, index, score };
  });
  ranked.sort((a, b) => b.score - a.score || b.index - a.index);
  for (const { exchange } of ranked) {
    if (selected.size === RECALLED_EXCHANGES) break;
    selected.add(exchange);
  }
  return selected;
}

// Each cut stays on a code point boundary, including when a selected identifier sits beside emoji.
function fragment(text: string, start: number, end: number): string {
  return text.slice(start, end).replace(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/gu, '');
}

function excerpt(text: string, limit: number, terms: RegExp[], instructionAt = -1): string {
  if (text.length <= limit) return text;
  if (limit < OMITTED.length * 2 + 4) return '';
  const room = limit - OMITTED.length;
  const head = Math.ceil(room / 2);
  const tail = text.length - (room - head);
  // A follow-up can name a line of code or an example in the middle of a much older answer.
  const hit = [instructionAt, ...terms.map(term => text.search(term))].find(index => index >= head && index < tail);
  if (hit !== undefined) {
    const edge = Math.floor(room / 4);
    const middle = room - 2 * edge - OMITTED.length;
    const start = Math.min(Math.max(edge, hit - Math.floor(middle / 3)), text.length - edge - middle);
    return fragment(text, 0, edge) + OMITTED + fragment(text, start, start + middle) + OMITTED
      + fragment(text, text.length - edge, text.length);
  }
  return fragment(text, 0, head) + OMITTED + fragment(text, tail, text.length);
}

function turn(entry: ChatEntry, limit: number, terms: RegExp[]): ChatTurn | undefined {
  const notes = (entry.changes ?? []).map(changeStatusNote);
  if (entry.writeOutcomeUnknown) notes.push('[Write outcome unknown. Check tracker state before repeating a change.]');
  if (entry.role === 'assistant' && entry.content.trim() && entry.state !== 'done') {
    notes.push('[Incomplete answer]');
  }
  // Receipts come from the change cards. Keep them even if the answer was empty or excerpted.
  const status = excerpt(notes.join('\n'), limit, []);
  const text = entry.content.trim();
  const bodyLimit = status ? limit - status.length - 2 : limit;
  const instructionAt = entry.role === 'user' && text.length > bodyLimit ? text.search(steering) : -1;
  const body = excerpt(text, bodyLimit, terms, instructionAt);
  const content = [body, status].filter(Boolean).join('\n\n');
  return content ? { role: entry.role, content } : undefined;
}

/**
 * Build provider-neutral history from this thread at send time. The current question and the
 * immediately preceding exchange get the full per-message allowance. Older exchanges are
 * verbatim excerpts in chronological order, with their original roles and current write outcomes.
 */
export function requestTurns(entries: readonly ChatEntry[]): ChatTurn[] {
  const exchanges: Exchange[] = [];
  for (let i = Math.max(0, entries.length - CHAT_STORED_ENTRIES - 1); i < entries.length; i++) {
    const question = entries[i];
    if (question.role !== 'user' || !question.content.trim()) continue;
    const next = entries[i + 1];
    exchanges.push({ question, answer: next?.role === 'assistant' ? next : undefined });
  }
  const current = exchanges.pop();
  if (!current) return [];

  const terms = references(current.question.content);
  const recentStart = Math.max(0, exchanges.length - RECENT_EXCHANGES);
  const recalled = recall(exchanges.slice(0, recentStart), terms);
  const messages: ChatTurn[] = [];
  const add = (entry: ChatEntry | undefined, limit: number) => {
    const message = entry && turn(entry, limit, terms);
    if (message) messages.push(message);
  };
  for (const [index, exchange] of exchanges.entries()) {
    const recent = index >= recentStart;
    if (!recent && !recalled.has(exchange)) {
      if (index === 0) add(exchange.question, 800);
      continue;
    }
    const limit = index === exchanges.length - 1 ? CHAT_MAX_MESSAGE_CHARS : recent ? 1_600 : 800;
    add(exchange.question, limit);
    add(exchange.answer, limit);
  }
  add(current.question, CHAT_MAX_MESSAGE_CHARS);
  add(current.answer, CHAT_MAX_MESSAGE_CHARS);
  return messages;
}
