import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';

export const scenarioTools = {
  menu: ['get_today'],
  today: ['get_today', 'create_today', 'edit_today', 'list_practices'],
  log: ['create_practices', 'list_practices', 'get_problems'],
  note: ['get_note_context', 'get_notes', 'patch_note', 'save_notes'],
  review: ['get_progress', 'list_notes', 'get_problems', 'get_notes', 'list_practices'],
  setup: ['catalog_coverage', 'import_problems', 'set_timezone', 'get_strategies', 'save_strategy', 'status', 'get_problems'],
};

function used(turn, tool) {
  const calls = turn.calls.filter(call => call.name === 'tracker_' + tool);
  assert.ok(calls.length, `Missing ${tool}; observed ${turn.calls.map(call => call.name).join(', ')}`);
  return calls;
}

export async function verifyScenario(scenario, call, ask, followUp) {
  const first = randomInt(800000, 900000);
  const problems = ['Cedar', 'Maple', 'Pine', 'Elm'].map((name, i) => ({
    id: String(first + i), title: 'Synthetic ' + name, difficulty: 'Easy', tags: ['Array'],
  }));
  const [a, b, c] = problems.map(problem => problem.id);
  const plan = () => call('get_today');
  const practices = () => call('list_practices');
  const note = async () => (await call('get_notes', { frontendIds: [a], maxChars: 20000 })).notes[0];
  const saveAttempts = records => call('create_practices', { operationId: randomUUID(), records });
  const strategy = {
    name: 'Fixture', weekdays: [0, 1, 2, 3, 4, 5, 6], dailyCount: 2,
    difficultyCounts: { Easy: 2, Medium: 0, Hard: 0 }, review: { mode: 'none' },
  };
  if (scenario === 'setup') {
    const before = await call('catalog_coverage');
    assert.equal(before.profileExists, false);
    const turn = await ask('setup Import only LeetCode #1 Two Sum and #70 Climbing Stairs. Use Asia/Tokyo. I will choose the schedule after import.');
    used(turn, 'catalog_coverage');
    used(turn, 'import_problems');
    assert.equal((await call('catalog_coverage')).totalProblems, 2);
    const { problems: imported } = await call('get_problems', { frontendIds: ['1', '70'] });
    assert.deepEqual(imported.map(p => p.title).sort(), ['Climbing Stairs', 'Two Sum']);
    const settings = await call('get_strategies');
    assert.equal(settings.timezone, 'Asia/Tokyo');
    assert.deepEqual(settings.strategies, []);
    const confirmed = await followUp('Confirmed: create the strategy named Maple Mondays for Monday only. One new Easy problem, zero reviews each Monday.');
    used(confirmed, 'save_strategy');
    const { strategies } = await call('get_strategies');
    assert.equal(strategies.length, 1);
    const [saved] = strategies;
    assert.equal(saved.name, 'Maple Mondays');
    assert.deepEqual(saved.weekdays, [1]);
    assert.equal(saved.rules.dailyCount, 1);
    assert.equal(saved.rules.difficulty.Easy, 100);
    assert.equal(saved.rules.reviewEnabled, false);
    return;
  }

  await call('import_problems', { problems });
  if (scenario === 'menu' || scenario === 'today') {
    await call('save_strategy', strategy);
    if (scenario === 'menu') {
      const { plan: seeded } = await call('create_today');
      const turn = await ask('');
      used(turn, 'get_today');
      for (const item of seeded.items) assert.ok(turn.answer.includes(item.frontendId));
      for (const cmd of ['today', 'log', 'note', 'review', 'setup']) assert.match(turn.answer, new RegExp(`\\b${cmd}\\b`, 'i'));
      return;
    }
    assert.equal((await plan()).hasPlan, false);
    const created = await ask('today');
    used(created, 'get_today');
    used(created, 'create_today');
    const initial = await plan();
    assert.equal(initial.items.length, 2);
    for (const item of initial.items) assert.ok(created.answer.includes(item.frontendId));
    const appended = await ask('today add one more problem');
    used(appended, 'edit_today');
    const expanded = await plan();
    assert.equal(expanded.items.length, 3);
    const id = initial.items[0].frontendId;
    const { records: [attempt] } = await saveAttempts([{ questionFrontendId: id, completed: true }]);
    const beforeRemoval = await plan();
    const preview = await ask(`today remove #${id} from today's plan`);
    assert.ok(used(preview, 'edit_today').every(c => c.args.dryRun === true));
    assert.ok(preview.answer.includes(id));
    assert.match(preview.answer, /practice|练习/i);
    assert.deepEqual(await plan(), beforeRemoval);
    assert.equal((await practices()).total, 1);
    const confirmed = await followUp(`Yes, remove #${id} and revoke its one linked practice record.`);
    assert.ok(used(confirmed, 'edit_today').some(c => !c.args.dryRun && c.args.steps.some(step => step.confirmRevokePracticeIds?.includes(attempt.id))));
    const final = await plan();
    assert.deepEqual(final.items.map(i => i.frontendId), expanded.items.filter(i => i.frontendId !== id).map(i => i.frontendId));
    assert.equal((await call('list_practices', { ids: [attempt.id] })).records[0].status, 'revoked');
  } else if (scenario === 'log') {
    const turn = await ask(`log ${a} completed; ${b} solved with hints in 23 minutes; ${c} unsolved after 11 minutes`);
    assert.equal(used(turn, 'create_practices').filter(c => !c.args.dryRun).length, 1);
    const { total, records } = await practices();
    assert.equal(total, 3);
    assert.deepEqual(records.map(r => [r.questionFrontendId, r.completed, r.outcome, r.durationMinutes]).sort(),
      [[a, true, null, null], [b, true, 'assisted', 23], [c, false, 'unsolved', 11]]);
  } else if (scenario === 'note') {
    const marker = `Cedar-${a}`;
    await saveAttempts([{ questionFrontendId: a, completed: true, outcome: 'assisted', durationMinutes: 31,
      notes: `Trace label ${marker}. I skipped the first element when summing an array.` }]);
    const before = await note();
    assert.equal(before.state, 'empty');
    const draft = await ask(`note ${a} Draft only. Include the trace label from my attempt.`);
    used(draft, 'get_note_context');
    assert.ok(draft.answer.includes(marker));
    assert.deepEqual(await note(), before);
    const written = await ask(`note ${a} Save a concise note in English including the trace label from my attempt.`);
    used(written, 'get_note_context');
    used(written, 'save_notes');
    const original = await note();
    assert.equal(original.state, 'written');
    assert.ok(original.content.includes(marker));
    const addition = 'Test the empty array before the first iteration.';
    const preview = await ask(`note ${a} Add this sentence to a new "Boundary check" section: "${addition}"`);
    used(preview, 'get_note_context');
    assert.ok(preview.answer.includes(addition));
    assert.deepEqual(await note(), original);
    const accepted = await followUp('Confirmed. Append exactly the proposed sentence under the new section.');
    assert.ok(used(accepted, 'patch_note').some(c => c.args.mode === 'append' && c.args.expectedContentHash === original.contentHash));
    const saved = await note();
    assert.ok(saved.content.startsWith(original.content.trimEnd()));
    assert.equal(saved.content.split(addition).length, 2);
    assert.match(saved.content, /^#{1,6} Boundary check\s*$/im);
  } else if (scenario === 'review') {
    const progress = () => call('get_progress', { weakTopics: true });
    const { weakTopics } = await progress();
    const yesterday = new Date(Date.parse(weakTopics.asOfDate + 'T00:00:00Z') - 86400000).toISOString().slice(0, 10);
    await saveAttempts([a, b, c].map((id, index) => ({
      questionFrontendId: id, completed: false, outcome: 'unsolved', practicedAt: index ? weakTopics.asOfDate : yesterday,
    })));
    const before = await progress();
    assert.deepEqual(before.weakTopics.topics.map(t => t.tag), ['Array']);
    const turn = await ask('review Which weak topic should I revisit? Include the IDs of two problems I actually practiced.');
    assert.ok(used(turn, 'get_progress').some(c => c.args.weakTopics === true));
    assert.match(turn.answer, /Array|数组/i);
    assert.ok([a, b, c].filter(id => turn.answer.includes(id)).length >= 2);
    assert.deepEqual(await progress(), before);
  }
}
