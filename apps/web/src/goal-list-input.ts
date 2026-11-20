import { GOAL_PROBLEM_ID_MAX_LENGTH } from '../../../packages/contracts/src/goal-list-utils.ts';
import type { Language } from './i18n.ts';

/** Keep imported string IDs containing separators or a literal "#" lossless in the bulk editor. */
export function formatGoalIds(ids: string[]) {
  return ids.map(id => /^[#"]|[,，、\r\n]/u.test(id) || id !== id.trim() ? JSON.stringify(id) : id).join('\n');
}

export function parseGoalIds(text: string, lang: Language) {
  const zh = lang === 'zh';
  const ids: string[] = [];
  const seen = new Set<string>();
  let error = '';
  function add(id: string, line: number) {
    if (!error) {
      if (!id.trim()) error = zh ? `第 ${line} 行缺少题号。` : `Enter a problem ID on line ${line}.`;
      else if (id.length > GOAL_PROBLEM_ID_MAX_LENGTH) error = zh ? `第 ${line} 行的题号超过 ${GOAL_PROBLEM_ID_MAX_LENGTH} 个字符。`
        : `The problem ID on line ${line} exceeds ${GOAL_PROBLEM_ID_MAX_LENGTH} characters.`;
      else if (seen.has(id)) error = zh ? `第 ${line} 行的题号 #${id} 重复了。` : `Duplicate problem #${id} on line ${line}.`;
    }
    if (id) { ids.push(id); seen.add(id); }
  }

  for (const [index, line] of text.split(/\r\n|[\r\n]/u).entries()) {
    const value = line.trim();
    if (!value) continue;
    if (value.startsWith('"')) {
      try {
        add(JSON.parse(value) as string, index + 1);
      } catch {
        error ||= zh ? `第 ${index + 1} 行的引号格式有误。带引号的题号请单独一行填写。`
          : `Invalid quotes on line ${index + 1}. Put each quoted ID on its own line.`;
      }
    } else {
      for (const part of value.split(/[,，、]/u)) {
        const token = part.trim();
        if (token) add(token.replace(/^#\s*/u, ''), index + 1);
      }
    }
  }
  if (!error && !ids.length && text.trim()) {
    error = zh ? '请输入题号。要清空题单，请清空输入框。' : 'Enter problem IDs, or leave the field empty to clear the list.';
  }
  return { ids, error, seen };
}
