/** Embedded driver runs only against the dedicated, isolated test application bundle. */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const explicitPath = process.env.TAURI_APP_PATH ? path.resolve(process.env.TAURI_APP_PATH) : undefined;
const candidates = [
  explicitPath,
  path.join(root, 'apps/desktop/src-tauri/target/aarch64-apple-darwin/release/bundle/macos/LeetCode Tracker.app/Contents/MacOS/leetcode-tracker-desktop'),
  path.join(root, 'apps/desktop/src-tauri/target/release/bundle/macos/LeetCode Tracker.app/Contents/MacOS/leetcode-tracker-desktop'),
].filter(Boolean);
const appBinaryPath = candidates.find(candidate => fs.existsSync(candidate)) ?? candidates[0];
export const config={
  runner:'local', specs:['./native.e2e.mjs'], maxInstances:1,
  services:[['@wdio/tauri-service',{appBinaryPath,driverProvider:'embedded'}]],
  capabilities:[{browserName:'tauri','tauri:options':{application:appBinaryPath}}],
  framework:'mocha', reporters:['spec'], logLevel:'warn',
  waitforTimeout:30000, connectionRetryTimeout:120000, connectionRetryCount:1,
  mochaOpts:{ui:'bdd',timeout:120000},
};
