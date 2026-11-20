/**
 * Client-side localization helpers for API errors, planning conflicts, and override issues.
 * Maps stable backend error codes and known diagnostic patterns into pure EN or ZH copy.
 */
import { ApiError } from './platform/index.ts';
import type { Language } from './i18n.ts';

interface BilingualMessage {
  en: string;
  zh: string;
}

const API_ERROR_MESSAGES: Record<string, BilingualMessage> = {
  LLM_OUTPUT_TRUNCATED: {
    en: 'The provider truncated its response. Paste fewer progress rows at a time.',
    zh: '模型输出已截断。请减少每次粘贴的进度行数，分批整理。',
  },
  LLM_INVALID_OUTPUT: {
    en: 'The provider returned unusable progress data. Check the pasted rows before trying again.',
    zh: '模型返回的进度数据格式有误。请检查粘贴的行后重试。',
  },
  LLM_REQUEST_REJECTED: {
    en: 'The provider rejected the formatting request. Check the model and endpoint settings.',
    zh: '服务商拒绝了整理请求。请检查模型和服务端点设置。',
  },
  NO_CANDIDATES: {
    en: 'No eligible candidates found for target difficulty and type; adjust rules to continue.',
    zh: '没有符合当前难度与题型条件的候选题目，请调整规则后再试。',
  },
  STALE_DATA: {
    en: 'Catalog or practice data changed. Refresh and try again.',
    zh: '题库或练习数据已发生变化，请刷新后重试。',
  },
  STRATEGY_NOT_FOUND: {
    en: 'Study strategy not found.',
    zh: '未找到对应的学习策略。',
  },
  TIMEZONE_REQUIRED: {
    en: 'Set your time zone in Settings to schedule practice on your local dates.',
    zh: '请先在设置中选择时区，再按当地日期安排练习。',
  },
  ACTIVE_STUDY_PLAN: {
    en: 'A goal is already active. Refresh the schedule and reopen the goal editor to replace it.',
    zh: '已有进行中的目标。请刷新学习安排，再打开目标表单进行替换。',
  },
  GOAL_HAS_PRACTICE: { en: 'This goal has practice history. You can archive it.', zh: '此目标已有练习记录，可以归档。' },
  STUDY_PLAN_NOT_FOUND: {
    en: 'This goal could not be found. Reopen Study Schedule.',
    zh: '找不到这份题单，请重新打开学习安排。',
  },
  STALE_STUDY_PLAN: {
    en: 'The active goal changed. Refresh the schedule and reopen the goal editor.',
    zh: '当前目标已发生变化。请刷新学习安排，再打开目标表单。',
  },
  INVALID_DATE: {
    en: 'Invalid plan date.',
    zh: '计划日期无效。',
  },
  CANNOT_GENERATE_HISTORICAL_PLAN: {
    en: 'Cannot generate a new plan for a past date.',
    zh: '无法为过去的日期生成新计划。',
  },
  ITEM_NOT_FOUND: {
    en: 'This problem is no longer in today’s plan.',
    zh: '今日计划中未找到该题目。',
  },
  ITEM_ALREADY_COMPLETED: {
    en: 'Completed problems cannot be replaced.',
    zh: '已完成的题目无法替换。',
  },
  MAX_COUNT_REACHED: {
    en: 'Today’s plan has already reached the maximum problem limit.',
    zh: '今日计划题目数量已达上限。',
  },
  REVIEW_QUOTA_CONFLICT: {
    en: 'Review quota conflicts with the current plan items. Adjust rules or replace items to continue.',
    zh: '复习题配额与当前计划冲突，请调整规则或更换题目后再试。',
  },
  COMPLETED_QUOTA: {
    en: 'Completed items already exceed the requested quota.',
    zh: '已完成的题目数量超过了目标配额。',
  },
  INVALID_DIFFICULTY_RATIO: {
    en: 'At least one difficulty must have a positive ratio.',
    zh: '至少需要为一个难度设置大于 0 的比例。',
  },
  WEEKDAY_CONFLICT: {
    en: 'One or more selected weekdays are already assigned to another strategy.',
    zh: '所选星期中已有部分日期分配给其他学习策略。',
  },
  STALE_STRATEGY: {
    en: 'This strategy was updated elsewhere. Reload and try again.',
    zh: '学习策略已发生变化，请重新加载后再试。',
  },
  PREVIEW_EXPIRED: {
    en: 'This preview has expired. Generate a new preview and try again.',
    zh: '预览已过期，请重新生成预览后再试。',
  },
  PREVIEW_NOT_FOUND: {
    en: 'Preview not found. Generate a new preview and try again.',
    zh: '未找到该预览，请重新生成预览后再试。',
  },
  INVALID_OVERRIDE: {
    en: 'The proposed rule adjustments are invalid. Check the issues listed below.',
    zh: '临时调整规则无效，请检查下方问题说明。',
  },
  UNKNOWN_TAG: {
    en: 'One or more selected tags are not in the local catalog.',
    zh: '所选标签中存在本地题库未包含的标签。',
  },
  OPERATION_REUSED: {
    en: 'This operation identifier conflicted with another request. Please retry.',
    zh: '操作标识与另一请求冲突，请重试。',
  },
  CATALOG_CHANGED: {
    en: 'The catalog changed after preview. Regenerate the preview and try again.',
    zh: '题库在预览后发生了变化，请重新生成预览后再试。',
  },
  DATABASE_CHANGED: {
    en: 'The database changed after preview. Regenerate the preview and try again.',
    zh: '数据库在预览后发生了变化，请重新生成预览后再试。',
  },
  NO_VALID_RECORDS: {
    en: 'No valid records were found to import.',
    zh: '没有可导入的有效记录。',
  },
  LINE_LIMIT_EXCEEDED: {
    en: 'The input exceeds the maximum allowed line limit.',
    zh: '内容超过了允许的最大行数限制。',
  },
  PROBLEM_NOT_FOUND: {
    en: 'Problem not found in the local catalog.',
    zh: '本地题库中未找到该题目。',
  },
  RECORD_NOT_FOUND: {
    en: 'Practice record not found.',
    zh: '未找到该练习记录。',
  },
  SNAPSHOT_NOT_FOUND: {
    en: 'Progress snapshot not found.',
    zh: '未找到该进度快照。',
  },
  IMPORT_NOT_FOUND: {
    en: 'Import history entry not found.',
    zh: '未找到该导入记录。',
  },
  INVALID_SETTINGS: {
    en: 'Invalid settings values. Check your inputs and try again.',
    zh: '设置参数无效，请检查输入后再试。',
  },
  INVALID_REQUEST: {
    en: 'Invalid request parameters.',
    zh: '请求参数无效。',
  },
  INVALID_QUERY: {
    en: 'Invalid query parameters.',
    zh: '查询参数无效。',
  },
  PROFILE_BUSY: {
    en: 'Wait for active operations to finish, then retry.',
    zh: '当前有其他操作正在进行，请稍后重试。',
  },
  STALE_REVISION: {
    en: 'This record was modified elsewhere. Refresh and try again.',
    zh: '数据在保存期间已被更新，请刷新后重试。',
  },
  CONFLICT: {
    en: 'This record changed while saving. Refresh and try again.',
    zh: '数据在保存期间发生冲突，请刷新后重试。',
  },
  STORAGE_ERROR: {
    en: 'Local storage operation failed. Please try again.',
    zh: '本地存储操作失败，请重试。',
  },
  DESKTOP_IPC_ERROR: {
    en: 'Desktop bridge communication failed. Please try again.',
    zh: '桌面端本地通信失败，请重试。',
  },
  TEST_CONNECTION_FAILED: {
    en: 'Connection test failed. Check your API key, model, and network.',
    zh: '连接测试失败，请检查 API 密钥、模型名称与网络配置。',
  },
  NOTE_FORMAT_NOT_CONFIGURED: {
    en: 'Configure an AI provider in Settings to format notes.',
    zh: '请先在设置中配置 AI 服务商。',
  },
  AI_NOT_CONFIGURED: {
    en: 'Configure an AI provider in Settings first.',
    zh: '请先在设置中配置 AI 服务商。',
  },
  GEMINI_NOT_CONFIGURED: {
    en: 'Configure an AI provider in Settings first.',
    zh: '请先在设置中配置 AI 服务商。',
  },
  NOTE_FORMAT_AUTH_ERROR: {
    en: 'AI provider authentication failed. Check your API key in Settings.',
    zh: 'AI 服务商鉴权失败，请检查设置中的 API 密钥。',
  },
  NOTE_FORMAT_QUOTA: {
    en: 'AI provider quota or balance exceeded. Check your billing or try another model.',
    zh: 'AI 服务商配额或余额不足，请检查账户额度或切换模型。',
  },
  GEMINI_QUOTA_EXCEEDED: {
    en: 'AI provider quota or balance exceeded. Check your billing or try another model.',
    zh: 'AI 服务商配额或余额不足，请检查账户额度或切换模型。',
  },
  OPENAI_QUOTA_EXCEEDED: {
    en: 'OpenAI quota or balance exceeded. Check your billing or try another model.',
    zh: 'OpenAI 配额或余额不足，请检查账户额度或切换模型。',
  },
  DEEPSEEK_QUOTA_EXCEEDED: {
    en: 'DeepSeek balance is insufficient. Check your provider billing.',
    zh: 'DeepSeek 账户余额不足，请检查服务商账单或额度。',
  },
  NOTE_FORMAT_TIMEOUT: {
    en: 'AI formatting timed out. Please try again.',
    zh: 'AI 整理请求超时，请稍后重试。',
  },
  GEMINI_TIMEOUT: {
    en: 'AI request timed out. Please try again.',
    zh: 'AI 请求超时，请稍后重试。',
  },
  OPENAI_TIMEOUT: {
    en: 'AI request timed out. Please try again.',
    zh: 'AI 请求超时，请稍后重试。',
  },
  DEEPSEEK_TIMEOUT: {
    en: 'AI request timed out. Please try again.',
    zh: 'AI 请求超时，请稍后重试。',
  },
  NOTE_FORMAT_UNAVAILABLE: {
    en: 'AI formatting is temporarily unavailable. Please try again.',
    zh: 'AI 整理服务暂时不可用，请稍后重试。',
  },
  GEMINI_UNAVAILABLE: {
    en: 'AI service is temporarily unavailable. Please try again.',
    zh: 'AI 服务暂时不可用，请稍后重试。',
  },
  OPENAI_UNAVAILABLE: {
    en: 'AI service is temporarily unavailable. Please try again.',
    zh: 'AI 服务暂时不可用，请稍后重试。',
  },
  DEEPSEEK_UNAVAILABLE: {
    en: 'AI service is temporarily unavailable. Please try again.',
    zh: 'AI 服务暂时不可用，请稍后重试。',
  },
  NOTE_FORMAT_INVALID_RESPONSE: {
    en: 'The AI returned an invalid layout. Try a smaller selection or edit manually.',
    zh: 'AI 返回了无效的格式结构，请缩小选区后重试或手动编辑。',
  },
  NOTE_FORMAT_INVALID_LAYOUT: {
    en: 'The AI returned an invalid layout. Try a smaller selection or edit manually.',
    zh: 'AI 返回了无效的格式结构，请缩小选区后重试或手动编辑。',
  },
  GEMINI_ERROR: {
    en: 'AI request failed. Check your provider settings or try again.',
    zh: 'AI 请求失败，请检查服务商配置或稍后重试。',
  },
  OPENAI_ERROR: {
    en: 'OpenAI request failed. Check your provider settings or try again.',
    zh: 'OpenAI 请求失败，请检查服务商配置或稍后重试。',
  },
  DEEPSEEK_ERROR: {
    en: 'DeepSeek request failed. Check your provider settings or try again.',
    zh: 'DeepSeek 请求失败，请检查服务商配置或稍后重试。',
  },
};

