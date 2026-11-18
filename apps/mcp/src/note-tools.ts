/**
 * Note tools for writing and maintaining solution notes from an MCP client.
 *
 * The server has no AI provider: the client's model writes the notes. These
 * tools give it everything it needs in one call (tracker_get_note_context),
 * let it edit one section without resending the whole note
 * (tracker_patch_note), read and save several notes at once, and export the
 * knowledge base to a local directory.
 *
 * Every note write is guarded by the contentHash of the note as last read,
 * the same rule tracker_save_note uses.
 */
import { mkdir, stat, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';
import type { TrackerApplication } from '../../../packages/application/src/application.ts';
import { formatProblemFilename, MAX_NOTE_BATCH, NOTE_TEMPLATES } from '../../../packages/contracts/src/notes.ts';
import type { PracticeRecord } from '../../../packages/contracts/src/practice.ts';
import type { CatalogProblem } from '../../../packages/contracts/src/sync.ts';
import { listHeadings, patchSection, SectionPatchError } from './note-sections.ts';
import { ProfileError } from './profile.ts';
import { json, refuse, type Registrar } from './registrar.ts';
import { contentHash, noteState } from './views.ts';

type Lang = 'en' | 'zh';
const langSchema = z.enum(['en', 'zh']).optional().describe('Template and export language; defaults to the profile language');
const frontendIdsSchema = (max: number) => z.array(z.string().trim().min(1).max(100)).min(1).max(max);

/** Notes this long or shorter come back whole from tracker_get_note_context. */
const CONTEXT_NOTE_LIMIT = 20000;

async function profileLang(application: TrackerApplication, requested: Lang | undefined): Promise<Lang> {
  if (requested) return requested;
  const { language } = await application.settings.get();
  return language === 'zh' ? 'zh' : 'en';
}

/** Every active practice record, newest first (the store's order); optionally for one problem. */
async function activePractices(application: TrackerApplication, frontendId?: string): Promise<PracticeRecord[]> {
  const records: PracticeRecord[] = [];
  for (let page = 1; ; page++) {
    const result = await application.practice.query({ questionFrontendId: frontendId, page, limit: 100 });
    records.push(...result.items);
    if (records.length >= result.total || result.items.length === 0) return records;
  }
}

async function requireProblem(application: TrackerApplication, frontendId: string): Promise<CatalogProblem> {
  const { problem } = await application.catalog.read({}, { frontendId });
  if (!problem) throw new ProfileError('PROBLEM_NOT_FOUND', `Problem ${frontendId} is not in the catalog.`);
  return problem;
}

async function currentNote(application: TrackerApplication, frontendId: string): Promise<string> {
  return (await application.notes.read({}, { frontendId })).note?.content ?? '';
}

/** The review stage the planner keeps for this problem, if any. */
async function reviewStage(application: TrackerApplication, frontendId: string): Promise<number | null> {
  const { items } = await application.notes.list({ search: frontendId, scope: 'all', limit: 100 });
  return items.find(item => item.questionFrontendId === frontendId)?.reviewStage ?? null;
}

/** Problems that share a tag with this one and already have a written note. */
async function relatedWrittenNotes(application: TrackerApplication, problem: CatalogProblem, limit: number) {
  const related = new Map<string, { frontendId: string; title: string; difficulty: string; sharedTags: string[] }>();
  for (const tag of problem.topicTags) {
    if (related.size >= limit) break;
    const { items } = await application.notes.list({ tag: tag.slug, noteState: 'written', scope: 'all', limit: 100 });
    for (const item of items) {
      if (item.questionFrontendId === problem.questionFrontendId) continue;
      const existing = related.get(item.questionFrontendId);
      if (existing) {
        existing.sharedTags.push(tag.name);
      } else if (related.size < limit) {
        related.set(item.questionFrontendId, { frontendId: item.questionFrontendId, title: item.title, difficulty: item.difficulty, sharedTags: [tag.name] });
      }
    }
  }
  return [...related.values()];
}

/** A refusal when the note changed since the caller read it. */
function assertHash(frontendId: string, current: string, expected: string): void {
  const currentHash = contentHash(current);
  if (currentHash !== expected) {
    throw new ProfileError('NOTE_CHANGED', `The note for problem ${frontendId} changed since it was read (current contentHash ${currentHash}). Read it again before saving.`);
  }
}

/** Mistake log: problems with unsolved, assisted or unfinished attempts, most recent first. */
function mistakesMarkdown(records: PracticeRecord[], problems: Map<string, CatalogProblem>, lang: Lang): string {
  const zh = lang === 'zh';
  const byProblem = new Map<string, PracticeRecord[]>();
  for (const record of records) {
    if (record.completed && record.outcome !== 'assisted') continue;
    const list = byProblem.get(record.questionFrontendId) ?? [];
    list.push(record);
    byProblem.set(record.questionFrontendId, list);
  }
  const rows = [...byProblem.entries()]
    .map(([frontendId, attempts]) => ({ frontendId, attempts, last: attempts.reduce((a, b) => (a.practicedAt > b.practicedAt ? a : b)) }))
    .sort((a, b) => b.last.practicedAt.localeCompare(a.last.practicedAt));

  const outcomeLabel = (record: PracticeRecord) => {
    const outcome = record.outcome ?? (record.completed ? 'independent' : 'unsolved');
    if (!zh) return outcome;
    return outcome === 'unsolved' ? '未解出' : outcome === 'assisted' ? '借助提示' : '独立完成';
  };

  const lines = [
    zh ? '# 错题本' : '# Mistake Log',
    '',
    zh
      ? `未解出、借助提示或未完成的题目，按最近一次尝试排序。共 ${rows.length} 题。`
      : `Problems with unsolved, assisted or unfinished attempts, most recent first. ${rows.length} problems.`,
    '',
  ];
  for (const { frontendId, attempts } of rows) {
    const problem = problems.get(frontendId);
    const title = problem?.title ?? attempts[0].problemTitle;
    const link = problem ? `problems/${formatProblemFilename(problem.questionFrontendId, problem.titleSlug)}` : null;
    lines.push(`## ${frontendId}. ${link ? `[${title}](${encodeURI(link)})` : title}`);
    if (problem) {
      lines.push('', `${problem.difficulty} · ${problem.topicTags.map(tag => tag.name).join(', ') || '-'}`);
    }
    lines.push('');
    for (const attempt of [...attempts].sort((a, b) => b.practicedAt.localeCompare(a.practicedAt))) {
      const minutes = attempt.durationMinutes ? (zh ? `，${attempt.durationMinutes} 分钟` : `, ${attempt.durationMinutes} min`) : '';
      const remark = attempt.notes?.trim() ? (zh ? `：${attempt.notes.trim()}` : `: ${attempt.notes.trim()}`) : '';
      lines.push(`- ${attempt.practicedAt.slice(0, 10)} ${outcomeLabel(attempt)}${minutes}${remark}`);
    }
    lines.push('');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

export function registerNoteTools({ register }: Registrar): void {
  register(
    'tracker_get_note_context',
    {
      description: 'Everything needed to write or improve one problem\'s solution note in a single call: problem details, every practice attempt, review stage, the current note with its contentHash and section headings, the note template, and related problems (shared tags) that already have written notes. Then save with tracker_save_note or edit one section with tracker_patch_note.',
      inputSchema: z.object({
        frontendId: z.string().trim().min(1).describe('Problem frontend ID, e.g. "42"'),
        lang: langSchema,
        maxRelated: z.number().int().min(0).max(30).optional().default(10).describe('How many related problems with notes to list (default 10)'),
      }),
    },
    async (application, { frontendId, lang, maxRelated = 10 }) => {
      const problem = await requireProblem(application, frontendId);
      const id = problem.questionFrontendId;
      const language = await profileLang(application, lang);
      const note = await currentNote(application, id);
      const practices = (await activePractices(application, id)).reverse();
      const solved = practices.filter(record => record.completed);
      return json({
        problem: {
          questionId: problem.questionId,
          frontendId: id,
          title: problem.title,
          difficulty: problem.difficulty,
          tags: problem.topicTags.map(tag => ({ name: tag.name, slug: tag.slug })),
          url: problem.url,
          isPaidOnly: problem.isPaidOnly,
        },
        practiceSummary: {
          attempts: practices.length,
          solved: solved.length,
          independent: practices.filter(record => record.outcome === 'independent').length,
          assisted: practices.filter(record => record.outcome === 'assisted').length,
          unsolved: practices.filter(record => !record.completed).length,
          firstPracticedAt: practices[0]?.practicedAt ?? null,
          lastPracticedAt: practices.at(-1)?.practicedAt ?? null,
          reviewStage: await reviewStage(application, id),
        },
        practices: practices.map(record => ({
          practicedAt: record.practicedAt,
          completed: record.completed,
          outcome: record.outcome,
          durationMinutes: record.durationMinutes,
          remark: record.notes,
        })),
        note: {
          state: noteState(note),
          contentHash: contentHash(note),
          length: note.length,
          headings: listHeadings(note).map(heading => ({ level: heading.level, text: heading.text })),
          content: note.length <= CONTEXT_NOTE_LIMIT ? note : null,
          truncated: note.length > CONTEXT_NOTE_LIMIT,
          hint: note.length > CONTEXT_NOTE_LIMIT ? 'The note is long; read it with tracker_get_note in chunks.' : undefined,
        },
        template: { lang: language, content: NOTE_TEMPLATES[language] },
        relatedNotes: maxRelated > 0 ? await relatedWrittenNotes(application, problem, maxRelated) : [],
      });
    },
    'read',
  );

  register(
    'tracker_get_notes',
    {
      description: `Read up to ${MAX_NOTE_BATCH} notes at once, each with its state (empty, stub = unedited template, written) and the contentHash tracker_save_notes needs. Long notes are cut at maxChars; their contentHash still covers the whole note.`,
      inputSchema: z.object({
        frontendIds: frontendIdsSchema(MAX_NOTE_BATCH),
        maxChars: z.number().int().min(200).max(20000).optional().default(4000).describe('Characters returned per note (default 4000)'),
      }),
    },
    async (application, { frontendIds, maxChars = 4000 }) => {
      const notes = [];
      const notFound: string[] = [];
      for (const raw of new Set(frontendIds)) {
        const { problem } = await application.catalog.read({}, { frontendId: raw });
        if (!problem) { notFound.push(raw); continue; }
        const content = await currentNote(application, problem.questionFrontendId);
        notes.push({
          frontendId: problem.questionFrontendId,
          title: problem.title,
          state: noteState(content),
          contentHash: contentHash(content),
          length: content.length,
          truncated: content.length > maxChars,
          content: content.slice(0, maxChars),
        });
      }
      return json({ notes, notFound });
    },
    'read',
  );

  register(
    'tracker_patch_note',
    {
      description: 'Edit one section of a problem\'s Markdown note without resending the rest. mode "append" adds content to the end of the section (dropping empty template bullets); "replace" swaps the section body. The heading is matched without its emoji or case, e.g. "Edge Cases & Traps"; a missing section is created at the end. Pass expectedContentHash from tracker_get_note or tracker_get_note_context. A blank note can start from the template.',
      inputSchema: z.object({
        frontendId: z.string().trim().min(1),
        heading: z.string().trim().min(1).max(200).describe('Section heading text, e.g. "Complexity Analysis" or "复杂度分析"'),
        mode: z.enum(['append', 'replace']),
        content: z.string().min(1).max(50000).describe('Markdown to add (append) or the new section body (replace), without the heading'),
        expectedContentHash: z.string().min(1),
        level: z.number().int().min(1).max(6).optional().describe('Heading level when the section is created (default 2)'),
        startFromTemplate: z.enum(['en', 'zh']).optional().describe('When the note is empty, start from this language\'s template before patching'),
      }),
    },
    async (application, { frontendId, heading, mode, content, expectedContentHash, level, startFromTemplate }) => {
      const problem = await requireProblem(application, frontendId);
      const id = problem.questionFrontendId;
      // The write lease is held for this whole call, so nothing can change between this check and the save.
      const current = await currentNote(application, id);
      assertHash(id, current, expectedContentHash);
      const base = !current.trim() && startFromTemplate ? NOTE_TEMPLATES[startFromTemplate] : current;
      let patched;
      try {
        patched = patchSection(base, { heading, mode, content, level });
      } catch (error) {
        if (error instanceof SectionPatchError) return refuse(error.code, error.message);
        throw error;
      }
      if (patched.content.length > 100000) return refuse('NOTE_TOO_LARGE', 'The patched note would exceed 100000 characters.');
      if (patched.content === current) return json({ status: 'unchanged', frontendId: id, contentHash: contentHash(current) });
      const { note } = await application.notes.save({ content: patched.content }, { frontendId: id });
      return json({
        status: 'applied',
        frontendId: id,
        heading: patched.heading,
        sectionCreated: patched.created,
        section: patched.section,
        contentHash: contentHash(note.content),
        length: note.content.length,
        state: noteState(note.content),
      });
    },
    'write',
    { destructive: true, idempotent: false },
  );

  register(
    'tracker_save_notes',
    {
      description: `Create or replace up to ${MAX_NOTE_BATCH} complete notes in one transaction. Each entry needs the expectedContentHash from tracker_get_notes or tracker_get_note_context; if any note changed since, nothing is saved and every conflict is listed. Set dryRun to check without saving.`,
      inputSchema: z.object({
        notes: z.array(z.object({
          frontendId: z.string().trim().min(1),
          content: z.string().max(100000).describe('The complete new note'),
          expectedContentHash: z.string().min(1),
        })).min(1).max(MAX_NOTE_BATCH),
        dryRun: z.boolean().optional().default(false),
      }),
    },
    async (application, { notes, dryRun = false }) => {
      const ids = notes.map(entry => entry.frontendId);
      if (new Set(ids).size !== ids.length) return refuse('INVALID_INPUT', 'Each problem may appear only once.');

      const planned = [];
      const missing: string[] = [];
      for (const entry of notes) {
        const { problem } = await application.catalog.read({}, { frontendId: entry.frontendId });
        if (!problem) { missing.push(entry.frontendId); continue; }
        const current = await currentNote(application, problem.questionFrontendId);
        const conflict = contentHash(current) !== entry.expectedContentHash;
        planned.push({
          frontendId: problem.questionFrontendId,
          content: entry.content,
          expectedContentHash: entry.expectedContentHash,
          status: conflict ? 'conflict' : current === entry.content ? 'unchanged' : 'apply',
          currentContentHash: contentHash(current),
        });
      }
      if (missing.length) return refuse('PROBLEM_NOT_FOUND', `Not in the catalog: ${missing.join(', ')}`);

      const summary = planned.map(({ frontendId, status, currentContentHash }) => ({ frontendId, status, currentContentHash }));
      const conflicts = planned.filter(entry => entry.status === 'conflict');
      if (dryRun) return json({ dryRun: true, wouldApply: conflicts.length === 0, notes: summary });
      if (conflicts.length) {
        return refuse('NOTE_CHANGED', `Nothing was saved. These notes changed since they were read: ${conflicts.map(entry => `${entry.frontendId} (current contentHash ${entry.currentContentHash})`).join(', ')}. Read them again before saving.`);
      }

      const changed = planned.filter(entry => entry.status === 'apply');
      if (changed.length === 0) return json({ status: 'unchanged', notes: summary.map(({ frontendId, currentContentHash }) => ({ frontendId, status: 'unchanged', contentHash: currentContentHash })) });

      const expected = new Map(changed.map(entry => [entry.frontendId, entry.expectedContentHash]));
      const { notes: saved } = await application.notes.saveMany(
        { notes: changed.map(({ frontendId, content }) => ({ frontendId, content })) },
        // Recheck inside the transaction; the lease makes a mismatch here unexpected but not impossible.
        { guard: current => { for (const [id, content] of current) assertHash(id, content, expected.get(id)!); } },
      );
      const savedById = new Map(saved.map(note => [note.questionFrontendId, note]));
      return json({
        status: 'applied',
        applied: saved.length,
        notes: planned.map(entry => {
          const note = savedById.get(entry.frontendId);
          return note
            ? { frontendId: entry.frontendId, status: 'applied', contentHash: contentHash(note.content), state: noteState(note.content) }
            : { frontendId: entry.frontendId, status: 'unchanged', contentHash: entry.currentContentHash };
        }),
      });
    },
    ({ dryRun }) => (dryRun ? 'read' : 'write'),
    { destructive: true, idempotent: true },
  );

  register(
    'tracker_export_notes',
    {
      description: 'Write the notes knowledge base into a local directory as Markdown: one file per problem under problems/ (frontmatter, practice timeline, your note), a README index with Obsidian Dataview queries, Notion CSVs, and mistakes.md listing unsolved, assisted and unfinished attempts. Point it at an Obsidian vault folder to browse the notes there. Existing files are only replaced with overwrite: true.',
      inputSchema: z.object({
        directory: z.string().min(1).describe('Absolute path of the target directory; created when missing'),
        scope: z.enum(['practiced', 'all']).optional().default('practiced').describe('practiced: only problems with practice history (default); all: the whole catalog'),
        lang: langSchema,
        includeMistakes: z.boolean().optional().default(true).describe('Also write mistakes.md (default true)'),
        overwrite: z.boolean().optional().default(false).describe('Replace files that already exist (default false)'),
      }),
    },
    async (application, { directory, scope = 'practiced', lang, includeMistakes = true, overwrite = false }) => {
      if (!path.isAbsolute(directory)) return refuse('INVALID_PATH', 'Provide an absolute directory path.');
      const root = path.resolve(directory);
      const info = await stat(root).catch(() => null);
      if (info && !info.isDirectory()) return refuse('INVALID_PATH', `${root} exists and is not a directory.`);

      const language = await profileLang(application, lang);
      const { files } = await application.exports.knowledgeFiles({ scope, lang: language });
      if (includeMistakes) {
        const records = await activePractices(application);
        const problems = new Map<string, CatalogProblem>();
        for (const id of new Set(records.map(record => record.questionFrontendId))) {
          const { problem } = await application.catalog.read({}, { frontendId: id });
          if (problem) problems.set(id, problem);
        }
        files.push({ name: 'mistakes.md', content: mistakesMarkdown(records, problems, language) });
      }

      const targets = files.map(file => ({ ...file, target: path.resolve(root, file.name) }));
      const escaping = targets.find(file => path.relative(root, file.target).startsWith('..') || path.isAbsolute(path.relative(root, file.target)));
      if (escaping) return refuse('INVALID_PATH', `Refusing to write outside ${root}: ${escaping.name}`);

      if (!overwrite && info) {
        const existing: string[] = [];
        for (const file of targets) {
          if (await stat(file.target).then(() => true, () => false)) existing.push(file.name);
        }
        if (existing.length) {
          return refuse('FILES_EXIST', `${existing.length} file(s) already exist in ${root} (first: ${existing.slice(0, 5).join(', ')}). Nothing was written. Pass overwrite: true to replace them, or choose an empty directory.`);
        }
      }

      for (const file of targets) {
        await mkdir(path.dirname(file.target), { recursive: true });
        await writeFile(file.target, file.content, 'utf8');
      }
      const problemFiles = targets.filter(file => file.name.startsWith('problems/')).length;
      return json({
        status: 'applied',
        directory: root,
        lang: language,
        scope,
        filesWritten: targets.length,
        problemFiles,
        files: targets.filter(file => !file.name.startsWith('problems/')).map(file => file.name),
      });
    },
    'export',
    { destructive: true, idempotent: true },
  );
}
