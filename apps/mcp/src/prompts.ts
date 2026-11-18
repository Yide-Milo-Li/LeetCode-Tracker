/**
 * MCP prompts: ready-made requests a user can pick in their client (Claude
 * Code shows them as /mcp__leetcode-tracker__<name>) instead of explaining a
 * multi-step workflow in their own words.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { MAX_IMPORT_BATCH } from './catalog-tools.ts';

/** The step-by-step request behind init_question_bank, also usable as documentation. */
export function initQuestionBankText(scope?: string): string {
  const target = scope?.trim() || 'every LeetCode problem you know reliably, in ascending frontend ID order';
  return [
    'Set up my LeetCode Tracker problem catalog from your own knowledge of LeetCode.',
    '',
    `Scope: ${target}.`,
    '',
    'Steps:',
    '1. Call tracker_catalog_coverage to see what is already there. It works even when no profile exists yet.',
    `2. Send problems with tracker_import_problems in batches of up to ${MAX_IMPORT_BATCH}, in ascending frontend ID order. Skip IDs that are already present unless you are correcting them.`,
    '3. For each problem give: id (the frontend number), the official English title, difficulty, the official LeetCode topic tag names (for example "Array", "Hash Table", "Dynamic Programming"), and isPaidOnly: true for premium-only problems you know of.',
    '4. Only include problems you are confident about. Never guess a title: a missing ID is better than an invented problem.',
    '5. After each batch, check the returned errors and coverage. Fix and resend rejected entries, then continue from the next ID.',
    '6. Do not use web search unless I ask for it.',
    '',
    'When you finish, tell me how many problems the catalog has, the counts by difficulty, which ID ranges are still missing, and that the data comes from model memory, so some titles or tags may be wrong; resending a corrected entry updates it without losing my practice history or notes.',
  ].join('\n');
}

export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    'init_question_bank',
    {
      title: 'Set up the question bank',
      description: 'Have the model fill the problem catalog from its own knowledge of LeetCode, in batches, then report coverage.',
      argsSchema: z.object({
        scope: z.string().max(200).optional()
          .describe('What to import, e.g. "Blind 75", "NeetCode 150", "problems 1-500"; default: every problem the model knows reliably'),
      }),
    },
    ({ scope }) => ({
      messages: [{ role: 'user' as const, content: { type: 'text' as const, text: initQuestionBankText(scope) } }],
    }),
  );
}
