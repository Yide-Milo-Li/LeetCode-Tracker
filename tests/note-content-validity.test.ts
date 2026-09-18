/**
 * Unit and contract tests for note content validity (hasMeaningfulNoteContent)
 * and clipboard card fallbacks under Phase 23.
 */
import { it, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  hasMeaningfulNoteContent,
  NOTE_TEMPLATES,
  formatObsidianCallout,
  formatNotionCard,
} from '../packages/contracts/src/notes.ts';

const HISTORICAL_EN_TEMPLATE = [
  '## 💡 Key Idea & Approach',
  '- ',
  '',
  '---',
  '',
  '## ⏱️ Complexity Analysis',
  '- Time Complexity: $O(N)$',
  '- Space Complexity: $O(1)$',
  '',
  '---',
  '',
  '## 💻 Clean Implementation',
  '```python',
  'class Solution:',
  '    pass',
  '```',
  '',
  '---',
  '',
  '## ⚠️ Edge Cases & Traps',
  '- ',
  '',
].join('\n');

const HISTORICAL_ZH_TEMPLATE = [
  '## 💡 核心思路',
  '- ',
  '',
  '---',
  '',
  '## ⏱️ 复杂度分析',
  '- 时间复杂度: $O(N)$',
  '- 空间复杂度: $O(1)$',
  '',
  '---',
  '',
  '## 💻 最佳实现',
  '```python',
  'class Solution:',
  '    pass',
  '```',
  '',
  '---',
  '',
  '## ⚠️ 避坑与边界情况',
  '- ',
  '',
].join('\n');

describe('Note Content Validity: hasMeaningfulNoteContent', () => {
  it('returns false for null, undefined, empty or whitespace-only content', () => {
    assert.equal(hasMeaningfulNoteContent(null), false);
    assert.equal(hasMeaningfulNoteContent(undefined), false);
    assert.equal(hasMeaningfulNoteContent(''), false);
    assert.equal(hasMeaningfulNoteContent('   '), false);
    assert.equal(hasMeaningfulNoteContent('\n\n\t  \r\n'), false);
  });

  it('returns false for historical unfilled templates (English and Chinese)', () => {
    assert.equal(hasMeaningfulNoteContent(HISTORICAL_EN_TEMPLATE), false);
    assert.equal(hasMeaningfulNoteContent(HISTORICAL_ZH_TEMPLATE), false);
    // CRLF line endings
    assert.equal(hasMeaningfulNoteContent(HISTORICAL_EN_TEMPLATE.replace(/\n/g, '\r\n')), false);
    assert.equal(hasMeaningfulNoteContent(HISTORICAL_ZH_TEMPLATE.replace(/\n/g, '\r\n')), false);
  });

  it('returns false for current newly inserted unfilled templates', () => {
    assert.equal(hasMeaningfulNoteContent(NOTE_TEMPLATES.en), false);
    assert.equal(hasMeaningfulNoteContent(NOTE_TEMPLATES.zh), false);
  });

  it('returns false for partial template skeletons and empty markdown structures', () => {
    const onlyHeadings = `## 💡 Key Idea & Approach\n\n## ⏱️ Complexity Analysis\n\n## 💻 Clean Implementation`;
    assert.equal(hasMeaningfulNoteContent(onlyHeadings), false);

    const headingsWithDividersAndBullets = `## 💡 核心思路\n- \n---\n## ⏱️ 复杂度分析\n- 时间复杂度:\n- 空间复杂度:\n---\n`;
    assert.equal(hasMeaningfulNoteContent(headingsWithDividersAndBullets), false);

    const emptyFences = `\`\`\`python\n\`\`\`\n---\n- \n`;
    assert.equal(hasMeaningfulNoteContent(emptyFences), false);

    const skeletonWithClassPassOnly = `## 💻 最佳实现\n\`\`\`python\nclass Solution:\n    pass\n\`\`\``;
    assert.equal(hasMeaningfulNoteContent(skeletonWithClassPassOnly), false);
  });

  it('returns true when genuine user reflections are added to the template', () => {
    const withIdea = HISTORICAL_EN_TEMPLATE.replace(
      '- \n\n---',
      '- Use two pointers from opposite ends.\n\n---'
    );
    assert.equal(hasMeaningfulNoteContent(withIdea), true);

    const withCode = NOTE_TEMPLATES.zh.replace(
      '```python\n\n```',
      '```python\ndef twoSum(nums, target):\n    return [0, 1]\n```'
    );
    assert.equal(hasMeaningfulNoteContent(withCode), true);

    const withEdgeCase = NOTE_TEMPLATES.en.replace(
      '## ⚠️ Edge Cases & Traps\n-',
      '## ⚠️ Edge Cases & Traps\n- Empty input array or all duplicates'
    );
    assert.equal(hasMeaningfulNoteContent(withEdgeCase), true);
  });

  it('returns true when user updates default complexity in template', () => {
    const modifiedTimeComplexity = HISTORICAL_EN_TEMPLATE.replace(
      'Time Complexity: $O(N)$',
      'Time Complexity: $O(N \\log N)$'
    );
    assert.equal(hasMeaningfulNoteContent(modifiedTimeComplexity), true);

    const modifiedSpaceComplexity = HISTORICAL_ZH_TEMPLATE.replace(
      '空间复杂度: $O(1)$',
      '空间复杂度: $O(N)$'
    );
    assert.equal(hasMeaningfulNoteContent(modifiedSpaceComplexity), true);

    const filledBlankComplexity = NOTE_TEMPLATES.en.replace(
      'Time Complexity:',
      'Time Complexity: $O(\\sqrt{N})$'
    );
    assert.equal(hasMeaningfulNoteContent(filledBlankComplexity), true);
  });

  it('returns true for free-form notes without template headers', () => {
    assert.equal(hasMeaningfulNoteContent('Hash map solution with linear scan'), true);
    assert.equal(hasMeaningfulNoteContent('O(1) auxiliary memory'), true);
    assert.equal(hasMeaningfulNoteContent('```python\nreturn a + b\n```'), true);
    assert.equal(hasMeaningfulNoteContent('Remember to check left < right'), true);
  });
});

