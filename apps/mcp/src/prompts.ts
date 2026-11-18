/**
 * MCP prompts: ready-made requests a user can pick in their client (Claude
 * Code shows them as /mcp__leetcode-tracker__<name>) instead of explaining a
 * multi-step workflow in their own words. Prompts cost no tool context: the
 * client only loads one when the user picks it.
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

/** The request behind write_note: gather context, then write or extend the note without losing the user's text. */
export function writeNoteText(frontendId: string, lang?: 'en' | 'zh'): string {
  const language = lang ? `, lang "${lang}"` : '';
  return [
    `Write or improve my solution note for LeetCode problem ${frontendId}.`,
    '',
    'Steps:',
    `1. Call tracker_get_note_context with frontendId "${frontendId}"${language}. It returns the problem, every attempt I made, the current note with its contentHash and headings, the note template, and related problems that already have notes.`,
    '2. If the note state is "empty" or "stub", write a complete note that follows the template\'s sections, in the template\'s language, and save it with tracker_save_notes using the contentHash from step 1.',
    '3. If the note state is "written", keep my text. Add only what is missing with tracker_patch_note in append mode, one section per call, passing the contentHash returned by the previous call.',
    '4. Ground the note in my attempts: where I needed help or failed (assisted or unsolved attempts and their remarks) belongs in the pitfalls section, and a dated line can go under a review log heading. General algorithm knowledge is fine; do not invent details about my attempts.',
    '5. Mention related problems from relatedNotes where the technique carries over.',
    '',
    'When you finish, tell me which sections you wrote or changed.',
  ].join('\n');
}

/** The request behind review_weak_topics: read-only analysis first, changes only after the user agrees. */
export function reviewWeakTopicsText(focus?: string): string {
  const scope = focus?.trim() ? `Focus on: ${focus.trim()}.` : 'Cover at most the five weakest topics.';
  return [
    'Review my weak LeetCode topics and suggest what to practice next.',
    '',
    scope,
    '',
    'Steps:',
    '1. Call tracker_get_progress with weakTopics: true. Each weak topic lists the difficulties that need reinforcement and why: a high share of assisted or unsolved attempts, or attempts that take long.',
    '2. For each topic, find the problems I practiced with tracker_list_notes (tag set to the topic slug, scope "practiced"), then check their recent outcomes with tracker_get_problems. Read my notes with tracker_get_notes where they explain a mistake.',
    '3. For each topic, tell me what the evidence says is going wrong, two or three problems from my history worth redoing, and one new problem type to try.',
    '4. Do not change anything yet. If I agree, you can focus a day on these topics with tracker_apply_today_rules (run it with dryRun first) or adjust a strategy with tracker_update_strategy.',
    '',
    'If no topic needs reinforcement, say so and name the topics that are still developing.',
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

  server.registerPrompt(
    'write_note',
    {
      title: 'Write a solution note',
      description: 'Write or extend one problem\'s solution note from its practice history, keeping any text already there.',
      argsSchema: z.object({
        frontendId: z.string().trim().min(1).max(100).describe('Problem frontend ID, e.g. "42"'),
        lang: z.enum(['en', 'zh']).optional().describe('Note language; default: the profile language'),
      }),
    },
    ({ frontendId, lang }) => ({
      messages: [{ role: 'user' as const, content: { type: 'text' as const, text: writeNoteText(frontendId, lang) } }],
    }),
  );

  server.registerPrompt(
    'review_weak_topics',
    {
      title: 'Review weak topics',
      description: 'Explain which topics need reinforcement and why, from the last 30 days of practice, and suggest problems to redo. Changes nothing until you agree.',
      argsSchema: z.object({
        focus: z.string().max(200).optional().describe('Limit the review, e.g. "dynamic programming" or "Medium only"'),
      }),
    },
    ({ focus }) => ({
      messages: [{ role: 'user' as const, content: { type: 'text' as const, text: reviewWeakTopicsText(focus) } }],
    }),
  );
}
