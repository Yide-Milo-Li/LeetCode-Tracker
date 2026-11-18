/** MCP server factory, kept separate from the CLI so tests can build one in-process. */
import { McpServer } from '@modelcontextprotocol/server';
import type { TrackerProfile } from './profile.ts';
import { registerTrackerTools } from './tools.ts';
import { registerPrompts } from './prompts.ts';
import { MCP_SERVER_VERSION } from './version.ts';

export function createServer(profile: TrackerProfile): McpServer {
  const server = new McpServer(
    { name: 'leetcode-tracker', version: MCP_SERVER_VERSION },
    {
      instructions:
        'LeetCode Tracker practice data. Call the tool you need directly; call tracker_status only for an overview or to diagnose PROFILE_NOT_FOUND / TIMEZONE_REQUIRED. Pass questionFrontendId directly to tracker_create_practices without calling tracker_get_problems first. Read before you write: practice edits need the record revision, plan changes need the plan version from tracker_get_today, and note saves need the contentHash from tracker_get_notes or tracker_get_note_context. Batch tools such as tracker_get_problems and tracker_create_practices also take a single item; there are no separate single-item versions. Writes fail with PROFILE_IN_USE while the desktop app is open. ' +
        'To set up or fill in the problem catalog (also when no profile exists yet), check tracker_catalog_coverage, then send problems you know reliably with tracker_import_problems in batches of up to 200 in ascending ID order; never invent titles.',
    },
  );
  registerTrackerTools(server, profile);
  registerPrompts(server);
  return server;
}
