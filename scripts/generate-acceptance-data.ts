/**
 * Generates synthetic test fixtures for Phase 35/36 field acceptance:
 * 1. Empty catalog JSONL
 * 2. Populated catalog JSONL (24 problems across Easy/Medium/Hard with tags)
 * 3. Current v4 and legacy v3 Snapshot Bundles containing settings, strategy, daily plan for today,
 *    practice records (with outcomes), short notes, and a long note (>4500 chars)
 *    for chunking/continuation testing.
 *
 * Supports --date YYYY-MM-DD, --timezone <tz>, and --output <directory> flags.
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CatalogStore } from '../packages/database/src/store.ts';
import { createTrackerApplication } from '../packages/application/src/application.ts';

// Parse CLI arguments
const args = process.argv.slice(2);
function getArg(name: string, fallback: string): string {
  const index = args.indexOf(`--${name}`);
  if (index !== -1 && args[index + 1]) return args[index + 1];
  const prefix = `--${name}=`;
  const match = args.find(a => a.startsWith(prefix));
  if (match) return match.slice(prefix.length);
  return fallback;
}

const targetTimezone = getArg('timezone', 'America/Los_Angeles');
const now = new Date();
const todayFormatted = getArg('date', new Intl.DateTimeFormat('en-CA', { timeZone: targetTimezone }).format(now));
let defaultOutputDir = resolve(import.meta.dirname, '../data');
if (!existsSync(defaultOutputDir)) {
  defaultOutputDir = resolve('.local/acceptance-bundle/data');
}
const outputDir = resolve(getArg('output', defaultOutputDir));
mkdirSync(outputDir, { recursive: true });

console.log(`[Acceptance Data Generator] Target Date: ${todayFormatted}, Timezone: ${targetTimezone}, Output: ${outputDir}`);

// 1. Empty Catalog
const emptyCatalogPath = join(outputDir, 'empty-catalog.jsonl');
writeFileSync(emptyCatalogPath, '', 'utf8');
console.log(`- Created empty catalog: ${emptyCatalogPath}`);

// 2. Synthetic Catalog (24 problems)
const rawProblems = [
  { id: '1', title: 'Two Sum', difficulty: 'Easy', tags: ['Array', 'Hash Table'], url: 'https://leetcode.com/problems/two-sum/' },
  { id: '2', title: 'Add Two Numbers', difficulty: 'Medium', tags: ['Linked List', 'Math'], url: 'https://leetcode.com/problems/add-two-numbers/' },
  { id: '3', title: 'Longest Substring Without Repeating Characters', difficulty: 'Medium', tags: ['Hash Table', 'String', 'Sliding Window'], url: 'https://leetcode.com/problems/longest-substring-without-repeating-characters/' },
  { id: '4', title: 'Median of Two Sorted Arrays', difficulty: 'Hard', tags: ['Array', 'Binary Search', 'Divide and Conquer'], url: 'https://leetcode.com/problems/median-of-two-sorted-arrays/' },
  { id: '5', title: 'Longest Palindromic Substring', difficulty: 'Medium', tags: ['Two Pointers', 'String', 'Dynamic Programming'], url: 'https://leetcode.com/problems/longest-palindromic-substring/' },
  { id: '6', title: 'Zigzag Conversion', difficulty: 'Medium', tags: ['String'], url: 'https://leetcode.com/problems/zigzag-conversion/' },
  { id: '7', title: 'Reverse Integer', difficulty: 'Medium', tags: ['Math'], url: 'https://leetcode.com/problems/reverse-integer/' },
  { id: '8', title: 'String to Integer (atoi)', difficulty: 'Medium', tags: ['String'], url: 'https://leetcode.com/problems/string-to-integer-atoi/' },
  { id: '9', title: 'Palindrome Number', difficulty: 'Easy', tags: ['Math'], url: 'https://leetcode.com/problems/palindrome-number/' },
  { id: '10', title: 'Regular Expression Matching', difficulty: 'Hard', tags: ['String', 'Dynamic Programming', 'Recursion'], url: 'https://leetcode.com/problems/regular-expression-matching/' },
  { id: '11', title: 'Container With Most Water', difficulty: 'Medium', tags: ['Array', 'Two Pointers', 'Greedy'], url: 'https://leetcode.com/problems/container-with-most-water/' },
  { id: '12', title: 'Integer to Roman', difficulty: 'Medium', tags: ['Hash Table', 'Math', 'String'], url: 'https://leetcode.com/problems/integer-to-roman/' },
  { id: '13', title: 'Roman to Integer', difficulty: 'Easy', tags: ['Hash Table', 'Math', 'String'], url: 'https://leetcode.com/problems/roman-to-integer/' },
  { id: '14', title: 'Longest Common Prefix', difficulty: 'Easy', tags: ['String', 'Trie'], url: 'https://leetcode.com/problems/longest-common-prefix/' },
  { id: '15', title: '3Sum', difficulty: 'Medium', tags: ['Array', 'Two Pointers', 'Sorting'], url: 'https://leetcode.com/problems/3sum/' },
  { id: '16', title: '3Sum Closest', difficulty: 'Medium', tags: ['Array', 'Two Pointers', 'Sorting'], url: 'https://leetcode.com/problems/3sum-closest/' },
  { id: '17', title: 'Letter Combinations of a Phone Number', difficulty: 'Medium', tags: ['Hash Table', 'String', 'Backtracking'], url: 'https://leetcode.com/problems/letter-combinations-of-a-phone-number/' },
  { id: '18', title: '4Sum', difficulty: 'Medium', tags: ['Array', 'Two Pointers', 'Sorting'], url: 'https://leetcode.com/problems/4sum/' },
  { id: '19', title: 'Remove Nth Node From End of List', difficulty: 'Medium', tags: ['Linked List', 'Two Pointers'], url: 'https://leetcode.com/problems/remove-nth-node-from-end-of-list/' },
  { id: '20', title: 'Valid Parentheses', difficulty: 'Easy', tags: ['String', 'Stack'], url: 'https://leetcode.com/problems/valid-parentheses/' },
  { id: '21', title: 'Merge Two Sorted Lists', difficulty: 'Easy', tags: ['Linked List', 'Recursion'], url: 'https://leetcode.com/problems/merge-two-sorted-lists/' },
  { id: '22', title: 'Generate Parentheses', difficulty: 'Medium', tags: ['String', 'Dynamic Programming', 'Backtracking'], url: 'https://leetcode.com/problems/generate-parentheses/' },
  { id: '23', title: 'Merge k Sorted Lists', difficulty: 'Hard', tags: ['Linked List', 'Divide and Conquer', 'Heap'], url: 'https://leetcode.com/problems/merge-k-sorted-lists/' },
  { id: '24', title: 'Swap Nodes in Pairs', difficulty: 'Medium', tags: ['Linked List', 'Recursion'], url: 'https://leetcode.com/problems/swap-nodes-in-pairs/' },
];

const catalogJsonl = rawProblems.map(p => JSON.stringify(p)).join('\n');
const catalogPath = join(outputDir, 'synthetic-catalog.jsonl');
writeFileSync(catalogPath, catalogJsonl, 'utf8');
console.log(`- Created synthetic catalog (${rawProblems.length} problems): ${catalogPath}`);

// 3. Long Note Sample (>4500 chars)
const longNoteSections = [
  '# 3. Longest Substring Without Repeating Characters\n',
  '## 1. Problem Clarification & Invariants\n' +
  'Given a string `s`, find the length of the longest substring without duplicate characters. ' +
  'A substring is a contiguous non-empty sequence of characters within a string. ' +
  'Our core invariant throughout the sliding window approach is that the window `[left, right]` ' +
  'always represents a valid substring containing no repeated characters at the end of each iteration. ' +
  'Whenever `s[right]` causes a collision with an existing character in the current window, ' +
  'the left boundary `left` must be contracted or fast-forwarded past the previous occurrence.\n',

  '## 2. Sliding Window Mechanics: Naive vs Fast-Forward Map\n' +
  'In the basic two-pointer approach, we increment `left` one step at a time until the duplicated ' +
  'character is evicted from our frequency map or set. While this guarantees O(2N) time complexity, ' +
  'it can perform redundant steps when the duplicate character was seen near the right boundary. ' +
  'By replacing the boolean frequency set with an index map (storing `lastSeenIndex[char]`), ' +
  'we can immediately advance `left` to `max(left, lastSeenIndex[char] + 1)`. ' +
  'Note that the `max` operation is strictly necessary because `lastSeenIndex[char]` might point ' +
  'to an index that has already fallen outside the current window (i.e. strictly smaller than `left`).\n',

  '## 3. ASCII Array vs Hash Map Memory Trade-offs\n' +
  'When the character set is restricted to standard ASCII (0-127) or Extended ASCII (0-255), ' +
  'a pre-allocated direct-mapped fixed-size integer array `int[128]` initialized to `-1` offers ' +
  'optimal CPU cache locality, eliminating dynamic memory allocations and hash collision overhead. ' +
  'However, when `s` contains arbitrary UTF-8 characters (e.g., CJK glyphs, emoji symbols, math notation), ' +
  'a general-purpose hash map or sparse array must be employed to avoid catastrophic memory inflation. ' +
  'In local desktop practice analysis, we track both Unicode code-point iterations and UTF-16 code-unit offsets.\n',

  '## 4. Formal Step-by-Step Trace & Example Walkthrough\n' +
  'Let us perform a complete trace on input string `s = "pwwkew"`:\n' +
  '- `right = 0, char = "p"`: not seen. Window: `[0, 0]` ("p"), length = 1, max = 1. Map: `{"p": 0}`.\n' +
  '- `right = 1, char = "w"`: not seen. Window: `[0, 1]` ("pw"), length = 2, max = 2. Map: `{"p": 0, "w": 1}`.\n' +
  '- `right = 2, char = "w"`: seen at index 1. `left = max(0, 1 + 1) = 2`. Window: `[2, 2]` ("w"), length = 1, max = 2. Map: `{"w": 2}`.\n' +
  '- `right = 3, char = "k"`: not seen in window. Window: `[2, 3]` ("wk"), length = 2, max = 2. Map: `{"k": 3}`.\n' +
  '- `right = 4, char = "e"`: not seen in window. Window: `[2, 4]` ("wke"), length = 3, max = 3. Map: `{"e": 4}`.\n' +
  '- `right = 5, char = "w"`: seen at index 2. `left = max(2, 2 + 1) = 3`. Window: `[3, 5]` ("kew"), length = 3, max = 3. Map: `{"w": 5}`.\n' +
  'Termination: Loop finishes. Final maximum length achieved is 3 ("wke" or "kew").\n',

  '## 5. Multi-Language Implementations\n' +
  '### TypeScript Implementation (Zero Allocation)\n' +
  '```typescript\n' +
  'export function lengthOfLongestSubstring(s: string): number {\n' +
  '  let maxLen = 0;\n' +
  '  let left = 0;\n' +
  '  const lastIndex = new Map<string, number>();\n' +
  '  for (let right = 0; right < s.length; right++) {\n' +
  '    const char = s[right];\n' +
  '    const prev = lastIndex.get(char);\n' +
  '    if (prev !== undefined && prev >= left) {\n' +
  '      left = prev + 1;\n' +
  '    }\n' +
  '    lastIndex.set(char, right);\n' +
  '    const currentLen = right - left + 1;\n' +
  '    if (currentLen > maxLen) maxLen = currentLen;\n' +
  '  }\n' +
  '  return maxLen;\n' +
  '}\n' +
  '```\n\n' +
  '### Rust Implementation (Safe Array Mapping)\n' +
  '```rust\n' +
  'pub fn length_of_longest_substring(s: String) -> i32 {\n' +
  '    let mut last_pos = [-1isize; 256];\n' +
  '    let mut max_len = 0isize;\n' +
  '    let mut left = 0isize;\n' +
  '    for (right, &byte) in s.as_bytes().iter().enumerate() {\n' +
  '        let prev = last_pos[byte as usize];\n' +
  '        if prev >= left {\n' +
  '            left = prev + 1;\n' +
  '        }\n' +
  '        last_pos[byte as usize] = right as isize;\n' +
  '        max_len = max_len.max(right as isize - left + 1);\n' +
  '    }\n' +
  '    max_len as i32\n' +
  '}\n' +
  '```\n\n' +
  '### Python Implementation\n' +
  '```python\n' +
  'class Solution:\n' +
  '    def lengthOfLongestSubstring(self, s: str) -> int:\n' +
  '        char_map = {}\n' +
  '        left = max_len = 0\n' +
  '        for right, char in enumerate(s):\n' +
  '            if char in char_map and char_map[char] >= left:\n' +
  '                left = char_map[char] + 1\n' +
  '            char_map[char] = right\n' +
  '            max_len = max(max_len, right - left + 1)\n' +
  '        return max_len\n' +
  '```\n',

  '## 6. Spaced Repetition Reminders & Variations\n' +
  '- Review Trigger: Re-examine this problem if error occurred during dynamic window boundary moves.\n' +
  '- Variant 1: Longest Substring with At Most K Distinct Characters (LeetCode 340).\n' +
  '- Variant 2: Longest Substring with At Most Two Distinct Characters (LeetCode 159).\n' +
  '- Variant 3: Subarrays with K Different Integers (Exact K = AtMost(K) - AtMost(K-1)).\n' +
  '- Complexity: O(N) time where N is the length of string `s`, O(min(M, N)) auxiliary space where M is charset size.\n' +
  '- Verification Checklist: Check empty string `""`, string with all unique characters `"abcdef"`, and string with all identical characters `"bbbb"`. All edge cases must return 0, 6, and 1 respectively.\n'
];

const longNoteContent = longNoteSections.join('\n');
const longNotePath = join(outputDir, 'long-note-sample.md');
writeFileSync(longNotePath, longNoteContent, 'utf8');
console.log(`- Created long note sample (${longNoteContent.length} chars, chunks=${Math.ceil(longNoteContent.length / 3000)}): ${longNotePath}`);

// 4. Build Synthetic Database in temp dir & Export Snapshot Bundle v3
const tempDir = mkdtempSync(join(tmpdir(), 'lc-acceptance-bundle-'));
const tempDbPath = join(tempDir, 'tracker.sqlite');
const tempBackupDir = join(tempDir, 'backups');
mkdirSync(tempBackupDir, { recursive: true });

let db: DatabaseSync | null = null;
try {
  db = new DatabaseSync(tempDbPath);
  const store = new CatalogStore(db, { backupDir: tempBackupDir, skipBackup: true });
  const app = createTrackerApplication({
    store,
    modelService: {
      getStatus: () => ({ configured: false, model: 'local' }),
      formatProgressText: async () => ({ candidates: [], unparsedSnippets: [], model: 'local' }),
    },
  });

  // Settings
  await app.settings.update({
    timezone: targetTimezone,
    language: 'zh',
    theme: 'system',
    palette: 'default',
  });

  // Catalog
  const preview = await app.catalog.preview({ content: catalogJsonl });
  await app.catalog.commit({ previewId: preview.previewId });

  // Strategy
  const strategy = await app.planning.createStrategy({
    name: 'Synthetic Daily Plan',
    weekdays: [0, 1, 2, 3, 4, 5, 6],
    rules: {
      dailyCount: 3,
      difficulty: { Easy: 40, Medium: 40, Hard: 20 },
      tags: [],
      premium: false,
      reviewEnabled: true,
      reviewPercent: 30,
      preference: '',
    },
  });

  // Generate today plan deterministically
  await app.planning.ensure({ date: todayFormatted });

  // Notes
  // Synthetic notes use the same restore-generation preconditions as normal writes.
  const expectedLibraryGeneration = store.getLibraryGeneration();
  await app.notes.save({ content: '# 1. Two Sum Note\nHash map complement lookup in one pass: O(N) time, O(N) space.', expectedRevision: 0, expectedLibraryGeneration }, { frontendId: '1' });
  await app.notes.save({ content: '# 2. Add Two Numbers Note\nUse dummy head pointer and maintain carry through addition.', expectedRevision: 0, expectedLibraryGeneration }, { frontendId: '2' });
  await app.notes.save({ content: longNoteContent, expectedRevision: 0, expectedLibraryGeneration }, { frontendId: '3' });

  // Practice records
  // Calculate relative dates for practice history
  const d0 = todayFormatted;
  const parseD = new Date(todayFormatted + 'T12:00:00Z');
  const dMinus1 = new Date(parseD.getTime() - 86400000).toISOString().slice(0, 10);
  const dMinus2 = new Date(parseD.getTime() - 2 * 86400000).toISOString().slice(0, 10);
  const dMinus4 = new Date(parseD.getTime() - 4 * 86400000).toISOString().slice(0, 10);
  const dMinus6 = new Date(parseD.getTime() - 6 * 86400000).toISOString().slice(0, 10);

  await app.practice.create({
    questionFrontendId: '1',
    practicedAt: d0,
    completed: true,
    outcome: 'independent',
    durationMinutes: 15,
    notes: 'Completed Two Sum independently using Map.',
  });

  await app.practice.create({
    questionFrontendId: '2',
    practicedAt: dMinus1,
    completed: true,
    outcome: 'assisted',
    durationMinutes: 25,
    notes: 'Needed help remembering the last carry check.',
  });

  await app.practice.create({
    questionFrontendId: '4',
    practicedAt: dMinus2,
    completed: false,
    outcome: 'unsolved',
    durationMinutes: 40,
    notes: 'Binary search partition condition needs more practice.',
  });

  await app.practice.create({
    questionFrontendId: '20',
    practicedAt: dMinus4,
    completed: true,
    outcome: 'independent',
    durationMinutes: 10,
    notes: 'Valid parentheses clean stack solution.',
  });

  await app.practice.create({
    questionFrontendId: '21',
    practicedAt: dMinus6,
    completed: true,
    outcome: 'independent',
    durationMinutes: 12,
    notes: 'Merge two sorted lists recursive solution.',
  });

  // Keep v3 for legacy-import acceptance; v4 is the current candidate's normal export.
  for (const version of [3, 4] as const) {
    const bundle = store.exportMigrationBundle(version);
    const bundlePath = join(outputDir, `synthetic-migration-bundle-v${version}.json`);
    writeFileSync(bundlePath, JSON.stringify(bundle, null, 2), 'utf8');
    console.log(`- Created synthetic migration bundle v${version}: ${bundlePath} (version=${bundle.version})`);
  }
} catch (err) {
  console.error('Error during data generation:', err);
  throw err;
} finally {
  if (db) {
    try { db.close(); } catch {}
  }
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {}
}

console.log('[Acceptance Data Generator] Complete!');
