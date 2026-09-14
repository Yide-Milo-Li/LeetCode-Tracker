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

const repoRoot = path.resolve(import.meta.dirname, '..');
const entryPoint = path.join(repoRoot, 'apps/server/src/desktop-entry.ts');
const outdir = path.join(repoRoot, 'apps/server/dist');
const outfile = path.join(outdir, 'desktop-server.mjs');

async function bundleDesktopServer(): Promise<void> {
  console.log('[Build] Bundling desktop server...');
  if (!fs.existsSync(outdir)) {
    fs.mkdirSync(outdir, { recursive: true });
  }

  const startTime = Date.now();
  await build({
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
}

bundleDesktopServer().catch((err) => {
  console.error('Failed to bundle desktop server:', err);
  process.exit(1);
});
