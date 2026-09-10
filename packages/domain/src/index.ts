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
  matches,
  candidates,
  select,
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
