import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

/** Keep the verification worker inside the relocatable MCP and desktop server bundles. */
export async function backupWorkerDefine() {
  const { outputFiles } = await build({
    entryPoints: [fileURLToPath(new URL('../packages/database/src/verify-backup-worker.ts', import.meta.url))],
    bundle: true, write: false, platform: 'node', format: 'esm', target: 'node24',
  });
  const url = 'data:text/javascript;base64,' + Buffer.from(outputFiles[0].contents).toString('base64');
  return { __LCT_VERIFY_BACKUP_WORKER__: JSON.stringify(url) };
}
