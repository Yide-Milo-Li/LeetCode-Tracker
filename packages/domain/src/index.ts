/**
 * Core business domain logic package for LeetCode Tracker.
 * Exports pure scheduling rules, recommendation selection, and dashboard analytics.
 * Zero storage, network, clock, or random-number dependencies.
 */

// Recommendation and scheduling algorithms
export {
  ALGORITHM_VERSION,
  allocate,
  quotas,
  evidenceAfter,
  evidenceDate,
  reviewState,
  projectReviewStates,
  reorderCandidates,
  matches,
  candidates,
  select,
  nextDifficultyForAppend,
  type Selection,
} from './recommendations.ts';

// Dashboard statistics, activity metrics, and time aggregation
export {
  getZonedDayInterval,
  resolveEventDate,
  getMondayOfWeek,
  calculateStreak,
  calculateDashboardStats,
  getActivityItems,
  filterAndPaginateActivities,
  type DashboardStatsInput,
} from './dashboard.ts';

// Tag mastery analysis and weak topic identification
export {
  calculateTagMastery,
  focusTopics,
  type TagMasteryInput,
} from './mastery.ts';

// Knowledge profile multi-signal analysis
export {
  calculateKnowledgeProfile,
  PROFILE_ANALYSIS_VERSION,
  type KnowledgeProfileInput,
} from './knowledge-profile.ts';
