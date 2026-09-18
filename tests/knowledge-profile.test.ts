/**
 * Automated test suite for Knowledge Profile multi-signal aggregation engine,
 * conservative outcome resolution, sample sufficiency gates, exponential time-decay,
 * and difficulty-independent evaluation rules.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateKnowledgeProfile,
  PROFILE_ANALYSIS_VERSION,
} from '../packages/domain/src/index.ts';
import type { CatalogProblem } from '../packages/contracts/src/sync.ts';
import type { PracticeRecord } from '../packages/contracts/src/practice.ts';

function createMockProblem(
  id: string,
  difficulty: 'Easy' | 'Medium' | 'Hard' = 'Easy',
  tags: { slug: string; name: string }[] = [{ slug: 'array', name: 'Array' }]
): CatalogProblem {
  return {
    questionId: id,
    questionFrontendId: id,
    title: `Problem ${id}`,
    titleSlug: `problem-${id}`,
    url: `https://leetcode.com/problems/problem-${id}/`,
    difficulty,
    isPaidOnly: false,
    topicTags: tags.map((t) => ({ ...t, id: t.slug })),
    source: 'leetcode.com',
  };
}

function createMockRecord(
  id: string,
  questionId: string,
  practicedAt: string,
  outcome: 'independent' | 'assisted' | 'unsolved' | null = null,
  completed = true,
  durationMinutes: number | null = null
): PracticeRecord {
  return {
    id,
    questionId,
    questionFrontendId: questionId,
    problemTitle: `Problem ${questionId}`,
    completed,
    practicedAt,
    timePrecision: 'date',
    notes: null,
    durationMinutes,
    sourceTimezone: 'UTC',
    revision: 1,
    status: 'active',
    createdAt: Date.parse(`${practicedAt}T12:00:00Z`),
    updatedAt: Date.parse(`${practicedAt}T12:00:00Z`),
    revokedAt: null,
    outcome,
  };
}

describe('Knowledge Profile Engine: calculateKnowledgeProfile', () => {
  const FIXED_NOW = Date.parse('2026-09-17T12:00:00Z'); // Today = 2026-09-17

  it('aggregates evidence by topic x difficulty and reports analysis metadata', () => {
    const problems = [
      createMockProblem('1', 'Easy', [{ slug: 'tree', name: 'Tree' }]),
      createMockProblem('2', 'Medium', [{ slug: 'tree', name: 'Tree' }]),
    ];

    const report = calculateKnowledgeProfile({
      problems,
      manualRecords: [],
      snapshots: [],
      now: FIXED_NOW,
      userZone: 'UTC',
    });

    assert.equal(report.analysisVersion, PROFILE_ANALYSIS_VERSION);
    assert.equal(report.asOfDate, '2026-09-17');
    assert.equal(report.topics.length, 1);

    const treeProfile = report.topics[0];
    assert.equal(treeProfile.tagSlug, 'tree');
    assert.equal(treeProfile.tagName, 'Tree');
    assert.equal(treeProfile.totalCatalogProblems, 2);
    assert.equal(treeProfile.solvedCount, 0);
    assert.equal(treeProfile.overallEvaluation, 'insufficient_evidence');
  });

  it('conservatively merges conflicting practice outcomes on the same problem and date', () => {
    // Priority: unsolved > assisted > independent
    const problems = [createMockProblem('1', 'Easy', [{ slug: 'dp', name: 'Dynamic Programming' }])];

    const records = [
      createMockRecord('r1', '1', '2026-09-17', 'independent', true),
      createMockRecord('r2', '1', '2026-09-17', 'assisted', true),
      createMockRecord('r3', '1', '2026-09-17', 'unsolved', false),
    ];

    const report = calculateKnowledgeProfile({
      problems,
      manualRecords: records,
      snapshots: [],
      now: FIXED_NOW,
      userZone: 'UTC',
    });

    const dpProfile = report.topics.find((p) => p.tagSlug === 'dp')!;
    const easy = dpProfile.difficulties.Easy;

    // Single day sample for problem 1 should have resolved to unsolved
    assert.equal(easy.distinctProblemCount, 1);
    assert.equal(easy.outcomeCounts.unsolved, 1);
    assert.equal(easy.outcomeCounts.assisted, 0);
    assert.equal(easy.outcomeCounts.independent, 0);
    assert.equal(easy.weightedOutcomeShares.unsolved, 1);
  });

  it('applies exponential decay weighting (half-life = 14 days) to outcomes', () => {
    // 3 distinct problems across 2 days
    const problems = [
      createMockProblem('1', 'Easy', [{ slug: 'graph', name: 'Graph' }]),
      createMockProblem('2', 'Easy', [{ slug: 'graph', name: 'Graph' }]),
      createMockProblem('3', 'Easy', [{ slug: 'graph', name: 'Graph' }]),
    ];

    // Problem 1: 14 days ago (weight 2^(-14/14) = 0.5), assisted
    // Problem 2: 14 days ago (weight 0.5), assisted
    // Problem 3: 0 days ago (weight 2^(0/14) = 1.0), independent
    // Total assisted weight = 1.0, total independent weight = 1.0
    // Total weighted sample count = 2.0
    // Shares: 50% assisted, 50% independent
    const records = [
      createMockRecord('r1', '1', '2026-09-03', 'assisted', true),
      createMockRecord('r2', '2', '2026-09-03', 'assisted', true),
      createMockRecord('r3', '3', '2026-09-17', 'independent', true),
    ];

    const report = calculateKnowledgeProfile({
      problems,
      manualRecords: records,
      snapshots: [],
      now: FIXED_NOW,
      userZone: 'UTC',
    });

    const graph = report.topics.find((p) => p.tagSlug === 'graph')!;
    const easy = graph.difficulties.Easy;

    assert.equal(easy.distinctProblemCount, 3);
    assert.equal(easy.practiceDaysCount, 2);
    assert.equal(easy.weightedSampleCount, 2.0);
    assert.equal(easy.weightedOutcomeShares.assisted, 0.5);
    assert.equal(easy.weightedOutcomeShares.independent, 0.5);

    // 50% assisted/unsolved meets >= 0.5 threshold -> needs_reinforcement
    assert.equal(easy.evaluation, 'needs_reinforcement');
    assert.ok(easy.reasons.includes('feedback_assistance'));
    assert.equal(graph.overallEvaluation, 'needs_reinforcement');
  });

  it('strictly enforces sample sufficiency gates (>= 3 problems, >= 2 days, >= 3 outcomes)', () => {
    const problems = [
      createMockProblem('1', 'Medium', [{ slug: 'greedy', name: 'Greedy' }]),
      createMockProblem('2', 'Medium', [{ slug: 'greedy', name: 'Greedy' }]),
    ];

    // Only 2 problems, even though both assisted
    const records = [
      createMockRecord('r1', '1', '2026-09-10', 'assisted', true),
      createMockRecord('r2', '2', '2026-09-15', 'assisted', true),
    ];

    const report = calculateKnowledgeProfile({
      problems,
      manualRecords: records,
      snapshots: [],
      now: FIXED_NOW,
      userZone: 'UTC',
    });

    const greedy = report.topics.find((p) => p.tagSlug === 'greedy')!;
    const med = greedy.difficulties.Medium;

    assert.equal(med.distinctProblemCount, 2);
    assert.equal(med.practiceDaysCount, 2);
    assert.equal(med.sufficiency, 'accumulating');
    // Insufficient feedback evidence prevents premature 'needs_reinforcement'
    assert.equal(med.evaluation, 'developing');
    assert.equal(greedy.overallEvaluation, 'developing');
  });

  it('keeps difficulty evaluations independent: Easy stability does not clear Medium difficulties', () => {
    const problems = [
      // 3 Easy problems, all independent across 3 days
      createMockProblem('e1', 'Easy', [{ slug: 'backtracking', name: 'Backtracking' }]),
      createMockProblem('e2', 'Easy', [{ slug: 'backtracking', name: 'Backtracking' }]),
      createMockProblem('e3', 'Easy', [{ slug: 'backtracking', name: 'Backtracking' }]),
      // 3 Medium problems, all assisted across 2 days
      createMockProblem('m1', 'Medium', [{ slug: 'backtracking', name: 'Backtracking' }]),
      createMockProblem('m2', 'Medium', [{ slug: 'backtracking', name: 'Backtracking' }]),
      createMockProblem('m3', 'Medium', [{ slug: 'backtracking', name: 'Backtracking' }]),
    ];

    const records = [
      createMockRecord('r1', 'e1', '2026-09-15', 'independent', true),
      createMockRecord('r2', 'e2', '2026-09-16', 'independent', true),
      createMockRecord('r3', 'e3', '2026-09-17', 'independent', true),
      createMockRecord('r4', 'm1', '2026-09-16', 'assisted', true),
      createMockRecord('r5', 'm2', '2026-09-16', 'assisted', true),
      createMockRecord('r6', 'm3', '2026-09-17', 'unsolved', false),
    ];

    const report = calculateKnowledgeProfile({
      problems,
      manualRecords: records,
      snapshots: [],
      now: FIXED_NOW,
      userZone: 'UTC',
    });

    const bt = report.topics.find((p) => p.tagSlug === 'backtracking')!;
    const easy = bt.difficulties.Easy;
    const med = bt.difficulties.Medium;

    // Easy tier is recently_stable
    assert.equal(easy.sufficiency, 'sufficient');
    assert.equal(easy.evaluation, 'recently_stable');
    assert.ok(easy.reasons.includes('recently_stable'));

    // Medium tier needs reinforcement
    assert.equal(med.sufficiency, 'sufficient');
    assert.equal(med.evaluation, 'needs_reinforcement');
    assert.ok(med.reasons.includes('feedback_assistance'));

    // Overall topic evaluation must reflect the weak tier!
    assert.equal(bt.overallEvaluation, 'needs_reinforcement');
    assert.deepEqual(bt.reinforcementDifficulties, ['Medium']);
    assert.equal(bt.isWeak, true);
  });

  it('evaluates duration threshold anomalies as reinforcement signals', () => {
    // Medium threshold is 45 minutes
    const problems = [
      createMockProblem('m1', 'Medium', [{ slug: 'math', name: 'Math' }]),
      createMockProblem('m2', 'Medium', [{ slug: 'math', name: 'Math' }]),
      createMockProblem('m3', 'Medium', [{ slug: 'math', name: 'Math' }]),
    ];

    // Outcome unrecorded, but 3 distinct problems with long durations (50m, 55m, 60m >= 45m)
    const records = [
      createMockRecord('r1', 'm1', '2026-09-10', null, true, 50),
      createMockRecord('r2', 'm2', '2026-09-12', null, true, 55),
      createMockRecord('r3', 'm3', '2026-09-15', null, true, 60),
    ];

    const report = calculateKnowledgeProfile({
      problems,
      manualRecords: records,
      snapshots: [],
      now: FIXED_NOW,
      userZone: 'UTC',
    });

    const math = report.topics.find((p) => p.tagSlug === 'math')!;
    const med = math.difficulties.Medium;

    assert.equal(med.durationSampleCount, 3);
    assert.equal(med.longDurationCount, 3);
    assert.equal(med.longDurationRate, 1.0);
    assert.equal(med.evaluation, 'needs_reinforcement');
    assert.ok(med.reasons.includes('duration_threshold'));
    assert.equal(math.overallEvaluation, 'needs_reinforcement');
  });

  it('excludes records outside the 30-day window from recent profile analytics', () => {
    const problems = [createMockProblem('1', 'Easy', [{ slug: 'string', name: 'String' }])];

    // Record from 35 days ago (2026-08-13)
    const records = [createMockRecord('r1', '1', '2026-08-13', 'unsolved', false)];

    const report = calculateKnowledgeProfile({
      problems,
      manualRecords: records,
      snapshots: [],
      now: FIXED_NOW,
      userZone: 'UTC',
    });

    const str = report.topics.find((p) => p.tagSlug === 'string')!;
    const easy = str.difficulties.Easy;

    assert.equal(easy.distinctProblemCount, 0);
    assert.equal(easy.practiceDaysCount, 0);
    assert.equal(easy.evaluation, 'insufficient_evidence');
  });
});
