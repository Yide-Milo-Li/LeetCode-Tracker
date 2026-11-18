import type { TrackerApplication } from '../../../../packages/application/src/application.ts';
import type { DeviceSyncService } from '../sync/sync-service.ts';

export interface RouteContext {
  application: TrackerApplication;
  deviceSync: DeviceSyncService;
  afterBundleRestore: () => void;
}
