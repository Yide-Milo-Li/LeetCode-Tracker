/**
 * Contracts, schemas, and types for Dashboard overview, yearly heatmap,
 * 30-day activity trends, difficulty/tag distributions, and activity history drawer.
 */
import { z } from 'zod';
import type { RevisionStamp } from './recommendations.ts';

import { isCalendarDate } from './time.ts';

/** Query parameters for the main dashboard endpoint. */
export const dashboardQuerySchema = z.object({
  year: z.coerce.number().int().min(1970).max(2100).optional(),
}).strict();

export type DashboardQuery = z.infer<typeof dashboardQuerySchema>;

/** Query parameters for paginated activity history drawer. */
export const dashboardActivityQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  date: z.string().refine(isCalendarDate, 'Invalid calendar date').optional(),
  source: z.enum(['manual', 'snapshot', 'all']).default('all'),
  pendingDate: z.enum(['true', 'false', 'all']).default('all'),
}).strict();

export type DashboardActivityQuery = z.infer<typeof dashboardActivityQuerySchema>;
export type DashboardActivityQueryInput = z.input<typeof dashboardActivityQuerySchema>;

/** Overview metrics summary card data. */
export interface DashboardOverview {
  uniqueSolvedProblems: number;
  solvedThisWeek: number;
  currentStreak: number;
  totalManualPractices: number;
  totalSnapshotSubmissions: number;
}

/** Today's plan execution summary card data on the dashboard. */
export interface DashboardDailySummary {
  status: 'ready' | 'rest' | 'setup' | 'failed' | 'generating';
  strategyName: string | null;
  completedCount: number;
  targetCount: number;
  shortage: number;
  planId: string | null;
  errorMessage: string | null;
}

/** Single calendar day statistics for yearly contribution heatmap. */
export interface YearlyActivityDay {
  date: string; // YYYY-MM-DD
  activeProblemCount: number; // Deduplicated distinct problems active on this day
  solvedProblemCount: number; // Distinct problems with success event on this day
  manualCount: number;
  snapshotCount: number;
}

/** Single day point in 30-day trend chart. */
export interface DailyTrendPoint {
  date: string; // YYYY-MM-DD
  activeCount: number;
  completedCount: number;
}

/** Problem count breakdown per difficulty. */
export interface DifficultyCount {
  solved: number;
  total: number;
}

/** Overall difficulty distribution across solved problems. */
export interface DifficultyDistribution {
  Easy: DifficultyCount;
  Medium: DifficultyCount;
  Hard: DifficultyCount;
}

/** Tag distribution entry among top 10 solved tags. */
export interface TagDistribution {
  tagSlug: string;
  tagName: string;
  solvedCount: number;
}

/** Verified historical snapshot success event. */
export interface DashboardSnapshotSuccess {
  questionId: string;
  questionFrontendId: string;
  problemTitle: string;
  difficulty: 'Easy' | 'Medium' | 'Hard';
  version: number;
  eventTime: string;
  precision: 'datetime' | 'date';
  sourceTimezone: string | null;
  recordedAt: number;
}

/** Item representing a recent activity event. */
export interface RecentActivityItem {
  id: string;
  source: 'manual' | 'snapshot';
  questionId: string;
  questionFrontendId: string;
  problemTitle: string;
  difficulty: 'Easy' | 'Medium' | 'Hard';
  action: string;
  status: 'completed' | 'uncompleted' | 'accepted' | 'other';
  timestamp: string;
  timePrecision: 'datetime' | 'date';
  sourceTimezone: string | null;
  isDatePending: boolean;
}

/** Status metadata regarding data freshness and timezones. */
export interface DashboardDataStatus {
  catalogUpdatedAt: number | null;
  practiceUpdatedAt: number | null;
  userTimezone: string | null;
  pendingDateCount: number;
}

/** Full payload returned by GET /api/v1/dashboard. */
export interface DashboardResponse {
  overview: DashboardOverview;
  todaySummary: DashboardDailySummary;
  yearlyActivity: {
    year: number;
    days: YearlyActivityDay[];
  };
  trend30Days: DailyTrendPoint[];
  difficultyDistribution: DifficultyDistribution;
  topTags: TagDistribution[];
  recentActivities: RecentActivityItem[];
  dataStatus: DashboardDataStatus;
  revision: RevisionStamp;
}

/** Paginated response returned by GET /api/v1/dashboard/activity. */
export interface DashboardActivityListResponse {
  items: RecentActivityItem[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}
