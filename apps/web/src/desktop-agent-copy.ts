import type { DesktopAgentActivity, DesktopMcpLaunch } from '../../../packages/contracts/src/desktop-agent.ts';
import type { Language } from './i18n.ts';

export const AI_CLIENTS = ['Claude Code', 'Claude Desktop', 'Codex', 'Antigravity'] as const;
export type AiClient = (typeof AI_CLIENTS)[number];

export const AI_CLIENT_CONFIG_FILES: Record<AiClient, string> = {
  'Claude Code': '.mcp.json',
  'Claude Desktop': 'claude_desktop_config.json',
  Codex: '~/.codex/config.toml',
  Antigravity: '~/.gemini/config/mcp_config.json',
};

const SKILL_CLIENTS = {
  'Claude Code': 'claude-code',
  Codex: 'codex',
  Antigravity: 'antigravity',
} as const;

/** The command runs in PowerShell on Windows and a POSIX shell on macOS. */
export function skillInstallCommand(client: AiClient, { command, entry }: DesktopMcpLaunch): string | null {
  if (client === 'Claude Desktop') return null;
  const windows = /^(?:[A-Za-z]:[\\/]|\\\\)/.test(command);
  const quote = windows
    ? (value: string) => `'${value.replaceAll("'", "''")}'`
    : (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  return `${windows ? '& ' : ''}${quote(command)} ${quote(entry)} install-skill --client ${SKILL_CLIENTS[client]}`;
}

export function clientConfig(client: AiClient, { command, entry, dbPath }: DesktopMcpLaunch): string {
  const args = [entry, '--db', dbPath];
  if (client === 'Codex') {
    return `[mcp_servers.leetcode-tracker]\ncommand = ${JSON.stringify(command)}\nargs = ${JSON.stringify(args)}\n`;
  }
  const server = client === 'Claude Code' ? { type: 'stdio', command, args } : { command, args };
  return JSON.stringify({ mcpServers: { 'leetcode-tracker': server } }, null, 2);
}

export function activityLabel({ tool, count }: DesktopAgentActivity, lang: Language): string {
  const zh = lang === 'zh';
  switch (tool) {
    case 'tracker_create_practices':
      return zh ? `AI 客户端记录了 ${count ?? 1} 条练习。` : `An AI client recorded ${count ?? 1} practice ${(count ?? 1) === 1 ? 'attempt' : 'attempts'}.`;
    case 'tracker_save_notes':
    case 'tracker_patch_note':
      return zh ? 'AI 客户端更新了题解笔记。' : 'An AI client updated problem notes.';
    case 'tracker_import_catalog':
    case 'tracker_import_problems':
      return zh ? 'AI 客户端更新了题库。' : 'An AI client updated the problem catalog.';
    case 'tracker_set_timezone':
      return zh ? 'AI 客户端更改了时区。' : 'An AI client changed the timezone.';
    default:
      return zh ? 'AI 客户端更新了刷题数据。' : 'An AI client updated your practice data.';
  }
}