const CJK_RE = /[\u4e00-\u9fff]/;

/**
 * Split legacy slash-separated bilingual error messages ("EN / ZH") when encountered.
 */
function splitMixedBilingual(message: string, lang: Language): string | null {
  const parts = message.split(/\s+\/\s+/);
  if (parts.length !== 2) return null;
  const [left, right] = parts;
  if (!CJK_RE.test(left) && CJK_RE.test(right)) {
    return lang === 'zh' ? right.trim() : left.trim();
  }
  return null;
}

/**
 * Map well-known English error message strings (from server fallbacks or unit-test mocks)
 * to localized copy while preserving English assertions in `en` mode.
 */
function matchKnownErrorMessage(message: string, lang: Language): string | null {
  if (message === 'Include at least one new-problem day; review-only days must be study days.')
    return lang === 'zh' ? '请至少保留一个可安排新题的学习日。' : message;
  if (message === 'Choose a future deadline or switch to daily pacing.') return lang === 'zh' ? '请延后截止日，或清空截止日后按日常题量恢复。' : message;
  if (message === 'Only an upcoming goal can change its start date.') return lang === 'zh' ? '只有尚未开始的目标可以改开始日期。' : message;
  if (message === 'Choose today or a future date.') return lang === 'zh' ? '请选择今天或之后的日期。' : message;
  if (message === 'The deadline has passed.') return lang === 'zh' ? '请选择今天或之后的截止日。' : message;
  const dependency = /^#(.+) requires #(.+)\. List prerequisites earlier in the route\.$/.exec(message);
  if (dependency) return lang === 'zh' ? `#${dependency[1]} 依赖 #${dependency[2]}。请将 #${dependency[2]} 放在它前面，或一并移除依赖它的题目。` : message;
  const duplicateRoute = /^Duplicate route item #(.+)\.$/.exec(message);
  if (duplicateRoute) return lang === 'zh' ? `题号 #${duplicateRoute[1]} 在题单中重复了，请保留一次。` : message;
  if (message === 'Use up to 150 problems, including at least one core problem.')
    return lang === 'zh' ? '请保留至少一道必做题，整份题单最多 150 道。' : message;
  const unknownProblem = /^Unknown catalog problem #(.+)\.$/.exec(message);
  if (unknownProblem) {
    return lang === 'zh' ? `本地题库中找不到题号 #${unknownProblem[1]}，请检查题号或先导入这道题。` : message;
  }
  const filteredGoalProblem = /^Stage ".+": #(.+) cannot be scheduled with these tags, Premium or difficulty rules\.$/.exec(message);
  if (filteredGoalProblem) {
    return lang === 'zh' ? `题号 #${filteredGoalProblem[1]} 与目标的题目筛选条件冲突，请检查难度占比、标签和会员题设置。` : message;
  }
  if (/no eligible candidates found/i.test(message)) {
    return lang === 'zh'
      ? '没有符合当前难度与题型条件的候选题目，请调整规则后再试。'
      : message;
  }
  if (/only today can be modified/i.test(message)) {
    return lang === 'zh'
      ? '仅支持修改今日计划，请刷新当前日期后重试。'
      : 'Only today can be modified; reload the current day.';
  }
  if (/failed to fetch|networkerror|load failed|fetch failed|network request failed/i.test(message)) {
    return lang === 'zh'
      ? '网络请求失败，请确认本地服务正常运行后重试。'
      : 'Network request failed. Check that the local service is running and try again.';
  }
  if (/plan changed;\s*reload it/i.test(message)) {
    return lang === 'zh' ? '今日计划已更新，请刷新后重试。' : message;
  }
  if (/data changed;\s*refresh and try again/i.test(message)) {
    return lang === 'zh' ? '题库或练习数据已发生变化，请刷新后重试。' : message;
  }
  if (/strategy changed;\s*reload it/i.test(message)) {
    return lang === 'zh' ? '学习策略已发生变化，请重新加载后再试。' : message;
  }
  if (/weekday already assigned/i.test(message)) {
    return lang === 'zh'
      ? '所选星期中已有部分日期分配给其他学习策略。'
      : message;
  }
  if (/duration must be a positive whole number/i.test(message)) {
    return lang === 'zh' ? '耗时须为正整数。' : 'Duration must be a positive whole number.';
  }
  return null;
}

