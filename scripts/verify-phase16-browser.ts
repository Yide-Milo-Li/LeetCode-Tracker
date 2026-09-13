/** Phase 16 desktop acceptance against an isolated synthetic SQLite store and mocked Gemini.
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
  : path.resolve(root, '.local/evidence/phase16/browser');
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
const fixtures = Array.from({ length: 40 }, (_, i) => ({
  id: String(i + 1), questionId: String(i + 1), title: 'Synthetic topic problem ' + (i + 1),
  difficulty: 'Medium', tags: [i < 20 ? 'Dynamic Programming' : 'Tree', 'topic-' + i % 12,
    ...(i===39?['A deliberately long topic label for desktop wrapping and keyboard reading — 桌面长标签换行与键盘阅读验收']:[])],
}));
await store.importJsonl(fixtures.map(p => JSON.stringify(p)).join('\n'));
await store.updateSettings({ timezone: 'UTC', language: 'en', theme: 'light' });
const today = new Date().toISOString().slice(0, 10);
db.prepare("UPDATE catalog_meta SET value='0' WHERE key='review_baseline'").run();
for (let i = 1; i <= 3; i++) {
  await store.createPracticeRecord({ questionFrontendId: String(i), completed: true,
    practicedAt: new Date(Date.now() - i * 86400000).toISOString(), durationMinutes: 50,
    notes: 'Synthetic local note.', sourceTimezone: 'UTC' });
}
// This fourth problem reaches stage two before a long due success: seven days becomes three.
for (const questionFrontendId of ['4','5']) for (const daysAgo of [15,14,11,4]) {
  await store.createPracticeRecord({ questionFrontendId,completed:true,
    practicedAt:new Date(Date.now()-daysAgo*86400000).toISOString(),
    durationMinutes:daysAgo===4?50:null,sourceTimezone:'UTC' });
}
await store.planning.saveStrategy({ name: 'Synthetic focus', weekdays: [0,1,2,3,4,5,6],
  rules: { dailyCount: 3, difficulty: { Easy: 0, Medium: 100, Hard: 0 }, tags: [], premium: false,
    reviewEnabled: false, reviewPercent: null, preference: '', focusWeakTags: true } });
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
  await click('Focus Session');
  await until("document.body.innerText.includes('Earlier-due reviews')");
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  assert.equal(await evaluate("document.activeElement?.getAttribute('aria-label')"), 'Focus Session');
  report.flows.push('Saved focus explanation opens and Escape restores keyboard focus.');
  const saved = JSON.stringify(store.planning.plans());
  for (const [width,height] of [[1280,800],[1440,900],[1920,1080]]) {
    for (const language of ['en','zh'] as const) for (const theme of ['light','dark'] as const) {
      await store.updateSettings({ language, theme });
      await send('Emulation.setDeviceMetricsOverride', {width,height,deviceScaleFactor:1,mobile:false});
      await reload('statistics');
      await until("document.querySelectorAll('.topic-insight-row').length === 10");
      await evaluate("document.querySelector('.topic-insights').scrollIntoView({block:'start'})");
      const layout = await evaluate("({scroll:document.documentElement.scrollWidth,width:innerWidth,theme:document.documentElement.getAttribute('data-theme')})");
      assert.ok(layout.scroll <= width + 1, 'Desktop horizontal overflow');
      report.layouts.push({width,height,language,theme,...layout});
      await screenshot(`insights-${width}-${language}-${theme}`);
      await click(language === 'en' ? 'Create topic strategy' : '创建专题策略');
      await until("document.querySelector('[role=dialog] input[type=checkbox]')");
      const flags = await evaluate("[...document.querySelectorAll('[role=dialog] input[type=checkbox]')].map(e=>({label:e.parentElement.textContent,checked:e.checked,disabled:e.disabled}))");
      assert.equal(flags.filter((f: any) => f.checked).length, 1, 'Only focus is preselected');
      assert.equal(await evaluate("document.querySelector('[role=dialog] input[type=text]').value"), '');
      await screenshot(`strategy-${width}-${language}-${theme}`);
      await click(language === 'en' ? 'Close' : '关闭');
    }
  }
  assert.equal(JSON.stringify(store.planning.plans()), saved, 'Reading insights and opening drafts must not mutate saved plans');
  report.flows.push('Twelve desktop/language/theme combinations render insights and an unsaved focus draft without changing saved plans.');
  /** Fill an actual labelled control without depending on generated React element IDs. */
  const fillLabel = async (label: string, value: string) => {
    const selector = await evaluate(`(() => {const labels=[...document.querySelectorAll('[role=dialog] label')];
      const label=labels.find(e=>e.textContent.trim().startsWith(${JSON.stringify(label)}));
      const input=label?.querySelector('input,select') ?? document.querySelector('[aria-label='+JSON.stringify(${JSON.stringify(label)})+']');
      if(!input)throw new Error('Missing label '+${JSON.stringify(label)});input.setAttribute('data-verification-input','current');return '[data-verification-input=current]';})()`);
    await fill(selector,value);
    await evaluate("document.querySelector('[data-verification-input=current]').removeAttribute('data-verification-input')");
  };
  for (const language of ['en','zh'] as const) {
    const zh=language==='zh';
    await store.updateSettings({language,theme:zh?'dark':'light'});
    await reload('statistics');
    await until("document.querySelector('.topic-insights')");
    await click(zh?'创建专题策略':'Create topic strategy');
    await until("document.querySelector('[role=dialog] input[type=text]')");
    await fill('[role=dialog] input[type=text]','Browser draft '+language);
    await fill(`[aria-label="${zh?'每日题量':'Daily Question Count'}"]`,'3');
    await fill(`[aria-label="${zh?'简单题数':'Easy count'}"]`,'0');
    await fill(`[aria-label="${zh?'中等题数':'Medium count'}"]`,'3');
    await click(zh?'全部复习':'All review','label');
    await click(zh?'启用基于用时的自适应复习':'Use duration-based adaptive review','label');
    await click(zh?'仅新题训练（不复习）':'New Problems Only (No Review)','label');
    assert.ok(await evaluate("!document.querySelector('.review-sub-options')"));
    await click(zh?'保存策略':'Save Strategy');
    await until("!document.querySelector('[role=dialog]')");
    assert.ok(store.planning.strategies().some(s=>s.name==='Browser draft '+language&&s.weekdays.length===0&&s.rules.focusWeakTags));
    await reload('today');
    const version=store.planning.planByDate(today)!.version;
    await click(zh?'换一题':'Replace');
    for(let n=0;n<50&&store.planning.planByDate(today)!.version===version;n++)await delay(100);
    assert.ok(store.planning.planByDate(today)!.version>version);
    await click(zh?'调整今天':'Adjust today');
    await click(zh?'手动校对规则':'Edit rules manually','summary');
    await fillLabel(zh?'每日题数':'Daily count','1');
    await fillLabel(zh?'复习模式':'Review mode','true');
    await fillLabel(zh?'复习占比 %':'Review share %','100');
    await fillLabel(zh?'标签（逗号分隔，空白不限）':'Tags (comma separated; empty means any)',zh?'topic-4':'topic-3');
    await fillLabel(zh?'启用基于用时的自适应复习':'Use duration-based adaptive review','true');
    await fillLabel(zh?'优先巩固专题':'Focus on practice topics','false');
    await click(zh?'预览校对后的规则':'Preview edited rules');
    await until("document.querySelector('.override-preview-card')");
    await screenshot('override-'+language);
    await click(zh?'确认应用到今日未完成题目':'Apply to Unfinished Slots');
    await until("!document.querySelector('[role=dialog]')");
    const applied=store.planning.planByDate(today)!;
    assert.equal(applied.rules.adaptiveReviewEnabled,true);
    assert.equal(applied.rules.focusWeakTags,false);
    assert.ok(applied.items.some(i=>i.explanation?.review?.baseIntervalDays===7&&i.explanation.review.intervalDays===3));
    {
      await click(zh?'自适应复习':'Adaptive Review');
      await screenshot('adaptive-explanation-'+language);
      await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
    }
    // Return to new-only for the second language; versions and exclusions remain intact.
    await click(zh?'调整今天':'Adjust today');
    await click(zh?'手动校对规则':'Edit rules manually','summary');
    await fillLabel(zh?'每日题数':'Daily count','3');
    await fillLabel(zh?'复习模式':'Review mode','false');
    await fillLabel(zh?'标签（逗号分隔，空白不限）':'Tags (comma separated; empty means any)','');
    await fillLabel(zh?'优先巩固专题':'Focus on practice topics','true');
    await click(zh?'预览校对后的规则':'Preview edited rules');
    await click(zh?'确认应用到今日未完成题目':'Apply to Unfinished Slots');
    await until("!document.querySelector('[role=dialog]')");
    report.flows.push(language+': saved unassigned focus strategy, independent switches, single replacement and explicit adaptive override through real UI.');
  }
  await store.updateSettings({ language:'en',theme:'light' });
  await reload('today');
  const practiceRevision=store.getPracticeRevision();
  await evaluate("document.querySelector('.completion-circle[aria-pressed=false]').focus()");
  await send('Input.dispatchKeyEvent',{type:'keyDown',key:' ',code:'Space',windowsVirtualKeyCode:32});
  await send('Input.dispatchKeyEvent',{type:'keyUp',key:' ',code:'Space',windowsVirtualKeyCode:32});
  await until("document.querySelector('[role=dialog]')");
  await fill('[role=dialog] input[type=number]','90');
  await click('Save details');
  await until("!document.querySelector('[role=dialog]')");
  assert.equal(store.getPracticeRevision(),practiceRevision+2);
  await navigate('statistics');
  await until("document.querySelector('.topic-insights')");
  await until("[...document.querySelectorAll('.topic-insight-row')].some(e=>e.querySelector('strong').textContent==='Dynamic Programming'&&e.querySelector('dd').textContent==='6/20')");
  await screenshot('after-practice-edit');
  await navigate('today');
  await evaluate("document.querySelector('.completion-circle[aria-pressed=true]').click()");
  await until("document.querySelector('.record-detail')");
  const analysisRequests=report.apiRequests.filter(url=>url.includes('/mastery')).length;
  await click('Revoke this record');
  await click('Confirm revoke');
  await until("document.querySelector('.record-detail').innerText.includes('Revoked')");
  await click('Close');
  await navigate('statistics');
  await until("document.querySelector('.topic-insights')");
  await until("[...document.querySelectorAll('.topic-insight-row')].some(e=>e.querySelector('strong').textContent==='Dynamic Programming'&&e.querySelector('dd').textContent==='5/20')");
  assert.equal(store.getPracticeRevision(),practiceRevision+3);
  assert.ok(report.apiRequests.filter(url=>url.includes('/mastery')).length>analysisRequests);
  report.flows.push('Keyboard completion, duration edit and revocation refresh visible topic analysis.');
  await reload('statistics');
  await until("document.querySelectorAll('.topic-insight-row').length === 10");
  await evaluate("document.querySelector('.topic-insights').scrollIntoView()");
  await click('Show all topics');
  assert.ok(await evaluate("document.querySelectorAll('.topic-insight-row').length > 10"));
  await click('Show fewer topics');
  fault={match:'/mastery',status:503,body:{message:'Synthetic unavailable'}};
  await reload('statistics');
  await until("document.body.innerText.includes('Topic insights could not be loaded.')");
  await screenshot('insights-error');
  fault=null;
  await click('Retry');
  await until("document.querySelector('.topic-insights')");
  report.flows.push('Insight expansion and independent request failure/retry recover in the real browser.');
  // CSS zoom exercises reflow of the actual desktop layout at doubled text/control scale.
  await send('Emulation.setDeviceMetricsOverride',{width:1280,height:800,deviceScaleFactor:1,mobile:false});
  await evaluate("document.documentElement.style.zoom='2'");
  await evaluate("document.querySelector('.topic-insights').scrollIntoView()");
  await screenshot('insights-200-percent');
  const zoomLayout=await evaluate("({scroll:document.documentElement.scrollWidth,width:document.documentElement.clientWidth})");
  assert.ok(zoomLayout.scroll <= zoomLayout.width + 1, '200 percent zoom horizontal overflow');
  report.layouts.push({zoom:2,...zoomLayout});
  assert.equal(report.errors.length,0);
  assert.equal(report.consoleMessages.filter((m:any)=>m.type==='error' && !m.args.some((a:any)=>String(a).includes('503'))).length,0);
  assert.equal(report.externalRequests.length,0);
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
