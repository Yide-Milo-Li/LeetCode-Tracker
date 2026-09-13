/**
 * Knowledge base export engine for Obsidian and Notion.
 * Generates structured Markdown files with YAML frontmatter, Dataview templates,
 * and Notion-compatible CSV tables, packaged into a ZIP archive.
 */
import type { DatabaseSync } from 'node:sqlite';
import * as zlib from 'node:zlib';

export interface ProblemExportData {
  questionId: string;
  questionFrontendId: string;
  title: string;
  titleSlug: string;
  difficulty: 'Easy' | 'Medium' | 'Hard';
  url: string;
  tags: string[];
  practices: Array<{
    practicedAt: string;
    completed: boolean;
    durationMinutes: number | null;
    notes: string | null;
    timePrecision: string;
  }>;
  customNote: string | null;
  reviewStage: number | null;
}

import { formatProblemFilename, formatObsidianCallout, formatNotionCard } from '../../contracts/src/notes.ts';
export { formatProblemFilename, formatObsidianCallout, formatNotionCard };

/**
 * Generate a complete Markdown note for a problem with YAML frontmatter,
 * practice timeline, and structured deep reflection sections.
 * Adapts headings, table labels, and default unwritten templates according to `lang`.
 */
export function generateProblemMarkdown(data: ProblemExportData, lang: 'en' | 'zh' = 'en'): string {
  const isZh = lang === 'zh';
  const hasAccepted = data.practices.some((p) => p.completed);
  const status = hasAccepted ? 'Solved' : data.practices.length > 0 ? 'Attempted' : 'Not Started';
  const statusDisplay = isZh
    ? (hasAccepted ? '已解决' : data.practices.length > 0 ? '尝试中' : '未开始')
    : status;
  const lastPractice = data.practices.length > 0 ? data.practices[0] : null;

  // 1. YAML Frontmatter
  const tagsYaml = data.tags.length > 0 ? data.tags.map((t) => `  - ${JSON.stringify(t)}`).join('\n') : '  - leetcode';

  const frontmatter = `---
id: ${JSON.stringify(data.questionFrontendId)}
title: ${JSON.stringify(data.title)}
slug: ${JSON.stringify(data.titleSlug)}
difficulty: ${data.difficulty}
tags:
${tagsYaml}
url: ${JSON.stringify(data.url)}
status: ${status}
total_practices: ${data.practices.length}
last_practiced: ${lastPractice ? JSON.stringify(lastPractice.practicedAt.slice(0, 10)) : 'null'}
duration_minutes: ${lastPractice?.durationMinutes ?? 'null'}
review_stage: ${data.reviewStage ?? 'null'}
---`;

  // 2. Body header and tags
  const tagsHash = data.tags.map((t) => `#leetcode/${t.toLowerCase().replace(/\s+/g, '-')}`).join(' ');

  // 3. Practice timeline table
  let timeline = '';
  if (data.practices.length > 0) {
    const rows = data.practices.map((p) => {
      const date = p.practicedAt.slice(0, 10);
      const st = isZh ? (p.completed ? '已解决' : '尝试中') : (p.completed ? 'Solved' : 'Attempted');
      const dur = p.durationMinutes
        ? (isZh ? `${p.durationMinutes} 分钟` : `${p.durationMinutes} min`)
        : '—';
      const cleanNotes = (p.notes || '—').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
      return `| ${date} | ${st} | ${dur} | ${cleanNotes} |`;
    });

    const timelineTitle = isZh ? '## 📅 练习记录' : '## 📅 Practice Timeline';
    const timelineHeaders = isZh
      ? '| 日期 | 状态 | 耗时 | 备注 |\n| :--- | :--- | :--- | :--- |'
      : '| Date | Status | Duration | Notes |\n| :--- | :--- | :--- | :--- |';

    timeline = `---

${timelineTitle}

${timelineHeaders}
${rows.join('\n')}`;
  }

  // 4. Deep note section
  let deepNote = '';
  if (data.customNote && data.customNote.trim().length > 0) {
    const noteHeading = isZh ? '## 📝 解题复盘与深度笔记' : '## 📝 Solution & Reflection';
    deepNote = `---

${noteHeading}

${data.customNote.trim()}`;
  } else if (isZh) {
    deepNote = `---

## 💡 核心思路
- 

---

## ⏱️ 复杂度分析
- 时间复杂度: $O(N)$
- 空间复杂度: $O(1)$

---

## 💻 最佳实现
\`\`\`python
class Solution:
    pass
\`\`\`

---

## ⚠️ 避坑与边界情况
- `;
  } else {
    deepNote = `---

## 💡 Key Idea & Approach
- 

---

## ⏱️ Complexity Analysis
- Time Complexity: $O(N)$
- Space Complexity: $O(1)$

---

## 💻 Clean Implementation
\`\`\`python
class Solution:
    pass
\`\`\`

---

## ⚠️ Edge Cases & Traps
- `;
  }

  const diffLabel = isZh ? '难度' : 'Difficulty';
  const statusLabel = isZh ? '状态' : 'Status';
  const tagsLabel = isZh ? '标签' : 'Tags';

  const sections = [
    `# [${data.questionFrontendId}. ${data.title}](${data.url})`,
    '',
    `> **${diffLabel}**: \`${data.difficulty}\` | **${statusLabel}**: \`${statusDisplay}\``,
    `> **${tagsLabel}**: ${tagsHash || '#leetcode'}`,
  ];

  if (timeline.trim().length > 0) {
    sections.push('', timeline.trim());
  }

  if (deepNote.trim().length > 0) {
    sections.push('', deepNote.trim());
  }

  return `${frontmatter}

${sections.join('\n')}
`;
}