/**
 * Convert an unknown error or `ApiError` into user-facing text in the requested language.
 * Prevents raw English backend errors or mixed `EN / ZH` strings from leaking into the UI.
 */
export function localizeApiError(err: unknown, lang: Language, fallback?: string): string {
  const defaultFallback = fallback ?? (lang === 'zh' ? '操作失败，请稍后重试。' : 'Request failed. Please try again.');

  if (err instanceof ApiError) {
    if (err.code === 'STALE_PLAN') {
      if (/only today can be modified/i.test(err.message)) {
        return lang === 'zh'
          ? '仅支持修改今日计划，请刷新当前日期后重试。'
          : 'Only today can be modified; reload the current day.';
      }
      return lang === 'zh'
        ? '今日计划已更新，请刷新后重试。'
        : 'Today’s plan changed. Reload and try again.';
    }

    const mapped = API_ERROR_MESSAGES[err.code];
    if (mapped) {
      return mapped[lang];
    }

    const rawMsg = err.message.trim();
    if (rawMsg) {
      const split = splitMixedBilingual(rawMsg, lang);
      if (split) return split;
      const known = matchKnownErrorMessage(rawMsg, lang);
      if (known) return known;
      if (lang === 'en' && !CJK_RE.test(rawMsg)) {
        return rawMsg;
      }
      if (lang === 'zh' && CJK_RE.test(rawMsg)) {
        return rawMsg;
      }
    }
    return defaultFallback;
  }

  const rawMsg = err instanceof Error ? err.message.trim() : typeof err === 'string' ? err.trim() : '';
  if (!rawMsg) return defaultFallback;

  const split = splitMixedBilingual(rawMsg, lang);
  if (split) return split;

  const known = matchKnownErrorMessage(rawMsg, lang);
  if (known) return known;

  if (lang === 'zh') {
    // Only surface raw messages in Chinese UI when they already contain Chinese text.
    return CJK_RE.test(rawMsg) ? rawMsg : defaultFallback;
  }

  return CJK_RE.test(rawMsg) ? defaultFallback : rawMsg;
}

