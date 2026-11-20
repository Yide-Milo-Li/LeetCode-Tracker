import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localModelService } from '../apps/mcp/src/profile.ts';
import { CatalogStore } from '../packages/database/src/store.ts';
import { createTrackerApplication } from '../packages/application/src/application.ts';
import type { DailyPlan } from '../packages/contracts/src/recommendations.ts';
import { validateMigrationBundle } from '../packages/database/src/migration-bundle.ts';

const monday = '2026-11-16';
const stage = (frontendId: string, requires: string[] = []) => ({
  frontendId,
  purpose: 'Practice ' + frontendId,
  requires,
});
function course() {
  return {
    operationId: randomUUID(),
    plan: {
      name: 'Windows',
      startDate: monday,
      weekdays: [1, 2, 3, 4, 5],
      dailyCount: 2,
      reviewCap: 1,
      stages: [
        { name: 'Fixed', items: [stage('643'), stage('1456')] },
        { name: 'Variable', items: [stage('3', ['1456']), stage('76', ['3'])] },
      ],
    },
  };
}
async function fixture(t: TestContext, extraIds: string[] = []) {
  let now = Date.parse(monday + 'T18:00:00Z');
  t.mock.method(Date, 'now', () => now);
  const dir = mkdtempSync(join(tmpdir(), 'study-course-'));
  const db = new DatabaseSync(':memory:');
  const store = new CatalogStore(db, { skipBackup: true, backupDir: dir });
  const app = createTrackerApplication({ store, modelService: localModelService });
  t.after(async () => {
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  await store.importJsonl(
    ['643', '1456', '3', '76', '99', '98', ...extraIds]
      .map((id) =>
        JSON.stringify({
          id,
          title: 'Problem ' + id,
          tags: [id.length === 2 && id !== '76' ? 'Tree' : 'Window'],
          difficulty: id === '99' ? 'Hard' : 'Easy',
        })
      )
      .join('\n')
  );
  await store.updateSettings({ timezone: 'America/Los_Angeles' });
  return {
    db,
    store,
    app,
    clock: (stamp: string) => {
      now = Date.parse(stamp);
    },
    log: (
      id: string,
      outcome: 'independent' | 'assisted' | 'unsolved' = 'independent',
      at = new Date(now).toISOString()
    ) =>
      app.practice.create({ questionFrontendId: id, completed: outcome !== 'unsolved', practicedAt: at, outcome }),
  };
}
const ids = (plan: DailyPlan | null) => plan?.items.map((i) => [i.problem.questionFrontendId, i.kind]);

test('read-only preview, stable Today, missed days, actual completion dates and bundle restore', async (t) => {
  const f = await fixture(t),
    req = course();
  const preview = await f.app.planning.saveStudyPlan({ ...req, dryRun: true });
  assert.equal((await f.app.planning.studyPlan()).plan, null);
  const saved = (await f.app.planning.saveStudyPlan(req)).plan;
  assert.deepEqual(saved.initialCalendar, preview.plan.initialCalendar);
  assert.deepEqual((await f.app.planning.saveStudyPlan(req)).plan.id, saved.id);
  assert.ok(saved.initialCalendar[1].items.some((i) => i.kind === 'review' && i.estimated));
  const first = await f.app.planning.readDay(monday);
  assert.equal(first.projected, true);
  assert.deepEqual(ids(first.plan), [
    ['643', 'new'],
    ['1456', 'new'],
  ]);
  assert.equal((await f.app.planning.plans()).items.length, 0);
  f.clock('2026-11-16T19:00:00Z');
  await f.log('643');
  const today = (await f.app.planning.ensure()).plan!;
  assert.deepEqual(
    today.items.map((i) => i.id),
    first.plan!.items.map((i) => i.id)
  );
  assert.equal(today.items[0].completed, true);
  f.clock('2026-11-19T05:00:00Z'); // Still Wednesday in Los Angeles.
  const resumed = (await f.app.planning.ensure()).plan!;
  assert.equal(resumed.date, '2026-11-18');
  assert.equal(resumed.rules.dailyCount, 2);
  assert.deepEqual(ids(resumed), [
    ['643', 'review'],
    ['1456', 'new'],
  ]);
  assert.ok(resumed.notices.some((n) => n.en.includes('1456') && n.en.includes(monday)));
  const shifted = (await f.app.planning.studyPlan()).plan!;
  assert.ok(shifted.estimatedFinish! > saved.estimatedFinish!);
  assert.deepEqual(shifted.initialCalendar, saved.initialCalendar);
  await f.log('1456', 'assisted');
  assert.equal((await f.app.planning.readDay(monday)).plan!.items[1].completed, false);
  assert.equal((await f.app.planning.studyPlan()).plan!.nodes[1].completedDate, resumed.date);
  assert.deepEqual(ids((await f.app.planning.ensure()).plan), ids(resumed));
  const bundle = (await f.app.bundle.exportBundle({ version: '5' })).content;
  await f.app.bundle.restore(bundle);
  assert.deepEqual((await f.app.planning.studyPlan()).plan!.initialCalendar, saved.initialCalendar);
  assert.equal((await f.app.planning.studyPlan()).plan!.completedCore, 2);
  await assert.rejects(f.app.bundle.exportBundle({ version: '1' }), /Bundle v5/);
  const portable = validateMigrationBundle(bundle);
  const corrupted = structuredClone(portable);
  const active = corrupted.tables.catalog_meta.find((row) => row.key === 'study-plan:active')!;
  active.value = randomUUID();
  await assert.rejects(f.app.bundle.restore(corrupted), /Invalid migration/);
  assert.equal((await f.app.planning.studyPlan()).plan!.id, saved.id);
});

test('create rejects invalid catalogs, dependencies, impossible core filters and conflicting retries', async (t) => {
  const f = await fixture(t),
    req = course();
  const create = (extra: object) => f.app.planning.saveStudyPlan({ ...req, plan: { ...req.plan, ...extra } });
  await assert.rejects(create({ tags: ['tree'] }), /643/);
  await assert.rejects(
    create({ stages: [{ name: 'bad', items: [stage('643', ['3']), stage('3', ['643'])] }] }),
    /earlier/
  );
  await assert.rejects(create({ stages: [{ name: 'bad', items: [stage('99999')] }] }), /99999/);
  await assert.rejects(create({ stages: [{ name: 'bad', items: [stage('3'), stage('3')] }] }), /Duplicate/);
  await assert.rejects(create({ reviewCap: 3 }), /review cap/);
  await assert.rejects(create({ maxDailyCount: 1 }), /maximum/);
  assert.equal((await f.app.planning.studyPlan()).plan, null);
  await create({});
  await assert.rejects(create({ name: 'changed' }), /different route/);
  const other = { ...req, operationId: randomUUID() };
  await f.app.planning.saveStudyPlan(other);
  assert.equal((await f.app.planning.studyPlan(req.operationId)).plan?.status, 'active');
  await f.app.planning.saveStudyPlan({ ...other, operationId: randomUUID(), replacePlanId: req.operationId });
  assert.equal((await f.app.planning.studyPlan(other.operationId)).plan?.status, 'active');
  assert.equal((await f.app.planning.studyPlan(req.operationId)).plan!.status, 'archived');
});

test('learner-wide due order, cross-topic backlog, explicit tag scope and reviews-only days', async (t) => {
  const f = await fixture(t),
    req = course();
  f.clock('2026-11-11T18:00:00Z');
  await f.log('99');
  f.clock('2026-11-12T18:00:00Z');
  await f.log('98');
  f.clock('2026-11-16T18:00:00Z');
  await f.app.planning.saveStudyPlan({
    ...req,
    plan: { ...req.plan, tags: ['window'], reviewsOnlyWeekdays: [1] },
  });
  const reviewDay = (await f.app.planning.ensure()).plan!;
  assert.deepEqual(ids(reviewDay), [
    ['99', 'review'],
    ['98', 'review'],
  ]);
  const replacement = {
    ...req,
    operationId: randomUUID(),
    replacePlanId: req.operationId,
    plan: { ...req.plan, tags: ['window'], filterReviewTags: true, reviewsOnlyWeekdays: [2] },
  };
  await f.app.planning.saveStudyPlan(replacement);
  assert.equal((await f.app.planning.ensure()).plan!.id, reviewDay.id);
  f.clock('2026-11-17T18:00:00Z');
  const empty = (await f.app.planning.ensure()).plan!;
  assert.equal(empty.items.length, 0);
  assert.ok(empty.notices.some((n) => n.en.includes('due reviews')));
  f.clock('2026-11-18T18:00:00Z');
  assert.deepEqual(ids((await f.app.planning.ensure()).plan), [
    ['643', 'new'],
    ['1456', 'new'],
  ]);
});

test('an overdue review beyond the cap can be added without consuming the next learning day', async (t) => {
  const f = await fixture(t);
  await f.log('99', 'independent', '2026-11-09');
  await f.log('98', 'independent', '2026-11-10');
  await f.app.planning.saveStudyPlan(course());
  const day = (await f.app.planning.ensure()).plan!;
  assert.deepEqual(ids(day), [
    ['99', 'review'],
    ['643', 'new'],
  ]);
  assert.equal(day.reviewBacklog, 1);
  const plus = await f.app.planning.append(
    { kind: 'review', operationId: randomUUID(), expectedVersion: day.version },
    { id: day.id }
  );
  assert.equal(plus.rules.reviewCount, 2);
  assert.equal(plus.reviewBacklog, 0);
  f.clock('2026-11-17T18:00:00Z');
  assert.equal((await f.app.planning.ensure()).plan!.rules.reviewCount, 1);
});

test('fixed deadline reports coverage; prior successes count and failed prerequisites stay locked', async (t) => {
  const f = await fixture(t),
    req = course();
  await f.log('643');
  await f.log('1456', 'unsolved');
  const result = await f.app.planning.saveStudyPlan({ ...req, plan: { ...req.plan, deadline: monday } });
  assert.equal(result.plan.completedCore, 1);
  assert.equal(result.plan.forecastCore, 2);
  assert.equal(result.plan.estimatedFinish, null);
  assert.ok(result.plan.nodes[1].attempted);
  assert.deepEqual(ids((await f.app.planning.ensure()).plan), [['1456', 'new']]);
  f.clock('2026-11-17T18:00:00Z');
  assert.equal((await f.app.planning.studyPlan()).plan!.status, 'expired');
  assert.equal((await f.app.planning.ensure()).status, 'rest');
});

test('ordinary appends and replacements stay within unlocked course problems', async (t) => {
  const f = await fixture(t),
    request = course();
  request.plan.dailyCount = 1;
  request.plan.reviewCap = 0;
  await f.app.planning.saveStudyPlan(request);
  const first = (await f.app.planning.ensure()).plan!;
  const swapped = await f.app.planning.replace(
    { mode: 'one', itemId: first.items[0].id, expectedVersion: 1, operationId: randomUUID() },
    { id: first.id }
  );
  assert.deepEqual(ids(swapped), [['1456', 'new']]);
  assert.ok(swapped.items[0].studyNodeId);
  await assert.rejects(
    f.app.planning.append({ expectedVersion: swapped.version, operationId: randomUUID() }, { id: first.id }),
    /No eligible/
  );
});

test('finished prerequisites unlock later stages and optional items fit a generous deadline', async (t) => {
  const f = await fixture(t),
    req = course();
  const result = await f.app.planning.saveStudyPlan({
    ...req,
    plan: {
      ...req.plan,
      deadline: '2026-12-10',
      stages: [
        { name: 'Intro', items: [stage('643'), { ...stage('1456'), optional: true }] },
        { name: 'Apply', items: [stage('3', ['643'])] },
      ],
    },
  });
  assert.ok(result.plan.initialCalendar.some(day => day.items.some(i => i.kind === 'new' && i.frontendId === '1456')));
  await f.log('3', 'independent');
  const advanced = (await f.app.planning.studyPlan()).plan!;
  assert.equal(advanced.nodes.find((n) => n.frontendId === '3')?.completed, true);
  assert.ok(advanced.calendar.every((d) => !d.items.some((i) => i.frontendId === '3' && i.kind === 'new')));
  await f.log('643', 'assisted');
  assert.equal((await f.app.planning.studyPlan()).plan!.status, 'completed');
});

const goalIds = Array.from({ length: 30 }, (_, index) => String(1001 + index));
function flatGoal(ids: string[], options: { dailyCount: number; reviewCap: number; deadline?: string; maxDailyCount?: number }) {
  const request = course();
  return {
    ...request,
    plan: { ...request.plan, ...options, stages: [{ name: 'Core', items: ids.map((id) => stage(id)) }] },
  };
}

test('a missed day spreads deadline catch-up across new-problem days with room for due reviews', async (t) => {
  const f = await fixture(t, goalIds);
  await f.log('98', 'independent', '2026-11-10');
  await f.log('99', 'independent', '2026-11-11');
  const { plan: created } = await f.app.planning.saveStudyPlan(flatGoal(goalIds.slice(0, 10), {
    dailyCount: 3, reviewCap: 1, deadline: '2026-11-20',
  }));
  assert.deepEqual(created.initialCalendar.map((day) => day.dailyCount), [3, 3, 3, 3, 3]);
  f.clock('2026-11-17T18:00:00Z');
  const shifted = (await f.app.planning.studyPlan()).plan!;
  assert.equal(shifted.baseDailyCount, 3);
  assert.equal(shifted.deadlineShortfall, 0);
  assert.deepEqual(shifted.calendar.map((day) => day.dailyCount), [3, 4, 3, 4]);
  assert.ok(shifted.calendar.every((day) => day.items.filter((item) => item.kind === 'review').length === 1));
  assert.deepEqual(shifted.initialCalendar, created.initialCalendar);

  const tuesday = (await f.app.planning.ensure()).plan!;
  for (const item of tuesday.items) await f.log(item.problem.questionFrontendId);
  f.clock('2026-11-18T18:00:00Z');
  const projected = (await f.app.planning.readDay('2026-11-18')).plan!;
  assert.equal(projected.rules.dailyCount, 4);
  assert.equal(projected.rules.reviewCount, 1);
  assert.match(projected.notices[0].en, /catch up before the deadline/);
  const wednesday = (await f.app.planning.ensure()).plan!;
  assert.deepEqual(ids(wednesday), ids(projected));
  for (const item of wednesday.items) await f.log(item.problem.questionFrontendId);
  // Two more goal problems solved ahead of schedule free the remaining catch-up slot.
  await f.log(goalIds[5]);
  await f.log(goalIds[6]);
  f.clock('2026-11-19T18:00:00Z');
  const caughtUp = (await f.app.planning.studyPlan()).plan!;
  assert.equal(caughtUp.baseDailyCount, 3);
  assert.deepEqual(caughtUp.calendar.map(day => day.dailyCount), [3, 2]);
});

test('the automatic maximum and review-only days constrain the deadline forecast', async (t) => {
  const f = await fixture(t, goalIds);
  await f.log('98', 'independent', '2026-11-10');
  await f.log('99', 'independent', '2026-11-11');
  const request = flatGoal(goalIds.slice(0, 6), {
    dailyCount: 2, maxDailyCount: 3, reviewCap: 1, deadline: '2026-11-18',
  });
  const { plan } = await f.app.planning.saveStudyPlan({
    ...request, plan: { ...request.plan, reviewsOnlyWeekdays: [2] },
  });
  assert.equal(plan.deadlineShortfall, 2);
  assert.deepEqual(plan.calendar.map((day) => day.dailyCount), [3, 1, 3]);
  assert.ok(plan.calendar[1].items.every((item) => item.kind === 'review'));
  assert.ok(plan.notices.some((notice) => notice.en.includes('2 core problems short')));

  const { content } = await f.app.bundle.exportBundle({ version: '5' });
  await f.app.bundle.restore(content);
  assert.equal((await f.app.planning.studyPlan()).plan?.deadlineShortfall, 2);
});

test('repeated completed additions raise the pace and repeated reductions lower it', async (t) => {
  const f = await fixture(t, goalIds);
  const { plan: created } = await f.app.planning.saveStudyPlan(flatGoal(goalIds, { dailyCount: 2, reviewCap: 0 }));
  for (const date of ['16', '17', '18', '19', '20']) {
    f.clock(`2026-11-${date}T18:00:00Z`);
    const original = (await f.app.planning.ensure()).plan!;
    assert.equal(original.rules.dailyCount, date === '20' ? 3 : 2);
    const day = date === '20' ? original : await f.app.planning.append(
      { kind: 'new', operationId: randomUUID(), expectedVersion: original.version }, { id: original.id }
    );
    // The first addition was never solved. A normal day still uses the old pace.
    for (const item of date === '16' ? original.items : day.items) await f.log(item.problem.questionFrontendId);
    assert.equal((await f.app.planning.studyPlan()).plan?.baseDailyCount, date === '20' ? 3 : 2);
  }

  const { content } = await f.app.bundle.exportBundle({ version: '5' });
  await f.app.bundle.restore(content);
  assert.equal((await f.app.planning.studyPlan()).plan?.baseDailyCount, 3);

  for (const date of ['23', '24', '25']) {
    f.clock(`2026-11-${date}T18:00:00Z`);
    const original = (await f.app.planning.ensure()).plan!;
    assert.equal(original.rules.dailyCount, 3);
    const day = await f.app.planning.remove(
      { itemId: original.items.at(-1)!.id, operationId: randomUUID(), expectedVersion: original.version }, { id: original.id }
    );
    for (const item of day.items) await f.log(item.problem.questionFrontendId);
    assert.equal((await f.app.planning.studyPlan()).plan?.baseDailyCount, 3);
  }

  f.clock('2026-11-26T18:00:00Z');
  const backToTwo = (await f.app.planning.ensure()).plan!;
  assert.equal(backToTwo.rules.dailyCount, 2);
  assert.ok(backToTwo.notices.some((notice) => notice.en.includes('pace fell from 3 to 2')));
  assert.deepEqual((await f.app.planning.studyPlan()).plan?.initialCalendar, created.initialCalendar);
});

test('deadline and remaining learning days determine pace independently of a supplied daily count', async t => {
  const f = await fixture(t, goalIds);
  await f.log(goalIds[0], 'independent', '2026-11-12');
  const req = flatGoal(goalIds.slice(0, 21), { dailyCount: 1, reviewCap: 0, deadline: '2026-11-20' });
  const preview = async (fields: object) => (await f.app.planning.saveStudyPlan({
    ...req, dryRun: true, plan: { ...req.plan, ...fields },
  })).plan;
  const counts = (plan: Awaited<ReturnType<typeof preview>>) => plan.calendar.map(d => d.dailyCount);
  assert.deepEqual(counts(await preview({})), [4, 4, 4, 4, 4]);
  assert.deepEqual(counts(await preview({ dailyCount: 30 })), [4, 4, 4, 4, 4]);
  assert.deepEqual(counts(await preview({ weekdays: [1, 5] })), [10, 10]);
  const limited = await preview({ maxDailyCount: 2 });
  assert.deepEqual(counts(limited), [2, 2, 2, 2, 2]);
  assert.equal(limited.deadlineShortfall, 10);
  const highReviewCap = await preview({ maxDailyCount: 2, reviewCap: 10 });
  assert.ok(highReviewCap.calendar.every(day => day.items.length <= 2));
  const restored = await f.app.planning.saveStudyPlan(req);
  assert.deepEqual(counts(restored.plan), counts(await preview({})));
});

test('a sparse deadline preserves the next planned session when days have no new work', async t => {
  const f = await fixture(t);
  const request = flatGoal(['643', '1456'], { dailyCount: 20, reviewCap: 0, deadline: '2026-11-20' });
  const { plan } = await f.app.planning.saveStudyPlan(request);
  assert.deepEqual(plan.nodes.map(n => n.scheduledDate), [monday, '2026-11-18']);
  const first = (await f.app.planning.ensure()).plan!;
  assert.equal(first.items.length, 1);
  await f.log('643');
  f.clock('2026-11-17T18:00:00Z');
  assert.equal((await f.app.planning.ensure()).status, 'rest');
  assert.equal((await f.app.planning.studyPlan()).plan?.nodes[1].scheduledDate, '2026-11-18');
  f.clock('2026-11-18T18:00:00Z');
  assert.deepEqual(ids((await f.app.planning.ensure()).plan), [['1456', 'new']]);
});

test('one new slot rotates eligible difficulties and finishes the authored list', async t => {
  const f = await fixture(t);
  const request = flatGoal(['643', '1456', '3', '99'], { dailyCount: 1, reviewCap: 0 });
  const { plan } = await f.app.planning.saveStudyPlan({
    ...request, plan: { ...request.plan, difficulty: { Easy: 50, Medium: 0, Hard: 50 } },
  });
  assert.deepEqual(plan.calendar.map(day => day.items[0].frontendId), ['643', '99', '1456', '3']);
  assert.deepEqual(ids((await f.app.planning.ensure()).plan), [['643', 'new']]);
  await f.log('643');
  f.clock('2026-11-17T18:00:00Z');
  assert.deepEqual(ids((await f.app.planning.ensure()).plan), [['99', 'new']]);
});

test('a fixed flexible pace survives repeated completed additions', async t => {
  const f = await fixture(t, goalIds);
  const request = flatGoal(goalIds, { dailyCount: 2, reviewCap: 0 });
  await f.app.planning.saveStudyPlan({ ...request, plan: { ...request.plan, adaptivePace: false } });
  for (const day of ['16', '17', '18']) {
    f.clock(`2026-11-${day}T18:00:00Z`);
    const original = (await f.app.planning.ensure()).plan!;
    const edited = await f.app.planning.append(
      { kind: 'new', expectedVersion: original.version, operationId: randomUUID() }, { id: original.id });
    for (const item of edited.items) await f.log(item.problem.questionFrontendId);
  }
  f.clock('2026-11-19T18:00:00Z');
  assert.equal((await f.app.planning.ensure()).plan?.rules.dailyCount, 2);
});

test('custom review gaps apply to actual due dates, course forecasts and restored settings', async t => {
  const f = await fixture(t, goalIds);
  const req = flatGoal(goalIds, { dailyCount: 2, reviewCap: 1 });
  for (const gaps of [[], [2, 2], [3, 1], [366], [1.5]]) {
    await assert.rejects(f.app.settings.update({ reviewIntervals: gaps }));
  }
  await f.app.settings.update({ reviewIntervals: [2, 5, 12] });
  await f.log('99', 'independent', '2026-11-15');
  for (const reviewPolicy of ['fixed', 'duration-v1', 'outcome-v2'] as const) {
    await f.store.updateSettings({ reviewPolicy });
    const review = f.store.planning.reviewStates('America/Los_Angeles', Date.now()).find(r => r.solved)!;
    assert.equal(review.dueDate, '2026-11-17');
    assert.equal(review.intervalDays, 2);
  }
  const { plan } = await f.app.planning.saveStudyPlan(req);
  assert.deepEqual(plan.calendar[1].items.filter(i => i.kind === 'review').map(i => i.frontendId), ['99']);
  const nextReview = plan.calendar[2].items.find(i => i.kind === 'review')!;
  assert.equal(nextReview.dueDate, '2026-11-18');
  const { content } = await f.app.bundle.exportBundle({ version: '5' });
  await f.app.bundle.restore(content);
  assert.deepEqual(f.store.getSettings().reviewIntervals, [2, 5, 12]);
  f.clock('2026-11-17T18:00:00Z');
  await f.log('99');
  assert.equal(f.store.planning.reviewStates('America/Los_Angeles', Date.now()).find(r => r.solved)?.dueDate, '2026-11-22');
});

test('editing a deadline redistributes remaining work and keeps the original calendar and saved day', async t => {
  const f = await fixture(t, goalIds);
  const { plan: original } = await f.app.planning.saveStudyPlan(flatGoal(goalIds.slice(0, 10), {
    dailyCount: 2, deadline: '2026-11-17', reviewCap: 0,
  }));
  const saved = (await f.app.planning.ensure()).plan!;
  assert.equal(saved.items.length, 5);
  await f.log(saved.items[0].problem.questionFrontendId);
  const edit = { id: original.id, expectedVersion: 1, operationId: randomUUID(), changes: { deadline: '2026-11-20' } };
  const preview = await f.app.planning.updateStudyPlan({ ...edit, dryRun: true });
  assert.equal((await f.app.planning.studyPlan()).plan?.version, 1);
  assert.deepEqual(preview.plan.calendar.map(d => d.dailyCount), [5, 2, 1, 1, 1]);
  const { plan } = await f.app.planning.updateStudyPlan(edit);
  assert.equal(plan.id, original.id);
  assert.equal(plan.version, 2);
  assert.equal(plan.completedCore, 1);
  assert.deepEqual(plan.initialCalendar, original.initialCalendar);
  assert.deepEqual(plan.calendar, preview.plan.calendar);
  const stillToday = (await f.app.planning.ensure()).plan!;
  assert.equal(stillToday.version, saved.version);
  assert.deepEqual(ids(stillToday), ids(saved));
  assert.equal(stillToday.items[0].completed, true);
  assert.deepEqual((await f.app.planning.studyPlan()).plan?.calendar, plan.calendar);

  const { content } = await f.app.bundle.exportBundle({ version: '5' });
  await f.app.bundle.restore(content);
  assert.equal((await f.app.planning.updateStudyPlan(edit)).plan.version, 2);
  await assert.rejects(f.app.planning.updateStudyPlan({ ...edit, operationId: randomUUID() }), /goal changed/i);
  await assert.rejects(f.app.planning.updateStudyPlan({ ...edit, changes: { reviewCap: 1 } }), /another edit/);
  const result = await f.app.planning.updateStudyPlan({ ...edit, expectedVersion: 2, operationId: randomUUID(),
    changes: { deadline: null, dailyCount: 1, adaptivePace: false, maxDailyCount: null } });
  assert.equal(result.plan.deadline, undefined);
  assert.equal(result.plan.baseDailyCount, 1);
  assert.equal(result.plan.initialCalendar.length, original.initialCalendar.length);
});

test('changing weekdays, review cap and difficulty preserves MCP stages, prerequisites and hidden settings', async t => {
  const f = await fixture(t);
  const req = course();
  const { plan } = await f.app.planning.saveStudyPlan({ ...req, plan: {
    ...req.plan, tags: ['window'], filterReviewTags: true, reviewsOnlyWeekdays: [5],
  } });
  const edit = { id: plan.id, expectedVersion: 1, operationId: randomUUID(),
    changes: { weekdays: [1, 3, 5], reviewCap: 0, dailyCount: 1, difficulty: { Easy: 100, Medium: 0, Hard: 0 } } };
  const edited = (await f.app.planning.updateStudyPlan(edit)).plan;
  assert.deepEqual(edited.settings.reviewsOnlyWeekdays, [5]);
  assert.deepEqual(edited.settings.tags, ['window']);
  assert.equal(edited.settings.filterReviewTags, true);
  assert.deepEqual(edited.stages, plan.stages);
  assert.deepEqual(edited.nodes.map(n => [n.questionId, n.purpose, n.requires]), plan.nodes.map(n => [n.questionId, n.purpose, n.requires]));
  assert.deepEqual(ids((await f.app.planning.ensure()).plan), [['643', 'new']]);
  assert.ok(edited.calendar.every(d => [1,3,5].includes(new Date(d.date + 'T12:00Z').getUTCDay())));
  await assert.rejects(f.app.planning.updateStudyPlan({ ...edit, expectedVersion: 2, operationId: randomUUID(),
    changes: { difficulty: { Easy: 0, Medium: 0, Hard: 100 } } }), /cannot be scheduled/);
  assert.equal((await f.app.planning.studyPlan()).plan?.version, 2);
  await f.app.planning.saveStudyPlan({ ...course(), replacePlanId: plan.id });
  await assert.rejects(f.app.planning.updateStudyPlan({ ...edit, expectedVersion: 2, operationId: randomUUID() }), /goal changed/i);
});

test('an expired goal can be resumed and unsaved today uses evidence up to the edit', async t => {
  const f = await fixture(t);
  const { plan } = await f.app.planning.saveStudyPlan({ ...course(), plan: { ...course().plan, deadline: monday } });
  f.clock('2026-11-17T18:00:00Z');
  await f.log('643');
  assert.equal((await f.app.planning.studyPlan()).plan?.status, 'expired');
  const update = { id: plan.id, expectedVersion: 1, operationId: randomUUID(), changes: {
    deadline: '2026-11-20', reviewCap: 0,
  } };
  const { plan: resumed } = await f.app.planning.updateStudyPlan(update);
  assert.equal(resumed.status, 'active');
  const today = (await f.app.planning.ensure()).plan!;
  assert.deepEqual(ids(today), [['1456', 'new']]);
  assert.equal(today.studyPlan?.id, plan.id);
});

test('adding, removing and reordering together replans open days and preserves practice and frozen assignments', async t => {
  const f = await fixture(t);
  const { plan: original } = await f.app.planning.saveStudyPlan(flatGoal(['643', '1456', '3', '76'], {
    dailyCount: 2, deadline: '2026-11-17', reviewCap: 0,
  }));
  const today = (await f.app.planning.ensure()).plan!;
  await f.log('643');
  const update = { id: original.id, expectedVersion: 1, operationId: randomUUID(),
    changes: { deadline: '2026-11-18', stageProblemIds: [['76', '98', '3']] } };
  const { plan: preview } = await f.app.planning.updateStudyPlan({ ...update, dryRun: true });
  const read = () => f.app.planning.studyPlan().then(result => result.plan!);
  assert.equal((await read()).totalCore, 4);
  assert.equal((await read()).version, 1);
  const { plan } = await f.app.planning.updateStudyPlan(update);
  assert.equal(plan.id, original.id);
  assert.equal(plan.version, 2);
  assert.equal(plan.completedCore, 0);
  assert.equal(plan.totalCore, 3);
  assert.deepEqual(plan.nodes.map(n => n.frontendId), ['76', '98', '3']);
  assert.deepEqual(plan.calendar, preview.calendar);
  assert.deepEqual(plan.calendar.slice(1).map(d => d.items.map(i => i.frontendId)), [['76', '98'], ['3']]);
  assert.deepEqual(plan.initialCalendar, original.initialCalendar);
  const frozen = (await f.app.planning.ensure()).plan!;
  assert.equal(frozen.version, today.version);
  assert.deepEqual(ids(frozen), ids(today));
  assert.equal(frozen.items[0].completed, true);
  const { content } = await f.app.bundle.exportBundle({ version: '5' });
  await f.app.bundle.restore(content);
  assert.deepEqual((await read()).nodes, plan.nodes);
  assert.equal((await f.app.planning.updateStudyPlan(update)).plan.version, 2);
  const { plan: readded } = await f.app.planning.updateStudyPlan({ ...update, expectedVersion: 2, operationId: randomUUID(),
    changes: { stageProblemIds: [['76', '643', '98', '3']] } });
  assert.equal(readded.completedCore, 1);
  assert.ok(readded.nodes.find(n => n.frontendId === '643')?.completed);
  f.clock('2026-11-17T18:00:00Z');
  assert.deepEqual(ids((await f.app.planning.ensure()).plan), [['76', 'new'], ['98', 'new']]);
});

test('stage list edits validate prerequisites, catalog IDs and quotas atomically while retaining authored metadata', async t => {
  const f = await fixture(t);
  const req = course();
  const { plan } = await f.app.planning.saveStudyPlan({ ...req, plan: {
    ...req.plan, stages: [
      { name: 'Part A', items: [stage('643'), { ...stage('1456'), optional: true }] },
      req.plan.stages[1],
    ],
  } });
  const apply = (lists: string[][], changes = {}) => f.app.planning.updateStudyPlan({ id: plan.id, expectedVersion: 1,
    operationId: randomUUID(), changes: { dailyCount: 3, stageProblemIds: lists, ...changes } });
  await assert.rejects(apply([['643'], ['3', '76']]), /#3 requires #1456/);
  await assert.rejects(apply([['643', '3'], ['1456', '76']]), /#3 requires #1456/);
  await assert.rejects(apply([['643'], ['643']]), /Duplicate/);
  await assert.rejects(apply([[], ['99999']]), /Unknown catalog problem/);
  await assert.rejects(apply([[], ['1456']]), /core problem/);
  await assert.rejects(apply([[], []]), /core problem/);
  await assert.rejects(apply([['643']]), /each existing stage/);
  await assert.rejects(apply([[], ['643', '99']], { difficulty: { Easy: 100, Medium: 0, Hard: 0 } }), /#99/);
  assert.equal((await f.app.planning.studyPlan()).plan?.version, 1);
  const { plan: moved } = await apply([[], ['1456', '3', '76', '643']]);
  assert.deepEqual(moved.nodes.map(n => n.stage), [1, 1, 1, 1]);
  assert.ok(moved.nodes[0].optional);
  assert.deepEqual(moved.nodes[1].requires, [moved.nodes[0].questionId]);
  assert.equal(moved.nodes[1].purpose, 'Practice 3');
  assert.equal(moved.settings.dailyCount, 3);
  assert.equal(moved.forecastCore, moved.totalCore);
});

test('a completed current goal can grow, and a stale list edit cannot overwrite it', async t => {
  const f = await fixture(t);
  await f.log('643');
  const { plan } = await f.app.planning.saveStudyPlan(flatGoal(['643'], { dailyCount: 1, reviewCap: 0 }));
  assert.equal(plan.status, 'completed');
  const request = { id: plan.id, expectedVersion: 1, operationId: randomUUID(), changes: { stageProblemIds: [['98', '643']] } };
  const { plan: resumed } = await f.app.planning.updateStudyPlan(request);
  assert.equal(resumed.status, 'active');
  assert.equal(resumed.completedCore, 1);
  assert.deepEqual(ids((await f.app.planning.ensure()).plan), [['98', 'new']]);
  await assert.rejects(f.app.planning.updateStudyPlan({ ...request, operationId: randomUUID(), changes: { stageProblemIds: [['99']] } }), /goal changed/i);
});

test('a future strategy assignment leaves an independent goal free to schedule the same problem', async t => {
  const f = await fixture(t);
  await f.app.planning.createStrategy({ name: 'Tree practice', weekdays: [2],
    rules: { dailyCount: 1, difficulty: { Easy: 0, Medium: 0, Hard: 100 }, tags: ['tree'], premium: false,
      reviewEnabled: false, reviewMode: 'none', reviewPercent: null, preference: '' } });
  const fixed = (await f.app.planning.ensure({ date: '2026-11-17' })).plan!;
  assert.deepEqual(ids(fixed), [['99', 'new']]);
  const { plan } = await f.app.planning.saveStudyPlan(flatGoal(['643', '1456'], { dailyCount: 1, reviewCap: 0 }));
  const { plan: changed } = await f.app.planning.updateStudyPlan({ id: plan.id, expectedVersion: 1, operationId: randomUUID(),
    changes: { stageProblemIds: [['99', '1456', '643']] } });
  assert.deepEqual(changed.calendar.map(day => day.items.map(item => item.frontendId)), [['99'], ['1456'], ['643']]);
  assert.deepEqual(ids((await f.app.planning.ensure()).plan), [['99', 'new']]);
  assert.equal((await f.app.planning.readDay('2026-11-17')).plan?.id, fixed.id);
});

test('goals run alongside one optional weekday strategy and share a single completion record', async t => {
  const f = await fixture(t);
  const first = await f.app.planning.saveStudyPlan(flatGoal(['99', '643'], { dailyCount: 1, reviewCap: 0 }));
  const second = await f.app.planning.saveStudyPlan(flatGoal(['99', '98'], { dailyCount: 1, reviewCap: 0 }));
  const goalsOnly = (await f.app.planning.ensure()).plans!;
  assert.equal(goalsOnly.length, 2);
  assert.deepEqual(new Set(goalsOnly.map(p => p.studyPlan?.id)), new Set([first.plan.id, second.plan.id]));
  const rules = { dailyCount: 1, difficulty: { Easy: 0, Medium: 0, Hard: 100 }, tags: ['tree'],
    premium: false, reviewEnabled: false, reviewMode: 'none', reviewPercent: null, preference: '' };
  await f.app.planning.createStrategy({ name: 'Monday trees', weekdays: [1], rules });
  await assert.rejects(f.app.planning.createStrategy({ name: 'Second Monday', weekdays: [1], rules }));
  assert.equal((await f.app.planning.readDay(monday)).pendingStrategy?.name, 'Monday trees');
  const results = await Promise.all([f.app.planning.ensure(), f.app.planning.ensure()]);
  assert.deepEqual(results[0].plans, results[1].plans);
  assert.equal(results[0].plans!.length, 3);
  for (const source of results[0].plans!) assert.deepEqual(ids(source), [['99', 'new']]);
  f.clock(monday + 'T19:00:00Z');
  await f.log('99');
  const day = await f.app.planning.readDay(monday);
  assert.equal(new Set(day.plans.flatMap(p => p.items.flatMap(i => i.evidenceIds))).size, 1);
  assert.ok(day.plans.every(p => p.items[0].completed));
  const goal = day.plans.find(p => p.studyPlan?.id === first.plan.id)!;
  const remove = { itemId: goal.items[0].id, expectedVersion: goal.version, operationId: randomUUID() };
  await f.app.planning.remove(remove, { id: goal.id });
  await f.app.planning.remove(remove, { id: goal.id });
  const kept = (await f.app.planning.ensure()).plans!;
  assert.equal(kept.find(p => p.id === goal.id)?.items.length, 0);
  assert.ok(kept.filter(p => p.id !== goal.id).every(p => p.items[0].completed && p.version === 1));
  assert.equal(f.store.queryPracticeRecords().total, 1);
  await assert.rejects(f.app.planning.previewOverride({ date: monday, rules: { dailyCount: 2 } }), /choose a source/i);
  const preview = await f.app.planning.previewOverride({ planId: goal.id, date: monday, rules: { dailyCount: 1 } });
  assert.equal(preview.planId, goal.id);
  const bundle = f.store.exportMigrationBundle(5);
  validateMigrationBundle(bundle);
  await f.store.importSnapshotBundle(bundle);
  assert.deepEqual((await f.app.planning.ensure()).plans, kept);
});

test('v12 upgrade retains the saved goal, daily plan ID, immutable versions and evidence', async t => {
  const f = await fixture(t);
  const goal = (await f.app.planning.saveStudyPlan(course())).plan;
  const day = (await f.app.planning.ensure()).plan!;
  await f.app.planning.remove({ itemId: day.items[1].id, expectedVersion: day.version, operationId: randomUUID() }, { id: day.id });
  f.clock(monday + 'T19:00:00Z');
  await f.log('643');
  const before = f.store.planning.planById(day.id);
  const versions = f.store.planning.versions(day.id);
  // Rebuild the authentic v12 single-date tables around the existing rows.
  f.db.exec(`
    BEGIN;
    ALTER TABLE daily_plan_versions RENAME TO saved_versions;
    ALTER TABLE daily_plans RENAME TO saved_days;
    CREATE TABLE daily_plans (id TEXT PRIMARY KEY, plan_date TEXT NOT NULL UNIQUE, version INTEGER NOT NULL, payload_json TEXT NOT NULL);
    CREATE TABLE daily_plan_versions (plan_id TEXT NOT NULL REFERENCES daily_plans(id), version INTEGER NOT NULL, payload_json TEXT NOT NULL, PRIMARY KEY(plan_id, version));
    INSERT INTO daily_plans SELECT id, plan_date, version, payload_json FROM saved_days;
    INSERT INTO daily_plan_versions SELECT * FROM saved_versions;
    DROP TABLE saved_versions;
    DROP TABLE saved_days;
    UPDATE schema_version SET version=12;
    COMMIT;
  `);
  const upgraded = new CatalogStore(f.db, { skipBackup: true });
  assert.deepEqual(upgraded.planning.planById(day.id), before);
  assert.deepEqual(upgraded.planning.versions(day.id), versions);
  await f.app.planning.saveStudyPlan(flatGoal(['99'], { dailyCount: 1, reviewCap: 0 }));
  const after = (await f.app.planning.ensure()).plans!;
  assert.equal(after.length, 2);
  assert.equal(after.find(p => p.studyPlan?.id === goal.id)?.id, day.id);
  assert.equal(after.find(p => p.id === day.id)?.items[0].completed, true);
});
