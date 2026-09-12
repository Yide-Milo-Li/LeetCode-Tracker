/** Phase 6 desktop acceptance against an isolated synthetic SQLite store and mocked Gemini.
 * Builds must exist before running. No environment files, private databases or real provider calls are used.
 * Chrome runs with its own profile; VERIFY_OUTPUT_DIR can keep evidence outside the checkout.
 */
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import { CatalogStore } from '../packages/database/src/store.ts';
import { buildApp } from '../apps/server/src/app.ts';
import type { IGeminiAssistant } from '../apps/server/src/gemini.ts';

const root = process.cwd();
const out = process.env.VERIFY_OUTPUT_DIR
  ? path.resolve(process.env.VERIFY_OUTPUT_DIR)
  : path.resolve(root, '.local/evidence/phase6/browser');
const profile = path.join(out, 'chrome-' + Date.now());
await mkdir(profile, { recursive: true });
const db = new DatabaseSync(':memory:');
const store = await CatalogStore.open(db);
const report: {
  scope: string;
  screenshots: string[];
  layouts: unknown[];
  overlays: unknown[];
  motion: unknown[];
  flows: string[];
  errors: unknown[];
  consoleMessages: unknown[];
  externalRequests: string[];
  apiRequests: string[];
  mockCalls: number;
  failure?: string;
} = {
  scope:
    'Synthetic local browser acceptance; real React/local API/SQLite, mocked Gemini. No live model or release.',
  screenshots: [],
  layouts: [],
  overlays: [],
  motion: [],
  flows: [],
  errors: [],
  consoleMessages: [],
  externalRequests: [],
  apiRequests: [],
  mockCalls: 0,
};
const fixtures = Array.from({ length: 68 }, (_, index) => ({
  id: String(9001 + index),
  questionId: 'synthetic-' + (index + 1),
  title: index === 67 ? 'A deliberately long English problem title covering repeated interval transformations, boundary conditions, and stable ordering across multiple independent update sequences — 长题名用于桌面换行验证' :
    [
      'Pair Sum Window',
      'Ordered Intervals',
      'Path Through a Grid',
      'Cache Entry Order',
      'Balanced Search Tree',
      'Longest Unique Segment',
    ][index % 6] + (index < 6 ? '' : ' ' + (index + 1)),
  difficulty: (['Easy', 'Medium', 'Hard'] as const)[index % 3],
  tags: index === 67 ? ['这是用于验证中文长标签是否完整换行的合成标签', 'Array'] : index % 2 ? ['Hash Table', 'Design'] : ['Array', 'Dynamic Programming'],
  url: 'https://example.org/problems/' + (index + 1),
  isPaidOnly: index % 9 === 0,
  source: 'synthetic',
}));
await store.importJsonl(fixtures.map((item) => JSON.stringify(item)).join('\n'));
await store.updateSettings({ timezone: 'America/Los_Angeles', language: 'en', theme: 'light' });
await store.planning.saveStrategy({
  name: 'Core patterns · 核心模式',
  weekdays: [0, 1, 2, 3, 4, 5, 6],
  rules: {
    dailyCount: 3,
    difficulty: { Easy: 34, Medium: 33, Hard: 33 },
    tags: [],
    premium: false,
    reviewEnabled: false,
    reviewPercent: null,
    preference: 'Review the reasoning after each problem.',
  },
});
for (let index = 0; index < 26; index++)
  await store.createPracticeRecord({
    questionFrontendId: fixtures[index % 12].id,
    completed: index % 5 !== 0,
    practicedAt: new Date(Date.now() - (index + 1) * 86400000).toISOString(),
    durationMinutes: index % 3 ? 18 + index : null,
    notes: 'Synthetic practice note.',
  });
