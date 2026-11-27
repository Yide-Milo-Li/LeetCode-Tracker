// A native webview has its own keyboard focus. Request the practice toolbar's chat action
// through a navigation the host cancels, without granting the site a native command.
if (['leetcode.com', 'leetcode.cn'].includes(location.hostname)) {
  let lastControl;
  document.addEventListener('focusin', event => {
    if (event.target instanceof HTMLElement && event.target !== document.body) lastControl = event.target;
  });
  window.addEventListener('lct-practice-return', () => {
    if (lastControl?.isConnected) lastControl.focus({ preventScroll: true });
  });
  window.addEventListener('keydown', event => {
    const modifier = /Mac/.test(navigator.platform) ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
    if (!event.isTrusted || event.isComposing || !modifier || event.altKey) return;
    const key = event.key.toLowerCase();
    const action = ({ '=': 'larger', '+': 'larger', '-': 'smaller', '0': 'reset', j: 'ask' })[key];
    if (!action || (key === 'j' && event.shiftKey)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!event.repeat) location.assign('https://lct-shortcut.invalid/' + action);
  }, true);
}
