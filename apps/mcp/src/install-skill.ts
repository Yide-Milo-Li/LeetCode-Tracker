import { randomUUID } from 'node:crypto';
import { constants, copyFileSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export const SKILL_CLIENTS = ['claude-code', 'codex', 'antigravity'] as const;
export type SkillClient = (typeof SKILL_CLIENTS)[number];

function skillRoot(client: SkillClient, workspace?: string): string {
  if (workspace !== undefined) {
    return resolve(workspace, client === 'claude-code' ? '.claude' : '.agents', 'skills');
  }
  const home = homedir();
  switch (client) {
    case 'claude-code':
      return resolve(process.env.CLAUDE_CONFIG_DIR || join(home, '.claude'), 'skills');
    case 'codex':
      return join(home, '.agents', 'skills');
    case 'antigravity':
      return join(home, '.gemini', 'config', 'skills');
  }
}

export function installSkill(client: SkillClient, source: URL, force = false, workspace?: string) {
  const target = join(skillRoot(client, workspace), 'lct', 'SKILL.md');
  mkdirSync(dirname(target), { recursive: true });
  try {
    copyFileSync(source, target, constants.COPYFILE_EXCL);
    return { status: 'installed', target } as const;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  if (readFileSync(source).equals(readFileSync(target))) return { status: 'unchanged', target } as const;
  if (!force) throw new Error(`A different skill already exists at ${target}. Use --force to replace it.`);

  // Replace in one step so the client never reads a partially written update.
  const pending = `${target}.${randomUUID()}.tmp`;
  try {
    copyFileSync(source, pending, constants.COPYFILE_EXCL);
    renameSync(pending, target);
  } finally {
    rmSync(pending, { force: true });
  }
  return { status: 'updated', target } as const;
}