const seedPreview = store.previewProgressImport({
  candidates: [{ frontendId: '9001', lastSubmitted: '2026-08-20', lastResult: 'Accepted', submissions: 8 }],
  sourceTimezone: 'America/Los_Angeles',
});
await store.commitProgressImport(seedPreview.previewId, seedPreview, []);
const gemini: IGeminiAssistant = {
  getStatus: () => ({ configured: true, model: 'synthetic-mock' }),
  formatProgressText: async () => {
    report.mockCalls++;
    return {
      candidates: [
        { frontendId: '9001', lastSubmitted: '2026-08-01', lastResult: 'Accepted', submissions: 3 },
        { frontendId: '9002', lastSubmitted: '2026-08-25', lastResult: 'Accepted', submissions: 4 },
        { frontendId: '999999', lastSubmitted: '2026-08-25', lastResult: 'Accepted', submissions: 1 },
      ],
      unparsedSnippets: ['Synthetic unmatched note'],
      model: 'synthetic-mock',
    };
  },
  generatePlanContent: async ({ problems }) => {
    report.mockCalls++;
    return {
      reasons: Object.fromEntries(
        problems.map((problem) => [
          problem.questionId,
          {
            en: 'Practice the core pattern and explain its boundary conditions.',
            zh: '练习核心模式，并说明边界条件。',
          },
        ]),
      ),
      encouragement: {
        en: 'Three thoughtful problems. One steady step forward.',
        zh: '认真练习三道题，踏实地前进一步。',
      },
      model: 'synthetic-mock',
    };
  },
  parseOverridePrompt: async () => {
    report.mockCalls++;
    return { patch: { dailyCount: 3 }, unresolved: [], model: 'synthetic-mock' };
  },
};
const app = await buildApp({
  store,
  geminiAssistant: gemini,
  staticRoot: path.resolve(root, 'apps/web/dist'),
});
await app.listen({ host: '127.0.0.1', port: 0 });
const address = app.server.address();
if (!address || typeof address === 'string') throw new Error('No loopback server address');
const origin = 'http://127.0.0.1:' + address.port;
const chrome = spawn(
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  [
    '--headless=new',
    '--remote-debugging-port=0',
    '--user-data-dir=' + profile,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--disable-extensions',
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
    'about:blank',
  ],
  { windowsHide: true, stdio: 'ignore' },
);
let socket: WebSocket | undefined;
/** Poll only a local rendering milestone with a short bounded delay. */
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let fault: {
  match: string | string[];
  method?: string;
  body: unknown;
  status?: number;
  hold?: number;
} | null = null;
let dropCreateResponse = false;
try {
  let port = 0;
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      port = Number((await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]);
      break;
    } catch {
      await delay(100);
    }
  }
  if (!port) throw new Error('Isolated Chrome did not start');
  const target = (await (
    await fetch('http://127.0.0.1:' + port + '/json/new?about:blank', { method: 'PUT' })
  ).json()) as { webSocketDebuggerUrl: string };
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => {
    socket!.onopen = () => resolve();
    socket!.onerror = reject;
  });
  let nextId = 0;
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  /** Time-bound CDP requests make a failed interaction stop with evidence instead of hanging. */
  const send = (method: string, params: Record<string, unknown> = {}): Promise<any> =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('CDP timeout: ' + method));
      }, 15000);
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      socket!.send(JSON.stringify({ id, method, params }));
    });
  socket.onmessage = (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id) {
      const operation = pending.get(message.id);
      pending.delete(message.id);
      if (operation)
        message.error
          ? operation.reject(new Error(JSON.stringify(message.error)))
          : operation.resolve(message.result);
    }
    if (message.method === 'Runtime.exceptionThrown') report.errors.push(message.params.exceptionDetails);
    if (message.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(message.params.type))
      report.consoleMessages.push({ type: message.params.type, args: message.params.args.map((arg: any) => arg.value ?? arg.description) });
    if (message.method === 'Network.requestWillBeSent') {
      const url = message.params.request.url as string;
      if (/^https?:/.test(url) && !url.startsWith(origin)) report.externalRequests.push(url);
      if (url.includes('/api/')) report.apiRequests.push(url);
    }
    if (message.method === 'Fetch.requestPaused') {
      const request = message.params.request;
      // Response-stage failure proves the database committed before the browser lost the response.
      if (message.params.responseStatusCode) {
        if (dropCreateResponse && request.method === 'POST' && message.params.responseStatusCode === 201) {
          dropCreateResponse = false;
          void send('Fetch.failRequest', { requestId: message.params.requestId, errorReason: 'ConnectionClosed' });
        } else void send('Fetch.continueResponse', { requestId: message.params.requestId });
        return;
      }
      const selected =
        fault &&
        [fault.match].flat().some((part) => request.url.includes(part)) &&
        (!fault.method || request.method === fault.method)
          ? { ...fault }
          : null;
      if (selected)
        void delay(selected.hold ?? 0).then(() =>
          send('Fetch.fulfillRequest', {
            requestId: message.params.requestId,
            responseCode: selected.status ?? 200,
            responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
            body: Buffer.from(JSON.stringify(selected.body)).toString('base64'),
          }),
        );
      else void send('Fetch.continueRequest', { requestId: message.params.requestId });
    }
  };
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Network.enable');
  await send('Page.bringToFront');
  await send('Fetch.enable', { patterns: [{ urlPattern: '*api/v1/*', requestStage: 'Request' }, { urlPattern: '*api/v1/practice-records', requestStage: 'Response' }] });
  /** Propagate page exceptions and only return serializable DOM values. */
  const evaluate = async (expression: string) => {
    const value = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (value.exceptionDetails)
      throw new Error(
        value.exceptionDetails.exception?.description ?? JSON.stringify(value.exceptionDetails),
      );
    return value.result.value;
  };
  /** Wait for an explicit DOM condition; timeout includes the actual visible text for diagnosis. */
  const until = async (condition: string) => {
    for (let n = 0; n < 70; n++) {
      if (await evaluate(`Boolean(${condition})`)) return;
      await delay(80);
    }
    throw new Error(
      'DOM timeout: ' + condition + '\n' + (await evaluate('document.body.innerText.slice(-3500)')),
    );
  };
  const visible = "e => e.getClientRects().length && !e.closest('[hidden], [inert]')";
  /** Click real visible controls by text without invoking application internals. */
  const click = async (label: string, selector = 'button') => {
    // Hit-test the settled control, not coordinates from a moving entrance frame.
    await until("document.getAnimations().every(a=>a.playState!=='running'||!['dialog-enter','drawer-enter'].includes(a.animationName))");
    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        const point = await evaluate(
          `(() => { const e = [...document.querySelectorAll(${JSON.stringify(selector)})].filter(${visible}).find(e => e.textContent.trim() === ${JSON.stringify(label)} || e.getAttribute('aria-label') === ${JSON.stringify(label)}); if (!e || e.disabled) throw new Error('Missing or disabled control: ' + ${JSON.stringify(label)}); e.scrollIntoView({block:'center'}); const r=e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`,
        );
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
        await delay(100);
        if (await evaluate("Boolean(document.querySelector('.overlay-backdrop.is-closing'))")) {
          await until("!document.querySelector('.overlay-backdrop.is-closing')");
        }
        return;
      } catch (err) {
        if (attempt === 29) throw err;
        await delay(60);
      }
    }
  };
  /** Native value setters trigger the same React change handlers as browser editing. */
  const fill = async (selector: string, value: string) => {
    await evaluate(
      `(() => { const e = [...document.querySelectorAll(${JSON.stringify(selector)})].find(${visible}); if (!e) throw new Error('Missing input'); const proto = e.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : e.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto,'value').set.call(e, ${JSON.stringify(value)}); e.dispatchEvent(new Event('input', {bubbles:true})); e.dispatchEvent(new Event('change', {bubbles:true})); })()`,
    );
    await delay(100);
  };
  const navigate = async (view: string) => {
    await evaluate('location.hash=' + JSON.stringify(view));
    await until(`document.getElementById('view-${view}') && !document.getElementById('view-${view}').hidden`);
    await delay(200);
  };
  const screenshot = async (name: string) => {
    await delay(240);
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    await writeFile(path.join(out, name + '.png'), Buffer.from(shot.data, 'base64'));
    report.screenshots.push(name + '.png');
  };
  const reload = async (view = 'today') => {
    // Hash-only navigation is same-document: force a new document before testing persisted preferences.
    await send('Page.navigate', { url: 'about:blank' });
    await until("!document.querySelector('.sidebar')");
    await send('Page.navigate', { url: origin + '/#' + view });
    await until("document.querySelector('.sidebar') && document.querySelector('h1')");
    await delay(400);
  };
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await reload();
  await until("document.querySelectorAll('.completion-circle').length === 3");
  assert.equal(await evaluate("document.querySelectorAll('nav .nav-item').length"), 3);
  // Phase 10 regression: exercise actual CSS and browser event timing using isolated fixture data.
  const initialRecords = new Set(store.queryPracticeRecords({ limit: 100 }).items.map((record) => record.id));
  await evaluate("document.querySelector('.completion-circle[aria-pressed=false]').click()");
  await until("document.querySelector('[role=dialog]')");
  const motion = await evaluate("(() => {const panel=document.querySelector('[role=dialog]');const css=getComputedStyle(panel);return {name:css.animationName,duration:css.animationDuration,background:getComputedStyle(document.querySelector('.overlay-backdrop')).animationName};})()");
  assert.equal(motion.name, 'dialog-enter');
  assert.equal(motion.duration, '0.22s');
  assert.equal(motion.background, 'fade-in');
  const race = await evaluate("(async () => {document.querySelector('[aria-label=Close]').click();await new Promise(r=>setTimeout(r,15));const inert=document.getElementById('root').inert;const exit=getComputedStyle(document.querySelector('[role=dialog]')).animationName;location.hash='problems';await new Promise(r=>setTimeout(r,30));document.dispatchEvent(new KeyboardEvent('keydown',{key:'n',bubbles:true}));await new Promise(r=>setTimeout(r,200));return {inert,exit,title:document.querySelector('[role=dialog] h2')?.textContent};})()");
  assert.equal(race.inert, true, 'The exiting dialog must retain its background lock');
  assert.equal(race.exit, 'dialog-exit');
  assert.equal(race.title, 'Manual record', 'Old exit must not close a new dialog after navigation');
  await click('Close');
  await reload('today');
  await navigate('problems');
  await evaluate("location.hash='today'");
  await until("!document.getElementById('view-today').hidden");
  assert.equal(await evaluate("document.getAnimations().filter(a=>a.effect?.target?.closest('.today-problem.completed')).length"), 0, 'Persisted completion must not replay');
  for (const record of store.queryPracticeRecords({ limit: 100 }).items) {
    if (!initialRecords.has(record.id)) await store.revokePracticeRecord(record.id);
  }
  await reload();
  report.motion.push({ enter: motion, navigationExit: race });
  report.flows.push('Real overlay enter/exit styles exist; inert lasts through exit; navigation cancels old callbacks; completed rows do not replay on return.');
  const before = store.getPracticeRevision();
  await evaluate(
    "document.querySelector('.completion-circle').focus(); document.querySelector('.completion-circle').click()",
  );
  await until(
    "document.querySelector('[role=dialog]') && document.querySelector('.completion-circle[aria-pressed=true]')",
  );
  assert.equal(store.getPracticeRevision(), before + 1);
  await screenshot('completion-optional-details');
  for (const invalid of ['0', '-1', '1.5']) {
    await fill('[role=dialog] input[type=number]', invalid);
    assert.equal(await evaluate("document.querySelector('[role=dialog] input[type=number]').checkValidity()"), false);
    await click('Save details');
    assert.equal(store.getPracticeRevision(), before + 1);
  }
  await fill('[role=dialog] input[type=number]', '27');
  await fill('[role=dialog] textarea', 'Synthetic browser detail.');
  await click('Save details');
  await until("!document.querySelector('[role=dialog]')");
  assert.equal(
    store.queryPracticeRecords({ limit: 100 }).items.filter((record) => record.durationMinutes === 27).length,
    1,
  );
  report.flows.push('Today circle creates first; optional duration and notes patch the same record.');
  await evaluate("document.querySelector('.completion-circle[aria-pressed=true]').click()");
  await until("document.querySelector('.record-detail')");
  await screenshot('completion-evidence-detail');
  await click('Revoke this record');
  await click('Confirm revoke');
  await delay(250);
  await until("document.querySelector('.record-detail')?.innerText.includes('Revoked')");
  await send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'Escape',
    code: 'Escape',
    windowsVirtualKeyCode: 27,
  });
  await until("!document.querySelector('[role=dialog]')");
  assert.equal(
    await evaluate("document.querySelectorAll('.completion-circle[aria-pressed=true]').length"),
    0,
  );
  report.flows.push(
    'Exact manual revoke preserves audit and reconciles the task; Escape restores the overlay trigger.',
  );
  fault = {
    match: '/practice-records',
    method: 'POST',
    status: 503,
    body: { error: 'SYNTHETIC_FAILURE', message: 'Synthetic create failure' },
  };
  const countBeforeFailure = store.queryPracticeRecords({ limit: 100 }).total;
  await evaluate("document.querySelector('.completion-circle').click()");
  await until("document.querySelector('.today-problem [role=alert]')");
  assert.equal(store.queryPracticeRecords({ limit: 100 }).total, countBeforeFailure);
  assert.equal(
    await evaluate("document.querySelector('.completion-circle').getAttribute('aria-pressed')"),
    'false',
  );
  await screenshot('completion-create-failure');
  fault = null;
  await click('Retry');
  await until("document.querySelector('[role=dialog]')");
  await fill('[role=dialog] input[type=number]', '41');
  fault = {
    match: '/practice-records/',
    method: 'PATCH',
    status: 503,
    body: { error: 'SYNTHETIC_FAILURE', message: 'Synthetic details failure' },
  };
  await click('Save details');
  await until("document.querySelector('[role=dialog] [role=alert]')");
  assert.equal(await evaluate("document.querySelector('[role=dialog] input[type=number]').value"), '41');
  assert.equal(
    await evaluate("document.querySelector('.completion-circle').getAttribute('aria-pressed')"),
    'true',
  );
  await screenshot('completion-details-failure');
  fault = null;
  // Real keyboard events exercise wrap-around focus; page controls remain inert during editing.
  await evaluate("document.querySelector('[role=dialog] button[aria-label=Close]').focus()");
  await send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'Tab',
    code: 'Tab',
    windowsVirtualKeyCode: 9,
    modifiers: 8,
  });
  assert.equal(await evaluate('document.activeElement.textContent.trim()'), 'Save details');
  await send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'Tab',
    code: 'Tab',
    windowsVirtualKeyCode: 9,
  });
  assert.equal(await evaluate("document.activeElement.getAttribute('aria-label')"), 'Close');
  await screenshot('completion-keyboard-focus');
  await click('Save details');
  await until("!document.querySelector('[role=dialog]')");
  for (const dismissal of ['Skip', 'Close', 'Escape', 'backdrop']) {
    await evaluate("document.querySelector('.completion-circle[aria-pressed=false]').click()");
    await until("document.querySelector('[role=dialog]')");
    const savedCount = store.queryPracticeRecords({ limit: 100 }).total;
    const completedRow = store.queryPracticeRecords({ limit: 100 }).items[0];
    if (dismissal === 'Escape')
      await send('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: 'Escape',
        code: 'Escape',
        windowsVirtualKeyCode: 27,
      });
    else if (dismissal === 'backdrop')
      await evaluate(
        "document.querySelector('.overlay-backdrop').dispatchEvent(new MouseEvent('mousedown',{bubbles:true}))",
      );
    else await click(dismissal);
    await until("!document.querySelector('[role=dialog]')");
    assert.equal(store.queryPracticeRecords({ limit: 100 }).total, savedCount);
    assert.equal(store.getPracticeRecord(completedRow.id)?.status, 'active');
    // Isolated fixture cleanup makes another incomplete row available for the next dismissal path.
    await store.revokePracticeRecord(completedRow.id);
    await reload();
  }
  report.flows.push(
    'Initial save failure stays unchecked; detail failure keeps the draft and completion; all four dismissals preserve the base row; Tab focus is trapped.',
  );
  const beforeLostResponse = store.queryPracticeRecords().total;
  dropCreateResponse = true;
  await evaluate("document.querySelector('.completion-circle[aria-pressed=false]').click()");
  await until("document.querySelector('.today-problem [role=alert]')");
  assert.equal(store.queryPracticeRecords().total, beforeLostResponse + 1);
  await screenshot('completion-response-lost-after-commit');
  await click('Retry');
  await until("document.querySelector('[role=dialog]')");
  assert.equal(store.queryPracticeRecords().total, beforeLostResponse + 1);
  await fill('[role=dialog] input[type=number]', '33');
  await fill('[role=dialog] textarea', 'Recover this closed draft.');
  fault = { match: '/practice-records/', method: 'PATCH', status: 503, hold: 800, body: { message: 'Synthetic late detail failure' } };
  await click('Save details');
  await click('Close');
  await until("document.querySelector('main [role=alert]')?.innerText.includes('Synthetic late detail failure')");
  await screenshot('completion-closed-save-recovery');
  fault = null;
  await click('Recover draft');
  assert.equal(await evaluate("document.querySelector('[role=dialog] input[type=number]').value"), '33');
  assert.equal(await evaluate("document.querySelector('[role=dialog] textarea').value"), 'Recover this closed draft.');
  await click('Save details');
  await until("!document.querySelector('[role=dialog]')");
  await reload();
  assert.equal(store.queryPracticeRecords().total, beforeLostResponse + 1);
  report.flows.push('A response dropped after the real INSERT retries the same operation without a second row; closed detail failure recovers its draft and patches the original ID; reload agrees with SQLite.');
  await navigate('records');
  await click('Manual record');
  await fill('[role=dialog] input[type=search]', '9006');
  await until("document.querySelector('.picker-option')");
  await evaluate("document.querySelector('.picker-option').click()");
  await screenshot('manual-record-search-selected');
  await click('Save record');
  await until("!document.querySelector('[role=dialog]')");
  report.flows.push('Search-first manual entry stores an independent practice outside the plan.');
  await evaluate("document.querySelector('#view-records .activity-table tbody tr button').click()");
  await until("document.querySelector('.record-detail')");
  await click('Correct record');
  await fill('[role=dialog] input[type=number]', '17');
  await fill('[role=dialog] textarea', 'Synthetic correction');
  await click('Save record');
  await until("!document.querySelector('[role=dialog] .practice-form')");
  const corrected = store.queryPracticeRecords({ limit: 100 }).items.find((item) => item.notes === 'Synthetic correction')!;
  assert.equal(corrected.durationMinutes, 17);
  await click('Edit details');
  await fill('[role=dialog] input[type=number]', '');
  await click('Save details');
  await until("!document.querySelector('[role=dialog] .practice-form')");
  assert.equal(store.getPracticeRecord(corrected.id)?.durationMinutes, null);
  assert.ok(await evaluate("document.querySelector('[role=dialog]').innerText.includes('Not recorded')"));
  await screenshot('record-correction-cleared-duration');
  await click('Close');
  report.flows.push('HTML rejects zero/negative/fractional duration; historical correction and detail clearing update the same record and display unknown duration as Not recorded.');
  const planBeforeBackfill = store.planning.plans()[0];
  await click('Manual record');
  await fill('[role=dialog] input[type=search]', planBeforeBackfill.items[0].problem.questionFrontendId);
  await until("document.querySelector('.picker-option')");
  await evaluate("document.querySelector('.picker-option').click()");
  await fill('[role=dialog] select', 'true');
  await fill('[role=dialog] input[type=datetime-local]', '2026-08-15T12:00:00');
  await fill('[role=dialog] textarea', 'Synthetic historical backfill');
  await click('Save record');
  await until("!document.querySelector('[role=dialog]')");
  await until("document.querySelector('.activity-records')?.innerText.includes('2026')");
  assert.ok(store.queryPracticeRecords({ limit: 100 }).items.some((item) => item.notes === 'Synthetic historical backfill' && item.practicedAt.startsWith('2026-08-15')));
  assert.deepEqual(store.planning.plans()[0].items.map((item) => item.completed), planBeforeBackfill.items.map((item) => item.completed));
  report.flows.push('Historical backfill uses the entered source-zone time and leaves current plan completion unchanged.');
  await navigate('progress-import');
  await fill('textarea', 'Synthetic progress batch');
  await click('Organize content');
  await until("document.querySelector('.candidate-table')");
  await screenshot('progress-import-candidates');
  await click('Generate preview');
  await until("document.querySelector('.preview-item')");
  await screenshot('progress-import-conflicts');
  await evaluate("document.querySelector('.preview-item.conflict input[type=checkbox]').click()");
  await click('Continue to confirmation');
  await screenshot('progress-import-confirm');
  await click('Confirm import');
  await until("document.body.innerText.includes('Progress imported')");
  await screenshot('progress-import-result');
  report.flows.push(
    'Mock Gemini candidates pass real preview/conflict/atomic import; unmatched rows remain errors.',
  );
  await evaluate("document.querySelector('.snapshot-browser .text-link').click()");
  await until("document.querySelector('[role=dialog]')?.innerText.includes('Snapshot version audit')");
  await click('Correct snapshot');
  await fill('[role=dialog] input[type=number]', '9');
  await click('Save correction');
  await until("!document.querySelector('[role=dialog] form')");
  assert.equal(store.getProgressSnapshot('9001')?.totalSubmissions, 9);
  await screenshot('snapshot-corrected-audit');
  await click('Revoke snapshot');
  await click('Confirm revoke');
  await until("document.querySelector('[role=dialog]')?.innerText.includes('revoked')");
  assert.equal(store.getProgressSnapshot('9001')?.status, 'revoked');
  await screenshot('snapshot-revoked-audit');
  await click('Close');
  report.flows.push(
    'Snapshot correction and scoped revocation preserve version audit and leave manual records independent.',
  );
  const pagePreview = store.previewProgressImport({ candidates: fixtures.slice(10, 34).map((item) => ({ frontendId: item.id, lastSubmitted: '2026-08-10', lastResult: 'Accepted', submissions: 1000001 })), sourceTimezone: 'America/Los_Angeles' });
  await store.commitProgressImport(pagePreview.previewId, pagePreview, []);
  await reload('progress-import');
  await click('Browse current snapshots', 'summary');
  await until("document.querySelectorAll('.snapshot-browser tbody tr').length === 20");
  const firstSnapshot = await evaluate("document.querySelector('.snapshot-browser tbody tr').innerText");
  await evaluate("document.querySelector('.snapshot-browser .pagination button[aria-label=Next]').click()");
  await until("document.querySelector('.snapshot-browser tbody tr')?.innerText !== " + JSON.stringify(firstSnapshot));
  await screenshot('snapshot-pagination-large-counts');
  report.flows.push('Current snapshots paginate through 25 active synthetic observations with large cumulative counts.');
  await navigate('catalog-import');
  const uploadPath = path.join(out, 'synthetic-upload.jsonl');
  await writeFile(uploadPath, JSON.stringify({ id: '99902', title: 'Synthetic Uploaded Problem', difficulty: 'Medium', tags: ['Array'] }) + '\n{invalid json}\n' + JSON.stringify({ id: 'invalid', title: 'Missing difficulty' }));
  const domRoot = await send('DOM.getDocument');
  const fileNode = await send('DOM.querySelector', { nodeId: domRoot.root.nodeId, selector: '#view-catalog-import input[type=file]' });
  await send('DOM.setFileInputFiles', { nodeId: fileNode.nodeId, files: [uploadPath] });
  await until("document.body.innerText.includes('synthetic-upload.jsonl')");
  await click('Preview Changes');
  await until("document.body.innerText.includes('Synthetic Uploaded Problem')");
  await screenshot('catalog-upload-error-details');
  await click('Confirm & Import Valid Records');
  await until("document.body.innerText.includes('Successfully committed')");
  assert.ok(store.getProblem('99902', 'frontendId'));
  await click('Close');
  report.flows.push('A real synthetic JSONL file upload displays invalid-line details and commits only the valid row; import history refreshes.');
  await click('Paste Raw JSONL');
  await fill(
    'textarea',
    JSON.stringify({ id: '99901', title: 'Synthetic Import Example', difficulty: 'Easy', tags: ['Array'] }),
  );
  await click('Preview Changes');
  await until("document.body.innerText.includes('Synthetic Import Example')");
  await screenshot('catalog-import-preview');
  await click('Confirm & Import Valid Records');
  await until("document.body.innerText.includes('Successfully committed')");
  await screenshot('catalog-import-result');
  await click('Close');
  report.flows.push('JSONL catalog preview and atomic commit refresh the real local catalog.');
  await navigate('schedule');
  await click('New Strategy');
  await screenshot('strategy-editor');
  await fill('[aria-label="Strategy Name"]', 'Synthetic unassigned strategy');
  await fill('[aria-label="Daily Question Count"]', '2');
  await fill('[aria-label="Easy %"]', '100');
  await fill('[aria-label="Medium %"]', '0');
  await fill('[aria-label="Hard %"]', '0');
  await evaluate("document.querySelectorAll('input[name=reviewMode]')[1].click()");
  await evaluate("document.querySelector('.weekday-select-btn').click()");
  await click('Save Strategy');
  await until("document.querySelector('[role=dialog] .alert-danger')");
  assert.equal(
    await evaluate('document.querySelector(\'[aria-label="Strategy Name"]\').value'),
    'Synthetic unassigned strategy',
  );
  await screenshot('strategy-weekday-conflict');
  await evaluate("document.querySelector('.weekday-select-btn').click()");
  await click('Save Strategy');
  await until("!document.querySelector('[role=dialog]')");
  assert.equal(store.planning.strategies().length, 2);
  report.flows.push(
    'The strategy editor saves explicitly supplied count, allocation and review rules with no implicit weekday assignment.',
  );
  await navigate('today');
  await click('Adjust today');
  await screenshot('today-adjustment');
  await fill('[role=dialog] textarea', 'Keep the count at three and retain the other rules.');
  await click('Parse with AI');
  await until(
    "document.querySelector('[role=dialog] .preview-card') || document.querySelector('[role=dialog] table')",
  );
  await screenshot('today-adjustment-preview');
  await click('Apply to Unfinished Slots');
  await until("!document.querySelector('[role=dialog]')");
  const beforeReplace = store.planning.plans()[0];
  await evaluate(
    "[...document.querySelectorAll('.today-problem:not(.completed) button')].find(e=>e.getAttribute('aria-label')==='Replace'||e.textContent.trim()==='Replace').click()",
  );
  await until("!document.querySelector('.today-problem .spin')");
  await delay(200);
  assert.ok(store.planning.plans()[0].version > beforeReplace.version);
  assert.ok(
    beforeReplace.items
      .filter((item) => item.completed)
      .every((item) => store.planning.plans()[0].items.some((next) => next.id === item.id)),
  );
  report.flows.push(
    'Weekday conflict preserves the draft; mocked prompt override previews and applies; single replacement remains available.',
  );
  await evaluate("document.querySelector('.action-menu summary').click()");
  await evaluate(
    "[...document.querySelectorAll('.action-menu button')].find(e=>e.textContent.includes('Version')).click()",
  );
  await until("document.querySelector('[role=dialog]')");
  await screenshot('plan-versions');
  await click('Close');
  const beforeBatch = store.planning.plans()[0].version;
  await evaluate(
    "[...document.querySelectorAll('.action-menu button')].find(e=>e.textContent.includes('Replace Unfinished')).click()",
  );
  await until("!document.querySelector('.today-problem .spin')");
  await delay(200);
  assert.ok(store.planning.plans()[0].version > beforeBatch);
  await navigate('problems');
  await fill('select', 'Easy');
  await until("document.querySelectorAll('#view-problems .data-table tbody tr').length && [...document.querySelectorAll('#view-problems .data-table tbody tr')].every(e=>e.innerText.includes('Easy'))");
  await fill('select', '');
  await until("document.querySelector('#view-problems .pagination button[aria-label=Next]') && !document.querySelector('#view-problems .pagination button[aria-label=Next]').disabled");
  const firstProblem = await evaluate("document.querySelector('.problem-title-button').textContent");
  await evaluate("document.querySelector('#view-problems .pagination button[aria-label=Next]').click()");
  await until("document.querySelector('.problem-title-button')?.textContent !== " + JSON.stringify(firstProblem));
  await screenshot('problems-page-two');
  await evaluate("document.querySelector('.problem-title-button').click()");
  await screenshot('problem-details');
  await click('Record practice');
  await until("document.querySelector('[role=dialog] .practice-form')");
  assert.equal(await evaluate("document.querySelectorAll('[role=dialog]').length"), 1);
  assert.equal(await evaluate("[...document.querySelectorAll('[role=dialog]')].at(-1).querySelectorAll('.practice-form').length"), 1);
  await screenshot('problem-shared-practice-editor');
  await click('Cancel');
  await click('Close');
  // Matrix drives persisted language/theme through the real API before rendering each desktop width.
  for (const [width, height] of [
    [1024, 768],
    [1440, 900],
    [1920, 1080],
  ]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    for (const language of ['en', 'zh'] as const)
      for (const theme of ['light', 'dark'] as const) {
        await store.updateSettings({ language, theme });
        await reload();
        await until(
          `document.documentElement.lang === '${language === 'zh' ? 'zh-CN' : 'en'}' && document.documentElement.classList.contains('dark') === ${theme === 'dark'}`,
        );
        for (const view of [
          'today',
          'problems',
          'records',
          'statistics',
          'settings',
          'schedule',
          'catalog-import',
          'progress-import',
        ]) {
          await navigate(view);
          await evaluate('window.scrollTo(0,0)');
          for (const expanded of [false, true]) {
            const desired = expanded ? 'expanded' : 'collapsed';
            if (!await evaluate(`document.querySelector('.sidebar').classList.contains('${desired}')`)) {
              await click(language === 'zh' ? (expanded ? '展开侧边栏' : '折叠侧边栏') : (expanded ? 'Expand sidebar' : 'Collapse sidebar'));
            }
            const geometry = await evaluate(
              `({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth, sidebarWidth: document.querySelector('.sidebar').getBoundingClientRect().width, dialogs: document.querySelectorAll('[role=dialog]').length, title: document.querySelector('#view-${view} h1')?.textContent || document.querySelector('main h1')?.textContent })`,
            );
            assert.equal(geometry.sidebarWidth, expanded ? 216 : 64);
            assert.ok(geometry.scrollWidth <= (await evaluate('document.documentElement.clientWidth')) + 1,
              'Page overflow: ' + [width, language, theme, view, desired].join('-'));
            // Layout rectangles can differ from integer CSS pixels by floating-point rounding.
            const smallTargets = await evaluate("[...document.querySelectorAll('.btn-icon')].filter(e=>e.getClientRects().length&&!e.closest('[hidden],details:not([open])')).map(e=>({name:e.getAttribute('aria-label'),w:e.getBoundingClientRect().width,h:e.getBoundingClientRect().height})).filter(r=>r.w<37.99||r.h<37.99)");
            assert.deepEqual(smallTargets, [], 'Icon target minimum: ' + JSON.stringify(smallTargets));
            if (!expanded) {
              await evaluate("document.querySelector('nav button').focus()");
              await until("document.querySelector('[role=tooltip]')");
              const tooltip = await evaluate("(() => {const e=document.querySelector('[role=tooltip]'),r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,insideSidebar:!!e.closest('.sidebar'),width:innerWidth,height:innerHeight};})()");
              assert.equal(tooltip.insideSidebar, false);
              assert.ok(tooltip.left>=0 && tooltip.right<=tooltip.width && tooltip.top>=0 && tooltip.bottom<=tooltip.height);
              await send('Input.dispatchKeyEvent', { type:'keyDown', key:'Escape', code:'Escape', windowsVirtualKeyCode:27 });
              await until("!document.querySelector('[role=tooltip]')");
            }
            if (view === 'today') {
              assert.equal(await evaluate("document.querySelectorAll('.today-view .page-description').length"), 1);
              assert.equal(await evaluate("Boolean(document.querySelector('.sidebar-caption'))"), false);
            }
            report.layouts.push({ width, height, language, theme, view, expanded, geometry });
            await screenshot([view, width, language, theme, desired].join('-'));
          }
          await click(language === 'zh' ? '折叠侧边栏' : 'Collapse sidebar');
          /** Inspect the active modal, including its real focus and horizontal bounds at every desktop combination. */
          const inspectOverlay = async (name: string) => {
            await until("document.querySelector('[role=dialog]')");
            await until("document.getAnimations().every(a=>a.playState!=='running' || !a.effect?.target?.closest?.('[role=dialog]'))");
            const bounds = await evaluate("(() => { const e=document.querySelector('[role=dialog]'); const r=e.getBoundingClientRect(); return {left:r.left,right:r.right,width:innerWidth,scroll:e.scrollWidth,client:e.clientWidth,focusInside:e.contains(document.activeElement),title:e.getAttribute('aria-labelledby'),count:document.querySelectorAll('[role=dialog]').length}; })()");
            report.overlays.push({ width, language, theme, name, bounds });
            await screenshot([name, width, language, theme].join('-'));
            assert.ok(bounds.left >= 0 && bounds.right <= bounds.width + 1 && bounds.scroll <= bounds.client + 1, 'Overlay overflow: ' + name + ' ' + JSON.stringify(bounds));
            assert.ok(bounds.focusInside && bounds.title, 'Overlay focus/name: ' + name);
            await click(language === 'zh' ? '关闭' : 'Close');
            await until("!document.querySelector('[role=dialog]')");
          };
          if (view === 'today') {
            // A keyboard completion creates real evidence; fixture cleanup restores the remaining task afterward.
            const completedBefore = new Set(store.queryPracticeRecords({ limit: 100 }).items.map((item) => item.id));
            await evaluate("(() => { const circle=document.querySelector('.completion-circle[aria-pressed=false]'); circle.scrollIntoView({block:'center'}); circle.focus(); })()");
            assert.equal(await evaluate("document.activeElement.classList.contains('completion-circle') && !document.activeElement.disabled"), true);
            await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', text: '\r', unmodifiedText: '\r', windowsVirtualKeyCode: 13 });
            await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
            await inspectOverlay('completion-dialog');
            const keyboardRecord = store.queryPracticeRecords({ limit: 100 }).items.find((item) => !completedBefore.has(item.id))!;
            assert.ok(keyboardRecord && keyboardRecord.durationMinutes === null);
            await store.revokePracticeRecord(keyboardRecord.id);
            await reload();
            await click(language === 'zh' ? '调整今天' : 'Adjust today');
            await inspectOverlay('adjust-dialog');
            await evaluate("document.querySelector('.action-menu').open=true; [...document.querySelectorAll('.action-menu button')].find(e=>/Version|版本/.test(e.textContent)).click()");
            await inspectOverlay('versions-drawer');
            await evaluate("document.querySelector('.completion-circle[aria-pressed=true]').focus(); document.querySelector('.completion-circle[aria-pressed=true]').click()");
            await inspectOverlay('evidence-drawer');
            assert.equal(await evaluate("document.activeElement.classList.contains('completion-circle')"), true);
          } else if (view === 'problems') {
            await fill('#view-problems input[type=search]', '9068');
            await until("document.querySelector('#view-problems .problem-title-button')?.textContent.includes('deliberately long')");
            await screenshot(['long-problem', width, language, theme].join('-'));
            assert.ok(await evaluate("document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1"));
            await evaluate("document.querySelector('#view-problems .problem-title-button').focus(); document.querySelector('#view-problems .problem-title-button').click()");
            await inspectOverlay('problem-drawer');
            await fill('#view-problems input[type=search]', '');
          } else if (view === 'records') {
            await click(language === 'zh' ? '手动记录' : 'Manual record');
            await fill('[role=dialog] input[type=search]', '9068');
            await until("document.querySelector('.picker-option')");
            await evaluate("document.querySelector('.picker-option').click()");
            await inspectOverlay('manual-dialog');
          } else if (view === 'schedule') {
            await click(language === 'zh' ? '新建策略' : 'New Strategy');
            await inspectOverlay('strategy-dialog');
          } else if (view === 'statistics') {
            await click(language === 'zh' ? '查看完整记录' : 'View full history');
            await inspectOverlay('history-drawer');
          } else if (view === 'progress-import') {
            await click(language === 'zh' ? '浏览当前快照' : 'Browse current snapshots', 'summary');
            await evaluate("document.querySelector('.snapshot-browser .text-link').focus(); document.querySelector('.snapshot-browser .text-link').click()");
            await inspectOverlay('snapshot-drawer');
          }
        }
      }
    console.log('Verified desktop matrix at ' + width + 'px');
  }
  await store.updateSettings({ language: 'en', theme: 'light' });
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  for (const state of ['setup', 'rest', 'failure', 'loading'] as const) {
    fault = {
      match: '/daily-plans/ensure',
      body:
        state === 'failure'
          ? { error: 'SYNTHETIC_FAILURE', message: 'Synthetic request failure. Retry is available.' }
          : { status: state === 'setup' ? 'setup' : 'rest', plan: null },
      status: state === 'failure' ? 503 : 200,
      hold: state === 'loading' ? 3000 : 0,
    };
    await reload();
    await screenshot('today-state-' + state);
    if (state === 'loading') await delay(3000);
  }
  fault = null;
  await reload();
  const dailyPlan = store.planning.plans()[0];
  fault = {
    match: '/daily-plans/ensure',
    body: {
      status: 'ready',
      plan: { ...dailyPlan, rules: { ...dailyPlan.rules, dailyCount: 12 }, source: 'local', model: null },
    },
  };
  await reload();
  await until("document.body.innerText.includes('Short by')");
  await screenshot('today-shortage-local-fallback');
  const imported = store.getProgressSnapshot('9002')!;
  fault = {
    match: '/daily-plans/ensure',
    body: {
      status: 'ready',
      plan: {
        ...dailyPlan,
        items: [
          {
            ...dailyPlan.items[0],
            problem: store.getProblem('9002', 'frontendId'),
            completed: true,
            evidenceIds: [`snapshot:${imported.questionId}:${imported.version}`],
          },
        ],
      },
    },
  };
  await reload();
  await evaluate("document.querySelector('.completion-circle[aria-pressed=true]').click()");
  await until("document.querySelector('[role=dialog]')?.innerText.includes('Imported snapshot')");
  assert.equal(
    await evaluate(
      "Boolean([...document.querySelectorAll('[role=dialog] button')].find(e=>e.textContent.includes('Revoke this record')))",
    ),
    false,
  );
  await screenshot('completion-snapshot-evidence-only');
  await click('Close');
  const dashboard = (await app.inject({ method: 'GET', url: '/api/v1/dashboard' })).json();
  const noKnown = {
    ...dashboard,
    overview: { ...dashboard.overview, currentStreak: 0 },
    trend30Days: dashboard.trend30Days.map((day: any) => ({ ...day, activeCount: 0, completedCount: 0 })),
  };
  fault = { match: '/api/v1/dashboard', method: 'GET', body: noKnown };
  await reload();
  await until("document.body.innerText.includes('No known activity')");
  await screenshot('today-no-known-records');
  fault = {
    match: '/api/v1/dashboard',
    method: 'GET',
    body: { ...noKnown, dataStatus: { ...noKnown.dataStatus, userTimezone: null } },
  };
  await reload();
  await until("document.body.innerText.includes('Confirm your timezone first')");
  assert.equal(await evaluate("document.querySelectorAll('.mini-day').length"), 0);
  await screenshot('today-unassigned-activity-dates');
  fault = {
    match: '/api/v1/dashboard',
    method: 'GET',
    status: 503,
    body: { message: 'Synthetic overview unavailable' },
  };
  await reload();
  await until("document.body.innerText.includes('Recent records unavailable')");
  await screenshot('today-overview-failure');
  fault = null;
  await reload('problems');
  await fill('input[type=search]', 'no-synthetic-problem-matches-this');
  await until("!document.querySelector('.problem-title-button')");
  await screenshot('problems-no-search-match');
  fault = {
    match: '/catalog',
    method: 'GET',
    status: 503,
    body: { message: 'Synthetic catalog request failure' },
  };
  await reload('problems');
  await screenshot('problems-request-failure');
  fault = {
    match: ['/catalog', '/practice/stats'],
    method: 'GET',
    body: {
      totalProblems: 0,
      easy: 0,
      medium: 0,
      hard: 0,
      paidOnly: 0,
      totalTags: 0,
      lastImportedAt: null,
      catalogRevision: 0,
      // Empty catalog and practice summaries must agree; tags also retain their endpoint contract.
      tags: [],
      uniqueSolvedProblems: 0,
      totalManualPractices: 0,
      completedManualPractices: 0,
      uncompletedManualPractices: 0,
      totalSnapshots: 0,
      acceptedSnapshots: 0,
      lastActivityAt: null,
      practiceRevision: 0,
      items: [],
      total: 0,
      page: 1,
      limit: 50,
    },
  };
  await reload('problems');
  await until("document.querySelector('.empty-state')?.innerText.includes('Import your own JSONL')");
  await screenshot('problems-empty-catalog');
  await evaluate("document.querySelector('.empty-state button').click()");
  await until("Boolean(document.getElementById('view-catalog-import') && !document.getElementById('view-catalog-import').hidden)");
  fault = null;
  await reload('statistics');
  await evaluate('window.scrollTo(0,650)');
  await screenshot('statistics-trend-and-distributions');
  await evaluate(
    "[...document.querySelectorAll('.workspace-details')].find(e=>e.textContent.includes('Activity data')).open = true; window.scrollTo(0,1900)",
  );
  await screenshot('statistics-coverage-and-history');
  await click('View full history');
  await until("document.querySelector('[role=dialog] .activity-records')");
  await screenshot('statistics-history-drawer');
  await click('Close');
  await reload('progress-import');
  await fill('textarea', 'Synthetic formatter failure preserves this input.');
  fault = { match: '/progress-imports/format', method: 'POST', status: 503, body: { message: 'Synthetic formatter unavailable' } };
  await click('Organize content');
  await until("document.body.innerText.includes('Synthetic formatter unavailable')");
  assert.equal(await evaluate("document.querySelector('#view-progress-import textarea').value"), 'Synthetic formatter failure preserves this input.');
  await screenshot('progress-formatter-failure-recovery');
  fault = null;
  await click('Enter candidates manually');
  await fill('[aria-label="frontendId 1"]', '9067');
  await fill('[aria-label="lastSubmitted 1"]', '2026-08-14');
  await click('Generate preview');
  await until("document.querySelector('.preview-item')");
  await click('Continue to confirmation');
  fault = { match: '/api/v1/progress-imports', method: 'POST', status: 409, body: { message: 'Preview expired. Generate a fresh preview.' } };
  await click('Confirm import');
  await until("document.querySelector('.candidate-table') && document.body.innerText.includes('Preview expired')");
  assert.equal(await evaluate("document.querySelector('[aria-label=\"frontendId 1\"]').value"), '9067');
  await screenshot('progress-expired-preview-retained-draft');
  fault = null;
  await click('Generate preview');
  await until("document.querySelector('.preview-item')");
  await click('Continue to confirmation');
  await click('Confirm import');
  await until("document.body.innerText.includes('Progress imported')");
  assert.ok(store.getProgressSnapshot('9067'));
  report.flows.push('Mock formatter failure preserves raw input and permits manual candidates; an injected expired-preview rejection retains candidates and fresh preview/commit succeeds.');
  report.flows.push(
    'Additional fixtures distinguish shortage/local fallback, no known records, unresolved timezone, overview failure and unmatched catalog search.',
  );
  await reload();
  // Compare the two surfaces against the same real server projection rather than image heights.
  const sharedProjection = (await app.inject('/api/v1/dashboard')).json();
  const strip = await evaluate("[...document.querySelectorAll('.mini-day')].map(e=>e.title)");
  assert.deepEqual(strip, sharedProjection.trend30Days.slice(-7).map((day: any) => day.date + ': ' + day.completedCount));
  report.flows.push('Today seven-day values exactly equal the Statistics endpoint for the same local dates, including today.');
  await click('Switch language to Chinese');
  await until("document.documentElement.lang === 'zh-CN'");
  await click('切换主题');
  await until("document.documentElement.classList.contains('dark')");
  await reload();
  assert.equal(await evaluate("document.documentElement.lang === 'zh-CN' && document.documentElement.classList.contains('dark')"), true);
  await click('切换语言为英文');
  await click('Adjust today');
  assert.equal(await evaluate("getComputedStyle(document.querySelector('[role=dialog]')).animationName"), 'drawer-enter');
  report.motion.push(await evaluate("document.getAnimations().map(a=>({name:a.animationName, state:a.playState, duration:a.effect.getTiming().duration}))"));
  await delay(350);
  assert.equal(await evaluate("document.getAnimations().filter(a=>a.playState==='running' && a.effect?.target?.closest('[role=dialog]')).length"), 0);
  await click('Close');
  await send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
  });
  assert.equal(
    await evaluate("getComputedStyle(document.querySelector('#view-today')).animationName"),
    'none',
  );
  await click('Adjust today');
  assert.equal(await evaluate("document.getAnimations().filter(a=>a.playState==='running').length"), 0);
  await screenshot('dialog-reduced-motion');
  await click('Close');
  await screenshot('today-reduced-motion');
  report.flows.push(
    'Setup/rest/error/loading fixtures stay distinct; reduced motion disables animation without removing controls.',
  );
  assert.equal(report.errors.length, 0, 'Unexpected browser exception');
  assert.equal(report.consoleMessages.filter((item: any) => item.type === 'error').length, 0, 'Unexpected console error');
  assert.equal(report.externalRequests.length, 0, 'Unexpected external page request');
} catch (error) {
  await writeFile(path.join(out, 'failure-fixture.json'), JSON.stringify({ now: Date.now(), plans: store.planning.plans(), records: store.queryPracticeRecords({ limit: 100 }) }, null, 2));
  report.failure = error instanceof Error ? error.stack : String(error);
  process.exitCode = 1;
  console.error(report.failure);
} finally {
  await writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  socket?.close();
  chrome.kill();
  await app.close();
  db.close();
  console.log(
    JSON.stringify({
      layouts: report.layouts.length,
      overlays: report.overlays.length,
      screenshots: report.screenshots.length,
      flows: report.flows.length,
      errors: report.errors.length,
      externalRequests: report.externalRequests.length,
      failure: Boolean(report.failure),
    }),
  );
}
