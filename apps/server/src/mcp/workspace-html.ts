/** Only the formal build is a workspace; missing assets cannot masquerade as ready. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const WORKSPACE_RESOURCE_URI = 'ui://leetcode-tracker/v1.2.0/workspace.html';
export const WORKSPACE_HTML_PATH = resolve(import.meta.dirname, '../../../chatgpt/dist/workspace.html');
export function getWorkspaceHtml(path = WORKSPACE_HTML_PATH): string {
  try {
    const html = readFileSync(path, 'utf8');
    if (!html.includes('<script type="module">') || !html.includes('tracker-root')) throw new Error('Invalid workspace artifact');
    return html;
  } catch { throw Object.assign(new Error('Build the ChatGPT workspace before opening it.'), { code: 'WORKSPACE_UI_UNAVAILABLE' }); }
}
