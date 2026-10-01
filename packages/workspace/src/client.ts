import type { createHttpTrackerClient } from './client-http-adapter.ts';
/** Full desktop business surface; embeds advertise the supported subset through their host. */
export type TrackerClient = ReturnType<typeof createHttpTrackerClient>['api'];
export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message); this.status = status; this.code = code;
  }
}
