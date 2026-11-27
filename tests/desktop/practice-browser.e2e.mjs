/** Opt-in live page smoke test for the isolated desktop E2E application. */
import assert from 'node:assert/strict';

describe('embedded LeetCode practice', () => {
  it('follows native problem history, keeps drafts with their problems, and preserves reading width', async () => {
    await browser.waitUntil(async () => (await browser.execute(() => window.__TAURI_INTERNALS__?.invoke('get_desktop_status')))?.state === 'ready');
    await browser.execute(async () => {
      const core = window.__TAURI_INTERNALS__;
      async function post(path, data) {
        const result = await core.invoke('api_request', { method: 'POST', path: '/api/v1' + path,
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
        if (result.status !== 200) throw new Error('Could not prepare test catalog: ' + result.status);
        return JSON.parse(result.body);
      }
      const problems = [{ id: '1', title: 'Two Sum', difficulty: 'Easy', tags: ['Array'] },
        { id: '2', title: 'Add Two Numbers', difficulty: 'Medium', tags: ['Linked List'] }];
      const preview = await post('/imports/preview', { content: problems.map(problem => JSON.stringify(problem)).join('\n') });
      await post('/imports', { previewId: preview.previewId });
    });
    await browser.execute(() => { location.hash = '#problems'; });
    await browser.waitUntil(() => browser.execute(() => !!document.querySelector('a[data-practice-id="1"]')));
    for (const width of [1280, 1600]) {
      await browser.setWindowSize(width, 800);
      // The embedded driver's window lookup only supports single-webview windows. Start the
      // sequence in the main renderer and return its results after the native child closes.
      const result = await browser.executeAsync(async (done) => {
        const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
        async function until(read) {
          const start = Date.now();
          while (Date.now() - start < 18000) {
            const value = await read();
            if (value) return value;
            await sleep(80);
          }
          throw new Error('Timed out waiting for ' + String(read).slice(0, 140));
        }
        let result;
        try {
          const link = document.querySelector('a[data-practice-id="1"]');
          link.click();
          const dialog = await until(() => document.querySelector('dialog.practice-workspace[open]'));
          const page = dialog.querySelector('.practice-page');
          const getPage = () => window.__TAURI__.webview.Webview.getByLabel('practice-page');
          const child = await until(getPage);
          const chrome = dialog.querySelector('header');
          const toggle = chrome.querySelector('[data-practice-chat-toggle]');
          const onProblem = await until(async () => (await window.__TAURI__.core.invoke('practice_location')) === link.href);
          const nativeWindow = window.__TAURI__.window.getCurrentWindow();
          async function toolbarClear() {
            const [host, size, position] = await Promise.all([nativeWindow.innerSize(), child.size(), child.position()]);
            const scale = host.width / window.innerWidth;
            const toolbar = chrome.getBoundingClientRect();
            const slot = page.getBoundingClientRect();
            // Native coordinates may include the title bar above the renderer's CSS viewport.
            const toolbarBottom = host.height - (window.innerHeight - toolbar.bottom) * scale;
            const controlsFit = [...chrome.children].every(control => {
              const box = control.getBoundingClientRect();
              return box.left >= 0 && box.right <= window.innerWidth && box.top >= 0 && box.bottom <= toolbar.bottom;
            });
            return controlsFit && Math.abs(position.y - toolbarBottom) <= scale
              && Math.abs(size.width - slot.width * scale) <= scale
              && Math.abs(position.y + size.height - host.height) <= scale;
          }
          await until(toolbarClear);
          if (window.innerWidth === 1280) {
            const resize = async width => {
              await nativeWindow.setSize(new window.__TAURI__.dpi.LogicalSize(width, 700));
              await until(() => window.innerWidth === width);
              await until(toolbarClear);
            };
            await resize(1024);
            await resize(1330);
            await nativeWindow.setFullscreen(true);
            await until(() => nativeWindow.isFullscreen());
            await until(toolbarClear);
            await nativeWindow.setFullscreen(false);
            await until(async () => !(await nativeWindow.isFullscreen()));
            await resize(1280);
          }
          const before = await child.size();
          toggle.click();
          await until(() => dialog.querySelector('.chat-panel'));
          const wide = window.innerWidth >= 1500;
          if (wide) {
            await until(async () => (await child.size()).width < before.width);
            await until(toolbarClear);
            const divider = dialog.querySelector('[role="separator"]');
            const key = value => divider.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true }));
            key('Enter');
            await until(toolbarClear);
            const start = page.getBoundingClientRect().width;
            key('ArrowLeft');
            await until(() => page.getBoundingClientRect().width < start - 10);
            await until(toolbarClear);
            key('Enter');
            await until(() => page.getBoundingClientRect().width === start);
            await until(toolbarClear);
          } else await until(() => page.getBoundingClientRect().width === 0);
          const chatWidth = dialog.querySelector('.chat-panel').getBoundingClientRect().width;
          const siteWidth = page.getBoundingClientRect().width;
          chrome.querySelector('[role="tab"][id$="-note"]').click();
          const noteField = () => dialog.querySelector('.practice-note-slot:not([hidden]) textarea:not(:disabled)');
          const edit = (field, value) => {
            Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(field, value);
            field.dispatchEvent(new Event('input', { bubbles: true }));
          };
          const firstNote = await until(noteField);
          const initialText = firstNote.value;
          const editor = firstNote.closest('.practice-note-editor');
          edit(firstNote, '');
          (await until(() => editor.querySelector('.nw-editor-empty-template'))).click();
          await until(() => firstNote.value.includes('##'));
          edit(firstNote, 'Complement');
          firstNote.setSelectionRange(0, firstNote.value.length);
          editor.querySelector('button[aria-label="Bold"]').click();
          await until(() => firstNote.value === '**Complement**');
          const views = editor.querySelectorAll('.nw-view-btn');
          views[1].click();
          await until(() => editor.querySelector('.notes-preview-pane strong')?.textContent === 'Complement');
          const source = firstNote.getBoundingClientRect();
          const preview = editor.querySelector('.notes-preview-pane').getBoundingClientRect();
          if (wide ? preview.top < source.bottom : preview.left < source.right) {
            throw new Error('Preview does not fit the available panel width');
          }
          views[0].click();
          editor.querySelector('.nw-ai-btn').click();
          const review = await until(() => dialog.querySelector('[data-overlay-host] [role="dialog"]'));
          await until(() => page.getBoundingClientRect().width === 0);
          if (review.closest('[inert]')) throw new Error('The format review cannot receive input');
          review.querySelector('.overlay-header button').click();
          await until(() => !dialog.querySelector('[data-overlay-host]'));
          if (wide) await until(toolbarClear);
          const draft = initialText + '\nCheck the complement.';
          edit(firstNote, draft);
          const title = chrome.querySelector('.practice-title');
          const move = back => window.__TAURI__.core.invoke('practice_test_history', { back });
          await move(false);
          await until(() => title.textContent.includes('#2 Add Two Numbers'));
          const secondNote = await until(noteField);
          if (secondNote.value === draft) throw new Error('Draft appeared on the wrong problem');
          const saved = secondNote.value.trimEnd() === 'Carry the one.' ? 'Check the last carry.\n' : 'Carry the one.\n';
          edit(secondNote, saved);
          (await until(() => secondNote.closest('.practice-note-editor').querySelector('footer button:not(:disabled)'))).click();
          await until(async () => {
            const response = await window.__TAURI__.core.invoke('api_request', {
              method: 'GET', path: '/api/v1/notes/2', headers: {}, body: null,
            });
            return JSON.parse(response.body).note?.content === saved;
          });
          await move(true);
          await until(() => title.textContent.includes('#1 Two Sum'));
          if ((await until(noteField)).value !== draft) throw new Error('Back lost the first draft');
          edit(noteField(), initialText);
          if (!wide) {
            const pin = chrome.querySelector('button[aria-pressed]');
            pin.click();
            await until(toolbarClear);
            pin.click();
            await until(() => page.getBoundingClientRect().width === 0);
          }
          chrome.querySelector('[role="tab"][id$="-chat"]').click();
          await until(() => dialog.querySelector('.chat-panel'));
          const options = chrome.querySelector('button[aria-controls$="-options"]');
          options.click();
          const zoom = await until(() => chrome.querySelector('select'));
          zoom.value = '150';
          zoom.dispatchEvent(new Event('change', { bubbles: true }));
          await until(() => page.getBoundingClientRect().width === 0);
          zoom.value = '100';
          zoom.dispatchEvent(new Event('change', { bubbles: true }));
          if (wide) await until(toolbarClear);
          options.click();
          if (wide) await until(toolbarClear);
          dialog.querySelector('.chat-panel').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          await until(() => !dialog.querySelector('.chat-panel'));
          await until(async () => (await child.size()).width === before.width);
          result = { wide, onProblem, chatWidth, siteWidth, fullWidth: page.getBoundingClientRect().width, viewport: window.innerWidth };
        } catch (error) { result = { error: String(error) }; }
        finally {
          document.querySelector('.practice-toolbar button')?.click();
          await sleep(350);
          document.querySelector('.practice-note-conflict button.text-link')?.click();
          if (document.querySelector('dialog.practice-workspace[open]')) {
            await window.__TAURI__.core.invoke('practice_close');
          }
        }
        done(result);
      });
      assert.ok(!result.error, result.error);
      assert.equal(result.onProblem, true);
      assert.equal(result.wide, width >= 1500);
      assert.equal(result.fullWidth, result.viewport);
      if (result.wide) assert.ok(result.siteWidth >= 1100 && result.chatWidth >= 390);
      else assert.ok(result.siteWidth === 0 && result.chatWidth >= 600);
      console.log('Practice layout', result);
    }
  });
});
