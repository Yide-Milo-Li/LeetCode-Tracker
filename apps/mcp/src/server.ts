/** MCP server factory, kept separate from the CLI so tests can build one in-process. */
import { McpServer } from '@modelcontextprotocol/server';
import type { TrackerProfile } from './profile.ts';
import { registerTrackerTools } from './tools.ts';
import { MCP_SERVER_VERSION } from './version.ts';

export function createServer(profile: TrackerProfile): McpServer {
  const server = new McpServer(
    { name: 'leetcode-tracker', version: MCP_SERVER_VERSION },
    {
      instructions:
        'LeetCode Tracker practice data. Call tracker_status first. Read before you write: practice edits need the record revision, plan changes need the plan version from tracker_get_today, and note saves need the contentHash from tracker_get_note. Writes fail with PROFILE_IN_USE while the desktop app is open.',
    },
  );
  registerTrackerTools(server, profile);
  return server;
}
