/**
 * Deterministic fallback logic for LLM recommendations and prompt override parsing
 * when AI is unavailable, unconfigured, or times out.
 * Maintains 100% offline, zero-network fallback guarantees.
 */
import { compilePreference } from '../../../../packages/domain/src/preference.ts';
import type { Bilingual, RulePatch, Rules, Candidate } from '../../../../packages/contracts/src/recommendations.ts';
import type { CatalogProblem } from '../../../../packages/contracts/src/sync.ts';
import type { OverridePromptResult, PlanContentResult } from './types.ts';

/**
 * Fallback bilingual reason and encouragement generator when AI is disabled or unavailable.
 *
 * @param problems Problem catalog items selected for today's plan.
 * @param _rules Active recommendation rules.
 * @returns Deterministic plan content result.
 */
export function fallbackPlanContent(problems: CatalogProblem[] = [], _rules: Rules): PlanContentResult {
  const list = Array.isArray(problems) ? problems : [];
  const reasons: Record<string, Bilingual> = {};
  for (const p of list) {
    const candidate = p as Partial<Candidate>;
    const focusTags = candidate.matchedWeakTags?.length ? candidate.matchedWeakTags.slice(0, 2).join(' / ') : null;
    const tagNames = p.topicTags.slice(0, 2).map((t: { name: string }) => t.name).join(' / ');
    const tagStr = focusTags ? ` (${focusTags})` : (tagNames ? ` (${tagNames})` : '');

    if (candidate.explanation?.reviewDecision) {
      const d = candidate.explanation.reviewDecision;
      const enReason = {
        independent: 'independent',
        assisted: 'assisted',
        unsolved: 'unsolved',
        duration_threshold: 'duration threshold',
        legacy_unknown: 'unknown outcome',
        baseline: 'historical baseline',
      }[d.reason];
      const zhReason = {
        independent: '独立完成',
        assisted: '辅助完成',
        unsolved: '未解决',
        duration_threshold: '达到用时阈值',
        legacy_unknown: '未记录解题方式',
        baseline: '历史基线',
      }[d.reason];
      reasons[p.questionId] = {
        en: 'Review (' + d.policyVersion + ', ' + enReason + '): stage ' + d.stage + ', interval ' + d.intervalDays + ' day(s), due ' + (d.dueDate ?? 'unknown') + '.',
        zh: '复习（' + d.policyVersion + '，' + zhReason + '）：阶段 ' + d.stage + '，间隔 ' + d.intervalDays + ' 天，到期 ' + (d.dueDate ?? '日期未知') + '。',
      };
    } else if (candidate.explanation?.recoveryPriority) {
      reasons[p.questionId] = { en: 'A recorded attempt remained unsolved. This recovery practice uses a new-problem slot.', zh: '已有一次未解决的记录；本次补练使用新题名额。' };
    } else if (candidate.kind === 'review') {
      reasons[p.questionId] = { en: 'Review due ' + (candidate.dueDate ?? 'on an unknown date') + ' under the saved review schedule.', zh: '依据当前复习安排，到期日期：' + (candidate.dueDate ?? '未知') + '。' };
    } else if (candidate.explanation?.evidenceSummary?.reasonText) {
      reasons[p.questionId] = candidate.explanation.evidenceSummary.reasonText;
    } else if (candidate.isFocusTopic) {
      reasons[p.questionId] = {
        en: `Selected ${p.difficulty} problem targeting weak topic${tagStr} for targeted practice.`,
        zh: `精选薄弱专题${p.difficulty === 'Easy' ? '简单' : p.difficulty === 'Medium' ? '中等' : '困难'}题目${tagStr}，针对性巩固突破。`,
      };
    } else {
      reasons[p.questionId] = {
        en: `Selected ${p.difficulty} problem${tagStr} to reinforce algorithmic problem-solving patterns.`,
        zh: `精选${p.difficulty === 'Easy' ? '简单' : p.difficulty === 'Medium' ? '中等' : '困难'}难度题目${tagStr}，针对性巩固算法解题模式。`,
      };
    }
  }
  return {
    reasons,
    encouragement: list.some(p => (p as Partial<Candidate>).explanation?.focusTagSlugs.length)
      ? {
          en: 'Practice the selected topics at your own pace and record what you learn.',
          zh: '按自己的节奏巩固今日专题，记录收获与疑问。',
        }
      : {
          en: 'Work through the selected plan at your own pace and record the outcome of each attempt.',
          zh: '按自己的节奏完成今日计划，并记录每次尝试的结果。',
        },
    model: 'local',
  };
}

/**
 * Fallback parser for user prompt when AI is disabled or unavailable.
 * Uses regular expressions and keyword matching against known catalog tags.
 *
 * @param prompt User natural language prompt.
 * @param _baseRules Current baseline rules for today.
 * @param knownTags Known tag slugs from catalog.
 * @returns Rule patch and unresolved requests.
 */
export function fallbackOverridePrompt(
  prompt: string,
  _baseRules: Rules | null = null,
  knownTags: string[] = [],
): OverridePromptResult {
  return compilePreference(prompt, _baseRules, knownTags);
}