/**
 * Generate README.md index for Obsidian Vault with Dataview query templates.
 * Supports bilingual formatting ('en' | 'zh').
 */
export function generateObsidianReadme(
  totalProblems: number,
  practicedProblems: number,
  lang: 'en' | 'zh' = 'en'
): string {
  if (lang === 'zh') {
    return `# 📚 LeetCode 个人算法知识库

由 **LeetCode Tracker** 导出的个人算法题库与做题笔记 Vault。

## 📊 题库概览
- **题库总题数**: ${totalProblems}
- **已练题目数**: ${practicedProblems}
- **导出日期**: ${new Date().toISOString().slice(0, 10)}

---

## ⚡ Dataview 动态仪表盘

> [!TIP]
> 若您在 Obsidian 中安装了 **Dataview** 插件，下方代码块将自动渲染为动态交互表格！

### 最近练习记录
\`\`\`dataview
TABLE difficulty AS "难度", status AS "状态", duration_minutes AS "耗时 (分钟)", review_stage AS "复习阶段", last_practiced AS "最后练习"
FROM #leetcode
WHERE last_practiced != null
SORT last_practiced DESC
LIMIT 20
\`\`\`

### 待复习题目
\`\`\`dataview
TABLE difficulty AS "难度", duration_minutes AS "耗时 (分钟)", review_stage AS "复习阶段"
FROM #leetcode
WHERE review_stage > 0 AND status = "Solved"
SORT review_stage ASC
LIMIT 25
\`\`\`

---

## 🔗 双链引用规范
所有题目笔记均位于 \`problems/\` 目录下，并按照补零题号与英文 slug 规范命名，例如：\`[[0001-two-sum]]\`。
在您的每日日记（Daily Note）或分类专题笔记中，可以直接使用 \`[[题号-slug]]\` 快速引用任意题目！
`;
  }

  return `# 📚 LeetCode Personal Knowledge Base

An exportable personal algorithm and practice vault generated by **LeetCode Tracker**.

## 📊 Overview
- **Total Problems**: ${totalProblems}
- **Practiced Problems**: ${practicedProblems}
- **Exported At**: ${new Date().toISOString().slice(0, 10)}

---

## ⚡ Dataview Dashboard

> [!TIP]
> If you have the Obsidian **Dataview** plugin installed, the queries below will automatically render interactive tables!

### Recently Practiced
\`\`\`dataview
TABLE difficulty AS "Difficulty", status AS "Status", duration_minutes AS "Duration (min)", review_stage AS "Review Stage", last_practiced AS "Last Practiced"
FROM #leetcode
WHERE last_practiced != null
SORT last_practiced DESC
LIMIT 20
\`\`\`

### Problems for Review
\`\`\`dataview
TABLE difficulty AS "Difficulty", duration_minutes AS "Duration (min)", review_stage AS "Review Stage"
FROM #leetcode
WHERE review_stage > 0 AND status = "Solved"
SORT review_stage ASC
LIMIT 25
\`\`\`

---

## 🔗 Wikilink Index Convention
All problem notes are located in the \`problems/\` directory and formatted deterministically, e.g.: \`[[0001-two-sum]]\`.
In your daily notes or topic notes, you can link directly to any problem using \`[[frontendId-slug]]\`!
`;
}