describe('Card / Callout Formatting with Note Fallback', () => {
  const dummyProblem = {
    frontendId: '1',
    title: 'Two Sum',
    url: 'https://leetcode.com/problems/two-sum/',
    difficulty: 'Easy',
    tags: ['Array', 'Hash Table'],
    slug: 'two-sum',
  };

  it('falls back to practice log notes when customNote is an unfilled template', () => {
    const callout = formatObsidianCallout(
      dummyProblem,
      { durationMinutes: 10, practicedAt: '2026-09-17T00:00:00Z', completed: true, notes: 'Quick hash map solve' },
      HISTORICAL_EN_TEMPLATE,
      'en'
    );
    assert.ok(callout.includes('Quick hash map solve'), 'Must contain practice notes fallback');
    assert.ok(!callout.includes('class Solution:'), 'Must not contain unfilled template placeholders');

    const card = formatNotionCard(
      dummyProblem,
      { durationMinutes: 10, practicedAt: '2026-09-17T00:00:00Z', completed: true, notes: 'Quick hash map solve' },
      HISTORICAL_ZH_TEMPLATE,
      'zh'
    );
    assert.ok(card.includes('Quick hash map solve'), 'Must contain practice notes fallback');
    assert.ok(!card.includes('class Solution:'), 'Must not contain unfilled template placeholders');
  });

  it('prefers customNote when it contains meaningful reflections', () => {
    const meaningfulNote = '## 💡 Key Idea & Approach\n- Two-pass hash table';
    const callout = formatObsidianCallout(
      dummyProblem,
      { durationMinutes: 10, practicedAt: '2026-09-17T00:00:00Z', completed: true, notes: 'Practice note' },
      meaningfulNote,
      'en'
    );
    assert.ok(callout.includes('Two-pass hash table'));
    assert.ok(!callout.includes('Practice note'));
  });

  it('renders no note section when neither meaningful customNote nor practice notes exist', () => {
    const callout = formatObsidianCallout(
      dummyProblem,
      { durationMinutes: 10, practicedAt: '2026-09-17T00:00:00Z', completed: true, notes: null },
      NOTE_TEMPLATES.en,
      'en'
    );
    assert.ok(!callout.includes('Notes & Reflections'));
  });
});
