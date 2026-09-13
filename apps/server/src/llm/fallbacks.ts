/**
 * Deterministic fallback logic for LLM recommendations and prompt override parsing
 * when AI is unavailable, unconfigured, or times out.
 * Maintains 100% offline, zero-network fallback guarantees.
 */
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

    if (candidate.isFocusTopic) {
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
          en: 'Consistent daily practice turns small efforts into mastery. Let’s tackle today’s challenge!',
          zh: '坚持每日训练，积硅步以至千里。开启今日刷题挑战吧！',
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
export function fallbackOverridePrompt(prompt: string, _baseRules: Rules | null, knownTags: string[]): OverridePromptResult {
  const patch: RulePatch = {};
  const unresolved: string[] = [];
  const lower = prompt.toLowerCase();

  const countMatch = lower.match(/(\d+)\s*(?:题|problems?|questions?|count)/i) ?? lower.match(/(?:做|加|选|刷)\s*(\d+)/i);
  if (countMatch) {
    const num = parseInt(countMatch[1], 10);
    if (num > 0) patch.dailyCount = num;
  }

  if (lower.includes('全easy') || lower.includes('全部简单') || lower.includes('all easy')) {
    patch.difficulty = { Easy: 100, Medium: 0, Hard: 0 };
  } else if (lower.includes('全medium') || lower.includes('全部中等') || lower.includes('all medium')) {
    patch.difficulty = { Easy: 0, Medium: 100, Hard: 0 };
  } else if (lower.includes('全hard') || lower.includes('全部困难') || lower.includes('all hard')) {
    patch.difficulty = { Easy: 0, Medium: 0, Hard: 100 };
  } else if (lower.includes('不要hard') || lower.includes('不要困难') || lower.includes('no hard')) {
    patch.difficulty = { Easy: 50, Medium: 50, Hard: 0 };
  }

  if (lower.includes('不要复习') || lower.includes('关复习') || lower.includes('no review') || lower.includes('without review')) {
    patch.reviewEnabled = false;
    patch.reviewPercent = null;
  } else if (lower.includes('复习') || lower.includes('review')) {
    const reviewPctMatch = lower.match(/(\d+)\s*%/);
    if (reviewPctMatch) {
      patch.reviewEnabled = true;
      patch.reviewPercent = Math.min(100, Math.max(1, parseInt(reviewPctMatch[1], 10)));
    }
  }

  const matchedTags: string[] = [];
  for (const slug of knownTags) {
    const cleanSlug = slug.toLowerCase().replace(/-/g, ' ');
    if (lower.includes(slug) || lower.includes(cleanSlug)) {
      matchedTags.push(slug);
    }
  }
  if (matchedTags.length > 0) {
    patch.tags = matchedTags;
  }

  if (lower.includes('高频') || lower.includes('top') || lower.includes('google') || lower.includes('amazon') || lower.includes('面试')) {
    unresolved.push('Company and frequency tags cannot be verified against local metadata; treated as soft qualitative preferences.');
  }

  return { patch, unresolved, model: 'local' };
}
