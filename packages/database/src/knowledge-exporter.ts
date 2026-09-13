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
 */
export function generateProblemMarkdown(data: ProblemExportData): string {
  const hasAccepted = data.practices.some((p) => p.completed);
  const status = hasAccepted ? 'Solved' : data.practices.length > 0 ? 'Attempted' : 'Not Started';
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
      const st = p.completed ? '✅ 已完成 (Solved)' : '⚠️ 尝试中 (Attempted)';
      const dur = p.durationMinutes ? `${p.durationMinutes} 分钟` : '—';
      const cleanNotes = (p.notes || '—').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
      return `| ${date} | ${st} | ${dur} | ${cleanNotes} |`;
    });

    timeline = `## 🕒 练习记录 (Practice Timeline)

| 练习日期 (Date) | 状态 (Status) | 耗时 (Duration) | 单次打卡备注 (Notes) |
| :--- | :--- | :--- | :--- |
${rows.join('\n')}
`;
  }

  // 4. Deep note section
  let deepNote = '';
  if (data.customNote && data.customNote.trim().length > 0) {
    deepNote = `## 📝 解题复盘与深度笔记 (Solution & Reflection)

${data.customNote.trim()}
`;
  } else {
    deepNote = `## 💡 核心思路 (Key Idea & Approach)
- 

## ⏱️ 复杂度分析 (Complexity)
- 时间复杂度 (Time Complexity): $O(N)$
- 空间复杂度 (Space Complexity): $O(1)$

## 💻 最佳实现 (Clean Implementation)
\`\`\`python
class Solution:
    pass
\`\`\`

## ⚠️ 避坑与边界情况 (Edge Cases & Common Traps)
- 
`;
  }

  return `${frontmatter}

# [${data.questionFrontendId}. ${data.title}](${data.url})

> **难度 (Difficulty)**: \`${data.difficulty}\` | **状态 (Status)**: \`${status}\`
> **标签 (Tags)**: ${tagsHash || '#leetcode'}

${timeline}
${deepNote}
`;
}

/**
 * Generate README.md index for Obsidian Vault with Dataview query templates.
 */
export function generateObsidianReadme(totalProblems: number, practicedProblems: number): string {
  return `# 📚 LeetCode 个人题库与复盘知识库 (LeetCode Knowledge Base)

由 **LeetCode Tracker** 自动导出的高移植性个人刷题资产库。

## 📊 题库概览 (Overview)
- **题库总题数 (Total Catalog)**: ${totalProblems} 道
- **已练习题数 (Practiced)**: ${practicedProblems} 道
- **更新时间 (Exported At)**: ${new Date().toISOString().slice(0, 10)}

---

## ⚡ Dataview 动态看板 (Dataview Dashboard)

> [!TIP]
> 如果你的 Obsidian 安装了 **Dataview** 插件，下方代码块将自动渲染为交互式表格！

### 最近练习题目 (Recently Practiced)
\`\`\`dataview
TABLE difficulty AS "难度", status AS "状态", duration_minutes AS "用时(分)", review_stage AS "复习阶段", last_practiced AS "最近做题"
FROM #leetcode
WHERE last_practiced != null
SORT last_practiced DESC
LIMIT 20
\`\`\`

### 待复习错题与重点题 (Needs Review)
\`\`\`dataview
TABLE difficulty AS "难度", duration_minutes AS "用时(分)", review_stage AS "复习阶段"
FROM #leetcode
WHERE review_stage > 0 AND status = "Solved"
SORT review_stage ASC
LIMIT 25
\`\`\`

---

## 🔗 双链索引规范
所有题目文件均位于 \`problems/\` 目录下，并以统一格式命名，例如：\`[[0001-two-sum]]\`。
你在任何日记（Daily Note）或算法专题笔记中，均可直接通过 \`[[题号-slug]]\` 建立无缝双向链接！
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
  scope: 'all' | 'practiced' = 'all'
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
      content: generateProblemMarkdown(data),
    });
  }

  // Add README.md
  entries.push({
    name: 'README.md',
    content: generateObsidianReadme(problems.length, practicedCount),
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
