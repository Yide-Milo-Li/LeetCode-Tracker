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
        'LeetCode Tracker practice data. Call tracker_status first. Tools read the local profile; tracker_import_catalog is the only tool that writes.',
    },
  );
  registerTrackerTools(server, profile);
  return server;
}
