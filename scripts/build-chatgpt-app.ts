/**
 * Builds the standalone self-contained ChatGPT Workspace HTML.
 * Bundles the React application and workspace stylesheet into apps/chatgpt/dist/workspace.html.
 */
import { build } from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { browserBuildAliases } from './browser-build-alias.ts';

const repoRoot = resolve(import.meta.dirname, '..');
const outDir = join(repoRoot, 'apps/chatgpt/dist');
mkdirSync(outDir, { recursive: true });

const bundleResult = await build({
  absWorkingDir: repoRoot,
  entryPoints: ['apps/chatgpt/src/index.tsx'],
  bundle: true,
  platform: 'browser',
  format: 'esm',
  target: 'es2023',
  write: false,
  minify: true,
  alias: browserBuildAliases,
  define: {
    'process.env.NODE_ENV': '"production"',
  },
});

const css = readFileSync(join(repoRoot, 'packages/workspace/src/styles.css'), 'utf8');
const jsCode = bundleResult.outputFiles[0].text.replaceAll('</script', '<\\/script');

const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>LeetCode Tracker Workspace</title>
  <style>html,body,#tracker-root{margin:0;min-height:100%;width:100%;} ${css}</style>
</head>
<body>
  <div id="tracker-root"></div>
  <script type="module">${jsCode}</script>
</body>
</html>`;

const targetHtml = join(outDir, 'workspace.html');
writeFileSync(targetHtml, html, 'utf8');

console.log(`ChatGPT Workspace app built: ${targetHtml} (${html.length} bytes)`);
