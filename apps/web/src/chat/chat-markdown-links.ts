import type { Element, ElementContent, Root } from 'hast';
import { chatLanguageHint } from '../../../../packages/contracts/src/chat-language.ts';
import type { ChatContextSummary } from '../../../../packages/contracts/src/chat.ts';
import { parseWorkspaceLink, settingsNames, workspaceNames, type WorkspaceLink } from '../../../../packages/contracts/src/workspace-links.ts';
import type { Language } from '../i18n.ts';

interface ChatLinkOptions {
  lang: Language;
  conversationLanguage?: Language;
  problem?: ChatContextSummary['problem'];
  desktop: boolean;
}

function destinationName(route: WorkspaceLink, lang: Language, problem?: ChatLinkOptions['problem']): string {
  if (!route.targetId) return workspaceNames[route.view][lang];
  if (route.view === 'settings') {
    const tab = settingsNames[route.targetId][lang];
    return lang === 'zh' ? '设置中的「' + tab + '」' : 'Settings · ' + tab;
  }
  const name = '#' + route.targetId + (problem?.frontendId === route.targetId ? ' ' + problem.title : '');
  if (route.view === 'notes') return lang === 'zh' ? '查看 ' + name + ' 的笔记' : 'View notes for ' + name;
  return lang === 'zh' ? '查看 ' + name + ' 的题目详情' : 'View tracker details for ' + name;
}

function linkText(node: ElementContent): string {
  if (node.type === 'text') return node.value;
  return node.type === 'element' ? node.children.map(linkText).join('') : '';
}

function originalProblemName(href: string, lang: Language, problem?: ChatLinkOptions['problem']): string | undefined {
  if (!/^https?:\/\//i.test(href) || !URL.canParse(href)) return;
  const url = new URL(href);
  const leetcode = /^(?:www\.)?leetcode\.(?:com|cn)$/i.test(url.hostname);
  const slug = leetcode && /^\/problems\/([a-z\d-]+)(?:\/|$)/i.exec(url.pathname)?.[1];
  const title = problem?.url === href ? problem.title
    : slug && slug.split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
  if (!title) return;
  const site = leetcode ? 'LeetCode' : url.hostname;
  return lang === 'zh' ? '在 ' + site + ' 打开《' + title + '》' : 'Open ' + title + ' on ' + site;
}

/** Some providers put a real tracker fragment on a placeholder host. Keep those links in the app. */
function workspaceFragment(href: string): string {
  if (href.startsWith('/#')) return href.slice(1);
  if (!/^https?:\/\//i.test(href)) return href;
  try {
    const url = new URL(href);
    if (url.pathname !== '/' || url.search || url.username || url.password || !url.hash) return href;
    const placeholder = /^(?:www\.)?example\.(?:com|org|net)$/i.test(url.hostname);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (placeholder || local || (typeof window !== 'undefined' && url.origin === window.location.origin)) return url.hash;
  } catch { /* Keep malformed URLs out of the workspace router. */ }
  return href;
}

/** Turn recognized standalone fragments in prose into anchors, keeping punctuation outside the link. */
function splitFragments(text: string, desktop: boolean): ElementContent[] {
  const pieces: ElementContent[] = [];
  let end = 0;
  for (const match of text.matchAll(/(?<![\w/#?=&%.-])\/?#[a-z][\w-]*(?:\/[a-zA-Z\d%_!~.+/*'-]+)?(?![\w/#?=&%-])/g)) {
    const href = match[0].replace(/[.!]+$/, '');
    if (!parseWorkspaceLink(href, desktop)) continue;
    if (match.index > end) pieces.push({ type: 'text', value: text.slice(end, match.index) });
    pieces.push({ type: 'element', tagName: 'a', properties: { href }, children: [{ type: 'text', value: href }] });
    end = match.index + href.length;
  }
  if (pieces.length && end < text.length) pieces.push({ type: 'text', value: text.slice(end) });
  return pieces;
}

/** Repair chat prose after Markdown resolves links and footnotes, before React renders it. */
export function chatMarkdownLinks(options: ChatLinkOptions) {
  return (tree: Root) => {
    const anchors: Element[] = [];
    const prose: string[] = [];
    function collect(parent: Element | Root) {
      for (let index = 0; index < parent.children.length; index++) {
        const child = parent.children[index];
        if (child.type === 'element') {
          if (child.tagName === 'a') anchors.push(child);
          else if (child.tagName !== 'code' && child.tagName !== 'pre' && child.tagName !== 'math') collect(child);
        } else if (child.type === 'text') {
          const parts = child.value.includes('#') ? splitFragments(child.value, options.desktop) : [];
          if (!parts.length) prose.push(child.value);
          else {
            parent.children.splice(index, 1, ...parts);
            index += parts.length - 1;
            for (const part of parts) {
              if (part.type === 'element') anchors.push(part);
              if (part.type === 'text') prose.push(part.value);
            }
          }
        }
      }
    }
    collect(tree);
    if (!anchors.length) return;
    const lang = options.conversationLanguage ?? chatLanguageHint(prose.join(' ')) ?? options.lang;
    for (const anchor of anchors) {
      const href = anchor.properties.href;
      if (typeof href !== 'string') continue;
      const fragment = workspaceFragment(href);
      const route = parseWorkspaceLink(fragment, options.desktop);
      if (route) anchor.properties.href = fragment;
      const label = linkText(anchor).trim();
      const generic = !label || label === href || /^https?:\/\/\S+$/i.test(label)
        || /^(?:here|click here|open|link|details|problem details|notes|original problem|点此|点击这里|这里|链接|打开|题目详情|详情|笔记|原题)$/i.test(label)
        || (route?.targetId && label === '#' + route.targetId)
        || Boolean(parseWorkspaceLink(label, options.desktop));
      // A copied placeholder or a model-written action in the wrong language needs a local label.
      const mismatchedAction = lang === 'zh' ? /^(?:notes for #|view (?:notes|details) for |open .+ on leetcode)/i.test(label)
        : /^(?:查看|打开|复习|在\s*LeetCode\s*做)/i.test(label);
      if (!generic && !mismatchedAction && !(route && href.includes('://') && href !== fragment)) continue;
      const name = route ? destinationName(route, lang, options.problem) : originalProblemName(href, lang, options.problem);
      if (name) anchor.children = [{ type: 'text', value: name }];
    }
  };
}
