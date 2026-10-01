/**
 * Business operations for exporting knowledge base artifacts (Obsidian ZIP and Notion CSVs).
 */
import { exportKnowledgeQuerySchema } from '../../../contracts/src/notes.ts';
import {
  formatProblemFilename,
  generateProblemMarkdown,
  type ProblemExportData,
} from '../../../database/src/knowledge-exporter.ts';
import type { ApplicationContext } from '../context.ts';
import { fail, artifact } from '../errors.ts';
/** Create operations over the owning application's shared context. */
export function createExportOperations(context: ApplicationContext) {
  const { store } = context;
  /** obsidian: validates input and preserves existing business rules. */
  const obsidian = async (input: unknown = {}) => {
    const parseRes = exportKnowledgeQuerySchema.safeParse(input);
    const scope = parseRes.success ? parseRes.data.scope : 'all';
    const systemLang = (store.getSettings().language as 'en' | 'zh' | undefined) ?? 'en';
    const lang = parseRes.success && parseRes.data.lang ? parseRes.data.lang : systemLang;

    const zipBuffer = store.generateObsidianZip(scope, lang);
    return artifact(zipBuffer, 'application/zip', "leetcode-obsidian-vault.zip");
  };

  /** notion: validates input and preserves existing business rules. */
  const notion = async (input: unknown = {}) => {
      const table = (input as Record<string, string | undefined>).table;
      const csvs = store.generateNotionCsvs();

      if (table === 'summary') {
        return artifact(csvs.problemsSummaryCsv, 'text/csv; charset=utf-8', "leetcode-problems-summary.csv");
      }

      if (table === 'history') {
        return artifact(csvs.practiceHistoryCsv, 'text/csv; charset=utf-8', "leetcode-practice-history.csv");
      }

      return csvs;
    };

  /** markdown: validates input and preserves existing business rules. */
  const markdown = async (input: unknown = {}, params: { frontendId: string }) => {
      const frontendId = params.frontendId;
      const problem = store.getProblem(frontendId, 'frontendId');
      if (!problem) {
        return fail(404, { error: 'PROBLEM_NOT_FOUND', message: `Problem #${frontendId} not found` });
      }

      const queryLang = (input as Record<string, string | undefined>).lang;
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
      return artifact(markdown, 'text/markdown; charset=utf-8', filename);
    };
  return { obsidian, notion, markdown };
}
