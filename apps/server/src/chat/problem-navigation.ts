import type { TrackerApplication } from '../../../../packages/application/src/application.ts';
import type { ChatRequest } from '../../../../packages/contracts/src/chat.ts';
import { problemWorkspaceHref } from '../../../../packages/contracts/src/workspace-links.ts';

/** A standalone “open #42” has two valid destinations. Let the user pick from the real catalog. */
export async function problemOpeningChoices(application: TrackerApplication, request: ChatRequest, lang: 'en' | 'zh') {
  // Prior turns can settle which destination “open” refers to. Leave those turns to the model.
  if (request.messages.length !== 1) return;
  const question = request.messages[0].content.trim().replace(/[.!?。！？]$/, '').trimEnd();
  const id = /^(?:请\s*)?(?:帮我\s*)?打开\s*(?:题目\s*|第\s*)?#?\s*(\d+)\s*题?$/u.exec(question)?.[1]
    ?? /^(?:please\s+)?open\s+(?:(?:the\s+)?problem\s*)?#?\s*(\d+)$/i.exec(question)?.[1];
  if (!id || (request.dataAccess === false && request.context?.frontendId !== id)) return;
  const { problem } = await application.catalog.read({}, { frontendId: id });
  if (!problem) return;
  const zh = lang === 'zh';
  const title = problem.title.replace(/\s+/g, ' ').replace(/[\\[\]*_<>~&`]/g, '\\$&');
  const name = '#' + id + ' ' + title;
  const details = '[' + (zh ? '查看 ' + name + ' 的题目详情' : 'View ' + name + ' in the tracker') + '](' + problemWorkspaceHref('problems', id) + ')';
  if (!URL.canParse(problem.url)) return details;
  const url = new URL(problem.url);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return details;
  const site = /^(?:www\.)?leetcode\.(?:com|cn)$/i.test(url.hostname) ? 'LeetCode' : url.hostname;
  const original = '[' + (zh ? '在 ' + site + ' 做 ' + name : 'Solve ' + name + ' on ' + site) + '](<' + url.href + '>)';
  return (zh ? '你想在哪里打开这道题？' : 'Where would you like to open this problem?') + '\n\n- ' + original + '\n- ' + details;
}
