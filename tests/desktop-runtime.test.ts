/** Runtime target decisions are explicit: no Intel Mac or Linux fallback to Windows binaries. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runtimeTarget, RUNTIMES } from '../scripts/prepare-desktop-runtime.ts';

test('selects only the supported native platform and architecture pairs', () => {
  assert.equal(runtimeTarget(undefined,'darwin','arm64'),'aarch64-apple-darwin');
  assert.equal(runtimeTarget(undefined,'win32','x64'),'x86_64-pc-windows-msvc');
  for(const [platform,arch] of [['darwin','x64'],['linux','x64'],['win32','arm64']]) {
    assert.throws(()=>runtimeTarget(undefined,platform,arch),/Unsupported/);
  }
  assert.throws(()=>runtimeTarget('universal-apple-darwin'),/Unsupported/);
  assert.equal(runtimeTarget('aarch64-apple-darwin','win32','x64'),'aarch64-apple-darwin');
  for(const target of Object.values(RUNTIMES)) assert.match(target.sha256,/^[a-f0-9]{64}$/);
});
