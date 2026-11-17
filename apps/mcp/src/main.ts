/**
 * leetcode-tracker-mcp: standalone stdio MCP server plus a few setup commands.
 *
 * stdout is reserved for JSON-RPC while serving, so every diagnostic goes to stderr.
 */
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { parseArgs } from 'node:util';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { ProfileError, TrackerProfile, resolveProfileLocation } from './profile.ts';
import { createServer } from './server.ts';
import { importCatalog, setTimeZone } from './operations.ts';
import { MCP_SERVER_VERSION } from './version.ts';

const USAGE = `leetcode-tracker-mcp ${MCP_SERVER_VERSION}

Usage:
  leetcode-tracker-mcp [--db <path>]                      Serve MCP over stdio (default)
  leetcode-tracker-mcp import <file.jsonl> [--dry-run]    Import a JSON Lines problem catalog
  leetcode-tracker-mcp set-timezone <IANA zone>           Set the timezone used for "today"
  leetcode-tracker-mcp where                              Print the profile path

Options:
  --db <path>     Profile database (default: the desktop app profile, or LEETCODE_TRACKER_DB)
  -h, --help      Show this help
  -v, --version   Show the version
`;

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      db: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
      version: { type: 'boolean', short: 'v', default: false },
    },
  });
  if (values.help) { process.stdout.write(USAGE); return 0; }
  if (values.version) { process.stdout.write(`${MCP_SERVER_VERSION}\n`); return 0; }

  const profile = new TrackerProfile(resolveProfileLocation({ explicitDbPath: values.db }));
  const [command, argument] = positionals;

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
      const content = await readFile(path.resolve(argument), 'utf8');
      const dryRun = values['dry-run'];
      const result = dryRun
        ? await profile.preview(application => importCatalog(application, content, { dryRun }))
        : await profile.write(application => importCatalog(application, content, { dryRun }));
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return result.validCount > 0 || result.totalLines === 0 ? 0 : 1;
    }
    case 'set-timezone': {
      if (!argument) { process.stderr.write(USAGE); return 2; }
      const zone = await profile.write(application => setTimeZone(application, argument));
      process.stdout.write(`Timezone set to ${zone}\n`);
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
