/** Conservative local intent compilation. Unrecognized text always survives for review. */
import type { RulePatch, Rules } from '../../contracts/src/recommendations.ts';

export function compilePreference(prompt: string, base: Rules | null, knownTags: string[]) {
  let remainder = prompt.normalize('NFKC').toLowerCase().trim();
  const patch: RulePatch = {}, unresolved: string[] = [];
  const values = new Map<string, unknown[]>();
  const remember = (field: string, value: unknown) => values.set(field, [...(values.get(field) ?? []), value]);
  const consume = (pattern: RegExp, action: (...groups: string[]) => void) => {
    remainder = remainder.replace(pattern, (...args: unknown[]) => { action(...args.slice(1, -2) as string[]); return ' '; });
  };
  // Remove supported negative review clauses before considering positive counts.
  consume(/(?:不要复习|不复习|关复习|仅新题|全新题|\b(?:no review|without review|new only)\b)/g, () => remember('review', { reviewMode: 'none', reviewCount: 0, reviewEnabled: false, reviewPercent: null }));
  if (/(?:\bnot\b|\bdon'?t\b|\bwithout\b|不要|不想|别|避免|不能|不全|不是|\bavoid\b|\bexcept\b|\bexclude\b)/.test(remainder)) {
    return { patch: {}, unresolved: [prompt.trim()], model: 'local' as const };
  }
  consume(/(?:全部复习|全复习|\ball review\b)/g, () => remember('review', { reviewMode: 'all', reviewCount: null, reviewEnabled: true, reviewPercent: 100 }));
  // Review counts are consumed first so they cannot be mistaken for a daily total.
  let reviewCount: number | undefined;
  consume(/(?:其中\s*)?(?:复习|\breview)\s*(\d+)\s*(?:题|道|problems?|questions?)?(?![\d\s]*%)/g, n => { reviewCount = Number(n); remember('reviewCount', reviewCount); });
  consume(/(\d+)\s*(?:道|题)?\s*(?:复习|\breviews?\b)/g, n => { reviewCount = Number(n); remember('reviewCount', reviewCount); });
  consume(/(?:\b(?:total|daily|do|count)\s*[:=]?\s*|(?:每天|今日|今天|总共|一共)?\s*(?:做|刷|选)\s*)(\d+)\s*(?:道|题|problems?|questions?)?/g, n => remember('dailyCount', Number(n)));
  consume(/(\d+)\s*(?:道题|道|题|\bproblems?\b|\bquestions?\b)/g, n => remember('dailyCount', Number(n)));
  consume(/(?:\ball\s*(easy|medium|hard)\b|全(?:部)?\s*(easy|medium|hard|简单|中等|困难))/g, (a, b) => {
    const difficulty = ({ easy: 'Easy', medium: 'Medium', hard: 'Hard', 简单: 'Easy', 中等: 'Medium', 困难: 'Hard' } as Record<string, string>)[a || b];
    remember('difficulty', { Easy: difficulty === 'Easy' ? 100 : 0, Medium: difficulty === 'Medium' ? 100 : 0, Hard: difficulty === 'Hard' ? 100 : 0 });
  });
  const aliases: Record<string, string> = { dp: 'dynamic-programming', 动态规划: 'dynamic-programming', 数组: 'array', 树: 'tree', 图: 'graph', 哈希表: 'hash-table' };
  const tags: string[] = [];
  for (const slug of knownTags) {
    const names = [slug, slug.replaceAll('-', ' '), ...Object.keys(aliases).filter(a => aliases[a] === slug)];
    for (const name of new Set(names)) {
      const escaped = name.replace(/[.*+?^$\x7b\x7d()|[\]\\]/g, '\\$&');
      const pattern = new RegExp('(?:^|[\\s,，;；]+|\\b(?:only|tags?|topics?)\\s*:?\\s*|(?:只(?:做|练)?|专题|标签)\\s*)' + escaped + '(?=$|[\\s,，;；])', 'g');
      consume(pattern, () => { if (!tags.includes(slug)) tags.push(slug); });
    }
  }
  if (tags.length) patch.tags = tags;
  for (const [field, candidates] of values) {
    const unique = [...new Set(candidates.map(v => JSON.stringify(v)))];
    if (unique.length > 1) { unresolved.push('Conflicting explicit values for ' + field + '.'); continue; }
    const value = JSON.parse(unique[0]);
    if (field === 'review') Object.assign(patch, value);
    else if (field !== 'reviewCount') Object.assign(patch, { [field]: value });
  }
  if (values.has('reviewCount')) {
    if (values.has('review') || new Set(values.get('reviewCount')).size > 1) unresolved.push('Conflicting review requests.');
    else if (reviewCount && Number.isSafeInteger(reviewCount)) {
      const total = patch.dailyCount ?? base?.dailyCount;
      patch.reviewMode = 'partial'; patch.reviewCount = reviewCount; patch.reviewEnabled = true;
      patch.reviewPercent = total ? reviewCount / total * 100 : null;
    } else unresolved.push('Review count must be positive.');
  }
  remainder = remainder.replace(/\b(?:please|today|and|with|problems|questions)\b|(?:今天|今日|请|其中)|[\s,，;；。.!！:：]+/g, ' ').trim();
  if (remainder) unresolved.push(remainder);
  return { patch, unresolved, model: 'local' as const };
}
