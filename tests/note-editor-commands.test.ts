/**
 * Unit tests for pure Markdown editing commands (`markdownCommands.ts`)
 * and unified typing/programmatic undo-redo history (`textHistory.ts`).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  cutCurrentLine,
  getCurrentLineText,
  handleEnterKey,
  handleTabIndent,
  insertCodeBlock,
  insertLink,
  isInsideFencedCodeBlock,
  pasteUrlOverSelection,
  toggleInlineWrap,
  toggleLinePrefix,
} from '../apps/web/src/components/notes/markdownCommands.ts';
import { TextHistory } from '../apps/web/src/components/notes/textHistory.ts';

describe('toggleInlineWrap', () => {
  it('toggles bold, italic, and bold+italic stacking independently', () => {
    // Wrap bold
    const bold = toggleInlineWrap('hello world', 0, 5, '**');
    assert.deepEqual(bold, { value: '**hello** world', selectionStart: 2, selectionEnd: 7 });

    // Stack italic onto bold
    const boldItalic = toggleInlineWrap(bold.value, bold.selectionStart, bold.selectionEnd, '*');
    assert.deepEqual(boldItalic, { value: '***hello*** world', selectionStart: 3, selectionEnd: 8 });

    // Untoggle bold from bold+italic, leaving italic
    const italicOnly = toggleInlineWrap(boldItalic.value, boldItalic.selectionStart, boldItalic.selectionEnd, '**');
    assert.deepEqual(italicOnly, { value: '*hello* world', selectionStart: 1, selectionEnd: 6 });

    // Untoggle italic from italic
    const plain = toggleInlineWrap(italicOnly.value, italicOnly.selectionStart, italicOnly.selectionEnd, '*');
    assert.deepEqual(plain, { value: 'hello world', selectionStart: 0, selectionEnd: 5 });
  });

  it('unwraps when markers are included inside selection and guards against multi-span corruption', () => {
    const insideBold = toggleInlineWrap('**hello** world', 0, 9, '**');
    assert.deepEqual(insideBold, { value: 'hello world', selectionStart: 0, selectionEnd: 5 });

    const insideBoldItalic = toggleInlineWrap('***hello***', 0, 11, '*');
    assert.deepEqual(insideBoldItalic, { value: '**hello**', selectionStart: 0, selectionEnd: 9 });

    const multiSpanBold = toggleInlineWrap('**a** and **b**', 0, 15, '**');
    assert.equal(multiSpanBold.value, '****a** and **b****');

    const multiSpanItalic = toggleInlineWrap('*a* and *b*', 0, 11, '*');
    assert.equal(multiSpanItalic.value, '**a* and *b**');
  });

  it('supports strikethrough, inline code, math ($ vs $$), and trims outer whitespace', () => {
    const trimmed = toggleInlineWrap('  hello  ', 0, 9, '**');
    assert.deepEqual(trimmed, { value: '  **hello**  ', selectionStart: 4, selectionEnd: 9 });

    const strike = toggleInlineWrap('typo', 0, 4, '~~');
    assert.deepEqual(strike, { value: '~~typo~~', selectionStart: 2, selectionEnd: 6 });
    assert.deepEqual(toggleInlineWrap(strike.value, strike.selectionStart, strike.selectionEnd, '~~'), {
      value: 'typo',
      selectionStart: 0,
      selectionEnd: 4,
    });

    const code = toggleInlineWrap('arr[i]', 0, 6, '`');
    assert.deepEqual(code, { value: '`arr[i]`', selectionStart: 1, selectionEnd: 7 });

    // Does not confuse $$x$$ block math with single-$ inline math
    const blockMath = toggleInlineWrap('$$x$$', 2, 3, '$');
    assert.deepEqual(blockMath, { value: '$$$x$$$', selectionStart: 3, selectionEnd: 4 });
  });

  it('promotes multi-line inline code selection to a fenced code block and toggles it back', () => {
    const fenced = toggleInlineWrap('line1\nline2', 0, 11, '`');
    assert.deepEqual(fenced, { value: '```\nline1\nline2\n```\n', selectionStart: 4, selectionEnd: 15 });

    const unfenced = toggleInlineWrap(fenced.value, fenced.selectionStart, fenced.selectionEnd, '`');
    assert.equal(unfenced.value, 'line1\nline2\n');
    assert.equal(unfenced.value.slice(unfenced.selectionStart, unfenced.selectionEnd), 'line1\nline2');
  });

  it('handles collapsed cursor empty-pair toggle and toolbar placeholder selection', () => {
    const inserted = toggleInlineWrap('ab', 1, 1, '**');
    assert.deepEqual(inserted, { value: 'a****b', selectionStart: 3, selectionEnd: 3 });

    // Toggling off empty pair restores original string
    const removed = toggleInlineWrap(inserted.value, inserted.selectionStart, inserted.selectionEnd, '**');
    assert.deepEqual(removed, { value: 'ab', selectionStart: 1, selectionEnd: 1 });

    // Inside **|** toggling * adds italic rather than breaking **
    const stackEmpty = toggleInlineWrap('****', 2, 2, '*');
    assert.deepEqual(stackEmpty, { value: '******', selectionStart: 3, selectionEnd: 3 });
    const unstackEmpty = toggleInlineWrap(stackEmpty.value, stackEmpty.selectionStart, stackEmpty.selectionEnd, '*');
    assert.deepEqual(unstackEmpty, { value: '****', selectionStart: 2, selectionEnd: 2 });

    // Toolbar placeholder
    const withPlaceholder = toggleInlineWrap('', 0, 0, '$', { placeholder: 'O(n)' });
    assert.deepEqual(withPlaceholder, { value: '$O(n)$', selectionStart: 1, selectionEnd: 5 });
  });
});

describe('toggleLinePrefix', () => {
  it('toggles headings, lists, tasks, and quotes on single and multi-line selections', () => {
    // Mid-line caret heading toggle
    const h1 = toggleLinePrefix('Approach', 4, 4, 'heading');
    assert.deepEqual(h1, { value: '### Approach', selectionStart: 8, selectionEnd: 8 });
    const hOff = toggleLinePrefix(h1.value, h1.selectionStart, h1.selectionEnd, 'heading');
    assert.deepEqual(hOff, { value: 'Approach', selectionStart: 4, selectionEnd: 4 });

    // Normalizes ## heading to ###
    const hReplace = toggleLinePrefix('## Title', 3, 3, 'heading');
    assert.deepEqual(hReplace, { value: '### Title', selectionStart: 4, selectionEnd: 4 });

    // Multi-line ordered list numbering and toggle off
    const ol = toggleLinePrefix('first\nsecond\nthird', 0, 18, 'ol');
    assert.deepEqual(ol, { value: '1. first\n2. second\n3. third', selectionStart: 0, selectionEnd: 27 });
    const olOff = toggleLinePrefix(ol.value, ol.selectionStart, ol.selectionEnd, 'ol');
    assert.deepEqual(olOff, { value: 'first\nsecond\nthird', selectionStart: 0, selectionEnd: 18 });
  });

  it('switches list marker types while preserving indentation', () => {
    const task = toggleLinePrefix('  - item', 5, 5, 'task');
    assert.deepEqual(task, { value: '  - [ ] item', selectionStart: 9, selectionEnd: 9 });

    const ul = toggleLinePrefix('  - [x] done', 8, 8, 'ul');
    assert.deepEqual(ul, { value: '  - done', selectionStart: 4, selectionEnd: 4 });

    const quote = toggleLinePrefix('  note', 4, 4, 'quote');
    assert.deepEqual(quote, { value: '  > note', selectionStart: 6, selectionEnd: 6 });
    const quoteOff = toggleLinePrefix(quote.value, quote.selectionStart, quote.selectionEnd, 'quote');
    assert.deepEqual(quoteOff, { value: '  note', selectionStart: 4, selectionEnd: 4 });
  });

  it('inserts placeholder on empty line when provided', () => {
    const emptyTask = toggleLinePrefix('', 0, 0, 'task', { placeholder: 'Task' });
    assert.deepEqual(emptyTask, { value: '- [ ] Task', selectionStart: 6, selectionEnd: 10 });
  });
});

describe('insertLink, pasteUrlOverSelection & insertCodeBlock', () => {
  it('builds Markdown links cleanly for text, URL, and empty selections', () => {
    const fromText = insertLink('See problem', 4, 11);
    assert.deepEqual(fromText, { value: 'See [problem](url)', selectionStart: 14, selectionEnd: 17 });

    const fromUrl = insertLink('https://leetcode.com', 0, 20, { textPlaceholder: 'link' });
    assert.deepEqual(fromUrl, { value: '[link](https://leetcode.com)', selectionStart: 1, selectionEnd: 5 });

    const fromEmpty = insertLink('', 0, 0);
    assert.deepEqual(fromEmpty, { value: '[](url)', selectionStart: 1, selectionEnd: 1 });
  });

  it('wraps selected text with pasted URL except inside code or URLs', () => {
    const wrapped = pasteUrlOverSelection('check LeetCode now', 6, 14, 'https://leetcode.com');
    assert.deepEqual(wrapped, {
      value: 'check [LeetCode](https://leetcode.com) now',
      selectionStart: 38,
      selectionEnd: 38,
    });

    assert.equal(pasteUrlOverSelection('check LeetCode', 6, 14, 'not a url'), null);
    assert.equal(pasteUrlOverSelection('https://a.com', 0, 13, 'https://b.com'), null);
    assert.equal(pasteUrlOverSelection('`code`', 1, 5, 'https://a.com'), null);
    assert.equal(pasteUrlOverSelection('```\ncode\n```', 4, 8, 'https://a.com'), null);
    assert.equal(isInsideFencedCodeBlock('```ts\nconst x = 1;\n```', 10), true);
    assert.equal(isInsideFencedCodeBlock('```ts\nconst x = 1;\n```\ntext', 25), false);
  });

  it('inserts fenced code blocks cleanly at start and mid-document', () => {
    const atStart = insertCodeBlock('', 0, 0, 'python', '# code');
    assert.deepEqual(atStart, { value: '```python\n# code\n```\n', selectionStart: 10, selectionEnd: 16 });

    const midLine = insertCodeBlock('Idea:\n', 4, 4, 'cpp', '// code');
    assert.deepEqual(midLine, { value: 'Idea\n```cpp\n// code\n```\n:\n', selectionStart: 12, selectionEnd: 19 });
  });
});

describe('handleEnterKey, handleTabIndent & current-line copy/cut', () => {
  it('continues lists, tasks (unchecked), numbered items, quotes, and exits on empty item', () => {
    const ulNext = handleEnterKey('- first', 7, 7);
    assert.deepEqual(ulNext, { value: '- first\n- ', selectionStart: 10, selectionEnd: 10 });

    const olNext = handleEnterKey('  2. second', 11, 11);
    assert.deepEqual(olNext, { value: '  2. second\n  3. ', selectionStart: 17, selectionEnd: 17 });

    const taskNext = handleEnterKey('- [x] done', 10, 10);
    assert.deepEqual(taskNext, { value: '- [x] done\n- [ ] ', selectionStart: 17, selectionEnd: 17 });

    const quoteNext = handleEnterKey('> idea', 6, 6);
    assert.deepEqual(quoteNext, { value: '> idea\n> ', selectionStart: 9, selectionEnd: 9 });

    const exitEmpty = handleEnterKey('- item\n- ', 9, 9);
    assert.deepEqual(exitEmpty, { value: '- item\n', selectionStart: 7, selectionEnd: 7 });

    // Inside fenced code block preserves indentation
    const codeIndent = handleEnterKey('```ts\n  if (x) {', 16, 16);
    assert.deepEqual(codeIndent, { value: '```ts\n  if (x) {\n  ', selectionStart: 19, selectionEnd: 19 });
  });

  it('indents/outdents inline, list items, and multi-line selections', () => {
    const inlineTab = handleTabIndent('abc', 1, 1, false);
    assert.deepEqual(inlineTab, { value: 'a  bc', selectionStart: 3, selectionEnd: 3 });

    const listIndent = handleTabIndent('- item', 4, 4, false);
    assert.deepEqual(listIndent, { value: '  - item', selectionStart: 6, selectionEnd: 6 });

    const listOutdent = handleTabIndent('  - item', 6, 6, true);
    assert.deepEqual(listOutdent, { value: '- item', selectionStart: 4, selectionEnd: 4 });

    const multiIndent = handleTabIndent('- a\n\n- b', 0, 8, false);
    assert.deepEqual(multiIndent, { value: '  - a\n\n  - b', selectionStart: 0, selectionEnd: 12 });

    const multiOutdent = handleTabIndent(multiIndent.value, 0, 12, true);
    assert.deepEqual(multiOutdent, { value: '- a\n\n- b', selectionStart: 0, selectionEnd: 8 });
  });

  it('extracts and cuts current line across first, middle, last, single, and empty lines', () => {
    assert.equal(getCurrentLineText('one\ntwo\nthree', 5), 'two');

    const cutFirst = cutCurrentLine('one\ntwo', 1);
    assert.deepEqual(cutFirst, {
      lineText: 'one',
      edit: { value: 'two', selectionStart: 1, selectionEnd: 1 },
    });

    const cutLast = cutCurrentLine('one\ntwo', 6);
    assert.deepEqual(cutLast, {
      lineText: 'two',
      edit: { value: 'one', selectionStart: 3, selectionEnd: 3 },
    });

    const cutSingle = cutCurrentLine('only', 2);
    assert.deepEqual(cutSingle, {
      lineText: 'only',
      edit: { value: '', selectionStart: 0, selectionEnd: 0 },
    });

    assert.equal(cutCurrentLine('', 0), null);
  });
});

describe('TextHistory', () => {
  it('coalesces contiguous typing bursts and breaks on pause, newline, cursor jump, and direction switch', () => {
    const h = new TextHistory('', 50, 600);
    h.recordTyping({ value: 'a', selectionStart: 1, selectionEnd: 1 }, 100);
    h.recordTyping({ value: 'ab', selectionStart: 2, selectionEnd: 2 }, 200);
    h.recordTyping({ value: 'abc', selectionStart: 3, selectionEnd: 3 }, 300);
    // Pause > 600ms creates new entry
    h.recordTyping({ value: 'abcd', selectionStart: 4, selectionEnd: 4 }, 1100);
    // Newline creates new entry
    h.recordTyping({ value: 'abcd\n', selectionStart: 5, selectionEnd: 5 }, 1200);
    // Backspace switches direction -> new entry
    h.recordTyping({ value: 'abcd', selectionStart: 4, selectionEnd: 4 }, 1300);

    assert.deepEqual(h.undo(), { value: 'abcd\n', selectionStart: 5, selectionEnd: 5 });
    assert.deepEqual(h.undo(), { value: 'abcd', selectionStart: 4, selectionEnd: 4 });
    assert.deepEqual(h.undo(), { value: 'abc', selectionStart: 3, selectionEnd: 3 });
    assert.deepEqual(h.undo(), { value: '', selectionStart: 0, selectionEnd: 0 });
    assert.equal(h.undo(), null);

    assert.deepEqual(h.redo(), { value: 'abc', selectionStart: 3, selectionEnd: 3 });
  });

  it('preserves pre-command selection on programmatic undo/redo and truncates stale redo branch', () => {
    const h = new TextHistory('hello world', 50, 600);
    h.recordProgrammatic(
      { start: 0, end: 5 },
      { value: '**hello** world', selectionStart: 2, selectionEnd: 7 },
    );
    assert.deepEqual(h.undo(), { value: 'hello world', selectionStart: 0, selectionEnd: 5 });
    assert.deepEqual(h.redo(), { value: '**hello** world', selectionStart: 2, selectionEnd: 7 });

    h.undo();
    h.recordTyping({ value: 'hi', selectionStart: 2, selectionEnd: 2 }, 2000);
    assert.equal(h.canRedo(), false);
  });

  it('caps history length and resets cleanly', () => {
    const h = new TextHistory('0', 3, 600);
    h.recordProgrammatic({ start: 0, end: 1 }, { value: '1', selectionStart: 1, selectionEnd: 1 });
    h.recordProgrammatic({ start: 1, end: 1 }, { value: '2', selectionStart: 1, selectionEnd: 1 });
    h.recordProgrammatic({ start: 1, end: 1 }, { value: '3', selectionStart: 1, selectionEnd: 1 });
    assert.deepEqual(h.undo(), { value: '2', selectionStart: 1, selectionEnd: 1 });
    assert.deepEqual(h.undo(), { value: '1', selectionStart: 1, selectionEnd: 1 });
    assert.equal(h.undo(), null);

    h.reset('fresh', 0, 0);
    assert.equal(h.canUndo(), false);
    assert.equal(h.canRedo(), false);
    assert.deepEqual(h.current(), { value: 'fresh', selectionStart: 0, selectionEnd: 0 });
  });
});
