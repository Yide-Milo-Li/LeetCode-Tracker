import type { TrackerApplication } from '../../../../packages/application/src/application.ts';
import type { McpController } from '../mcp/config.ts';
/** Routes receive the protected application, never raw storage or providers. */
export interface RouteContext { application: TrackerApplication; mcp?: McpController }