/**
 * Generate standard CSVs for Notion Database import.
 */
export function generateNotionCsvs(db: DatabaseSync): {
  problemsSummaryCsv: string;
  practiceHistoryCsv: string;
} {
  // 1. Problems Summary CSV
  const problems = db
    .prepare(
      `SELECT
         p.question_id AS questionId,
         p.frontend_question_id AS frontendId,
         p.title,
         p.difficulty,
         p.url,
         n.content AS customNote,
         (SELECT count(*) FROM practice_records pr WHERE pr.question_id = p.question_id AND pr.status = 'active') AS totalPractices,
         (SELECT max(pr.practiced_at) FROM practice_records pr WHERE pr.question_id = p.question_id AND pr.status = 'active') AS lastPracticedAt,
         (SELECT pr.notes FROM practice_records pr WHERE pr.question_id = p.question_id AND pr.status = 'active' AND pr.notes IS NOT NULL ORDER BY pr.practiced_at DESC LIMIT 1) AS latestNotes,
         (
           SELECT CASE WHEN count(*) > 0 THEN 1 ELSE 0 END
           FROM (
             SELECT 1 FROM practice_records pr WHERE pr.question_id = p.question_id AND pr.completed = 1 AND pr.status = 'active'
             UNION ALL
             SELECT 1 FROM progress_snapshots ps WHERE ps.question_id = p.question_id AND ps.has_accepted = 1 AND ps.status = 'active'
           )
         ) AS hasAccepted,
         (SELECT payload_json FROM problem_review_state prs WHERE prs.question_id = p.question_id) AS reviewPayload
       FROM problems p
       LEFT JOIN problem_notes n ON n.question_id = p.question_id
       ORDER BY CAST(p.frontend_question_id AS INTEGER) ASC`
    )
    .all() as Array<{
      questionId: string;
      frontendId: string;
      title: string;
      difficulty: string;
      url: string;
      customNote: string | null;
      totalPractices: number;
      lastPracticedAt: string | null;
      latestNotes: string | null;
      hasAccepted: number;
      reviewPayload: string | null;
    }>;

  // Retrieve tags
  const tagRows = db
    .prepare(
      `SELECT pt.question_id AS qid, t.name AS tagName
       FROM problem_tags pt
       JOIN tags t ON t.slug = pt.tag_slug
       ORDER BY t.name ASC`
    )
    .all() as Array<{ qid: string; tagName: string }>;

  const tagMap = new Map<string, string[]>();
  for (const tr of tagRows) {
    const arr = tagMap.get(tr.qid) ?? [];
    arr.push(tr.tagName);
    tagMap.set(tr.qid, arr);
  }

  const escapeCsv = (val: string | number | null | undefined): string => {
    if (val === null || val === undefined) return '';
    const s = String(val);
    if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };

  const summaryHeaders = [
    'Title',
    'Number',
    'Difficulty',
    'Tags',
    'Status',
    'Last Practiced',
    'Total Practices',
    'Review Stage',
    'URL',
    'Notes',
  ];

  const summaryRows = problems.map((p) => {
    let stage: number | '' = '';
    if (p.reviewPayload) {
      try {
        const parsed = JSON.parse(p.reviewPayload);
        if (typeof parsed?.stage === 'number') stage = parsed.stage;
      } catch {
        // ignore
      }
    }
    const status = p.hasAccepted === 1 ? 'Solved' : p.totalPractices > 0 ? 'Attempted' : 'Not Started';
    const tagsStr = (tagMap.get(p.questionId) ?? []).join(', ');
    const noteText = (p.customNote || p.latestNotes || '').trim();

    return [
      escapeCsv(`${p.frontendId}. ${p.title}`),
      escapeCsv(p.frontendId),
      escapeCsv(p.difficulty),
      escapeCsv(tagsStr),
      escapeCsv(status),
      escapeCsv(p.lastPracticedAt ? p.lastPracticedAt.slice(0, 10) : ''),
      escapeCsv(p.totalPractices),
      escapeCsv(stage),
      escapeCsv(p.url),
      escapeCsv(noteText),
    ].join(',');
  });

  const problemsSummaryCsv = '\uFEFF' + [summaryHeaders.join(','), ...summaryRows].join('\r\n');

  // 2. Practice History CSV
  const historyRecords = db
    .prepare(
      `SELECT
         p.frontend_question_id AS frontendId,
         p.title,
         pr.practiced_at AS practicedAt,
         pr.completed,
         pr.duration_minutes AS durationMinutes,
         pr.notes,
         pr.source_timezone AS sourceTimezone
       FROM practice_records pr
       JOIN problems p ON p.question_id = pr.question_id
       WHERE pr.status = 'active'
       ORDER BY pr.practiced_at DESC`
    )
    .all() as Array<{
      frontendId: string;
      title: string;
      practicedAt: string;
      completed: number;
      durationMinutes: number | null;
      notes: string | null;
      sourceTimezone: string | null;
    }>;

  const historyHeaders = ['Problem', 'Number', 'Date', 'Duration (min)', 'Status', 'Notes', 'Timezone'];
  const historyRows = historyRecords.map((r) => [
    escapeCsv(`${r.frontendId}. ${r.title}`),
    escapeCsv(r.frontendId),
    escapeCsv(r.practicedAt.slice(0, 10)),
    escapeCsv(r.durationMinutes ?? ''),
    escapeCsv(r.completed === 1 ? 'Solved' : 'Attempted'),
    escapeCsv((r.notes || '').trim()),
    escapeCsv(r.sourceTimezone || ''),
  ].join(','));

  const practiceHistoryCsv = '\uFEFF' + [historyHeaders.join(','), ...historyRows].join('\r\n');

  return { problemsSummaryCsv, practiceHistoryCsv };
}

