/**
 * Display names for the tracker data the AI can look up, keyed by the read tool the server
 * reports in a `tool` event. The server decides which tools exist; this only names them.
 */
import type { Language } from '../i18n.ts';

const TOOL_LABELS: Record<string, Record<Language, string>> = {
  tracker_get_today: { en: "today's plan", zh: '今日计划' },
  tracker_search_problems: { en: 'problem catalog', zh: '题库' },
  tracker_get_problems: { en: 'problem details', zh: '题目详情' },
  tracker_list_practices: { en: 'practice records', zh: '练习记录' },
  tracker_get_progress: { en: 'progress', zh: '进度统计' },
  tracker_get_note_context: { en: 'problem history', zh: '题目记录' },
  tracker_get_notes: { en: 'notes', zh: '笔记' },
  tracker_list_notes: { en: 'note list', zh: '笔记列表' },
  tracker_get_strategies: { en: 'study strategies', zh: '学习策略' },
  tracker_get_goal_lists: { en: 'goal lists', zh: '目标题单' },
  tracker_get_favorite_folders: { en: 'favorites', zh: '收藏夹' },
};

/** What a lookup read, in the interface language; a tool this build does not know keeps its name. */
export function toolLabel(name: string, lang: Language): string {
  return TOOL_LABELS[name]?.[lang] ?? name;
}
