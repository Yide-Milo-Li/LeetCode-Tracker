import process from 'node:process';

const repository = process.env.GITHUB_REPOSITORY;
if (!repository || !/^[\w.-]+\/[\w.-]+$/.test(repository)) {
  throw new Error('Set GITHUB_REPOSITORY to the release repository.');
}
const apply = process.argv.includes('--apply');
if (apply && !process.env.GITHUB_TOKEN) throw new Error('A repository token is required to remove attachments.');

const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
const base = `https://api.github.com/repos/${repository}`;

async function request(path, options = {}) {
  const response = await fetch(base + path, { headers, ...options });
  if (options.method === 'DELETE' && response.status === 404) return response;
  if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status} for ${path}`);
  return response;
}

async function latestRelease() {
  return (await request('/releases/latest')).json();
}

function installerNames(tag) {
  const version = tag.replace(/^v/, '');
  return ['LeetCode-Tracker', 'LeetCode.Tracker', 'LeetCode Tracker'].flatMap(prefix => [
    `${prefix}_${version}_x64-setup.exe`,
    `${prefix}_${version}_aarch64.dmg`,
  ]);
}

const latest = await latestRelease();
if (latest.draft || latest.prerelease) throw new Error('Expected a published stable release.');
const installers = latest.assets.filter(asset => installerNames(latest.tag_name).includes(asset.name));
const manifest = latest.assets.find(asset => asset.name === 'SHA256SUMS.txt');
if (!manifest || !installers.some(a => a.name.endsWith('.exe')) || !installers.some(a => a.name.endsWith('.dmg'))) {
  throw new Error(`Keep all downloads until ${latest.tag_name} has both installers and SHA256SUMS.txt.`);
}
const checksumResponse = await request(`/releases/assets/${manifest.id}`, {
  headers: { ...headers, Accept: 'application/octet-stream' },
});
const checksums = (await checksumResponse.text()).trim().split(/\r?\n/);
for (const asset of installers) {
  const hash = asset.digest?.match(/^sha256:([0-9a-f]{64})$/)?.[1];
  if (!hash || !checksums.some(line => {
    const match = /^([0-9a-f]{64})\s+\*?(.+)$/.exec(line);
    return match?.[1] === hash && match[2] === asset.name;
  })) throw new Error(`Missing or mismatched checksum for ${asset.name}`);
}

console.log(`Keeping ${latest.tag_name} with verified Windows and macOS download checksums.`);
let count = 0;
for (let page = 1; ; page++) {
  const releases = await (await request(`/releases?per_page=100&page=${page}`)).json();
  for (const release of releases) {
    if (release.id === latest.id || release.draft || release.published_at >= latest.published_at) continue;
    const names = new Set([...installerNames(release.tag_name), 'SHA256SUMS.txt']);
    const old = release.assets.filter(asset => names.has(asset.name));
    if (old.length && apply && (await latestRelease()).id !== latest.id) throw new Error('Latest release changed. Re-run the workflow.');
    for (const asset of old) {
      if (apply) await request(`/releases/assets/${asset.id}`, { method: 'DELETE' });
      console.log(`${apply ? 'Removed' : 'Would remove'} ${release.tag_name}/${asset.name}`);
      count++;
    }
  }
  if (releases.length < 100) break;
}
console.log(`${count} old attachments ${apply ? 'removed' : 'eligible for removal'}.`);
