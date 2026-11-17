import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { formatMarkdown, prepareAiFormat, applyAiLayout } from '../packages/markdown/src/index.ts';
import { NOTE_TEMPLATES, hasMeaningfulNoteContent } from '../packages/contracts/src/notes.ts';
import { CatalogStore } from '../packages/database/src/store.ts';
import { buildApp } from '../apps/server/src/app.ts';
import { LLMAssistant } from '../apps/server/src/llm/assistant.ts';
import { LLMError } from '../apps/server/src/llm/types.ts';
import type { DiagnosticTrace } from '../apps/server/src/llm/diagnostics.ts';

describe('Markdown formatting and preservation', () => {
  it('normalizes Markdown idempotently while preserving wrong code, formulas, links, and task state', () => {
    const code = 'if a = b:\n\treturn  false  # intentional mistake';
    const source = `## Notes\n\n* [x] Old attempt\n* [ ] Still unsure\n\n\`\`\`python\n${code}\n\`\`\`\n\n$a  <  b$ and [link](https://example.com/a)\n`;
    const result = formatMarkdown(source);
    assert.equal(result.status, 'formatted');
    assert.ok(result.content.includes(code));
    assert.ok(result.content.includes('$a  <  b$'));
    assert.ok(result.content.includes('[link](https://example.com/a)'));
    assert.ok(result.content.includes('- [x] Old attempt'));
    assert.deepEqual(formatMarkdown(result.content), { content: result.content, status: 'unchanged' });
  });

  it('skips unclosed fences and recognized portable extensions without altering source', () => {
    for (const source of ['```python\nif a = b:\n  pass\n', '$$\na+b\n', '---\ntitle: Note\n---\n', 'See [[Old Mistake]]', '> [!note] Preserve\n']) {
      const result = formatMarkdown(source);
      assert.equal(result.status, 'skipped', source);
      assert.equal(result.content, source);
    }
    assert.notEqual(formatMarkdown('```text\n[[literal code]]\n```\n').status, 'skipped');
  });

  it('keeps empty template classification intact when the caller applies the safety guard', () => {
    for (const source of Object.values(NOTE_TEMPLATES)) {
      const result = formatMarkdown(source);
      const safe = hasMeaningfulNoteContent(source) === hasMeaningfulNoteContent(result.content) ? result.content : source;
      assert.equal(hasMeaningfulNoteContent(safe), false);
    }
  });

  it('uses original fragments to build a layout and redacts existing code, math and links from provider input', () => {
    const source = 'Title\nFirst try\nSecond try\n\n`SECRET_CODE` and $SECRET_MATH$ [ref](https://secret.invalid)\n\n```python\nSECRET_WRONG_CODE\n```\n';
    const prepared = prepareAiFormat(source);
    const providerInput = JSON.stringify(prepared.fragments);
    for (const secret of ['SECRET_CODE', 'SECRET_MATH', 'secret.invalid', 'SECRET_WRONG_CODE']) assert.ok(!providerInput.includes(secret));
    const candidate = applyAiLayout(prepared, [
      { style: 'heading', ids: ['f1'], level: 2 },
      { style: 'bullet_list', ids: ['f2', 'f3'] },
      { style: 'keep', ids: ['f4', 'f5'] },
    ]);
    assert.ok(candidate.startsWith('## Title\n\n- First try\n- Second try'));
    assert.ok(candidate.includes('`SECRET_CODE` and $SECRET_MATH$ [ref](https://secret.invalid)'));
    assert.ok(candidate.includes('```python\nSECRET_WRONG_CODE\n```'));
  });

  it('wraps unfenced source as code without changing the original code body', () => {
    const source = 'a = 1\nif a = 2:\n  pass\n';
    const prepared = prepareAiFormat(source);
    const candidate = applyAiLayout(prepared, [{ style: 'code', ids: prepared.fragments.map(fragment => fragment.id) }]);
    assert.equal(candidate, `\`\`\`\na = 1\nif a = 2:\n  pass\n\`\`\`\n`);
  });

  it('supports paragraph, ordered-list and quote layout instructions', () => {
    const source = 'one\ntwo\n';
    for (const [style, expected] of [
      ['paragraph', 'one\ntwo\n'],
      ['ordered_list', '1. one\n2. two\n'],
      ['quote', '> one\n>\n> two\n'],
    ] as const) {
      const prepared = prepareAiFormat(source);
      assert.equal(applyAiLayout(prepared, [{ style, ids: ['f1', 'f2'] }]), expected);
    }
  });

  it('expands a UTF-16 selection to full blocks and keeps surrounding source byte-for-byte', () => {
    const source = '前文 😀\n\nTitle\nfirst\n\nafter\n';
    const start = source.indexOf('Title') + 1;
    const prepared = prepareAiFormat(source, { start, end: source.indexOf('first') + 2 });
    const candidate = applyAiLayout(prepared, [{ style: 'heading', ids: ['f1'], level: 2 }, { style: 'paragraph', ids: ['f2'] }]);
    assert.ok(candidate.startsWith(source.slice(0, prepared.range.start)));
    assert.ok(candidate.endsWith(source.slice(prepared.range.end)));
    assert.ok(candidate.includes('## Title\n\nfirst'));
  });

  it('rejects dropped, duplicated, reordered, or repurposed protected fragments', () => {
    const prepared = prepareAiFormat('one\ntwo\n\n```js\nwrong()\n```\n');
    for (const groups of [
      [{ style: 'keep' as const, ids: ['f1', 'f3'] }],
      [{ style: 'keep' as const, ids: ['f1', 'f1', 'f3'] }],
      [{ style: 'keep' as const, ids: ['f2', 'f1', 'f3'] }],
      [{ style: 'keep' as const, ids: ['f1', 'f2'] }, { style: 'heading' as const, ids: ['f3'], level: 2 }],
    ]) assert.throws(() => applyAiLayout(prepared, groups));
  });
});