const DIFFICULTY_ZH: Record<'Easy' | 'Medium' | 'Hard', string> = {
  Easy: '简单',
  Medium: '中等',
  Hard: '困难',
};

/**
 * Localize an `OverridePreview` issue or unresolved-clause string into the active UI language.
 * Preserves English strings verbatim when `lang === 'en'` and translates backend validation issues in `zh`.
 */
export function localizePlanningIssue(issue: string, lang: Language): string {
  const trimmed = issue.trim();
  if (!trimmed) return trimmed;
  if (lang === 'en') return trimmed;
  if (CJK_RE.test(trimmed)) return trimmed;

  if (trimmed === 'Use the structured focus and adaptive review controls to specify these options.') {
    return '请使用下方的薄弱专题聚焦与自适应复习控件来设置这些选项。';
  }
  if (trimmed === 'Daily question count must be explicitly specified.') {
    return '请明确指定每日题目数量。';
  }
  if (trimmed === 'Difficulty distribution percentages must be explicitly specified.') {
    return '请明确指定难度分布百分比。';
  }
  if (trimmed === 'Review setting (enabled/disabled) must be explicitly specified.') {
    return '请明确指定是否启用复习题。';
  }
  if (trimmed === 'Difficulty percentages must sum to exactly 100%.') {
    return '各难度比例之和必须等于 100%。';
  }

  const unknownTagMatch = /^Unknown tag '(.+)' is not in the local catalog\.$/.exec(trimmed);
  if (unknownTagMatch) {
    return `本地题库中不存在标签“${unknownTagMatch[1]}”。`;
  }

  const completedDiffMatch = /^Completed (Easy|Medium|Hard) problems \((\d+)\) exceed the proposed quota \((\d+)\)\.$/.exec(trimmed);
  if (completedDiffMatch) {
    const diff = DIFFICULTY_ZH[completedDiffMatch[1] as 'Easy' | 'Medium' | 'Hard'];
    return `已完成的${diff}题目（${completedDiffMatch[2]} 道）超过了调整后的配额（${completedDiffMatch[3]} 道）。`;
  }

  const completedReviewMatch = /^Completed review problems \((\d+)\) exceed the proposed review quota \((\d+)\)\.$/.exec(trimmed);
  if (completedReviewMatch) {
    return `已完成的复习题（${completedReviewMatch[1]} 道）超过了调整后的复习配额（${completedReviewMatch[2]} 道）。`;
  }

  const completedNewMatch = /^Completed new problems \((\d+)\) exceed the proposed new question quota \((\d+)\)\.$/.exec(trimmed);
  if (completedNewMatch) {
    return `已完成的新题（${completedNewMatch[1]} 道）超过了调整后的新题配额（${completedNewMatch[2]} 道）。`;
  }

  if (/^dailyCount:/i.test(trimmed)) {
    return '每日题目数量必须在允许的整数范围内（1–50）。';
  }
  if (/^difficulty:/i.test(trimmed)) {
    return '难度分布比例配置无效，请检查各难度百分比。';
  }
  if (/^reviewCount:/i.test(trimmed)) {
    return '复习题数量配置无效，请检查复习题数与总题数范围。';
  }
  if (/^reviewPercent:/i.test(trimmed)) {
    return '复习题比例配置无效，请填写 0–100 之间的数值。';
  }

  return trimmed;
}
