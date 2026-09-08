import { readdir, readFile, access } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

async function findMarkdownFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(entry => {
      const full = `${dir}/${entry.name}`;
      return entry.isDirectory() ? findMarkdownFiles(full) : Promise.resolve(full.endsWith('.md') ? [full] : []);
    }),
  );
  return files.flat();
}

const docsToCheck = [
  'README.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'CODE_OF_CONDUCT.md',
  'CHANGELOG.md',
  'apps/README.md',
  'packages/README.md',
  'scripts/README.md',
  'tests/README.md',
  ...(await findMarkdownFiles('docs')),
];

let errors = 0;
for (const path of docsToCheck) {
  const content = await readFile(path, 'utf8');
  if (!content.startsWith('# ')) {
    console.error(`Document missing top-level title (# ): ${path}`);
    errors++;
  }

  for (const match of content.matchAll(/\[.*?\]\(([^)]+)\)/g)) {
    const target = match[1].split('#')[0];
    if (target && !/^[a-z]+:/i.test(target) && !target.startsWith('mailto:')) {
      try {
        await access(resolve(dirname(path), target));
      } catch {
        console.error(`Broken link in ${path}: ${target}`);
        errors++;
      }
    }
  }
}

if (errors > 0) {
  process.exit(1);
}

console.log(`Checked ${docsToCheck.length} Markdown documents and all local file links.`);

