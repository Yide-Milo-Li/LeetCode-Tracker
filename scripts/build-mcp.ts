/**
 * Bundles the standalone MCP executable, chunks and skill so the npm package
 * ships without the workspace packages. Node built-ins (including
 * node:sqlite) stay external.
 */
import * as path from 'node:path';
import * as fs from 'node:fs';
import { build } from 'esbuild';

const repoRoot = path.resolve(import.meta.dirname, '..');
const entryPoint = path.join(repoRoot, 'apps/mcp/src/main.ts');
export async function bundleMcp(desktop = false): Promise<void> {
  const outdir = path.join(repoRoot, desktop ? 'apps/server/dist/mcp' : 'apps/mcp/dist');
  const outfile = path.join(outdir, 'leetcode-tracker-mcp.mjs');

  const started = Date.now();
  fs.rmSync(outdir, { recursive: true, force: true });
  await build({
    entryPoints: [entryPoint],
    bundle: true,
    platform: 'node',
    target: 'node26',
    format: 'esm',
    // Splitting keeps the store's dynamic schema import as its own chunk. A single
    // file would wrap shared modules (zod) in lazy initializers that the MCP SDK
    // reaches before they run ("ZodLazy is not a constructor").
    splitting: true,
    outdir,
    entryNames: 'leetcode-tracker-mcp',
    chunkNames: 'chunks/[name]-[hash]',
    outExtension: { '.js': '.mjs' },
    external: ['node:*'],
    // The source shebang is dropped by the bundler; the bin entry needs one.
    banner: {
      js: [
        '#!/usr/bin/env node',
        "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
      ].join('\n'),
    },
    legalComments: 'none',
    minify: false,
    logLevel: 'warning',
  });
  const skillDir = path.join(outdir, 'skills/lct');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.copyFileSync(path.join(repoRoot, 'skills/lct/SKILL.md'), path.join(skillDir, 'SKILL.md'));
  const size = fs.readdirSync(outdir, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .reduce((total, entry) => total + fs.statSync(path.join(entry.parentPath, entry.name)).size, 0);
  console.log(`[Build] ${path.relative(repoRoot, outfile)} (+chunks and skill) ${(size / 1024).toFixed(0)} KiB in ${Date.now() - started} ms`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) await bundleMcp();
