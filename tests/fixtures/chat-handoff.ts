import type { ChatEntry } from '../../apps/web/src/chat/useChat.ts';

/** Long debugging sessions with a correction and a named observation outside the recent window. */
export function handoffFixture(lang: 'en' | 'zh') {
  const zh = lang === 'zh';
  const opening = zh ? '我想自己写出每天温度的解法，只给提示。' : 'Help me debug lower_bound in Python. Give hints only.';
  const correction = zh ? '更正一下，我的遍历方向是从右往左。' : 'Correction: my interval is half-open, [lo, hi).';
  const observation = zh ? '重复温度也要弹出，因为题目要求严格升温。' : 'pivot_index rounds down so the right half starts at pivot_index + 1.';
  const previousQuestion = zh ? '我卡在返回值，栈空时填什么？' : 'I am stuck on what to return when lo reaches hi.';
  const previousAnswer = zh ? '你可以用最后一天做个反例，检查默认的 0。' : 'Try the insertion point one past the last element.';
  const current = zh ? '回到重复温度的例子，结合我改过的遍历方向，再给一个提示。' : 'Revisit pivot_index with my corrected interval. What should I try next?';
  const entries: ChatEntry[] = [];
  const add = (role: ChatEntry['role'], content: string) => entries.push({ id: String(entries.length), state: 'done', role, content });
  const trace = (step: number) => Array.from({ length: 64 }, (_, i) => zh
    ? `第 ${i} 天，温度 ${18 + (i + step) % 12}，栈中候选下标为 ${i + 1} 和 ${i + 3}。`
    : `Step ${i}: inspect range [${i}, ${i + step + 4}) and compare its middle value with the target.`).join('\n');
  add('user', opening);
  add('assistant', zh ? '你现在是怎么遍历数组的？' : 'How do you represent the search interval?');
  add('user', correction);
  add('assistant', zh ? '先手动模拟三天。' : 'Trace three iterations by hand.');
  add('user', zh ? '能解释一下相同的值吗？' : 'Walk me through the midpoint calculation.');
  add('assistant', [trace(0), observation, trace(1)].join('\n'));
  for (let step = 0; step < 6; step++) {
    add('user', zh ? `用第 ${step + 2} 组输入继续模拟。` : `Trace input number ${step + 2}.`);
    add('assistant', trace(step + 2));
  }
  add('user', previousQuestion);
  add('assistant', previousAnswer);
  add('user', current);
  return { entries, facts: [opening, correction, observation, previousQuestion, previousAnswer, current] };
}
