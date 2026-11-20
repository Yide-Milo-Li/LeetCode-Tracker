// Full integrity and foreign-key scans run on a closed snapshot, off the API thread.
import { workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { inspectCatalogSchema } from './schema.ts';

const snapshot = new DatabaseSync(workerData as string, { readOnly: true });
try {
  inspectCatalogSchema(snapshot);
} finally {
  snapshot.close();
}
