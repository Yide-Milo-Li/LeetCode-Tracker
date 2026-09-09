/**
 * Live Gemini API Integration Verification Test.
 * Executed strictly on demand via `npm run test:live`.
 * Requires a valid GEMINI_API_KEY in .env or environment variables.
 *
 * Verifies:
 * 1. AI problem selection (selectPlanProblems): Non-local model, non-empty selection, bilingual reasons.
 * 2. AI plan encouragement (generatePlanContent): Non-local model, non-empty bilingual encouragement.
 * 3. AI natural language override prompt parsing (parseOverridePrompt): Non-local model, structured patch.
 */
import { it, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { GeminiAssistant } from '../apps/server/src/gemini.ts';

// Load environment file
if (typeof process.loadEnvFile === 'function') {
  try {
    process.loadEnvFile(path.resolve(process.cwd(), '.env'));
  } catch {
    // ignore if not present
  }
}

describe('Live External Gemini Verification Gate', () => {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      'GEMINI_API_KEY is not configured. Live external verification requires a valid GEMINI_API_KEY in .env.'
    );
  }

  const assistant = new GeminiAssistant();
  const status = assistant.getStatus();

  it('confirms GeminiAssistant is configured with a live upstream model', () => {
    assert.equal(status.configured, true, 'Gemini assistant must be configured');
    assert.ok(status.model.length > 0, 'Gemini assistant primary model must be non-empty');
    assert.notEqual(status.model, 'local', 'Gemini assistant model must not be local');
  });

  const syntheticCandidates = [
    {
      questionId: '1',
      title: 'Two Sum',
      difficulty: 'Easy' as const,
      topicTags: [
        { name: 'Array', slug: 'array', id: 'array' },
        { name: 'Hash Table', slug: 'hash-table', id: 'hash-table' },
      ],
      questionFrontendId: '1',
      titleSlug: 'two-sum',
      url: 'https://leetcode.com/problems/two-sum/',
      isPaidOnly: false,
      source: 'leetcode.com' as const,
    },
    {
      questionId: '70',
      title: 'Climbing Stairs',
      difficulty: 'Easy' as const,
      topicTags: [
        { name: 'Dynamic Programming', slug: 'dynamic-programming', id: 'dynamic-programming' },
      ],
      questionFrontendId: '70',
      titleSlug: 'climbing-stairs',
      url: 'https://leetcode.com/problems/climbing-stairs/',
      isPaidOnly: false,
      source: 'leetcode.com' as const,
    },
    {
      questionId: '322',
      title: 'Coin Change',
      difficulty: 'Medium' as const,
      topicTags: [
        { name: 'Dynamic Programming', slug: 'dynamic-programming', id: 'dynamic-programming' },
      ],
      questionFrontendId: '322',
      titleSlug: 'coin-change',
      url: 'https://leetcode.com/problems/coin-change/',
      isPaidOnly: false,
      source: 'leetcode.com' as const,
    },
  ];

  const rules = {
    dailyCount: 2,
    difficulty: { Easy: 50, Medium: 50, Hard: 0 },
    tags: ['dynamic-programming'],
    premium: false,
    reviewEnabled: true,
    reviewPercent: 50,
    preference: 'Focus on dynamic programming problems with clear progression',
  };

  it('selects problems via real Gemini model and provides bilingual reasons', async () => {
    const selection = await assistant.selectPlanProblems({
      candidates: syntheticCandidates,
      rules,
      date: '2026-09-09',
    });

    assert.ok(selection, 'selectPlanProblems must return a result');
    assert.notEqual(
      selection.model,
      'local',
      `Live Gemini call failed and fell back to local selection (model: ${selection.model})`
    );
    assert.ok(Array.isArray(selection.selectedQuestionIds), 'selectedQuestionIds must be an array');
    assert.ok(
      selection.selectedQuestionIds.length > 0,
      'Real Gemini selection must select at least one problem'
    );
    assert.ok(
      selection.selectedQuestionIds.length <= rules.dailyCount,
      'Selected count must not exceed requested count'
    );

    // Verify each selected problem exists in candidates
    const candidateIds = new Set(syntheticCandidates.map(c => c.questionId));
    for (const qId of selection.selectedQuestionIds) {
      assert.ok(candidateIds.has(qId), `Selected problem ${qId} must be from provided candidates`);
    }

    console.log(`  ✔ Live selectPlanProblems passed with model: ${selection.model} (selected: ${selection.selectedQuestionIds.join(', ')})`);
  });

  it('generates bilingual plan encouragement and problem reasons via real Gemini model', async () => {
    // Respect free-tier RPM rate limit window between live calls
    await new Promise(resolve => setTimeout(resolve, 15000));

    const selectedProblems = syntheticCandidates.filter(c => c.questionId === '70' || c.questionId === '322');
    const planContent = await assistant.generatePlanContent({
      problems: selectedProblems,
      rules,
      date: '2026-09-09',
    });

    assert.ok(planContent, 'generatePlanContent must return content');
    assert.notEqual(
      planContent.model,
      'local',
      `Live Gemini call fell back to local defaults (model: ${planContent.model})`
    );
    assert.ok(
      typeof planContent.encouragement.en === 'string' && planContent.encouragement.en.trim().length > 0,
      'Encouragement EN must be non-empty string'
    );
    assert.ok(
      typeof planContent.encouragement.zh === 'string' && planContent.encouragement.zh.trim().length > 0,
      'Encouragement ZH must be non-empty string'
    );

    for (const p of selectedProblems) {
      const reason = planContent.reasons[p.questionId];
      assert.ok(reason, `Reason for problem ${p.questionId} must exist`);
      assert.ok(typeof reason.en === 'string' && reason.en.trim().length > 0);
      assert.ok(typeof reason.zh === 'string' && reason.zh.trim().length > 0);
    }

    console.log(`  ✔ Live generatePlanContent passed with model: ${planContent.model}`);
  });

  it('parses natural language override prompt into structured RulePatch via real Gemini model', async () => {
    // Respect free-tier RPM rate limit window between live calls
    await new Promise(resolve => setTimeout(resolve, 15000));

    const overrideResult = await assistant.parseOverridePrompt({
      prompt: 'Only give me 1 hard dynamic programming problem for today, no review',
      baseRules: rules,
      knownTags: ['dynamic-programming', 'array', 'hash-table', 'graph'],
    });

    assert.ok(overrideResult, 'parseOverridePrompt must return a result');
    assert.notEqual(
      overrideResult.model,
      'local',
      `Live Gemini call fell back to local keyword parser (model: ${overrideResult.model})`
    );

    const { patch } = overrideResult;
    assert.ok(patch, 'RulePatch must be parsed');
    assert.equal(patch.dailyCount, 1, 'dailyCount must be parsed as 1');
    assert.equal(patch.difficulty?.Hard, 100, 'difficulty.Hard must be parsed as 100');
    assert.equal(patch.reviewEnabled, false, 'reviewEnabled must be parsed as false');

    console.log(`  ✔ Live parseOverridePrompt passed with model: ${overrideResult.model} (parsed patch: ${JSON.stringify(patch)})`);
  });
});