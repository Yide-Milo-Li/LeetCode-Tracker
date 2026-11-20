/**
 * Bundles the Fastify desktop server and its domain/database/contract dependencies
 * into a standalone, production-ready ECMAScript module (ESM).
 *
 * Uses esbuild to package all workspace packages and external npm dependencies
 * while keeping Node.js 24 native built-ins (node:sqlite, node:fs, etc.) external.
 */
import * as path from 'node:path';
import * as fs from 'node:fs';
import { build } from 'esbuild';
import { backupWorkerDefine } from './backup-worker-build.ts';
import { bundleMcp } from './build-mcp.ts';

const repoRoot = path.resolve(import.meta.dirname, '..');
const entryPoint = path.join(repoRoot, 'apps/server/src/desktop-entry.ts');
const outdir = path.join(repoRoot, 'apps/server/dist');
const outfile = path.join(outdir, 'desktop-server.mjs');

async function bundleDesktopServer(): Promise<void> {
  console.log('[Build] Bundling desktop server...');
  if (!fs.existsSync(outdir)) {
    fs.mkdirSync(outdir, { recursive: true });
  }

  // Only the hosted distribution jobs opt in. Source builds never embed inherited credentials.
  let bundledGoogleClient;
  if (process.env.LCT_DESKTOP_DISTRIBUTION === 'official') {
    const clientId = process.env.LCT_GOOGLE_DESKTOP_CLIENT_ID?.trim();
    const clientSecret = process.env.LCT_GOOGLE_DESKTOP_CLIENT_SECRET?.trim();
    if (!clientId || !clientSecret) throw new Error('Official desktop builds require both Google Desktop OAuth settings');
    bundledGoogleClient = { clientId, clientSecret };
  }

  const startTime = Date.now();
  await build({
    define: { ...await backupWorkerDefine(), __LCT_BUNDLED_GOOGLE_CLIENT__: JSON.stringify(bundledGoogleClient) ?? 'undefined' },
    entryPoints: [entryPoint],
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'esm',
    outfile,
    sourcemap: false,
    external: [
      'node:*',
      'node:sqlite',
      'node:fs',
      'node:path',
      'node:crypto',
      'node:net',
      'node:readline',
      'node:os',
      'node:stream',
      'node:events',
      'node:buffer',
      'node:util',
      'node:url',
      'node:http',
      'node:https',
      'node:zlib',
      'node:perf_hooks',
      'node:async_hooks',
    ],
    banner: {
      js: `import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);`,
    },
    minify: false, // Keep readable stacktraces and predictable error reporting
    logLevel: 'info',
  });

  const duration = Date.now() - startTime;
  const stats = fs.statSync(outfile);
  const sizeMb = (stats.size / (1024 * 1024)).toFixed(2);
  console.log(`✓ Desktop server bundled successfully in ${duration}ms: ${outfile} (${sizeMb} MB)`);
  await bundleMcp(true);
}

bundleDesktopServer().catch((err) => {
  console.error('Failed to bundle desktop server:', err);
  process.exit(1);
});
