/**
 * Pure problem-note templates, content meaningfulness checks, and export formatters.
 * Kept free of schema runtime dependencies so client views can import them without bundling Zod.
 */

/**
 * Default structural note templates for bilingual practice.
 * Omits default complexity answers and placeholder implementations so that empty templates are blank skeletons.
 */
export const NOTE_TEMPLATES = {
  en: `## 💡 Key Idea & Approach
-

---

## ⏱️ Complexity Analysis
- Time Complexity:
- Space Complexity:

---

## 💻 Clean Implementation
\`\`\`python

\`\`\`

---

## ⚠️ Edge Cases & Traps
-
`,
  zh: `## 💡 核心思路
-

---

## ⏱️ 复杂度分析
- 时间复杂度:
- 空间复杂度:

---

## 💻 最佳实现
\`\`\`python

\`\`\`

---

## ⚠️ 避坑与边界情况
-
`,
} as const;

/** Normalize only whitespace and line endings when identifying known template skeletons. */
function normalizeNoteSkeleton(content: string): string {
  return content.split(/\r\n?|\n/).map((line) => line.trim()).filter(Boolean).join('\n');
}

// Recognize historical answers only as part of the complete old template. The same
// answers entered into a blank/current note are user content, not placeholders.
const legacyNoteSkeletons = new Set(Object.values(NOTE_TEMPLATES).map((template) =>
  normalizeNoteSkeleton(template
    .replace(/(Time Complexity:|时间复杂度:)/, '$1 $O(N)$')
    .replace(/(Space Complexity:|空间复杂度:)/, '$1 $O(1)$')
    .replace('```python\n\n```', '```python\nclass Solution:\n    pass\n```'))
));

/**
 * Determine whether a problem note string contains meaningful user notes,
 * distinguishing genuine reflections, complexity notes, or code from blank notes
 * and unedited template skeletons (both legacy and current).
 *
 * Contract:
 * - Empty, whitespace-only, or unedited templates -> false
 * - Only built-in template skeleton / placeholders -> false
 * - Any genuine user reflections, complexity edits, code, or short notes -> true
 * - Conservative: Ambiguous non-empty content not strictly matching known placeholders defaults to true.
 */
export function hasMeaningfulNoteContent(content: string | null | undefined): boolean {
  if (!content) return false;
  const trimmed = content.trim();
  if (trimmed.length === 0) return false;

  const normalized = normalizeNoteSkeleton(trimmed);
  if (legacyNoteSkeletons.has(normalized)) return false;

  // A partial legacy implementation skeleton is recognizable only with its heading
  // and complete fenced starter block; standalone `pass` remains genuine content.
  const lines = normalized.replace(
    /(^|\n)## 💻 (?:Clean Implementation|最佳实现)\n```python\nclass Solution:\npass\n```(?=\n|$)/g,
    '$1'
  ).split('\n');
  const meaningfulLines: string[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length === 0) continue;

    // 1. Check known template headings
    if (
      line === '## 💡 Key Idea & Approach' ||
      line === '## 💡 核心思路' ||
      line === '## ⏱️ Complexity Analysis' ||
      line === '## ⏱️ 复杂度分析' ||
      line === '## 💻 Clean Implementation' ||
      line === '## 💻 最佳实现' ||
      line === '## ⚠️ Edge Cases & Traps' ||
      line === '## ⚠️ 避坑与边界情况' ||
      line === '## 📝 解题复盘与深度笔记' ||
      line === '## 📝 Solution & Reflection'
    ) {
      continue;
    }

    // 2. Horizontal divider lines (e.g. ---, ***, ___, - - -)
    if (/^(?:[-*_]\s*){3,}$/.test(line)) {
      continue;
    }

    // 3. Code block fences (``` or ```python)
    if (/^```(?:python|py|ts|js|java|cpp|c|go|rust)?$/i.test(line)) {
      continue;
    }

    // 4. Empty bullet points (e.g. "-" or "*" or "+")
    if (/^[-*+]$/.test(line)) {
      continue;
    }

    // Empty answer labels are structural; any supplied complexity is meaningful here.
    if (
      /^[-*]?\s*Time Complexity:\s*$/i.test(line) ||
      /^[-*]?\s*Space Complexity:\s*$/i.test(line) ||
      /^[-*]?\s*时间复杂度:\s*$/i.test(line) ||
      /^[-*]?\s*空间复杂度:\s*$/i.test(line)
    ) {
      continue;
    }

    // Any line not matching known built-in placeholders is genuine user content
    meaningfulLines.push(line);
  }

  return meaningfulLines.length > 0;
}

/**
 * Format a zero-padded filename for deterministic alphabetical ordering in Obsidian.
 */
export function formatProblemFilename(frontendId: string, slug: string): string {
  const num = parseInt(frontendId, 10);
  const prefix = Number.isSafeInteger(num) ? String(num).padStart(4, '0') : frontendId;
  const cleanSlug = slug.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
  return `${prefix}-${cleanSlug}.md`;
}

/**
 * Format single problem as a Notion Rich Block card for clipboard copying.
 * Adapts labels and statuses according to the requested language ('en' | 'zh').
 * If customNote has no meaningful content, falls back to practice log notes.
 */
export function formatNotionCard(
  problem: { frontendId: string; title: string; url: string; difficulty: string; tags: string[] },
  record?: { durationMinutes: number | null; practicedAt?: string; completed?: boolean; notes: string | null },
  customNote?: string | null,
  lang: 'en' | 'zh' = 'en'
): string {
  const isZh = lang === 'zh';
  const effectiveCustomNote = hasMeaningfulNoteContent(customNote) ? customNote!.trim() : null;
  const recordNotes = record?.notes && record.notes.trim().length > 0 ? record.notes.trim() : null;
  const noteContent = effectiveCustomNote || recordNotes;
  const tagList = problem.tags.join(', ');
  const durationStr = record?.durationMinutes
    ? (isZh ? `${record.durationMinutes} 分钟` : `${record.durationMinutes} min`)
    : (isZh ? '未记录' : 'Unrecorded');
  const statusStr = record?.completed
    ? (isZh ? '✅ 已解决' : '✅ Solved')
    : (isZh ? '⚠️ 尝试中' : '⚠️ Attempted');
  const dateStr = record?.practicedAt ? record.practicedAt.slice(0, 10) : new Date().toISOString().slice(0, 10);

  const dateLabel = isZh ? '日期' : 'Date';
  const durLabel = isZh ? '耗时' : 'Duration';
  const statusLabel = isZh ? '状态' : 'Status';
  const tagsLabel = isZh ? '标签' : 'Tags';
  const noneStr = isZh ? '无' : 'None';
  const notesHeading = isZh ? '复盘笔记与核心心得' : 'Notes & Key Takeaways';

  return `> 🎯 **[${problem.frontendId}. ${problem.title}](${problem.url})** · \`${problem.difficulty}\`
> 📅 **${dateLabel}**: ${dateStr} · ⏱️ **${durLabel}**: ${durationStr} · 🏆 **${statusLabel}**: ${statusStr}
> 🏷️ **${tagsLabel}**: ${tagList || noneStr}
${
  noteContent && noteContent.length > 0
    ? `> \n> 💡 **${notesHeading}**:\n> ${noteContent.replace(/\r?\n/g, '\n> ')}`
    : ''
}`;
}
