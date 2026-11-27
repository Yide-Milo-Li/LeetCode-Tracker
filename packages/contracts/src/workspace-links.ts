/** Fragment destinations shared by the chat prompt and the desktop and web workspaces. */
export const workspaceViews = [
  'today', 'schedule', 'notes', 'problems', 'favorites', 'goal-lists', 'catalog-import',
  'records', 'statistics', 'progress-import', 'settings',
] as const;
export type WorkspaceView = typeof workspaceViews[number];

export const linkedSettingsSections = ['general', 'appearance', 'practice', 'ai', 'clients', 'sync', 'data'] as const;
export type SettingsSection = typeof linkedSettingsSections[number];
export function visibleSections(desktop: boolean): SettingsSection[] {
  return linkedSettingsSections.filter(section => desktop || section !== 'clients');
}

type Names<T extends string> = Record<T, { en: string; zh: string }>;
export const workspaceNames: Names<WorkspaceView> = {
  today: { en: "Today's plan", zh: '今日计划' },
  schedule: { en: 'Study schedule', zh: '学习安排' },
  notes: { en: 'My notes', zh: '我的复盘笔记' },
  problems: { en: 'Problem catalog', zh: '题库' },
  favorites: { en: 'Favorites', zh: '收藏夹' },
  'goal-lists': { en: 'Goal lists', zh: '目标题单' },
  'catalog-import': { en: 'Import problems', zh: '导入题库' },
  records: { en: 'Practice records', zh: '练习记录' },
  statistics: { en: 'Progress statistics', zh: '进展统计' },
  'progress-import': { en: 'Import progress', zh: '导入进度' },
  settings: { en: 'Settings', zh: '设置' },
};
export const settingsNames: Names<SettingsSection> = {
  general: { en: 'General', zh: '通用' },
  appearance: { en: 'Appearance', zh: '外观' },
  practice: { en: 'Practice & notes', zh: '练习与笔记' },
  ai: { en: 'AI assistant', zh: 'AI 助手' },
  clients: { en: 'AI clients', zh: 'AI 客户端' },
  sync: { en: 'Sync', zh: '设备同步' },
  data: { en: 'Data', zh: '数据' },
};

export type WorkspaceLink =
  | { view: WorkspaceView; targetId?: undefined }
  | { view: 'notes' | 'problems'; targetId: string }
  | { view: 'settings'; targetId: typeof linkedSettingsSections[number] };

export function problemWorkspaceHref(view: 'problems' | 'notes', frontendId: string): string {
  return '#' + view + '/' + encodeURIComponent(frontendId).replace(/[()]/g, char => char === '(' ? '%28' : '%29');
}

/** Unknown fragments belong to the document (for example, Markdown footnotes). */
export function parseWorkspaceLink(href: string, desktop = false): WorkspaceLink | null {
  if (href.startsWith('/#')) href = href.slice(1);
  if (!href.startsWith('#')) return null;
  const [name, target, ...extra] = href.slice(1).split('/');
  const view = workspaceViews.find(item => item === name);
  if (!view || extra.length) return null;
  if (target === undefined) return { view };
  if (view === 'settings') {
    const section = visibleSections(desktop).find(item => item === target);
    return section ? { view, targetId: section } : null;
  }
  if (view !== 'notes' && view !== 'problems') return null;
  try {
    const id = decodeURIComponent(target);
    if (!id.trim() || id !== id.trim() || id.length > 100 || id === '.' || id === '..' || /[\u0000-\u001f\u007f]/u.test(id)) return null;
    return { view, targetId: id };
  } catch {
    return null;
  }
}
