/** Verify the static production dependency graph, including any Vite shared chunks. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { build } from 'vite';

test('returning users load Today without the setup wizard or the Zod runtime', async () => {
  const root = path.resolve(import.meta.dirname, '../apps/web');
  const result = await build({ root, logLevel: 'silent', build: { write: false, sourcemap: true } });
  assert.ok(!Array.isArray(result) && 'output' in result);
  const chunks = result.output.filter(chunk => chunk.type === 'chunk');
  const entry = chunks.find(chunk => chunk.isEntry);
  assert.ok(entry);
  const pending = [entry];
  const visited = new Set<string>();
  while (pending.length) {
    const chunk = pending.pop()!;
    if (visited.has(chunk.fileName)) continue;
    visited.add(chunk.fileName);
    assert.ok(chunk.map?.sources.length, chunk.fileName);
    for (const source of chunk.map.sources) {
      assert.doesNotMatch(source, /\/node_modules\/zod\/|\/components\/SetupGuide\.tsx$/, chunk.fileName + ' includes ' + source);
    }
    for (const name of chunk.imports) {
      const dependency = chunks.find(item => item.fileName === name);
      assert.ok(dependency, 'Expected a bundled static dependency for ' + name);
      pending.push(dependency);
    }
  }
});