/**
 * Pack a list of virtual files into a standard, zero-dependency ZIP archive Buffer.
 */
export function buildZipArchive(entries: Array<{ name: string; content: string | Buffer }>): Buffer {
  const localChunks: Buffer[] = [];
  const centralChunks: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const dataBuf = typeof entry.content === 'string' ? Buffer.from(entry.content, 'utf8') : entry.content;
    const compressed = zlib.deflateRawSync(dataBuf);
    const crc = zlib.crc32(dataBuf);

    // Local Header (30 bytes + name length)
    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0); // signature
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // flags: UTF-8
    local.writeUInt16LE(8, 8); // compression: deflate
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0, 12); // date
    local.writeUInt32LE(crc, 14); // crc-32
    local.writeUInt32LE(compressed.length, 18); // compressed size
    local.writeUInt32LE(dataBuf.length, 22); // uncompressed size
    local.writeUInt16LE(nameBuf.length, 26); // name length
    local.writeUInt16LE(0, 28); // extra field length
    nameBuf.copy(local, 30);

    localChunks.push(local, compressed);

    // Central Directory Header (46 bytes + name length)
    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0); // signature
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8); // flags: UTF-8
    central.writeUInt16LE(8, 10); // compression
    central.writeUInt16LE(0, 12); // time
    central.writeUInt16LE(0, 14); // date
    central.writeUInt32LE(crc, 16); // crc-32
    central.writeUInt32LE(compressed.length, 20); // compressed size
    central.writeUInt32LE(dataBuf.length, 24); // uncompressed size
    central.writeUInt16LE(nameBuf.length, 28); // name length
    central.writeUInt16LE(0, 30); // extra field length
    central.writeUInt16LE(0, 32); // comment length
    central.writeUInt16LE(0, 34); // disk start
    central.writeUInt16LE(0, 36); // internal attr
    central.writeUInt32LE(0, 38); // external attr
    central.writeUInt32LE(offset, 42); // local header offset
    nameBuf.copy(central, 46);

    centralChunks.push(central);
    offset += local.length + compressed.length;
  }

  const centralBuf = Buffer.concat(centralChunks);

  // End of Central Directory Record (22 bytes)
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // signature
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // start disk
  eocd.writeUInt16LE(entries.length, 8); // entries on this disk
  eocd.writeUInt16LE(entries.length, 10); // total entries
  eocd.writeUInt32LE(centralBuf.length, 12); // size of central directory
  eocd.writeUInt32LE(offset, 16); // central directory offset
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...localChunks, centralBuf, eocd]);
}

/**
 * Generate full Obsidian knowledge base ZIP archive, including Markdown problems,
 * README Dataview index, and Notion CSVs.
 */
