/**
 * Fastify routes for exporting knowledge base artifacts (Obsidian ZIP and Notion CSVs).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { exportKnowledgeQuerySchema } from '../../../../packages/contracts/src/notes.ts';
import {
  formatProblemFilename,
  generateProblemMarkdown,
  type ProblemExportData,
} from '../../../../packages/database/src/knowledge-exporter.ts';
import type { RouteContext } from './types.ts';

export function registerExportRoutes(app: FastifyInstance, context: RouteContext): void {
  const { store } = context;

  /** GET /api/v1/export/obsidian-zip: Download Obsidian Markdown knowledge base ZIP archive */
  app.get('/api/v1/export/obsidian-zip', async (request: FastifyRequest, reply: FastifyReply) => {
    const parseRes = exportKnowledgeQuerySchema.safeParse(request.query);
    const scope = parseRes.success ? parseRes.data.scope : 'all';
    const systemLang = (store.getSettings().language as 'en' | 'zh' | undefined) ?? 'en';
    const lang = parseRes.success && parseRes.data.lang ? parseRes.data.lang : systemLang;

    const zipBuffer = store.generateObsidianZip(scope, lang);
    return reply
      .status(200)
      .header('Content-Type', 'application/zip')
      .header('Content-Disposition', 'attachment; filename="leetcode-obsidian-vault.zip"')
      .send(zipBuffer);
  });

  /** GET /api/v1/export/notion-csv: Download Notion-compatible CSV tables */
  app.get(
    '/api/v1/export/notion-csv',
    async (request: FastifyRequest<{ Querystring: { table?: string } }>, reply: FastifyReply) => {
      const table = request.query.table;
      const csvs = store.generateNotionCsvs();

      if (table === 'summary') {
        return reply
          .status(200)
          .header('Content-Type', 'text/csv; charset=utf-8')
          .header('Content-Disposition', 'attachment; filename="leetcode-problems-summary.csv"')
          .send(csvs.problemsSummaryCsv);
      }

      if (table === 'history') {
        return reply
          .status(200)
          .header('Content-Type', 'text/csv; charset=utf-8')
          .header('Content-Disposition', 'attachment; filename="leetcode-practice-history.csv"')
          .send(csvs.practiceHistoryCsv);
      }

      return reply.status(200).send(csvs);
    }
  );

  /** GET /api/v1/export/markdown/:frontendId: Download single problem's Markdown note */
  app.get(
    '/api/v1/export/markdown/:frontendId',
    async (
      request: FastifyRequest<{ Params: { frontendId: string }; Querystring: { lang?: string } }>,
      reply: FastifyReply
    ) => {
      const frontendId = request.params.frontendId;
      const problem = store.getProblem(frontendId, 'frontendId');
      if (!problem) {
        return reply.status(404).send({ error: 'PROBLEM_NOT_FOUND', message: `Problem #${frontendId} not found` });
      }

      const queryLang = request.query.lang;
      const systemLang = (store.getSettings().language as 'en' | 'zh' | undefined) ?? 'en';
      const lang: 'en' | 'zh' = queryLang === 'zh' || queryLang === 'en' ? queryLang : systemLang;

      const note = store.getProblemNote(frontendId);
      const practiceRes = store.queryPracticeRecords({ questionFrontendId: frontendId, limit: 100, page: 1 });
      const filename = formatProblemFilename(problem.questionFrontendId, problem.titleSlug);

      const exportData: ProblemExportData = {
        questionId: problem.questionId,
        questionFrontendId: problem.questionFrontendId,
        title: problem.title,
        titleSlug: problem.titleSlug,
        difficulty: problem.difficulty,
        url: problem.url,
        tags: problem.topicTags.map((t) => t.name),
        practices: practiceRes.items.map((r) => ({
          practicedAt: r.practicedAt,
          completed: r.completed,
          durationMinutes: r.durationMinutes,
          notes: r.notes,
          timePrecision: r.timePrecision,
        })),
        customNote: note?.content ?? null,
        reviewStage: null,
      };

      const markdown = generateProblemMarkdown(exportData, lang);
      return reply
        .status(200)
        .header('Content-Type', 'text/markdown; charset=utf-8')
        .header('Content-Disposition', `attachment; filename="${filename}"`)
        .send(markdown);
    }
  );
}
