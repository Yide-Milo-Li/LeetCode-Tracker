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

describe('macOS native profile migration',()=>{
  it('starts, migrates a Windows fixture, renders Settings and persists through reload',async()=>{
    await browser.waitUntil(async()=>{
      const state=await browser.tauri.execute(({core})=>core.invoke('get_desktop_status'));
      return state.state==='ready';
    },{timeout:45000});
    const fixture=JSON.parse(readFileSync(path.join(evidenceDir,'windows-migration.json'),'utf8'));
    await api('POST','/bundle/import',fixture);
    const copied=await api('GET','/bundle/export?version=3');
    assert.deepEqual(copied.tables,fixture.tables);
    await browser.refresh();
    const settings=await browser.$('button[aria-label="设置"]');
    await settings.waitForDisplayed(); await settings.click();
    const view=await browser.$('#view-settings');
    await view.waitForDisplayed();
    assert.match(await view.getText(),/导出完整迁移包/);
    assert.match(await view.getText(),/导入迁移包/);
    await api('PATCH','/settings',{language:'en',theme:'light'});
    await browser.refresh();
    const english=await browser.$('button[aria-label="Settings"]');
    await english.waitForDisplayed();await english.click();
    assert.match(await (await browser.$('#view-settings')).getText(),/Export Complete Migration/);
    mkdirSync(evidenceDir,{recursive:true});
    await browser.saveScreenshot(path.join(evidenceDir,'macos-settings.png'));
    const state=await api('GET','/bundle/export?version=3');
    assert.equal(state.tables.problems.length,fixture.tables.problems.length);
    assert.deepEqual(state.tables.practice_records,fixture.tables.practice_records);
  });
});