export function generateKnowledgeZip(
  db: DatabaseSync,
  scope: 'all' | 'practiced' = 'all',
  lang: 'en' | 'zh' = 'en'
): Buffer {
  let whereSql = '';
  if (scope === 'practiced') {
    whereSql = `WHERE (
      EXISTS (SELECT 1 FROM practice_records pr WHERE pr.question_id = p.question_id AND pr.status = 'active')
      OR EXISTS (SELECT 1 FROM progress_snapshots ps WHERE ps.question_id = p.question_id AND ps.status = 'active')
      OR n.content IS NOT NULL
    )`;
  }

  const problems = db
    .prepare(
      `SELECT
         p.question_id AS questionId,
         p.frontend_question_id AS questionFrontendId,
         p.title,
         p.title_slug AS titleSlug,
         p.difficulty,
         p.url,
         n.content AS customNote,
         (SELECT payload_json FROM problem_review_state prs WHERE prs.question_id = p.question_id) AS reviewPayload
       FROM problems p
       LEFT JOIN problem_notes n ON n.question_id = p.question_id
       ${whereSql}
       ORDER BY CAST(p.frontend_question_id AS INTEGER) ASC`
    )
    .all() as Array<{
      questionId: string;
      questionFrontendId: string;
      title: string;
      titleSlug: string;
      difficulty: 'Easy' | 'Medium' | 'Hard';
      url: string;
      customNote: string | null;
      reviewPayload: string | null;
    }>;

  // Retrieve tags
  const tagRows = db
    .prepare(
      `SELECT pt.question_id AS qid, t.name AS tagName
       FROM problem_tags pt
       JOIN tags t ON t.slug = pt.tag_slug
       ORDER BY t.name ASC`
    )
    .all() as Array<{ qid: string; tagName: string }>;

  const tagMap = new Map<string, string[]>();
  for (const tr of tagRows) {
    const arr = tagMap.get(tr.qid) ?? [];
    arr.push(tr.tagName);
    tagMap.set(tr.qid, arr);
  }

  // Retrieve practice records
  const practiceRows = db
    .prepare(
      `SELECT
         question_id AS qid,
         practiced_at AS practicedAt,
         completed,
         duration_minutes AS durationMinutes,
         notes,
         time_precision AS timePrecision
       FROM practice_records
       WHERE status = 'active'
       ORDER BY practiced_at DESC`
    )
    .all() as Array<{
      qid: string;
      practicedAt: string;
      completed: number;
      durationMinutes: number | null;
      notes: string | null;
      timePrecision: string;
    }>;

  const practiceMap = new Map<string, ProblemExportData['practices']>();
  for (const pr of practiceRows) {
    const arr = practiceMap.get(pr.qid) ?? [];
    arr.push({
      practicedAt: pr.practicedAt,
      completed: pr.completed === 1,
      durationMinutes: pr.durationMinutes,
      notes: pr.notes,
      timePrecision: pr.timePrecision,
    });
    practiceMap.set(pr.qid, arr);
  }

  const entries: Array<{ name: string; content: string }> = [];

  let practicedCount = 0;
  for (const p of problems) {
    let reviewStage: number | null = null;
    if (p.reviewPayload) {
      try {
        const parsed = JSON.parse(p.reviewPayload);
        if (typeof parsed?.stage === 'number') reviewStage = parsed.stage;
      } catch {
        // ignore
      }
    }

    const problemPractices = practiceMap.get(p.questionId) ?? [];
    if (problemPractices.length > 0 || (p.customNote && p.customNote.trim().length > 0)) {
      practicedCount++;
    }

    const data: ProblemExportData = {
      questionId: p.questionId,
      questionFrontendId: p.questionFrontendId,
      title: p.title,
      titleSlug: p.titleSlug,
      difficulty: p.difficulty,
      url: p.url,
      tags: tagMap.get(p.questionId) ?? [],
      practices: problemPractices,
      customNote: p.customNote,
      reviewStage,
    };

    const filename = formatProblemFilename(p.questionFrontendId, p.titleSlug);
    entries.push({
      name: `problems/${filename}`,
      content: generateProblemMarkdown(data, lang),
    });
  }

  // Add README.md
  entries.push({
    name: 'README.md',
    content: generateObsidianReadme(problems.length, practicedCount, lang),
  });

  // Add Notion CSVs
  const { problemsSummaryCsv, practiceHistoryCsv } = generateNotionCsvs(db);
  entries.push({
    name: 'notion/problems-summary.csv',
    content: problemsSummaryCsv,
  });
  entries.push({
    name: 'notion/practice-history.csv',
    content: practiceHistoryCsv,
  });

  return buildZipArchive(entries);
}
