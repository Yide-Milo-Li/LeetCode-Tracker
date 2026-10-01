import type { TrackerApplication } from '../../../../packages/application/src/application.ts';
/** Routes receive the protected application, never raw storage or providers. */
export interface RouteContext { application: TrackerApplication }