describe('Read-only AI note formatting API', () => {
  it('respects settings, sends only allowed fragments, returns a proposal and records usage without note content', async () => {
    const db = new DatabaseSync(':memory:');
    const store = new CatalogStore(db, { skipBackup: true });
    const traces: DiagnosticTrace[] = [];
    let prompt = '';
    const assistant = new LLMAssistant({ apiKey: 'synthetic-key', fallbackModels: [], diagnosticSink: trace => { traces.push(trace); },
      generateContentFn: async ({ contents }) => {
        prompt = contents;
        return { text: JSON.stringify({ groups: [{ style: 'heading', ids: ['f1'], level: 2 }, { style: 'keep', ids: ['f2', 'f3'] }] }),
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 } };
      } });
    const app = await buildApp({ store, geminiAssistant: assistant, disableStatic: true });
    try {
      assert.equal((await app.inject({ method: 'GET', url: '/api/v1/settings' })).json().notesFormatOnSave, true);
      const setting = await app.inject({ method: 'PATCH', url: '/api/v1/settings', payload: { notesFormatOnSave: false } });
      assert.equal(setting.json().notesFormatOnSave, false);
      assert.equal((await app.inject({ method: 'GET', url: '/api/v1/settings' })).json().notesFormatOnSave, false);
      const source = 'Title\nReflection\n\n```python\nPRIVATE_WRONG_CODE\n```\n';
      const res = await app.inject({ method: 'POST', url: '/api/v1/notes/format', payload: { content: source } });
      assert.equal(res.statusCode, 200, res.payload);
      assert.match(res.json().content, /^## Title/);
      assert.ok(res.json().content.includes('PRIVATE_WRONG_CODE'));
      assert.ok(!prompt.includes('PRIVATE_WRONG_CODE'));
      assert.equal((db.prepare('SELECT COUNT(*) AS count FROM problem_notes').get() as { count: number }).count, 0);
      assert.equal(traces.length, 1);
      assert.equal(traces[0].purpose, 'note_format');
      assert.ok(!JSON.stringify(traces).includes('PRIVATE_WRONG_CODE'));
    } finally { await app.close(); db.close(); }
  });

  it('rejects invalid provider operations and reports timeout without writing a note', async () => {
    const db = new DatabaseSync(':memory:');
    const store = new CatalogStore(db, { skipBackup: true });
    let mode: 'invalid' | 'timeout' = 'invalid';
    const app = await buildApp({ store, disableStatic: true, geminiAssistant: {
      getStatus: () => ({ configured: true, model: 'mock' }),
      formatProgressText: async () => ({ candidates: [], unparsedSnippets: [], model: 'mock' }),
      formatNoteMarkdown: async () => {
        if (mode === 'timeout') throw new LLMError('NOTE_FORMAT_TIMEOUT', 'Timed out', 504);
        return { groups: [{ style: 'keep', ids: ['f1', 'f1'] }], model: 'mock' };
      },
    } });
    try {
      const request = () => app.inject({ method: 'POST', url: '/api/v1/notes/format', payload: { content: 'one\ntwo' } });
      assert.equal((await request()).statusCode, 422);
      mode = 'timeout';
      assert.equal((await request()).statusCode, 504);
      assert.equal((db.prepare('SELECT COUNT(*) AS count FROM problem_notes').get() as { count: number }).count, 0);
    } finally { await app.close(); db.close(); }
  });

  it('rejects oversized input before invoking the provider', async () => {
    const db = new DatabaseSync(':memory:');
    const store = new CatalogStore(db, { skipBackup: true });
    let calls = 0;
    const app = await buildApp({ store, disableStatic: true, geminiAssistant: {
      getStatus: () => ({ configured: true, model: 'mock' }),
      formatProgressText: async () => ({ candidates: [], unparsedSnippets: [], model: 'mock' }),
      formatNoteMarkdown: async () => { calls++; return { groups: [], model: 'mock' }; },
    } });
    try {
      const res = await app.inject({ method: 'POST', url: '/api/v1/notes/format', payload: { content: 'x'.repeat(20001) } });
      assert.equal(res.statusCode, 413);
      assert.equal(calls, 0);
    } finally { await app.close(); db.close(); }
  });
});
