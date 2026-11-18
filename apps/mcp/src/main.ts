/**
 * leetcode-tracker-mcp: standalone stdio MCP server plus a few setup commands.
 *
 * stdout is reserved for JSON-RPC while serving, so every diagnostic goes to stderr.
 */
import * as path from 'node:path';
import { parseArgs } from 'node:util';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { ProfileError, TrackerProfile, resolveProfileLocation } from './profile.ts';
import { createServer } from './server.ts';
import { createTrackerToolRegistry } from './tools.ts';
import { callTrackerTool, type ToolName } from './registrar.ts';
import { MCP_SERVER_VERSION } from './version.ts';
import { installSkill, SKILL_CLIENTS } from './install-skill.ts';

async function callSetupTool(profile: TrackerProfile, name: ToolName, args: Record<string, unknown>) {
  const result = await callTrackerTool(createTrackerToolRegistry(profile).get(name)!, profile, args);
  if (result.isError) throw new Error(result.content[0]?.text ?? 'The tool failed.');
  return result.structuredContent!;
}

const USAGE = `leetcode-tracker-mcp ${MCP_SERVER_VERSION}

Usage:
  leetcode-tracker-mcp [--db <path>]                      Serve MCP over stdio (default)
  leetcode-tracker-mcp import <file.jsonl> [--dry-run]    Import a JSON Lines problem catalog
  leetcode-tracker-mcp set-timezone <IANA zone>           Set the timezone used for "today"
  leetcode-tracker-mcp where                              Print the profile path
  leetcode-tracker-mcp install-skill --client <${SKILL_CLIENTS.join('|')}> [--workspace <directory>] [--force]

Options:
  --db <path>     Profile database (default: the desktop app profile, or LEETCODE_TRACKER_DB)
  --workspace <directory>   Install the skill in this client workspace (default: current user)
  --force        Replace an existing, different copy of the LCT skill
  -h, --help      Show this help
  -v, --version   Show the version
`;

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      db: { type: 'string' },
      client: { type: 'string' },
      workspace: { type: 'string' },
      force: { type: 'boolean' },
      'dry-run': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
      version: { type: 'boolean', short: 'v', default: false },
    },
  });
  if (values.help) { process.stdout.write(USAGE); return 0; }
  if (values.version) { process.stdout.write(`${MCP_SERVER_VERSION}\n`); return 0; }

  const [command, argument] = positionals;
  if (command === 'install-skill') {
    const client = SKILL_CLIENTS.find(name => name === values.client);
    if (!client || argument !== undefined || values.workspace?.trim() === '' || values.db !== undefined || values['dry-run']) {
      process.stderr.write(USAGE);
      return 2;
    }
    const source = new URL(
      import.meta.url.endsWith('.ts') ? '../../../skills/lct/SKILL.md' : './skills/lct/SKILL.md',
      import.meta.url,
    );
    const { status, target } = installSkill(client, source, values.force, values.workspace);
    process.stdout.write(status === 'unchanged' ? `LCT skill is already up to date at ${target}\n`
      : `LCT skill ${status} at ${target}\n`);
    return 0;
  }
  if (values.client !== undefined || values.workspace !== undefined || values.force) {
    process.stderr.write('--client, --workspace and --force apply to install-skill only.\n');
    return 2;
  }

  const profile = new TrackerProfile(resolveProfileLocation({ explicitDbPath: values.db }));

  switch (command) {
    case undefined:
    case 'serve': {
      console.error(`[leetcode-tracker-mcp] ${MCP_SERVER_VERSION} serving profile ${profile.location.dbPath}`);
      serveStdio(() => createServer(profile), {
        onerror: error => console.error('[leetcode-tracker-mcp] transport error:', error),
      });
      // serveStdio keeps the process alive until stdin closes.
      return -1;
    }
    case 'import': {
      if (!argument) { process.stderr.write(USAGE); return 2; }
      const result = await callSetupTool(profile, 'tracker_import_catalog', {
        path: path.resolve(argument), dryRun: values['dry-run'],
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return Number(result.validCount) > 0 || result.totalLines === 0 ? 0 : 1;
    }
    case 'set-timezone': {
      if (!argument) { process.stderr.write(USAGE); return 2; }
      const result = await callSetupTool(profile, 'tracker_set_timezone', { timezone: argument });
      process.stdout.write(`Timezone set to ${result.timezone}\n`);
      return 0;
    }
    case 'where': {
      process.stdout.write(`${profile.location.dbPath}\n`);
      return 0;
    }
    default:
      process.stderr.write(`Unknown command: ${command}\n\n${USAGE}`);
      return 2;
  }
}

main(process.argv.slice(2)).then(
  code => { if (code >= 0) process.exitCode = code; },
  error => {
    const message = error instanceof ProfileError ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : String(error);
    console.error(`[leetcode-tracker-mcp] ${message}`);
    process.exitCode = 1;
  },
);
