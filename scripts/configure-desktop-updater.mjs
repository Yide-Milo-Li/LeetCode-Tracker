import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const output = '.local/desktop-updater.json';
const isTag = process.env.GITHUB_REF?.startsWith('refs/tags/v');
let config = {};
if (isTag) {
  const repository = process.env.GITHUB_REPOSITORY;
  const pubkey = process.env.LCT_UPDATER_PUBLIC_KEY?.trim();
  if (!repository || !/^[\w.-]+\/[\w.-]+$/.test(repository) || !pubkey) {
    throw new Error('Tagged desktop builds require GITHUB_REPOSITORY and LCT_UPDATER_PUBLIC_KEY.');
  }
  config = {
    bundle: { createUpdaterArtifacts: true },
    plugins: {
      updater: {
        pubkey,
        endpoints: [`https://github.com/${repository}/releases/latest/download/latest.json`],
        windows: { installMode: 'passive' },
      },
    },
  };
}
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify(config));
