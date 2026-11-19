/** Real WKWebView + Rust IPC + sidecar; synthetic data only, with no mocked business transport. */
import assert from 'node:assert/strict';
import {readFileSync,mkdirSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const evidenceDir=path.join(root,'.local/evidence/phase21');

/** Send a real authenticated request through the same native command as the UI. */
async function api(method,path,body) {
  const response=await browser.tauri.execute(async ({core},args)=>core.invoke('api_request',args),
    {method,path:`/api/v1${path}`,headers:{'Content-Type':'application/json'},body:body===undefined?null:JSON.stringify(body)});
  assert.equal(response.status,200,response.body);
  return JSON.parse(response.body);
}

/** Navigate via the sidebar button and confirm both the hash route and view container are active. */
async function navigateTo(ariaLabel, expectedHash, viewSelector) {
  const navButton = await browser.$(`button[aria-label="${ariaLabel}"]`);
  await navButton.waitForDisplayed();
  await navButton.click();
  const view = await browser.$(viewSelector);
  await view.waitForDisplayed();
  await browser.waitUntil(async () => (await browser.execute(() => window.location.hash)) === expectedHash);
  return view;
}

/** Select the Settings Data tab, which holds the migration export/import controls. */
async function openDataTab() {
  const tab = await browser.$('#settings-tab-data');
  await tab.waitForDisplayed();
  await tab.click();
  await (await browser.$('#settings-panel-data')).waitForDisplayed();
}

/** Verify no visible error alert banner rendered inside the given view. */
async function assertNoViewErrors(view) {
  const alerts = await view.$$('[role="alert"], .feedback.error');
  assert.equal(alerts.length, 0, 'Expected no error alerts in active view');
}

describe('macOS native profile migration',()=>{
  it('starts, migrates a Windows fixture, renders Settings and persists through reload',async()=>{
    await browser.waitUntil(async()=>{
      const state=await browser.tauri.execute(({core})=>core.invoke('get_desktop_status'));
      return state.state==='ready';
    },{timeout:45000});
    const fixture=JSON.parse(readFileSync(path.join(evidenceDir,'windows-migration.json'),'utf8'));
    await api('POST','/bundle/import',fixture);
    const copied=await api('GET','/bundle/export?version=5');
    assert.deepEqual(copied.tables,fixture.tables);
    await browser.refresh();
    const settings=await browser.$('button[aria-label="设置"]');
    await settings.waitForDisplayed(); await settings.click();
    const view=await browser.$('#view-settings');
    await view.waitForDisplayed();
    // Settings is tabbed; migration controls live on the Data tab.
    await openDataTab();
    assert.match(await view.getText(),/导出迁移包/);
    assert.match(await view.getText(),/导入迁移包/);
    await api('PATCH','/settings',{language:'en',theme:'light'});
    await browser.refresh();
    const english=await browser.$('button[aria-label="Settings"]');
    await english.waitForDisplayed();await english.click();
    await openDataTab();
    assert.match(await (await browser.$('#view-settings')).getText(),/Export migration file/);
    mkdirSync(evidenceDir,{recursive:true});
    await browser.saveScreenshot(path.join(evidenceDir,'macos-settings.png'));
    const state=await api('GET','/bundle/export?version=5');
    assert.equal(state.tables.problems.length,fixture.tables.problems.length);
    assert.deepEqual(state.tables.practice_records,fixture.tables.practice_records);
  });

  it('verifies the knowledge profile API and Today, Problems, Statistics, and Notes views', async () => {
    const profile = await api('GET', '/knowledge-profile');
    assert.equal(profile.analysisVersion, 'profile-v1');
    assert.equal(profile.windowDays, 30);
    assert.ok(Array.isArray(profile.topics), 'knowledge-profile topics should be an array');
    assert.ok(profile.topics.some((topic) => topic.tagSlug === 'array'));

    const todayView = await navigateTo('Today', '#today', '#view-today');
    const todayProblem = await todayView.$('.today-problems .today-problem');
    await todayProblem.waitForDisplayed();
    const progressBar = await todayView.$('.target-meter[role="progressbar"]');
    await progressBar.waitForDisplayed();
    assert.equal(await progressBar.getAttribute('aria-label'), 'Today completion progress');
    assert.ok((await progressBar.$$('.target-meter-seg')).length >= 1);
    const rhythmSummary = await todayView.$('.rhythm-summary');
    await rhythmSummary.waitForDisplayed();
    assert.match(await rhythmSummary.getText(), /Records on \d+ of 7 days/);
    assert.equal((await todayView.$$('.rhythm-chart-wrap .rhythm-day-col')).length, 7);
    const todayTitleLink = await todayProblem.$('a.problem-title-link');
    await todayTitleLink.waitForDisplayed();
    assert.match(await todayTitleLink.getText(), /Synthetic 数组/);
    assert.equal(await todayTitleLink.getAttribute('href'), 'https://leetcode.com/problems/synthetic/');
    assert.equal(await todayTitleLink.getAttribute('target'), '_blank');

    const todayTimerBtn = await todayProblem.$('button[aria-label^="Start timer:"]');
    await todayTimerBtn.waitForDisplayed();
    await todayTimerBtn.click();
    const timerPill = await browser.$('section.practice-timer-pill');
    await timerPill.waitForDisplayed();
    assert.match(await timerPill.getText(), /Synthetic 数组/);
    const discardTimerBtn = await timerPill.$('button[aria-label="Discard timer"]');
    await discardTimerBtn.waitForDisplayed();
    await discardTimerBtn.click();
    await timerPill.waitForExist({ reverse: true });
    await assertNoViewErrors(todayView);

    const problemsView = await navigateTo('Problems', '#problems', '#view-problems');
    const catalogRow = await problemsView.$('table.problem-table tbody tr');
    await catalogRow.waitForDisplayed();
    assert.match(await catalogRow.getText(), /Synthetic 数组/);
    const catalogTimerBtn = await catalogRow.$('button[aria-label^="Start timer:"]');
    await catalogTimerBtn.waitForDisplayed();
    assert.match(await catalogTimerBtn.getAttribute('aria-label'), /Synthetic 数组/);
    const catalogExtLink = await catalogRow.$('a[href="https://leetcode.com/problems/synthetic/"]');
    await catalogExtLink.waitForDisplayed();
    await assertNoViewErrors(problemsView);

    const statisticsView = await navigateTo('Progress', '#statistics', '#view-statistics');
    await (await statisticsView.$('.dashboard-view-container')).waitForDisplayed();
    await (await statisticsView.$('.heatmap-card')).waitForDisplayed();
    // The 30-day trend renders only with recent activity; otherwise the heatmap shows a quiet note.
    await browser.waitUntil(async () =>
      (await statisticsView.$('.progress-insights-grid section.trend-card').isDisplayed()) ||
      (await statisticsView.$('.heatmap-quiet').isDisplayed()));
    const masteryCard = await statisticsView.$('.progress-insights-grid section.distribution-card.mastery-card');
    await masteryCard.waitForDisplayed();
    assert.match(await masteryCard.getText(), /Mastery/);
    await browser.waitUntil(async () => (await masteryCard.$$('.mastery-row-track[role="meter"]')).length === 3);
    await (await statisticsView.$('.progress-insights-grid section.focus-topics-card')).waitForDisplayed();
    const topicInsights = await statisticsView.$('.topic-insights');
    await topicInsights.waitForDisplayed();
    await (await topicInsights.$('table.topic-table')).waitForDisplayed();
    assert.match(await topicInsights.getText(), /Array/);
    await assertNoViewErrors(statisticsView);

    const notesView = await navigateTo('Notes', '#notes', '#view-notes');
    await (await notesView.$('.notes-workspace-view')).waitForDisplayed();
    const noteCard = await notesView.$('.notes-problem-card');
    await noteCard.waitForDisplayed();
    assert.match(await noteCard.getText(), /Synthetic 数组/);
    const noteTextarea = await notesView.$('.notes-detail-pane textarea');
    await noteTextarea.waitForDisplayed();
    await browser.waitUntil(async () => /Synthetic note/.test(await noteTextarea.getValue()));
    await assertNoViewErrors(notesView);
  });
});
