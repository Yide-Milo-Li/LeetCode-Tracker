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
        'LeetCode Tracker practice data. Call the tool you need directly; use tracker_status only for an overview or to diagnose PROFILE_NOT_FOUND / TIMEZONE_REQUIRED. Pass questionFrontendId directly to tracker_create_practices without calling tracker_get_problems first. Writes require the revision (practice), version (plan/strategy), or contentHash (notes) from a prior read, and fail with PROFILE_IN_USE while the desktop app is open. Use tracker_catalog_coverage and tracker_import_problems to build or update the problem catalog.',
    },
  );
  registerTrackerTools(server, profile);
  registerPrompts(server);
  return server;
}
