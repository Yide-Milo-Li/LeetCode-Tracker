/** Linear, request-local evidence aggregation; no notes, submission totals or ability scores. */
import type { CatalogProblem } from '../../contracts/src/sync.ts';
import type { PracticeRecord, ProgressSnapshot } from '../../contracts/src/practice.ts';
import type { DashboardSnapshotSuccess } from '../../contracts/src/dashboard.ts';
import type { ReviewState, RevisionStamp, Evidence } from '../../contracts/src/recommendations.ts';
import type { TagMastery, TagMasteryReport } from '../../contracts/src/mastery.ts';
import { localDate, addDays, isTimeZone } from '../../contracts/src/time.ts';
import { createEvidenceDateResolver } from './recommendations.ts';
import { ANALYSIS_VERSION, DURATION_THRESHOLDS, validDuration } from './review-policy.ts';
/** Fixed projections make insights independent of strategy-specific adaptive switches. */
export interface TagMasteryInput {
    problems: CatalogProblem[];
    manualRecords: PracticeRecord[];
    snapshots: ProgressSnapshot[];
    snapshotSuccesses?: DashboardSnapshotSuccess[];
    reviewStates?: ReviewState[];
    now: number;
    userZone?: string | null;
    revision?: RevisionStamp;
}
/** Aggregate each question/day once; unknown dates contribute coverage but not trends. */
export function calculateTagMastery(input: TagMasteryInput): TagMasteryReport {
    const { problems, manualRecords, snapshots, now } = input;
    const zone = input.userZone && isTimeZone(input.userZone) ? input.userZone : 'UTC';
    const today = localDate(now, zone), start = addDays(today, -29), resolve = createEvidenceDateResolver(zone, now);
    const byId = new Map(problems.map(p => [p.questionId, p]));
    const solved = new Set<string>(), unknown = new Set<string>();
    const samples = new Map<string, Map<string, number | null>>();
    const recentSolved = new Set<string>();
    /** Keep one conservative completed duration per question/day across all sources. */
    function activity(id: string, evidence: Evidence, completed: boolean, duration?: number | null): void {
        if (!byId.has(id))
            return;
        if (completed)
            solved.add(id);
        const date = resolve(evidence);
        if (date === null) {
            unknown.add(id);
            return;
        }
        if (date < start || date > today)
            return;
        if (completed)
            recentSolved.add(id);
        let days = samples.get(id);
        if (!days) {
            days = new Map();
            samples.set(id, days);
        }
        const previous = days.get(date) ?? null;
        days.set(date, completed && validDuration(duration) ? Math.max(previous ?? 0, duration) : previous);
    }
    for (const r of manualRecords) {
        if (r.status !== 'active')
            continue;
        activity(r.questionId, { id: r.id, questionId: r.questionId, at: r.practicedAt, precision: r.timePrecision,
            zone: r.sourceTimezone, recordedAt: r.createdAt }, r.completed, r.durationMinutes);
    }
    for (const s of snapshots) {
        if (s.status !== 'active')
            continue;
        const accepted = s.hasAccepted || s.lastResult === 'Accepted';
        if (accepted)
            solved.add(s.questionId);
        activity(s.questionId, { id: 'snapshot:' + s.questionId, questionId: s.questionId, at: s.lastSubmittedAt,
            precision: s.timePrecision, zone: (s as ProgressSnapshot & {
                sourceTimezone?: string | null;
            }).sourceTimezone ?? null,
            recordedAt: s.updatedAt }, s.lastResult === 'Accepted');
    }
    for (const s of input.snapshotSuccesses ?? []) {
        activity(s.questionId, { id: 'success:' + s.questionId + ':' + s.version, questionId: s.questionId,
            at: s.eventTime, precision: s.precision, zone: s.sourceTimezone, recordedAt: s.recordedAt }, true);
    }
    const states = new Map((input.reviewStates ?? []).map(s => [s.questionId, s]));
    const tags = new Map<string, {
        tag: TagMastery;
        days: Set<string>;
        timedProblems: number;
        recentSolved: number;
        sum: number;
    }>();
    for (const p of problems) {
        const days = samples.get(p.questionId);
        const durations = [...(days?.values() ?? [])].filter(validDuration);
        const state = states.get(p.questionId);
        for (const t of p.topicTags) {
            let acc = tags.get(t.slug);
            if (!acc) {
                acc = { tag: { tagSlug: t.slug, tagName: t.name, totalCatalogProblems: 0, solvedCount: 0, coverageRate: 0,
                        recentProblemCount: 0, recentDayCount: 0, durationSampleCount: 0, avgDurationMinutes: null, longDurationCount: 0, longDurationRate: null,
                        knownDueCount: 0, dueTodayCount: 0, overdueCount: 0, overdueRate: null, unknownDateCount: 0, level: 'insufficient_data', reasons: [] },
                    days: new Set(), timedProblems: 0, recentSolved: 0, sum: 0 };
                tags.set(t.slug, acc);
            }
            const tag = acc.tag;
            tag.totalCatalogProblems++;
            if (solved.has(p.questionId))
                tag.solvedCount++;
            if (unknown.has(p.questionId) || state?.unknownDate)
                tag.unknownDateCount++;
            if (days?.size) {
                tag.recentProblemCount++;
                for (const day of days.keys())
                    acc.days.add(day);
            }
            if (recentSolved.has(p.questionId))
                acc.recentSolved++;
            if (durations.length)
                acc.timedProblems++;
            for (const d of durations) {
                acc.sum += d;
                tag.durationSampleCount++;
                if (d >= DURATION_THRESHOLDS[p.difficulty])
                    tag.longDurationCount++;
            }
            if (state?.solved && state.dueDate) {
                tag.knownDueCount++;
                if (state.dueDate < today)
                    tag.overdueCount++;
                if (state.dueDate === today)
                    tag.dueTodayCount++;
            }
        }
    }
    for (const acc of tags.values()) {
        const t = acc.tag;
        t.coverageRate = t.solvedCount / t.totalCatalogProblems;
        t.recentDayCount = acc.days.size;
        t.avgDurationMinutes = t.durationSampleCount ? Math.round(acc.sum / t.durationSampleCount * 10) / 10 : null;
        const timed = t.durationSampleCount >= 3 && acc.timedProblems >= 2;
        t.longDurationRate = timed ? t.longDurationCount / t.durationSampleCount : null;
        t.overdueRate = t.knownDueCount >= 3 ? t.overdueCount / t.knownDueCount : null;
        if (t.recentProblemCount < 3 || t.recentDayCount < 2)
            continue;
        if (t.longDurationRate !== null && t.longDurationRate >= 0.5)
            t.reasons.push('duration_threshold');
        if (t.overdueRate !== null && t.overdueRate >= 0.5)
            t.reasons.push('overdue_reviews');
        t.level = t.reasons.length ? 'needs_practice' :
            timed && acc.recentSolved >= 3 && t.longDurationRate === 0 && t.overdueRate === 0 ? 'recently_stable' : 'developing';
    }
    return { analysisVersion: ANALYSIS_VERSION, generatedAt: now, asOfDate: today, timezone: zone, windowDays: 30,
        revision: input.revision ?? { catalog: 0, practice: 0, planning: 0, timezone: input.userZone ?? null },
        tags: [...tags.values()].map(a => a.tag).sort((a, b) => a.tagSlug.localeCompare(b.tagSlug)) };
}
/** Rank only evidence-backed attention topics; deterministic ties make reports reproducible. */
export function focusTopics(report: TagMasteryReport): TagMastery[] {
    return report.tags.filter(t => t.level === 'needs_practice').sort((a, b) => (b.longDurationRate ?? -1) - (a.longDurationRate ?? -1) || (b.overdueRate ?? -1) - (a.overdueRate ?? -1) ||
        b.recentProblemCount - a.recentProblemCount || a.tagSlug.localeCompare(b.tagSlug));
}
