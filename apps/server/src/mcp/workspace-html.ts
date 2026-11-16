/** Only the formal build is a workspace; missing assets cannot masquerade as ready. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
declare const __TRACKER_WORKSPACE_HTML__: string;

export const WORKSPACE_HTML_PATH = resolve(
  import.meta.dirname,
  '../../../chatgpt/dist/workspace.html',
);
const embedded =
  typeof __TRACKER_WORKSPACE_HTML__ === 'string' ? __TRACKER_WORKSPACE_HTML__ : undefined;
const artifact = () => {
  try {
    return embedded ?? readFileSync(WORKSPACE_HTML_PATH, 'utf8');
  } catch {
    return '';
  }
};
export const WORKSPACE_RESOURCE_URI = `ui://leetcode-tracker/v1.2.0/${createHash('sha256').update(artifact()).digest('hex').slice(0, 16)}/workspace.html`;
export function getWorkspaceHtml(path = WORKSPACE_HTML_PATH): string {
  try {
    const html = path === WORKSPACE_HTML_PATH && embedded ? embedded : readFileSync(path, 'utf8');
    if (!html.includes('<script type="module">') || !html.includes('tracker-root'))
      throw new Error('Invalid workspace artifact');
    return html;
  } catch {
    throw Object.assign(new Error('Build the ChatGPT workspace before opening it.'), {
      code: 'WORKSPACE_UI_UNAVAILABLE',
    });
  }
}
