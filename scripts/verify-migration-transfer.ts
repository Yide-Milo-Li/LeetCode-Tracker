/** Export/restore only synthetic transfer fixtures, for OS-to-OS CI evidence. */
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';
import { CatalogStore } from '../packages/database/src/store.ts';
import { seedMigrationProfile } from '../tests/fixtures/migration-profile.ts';

/** A fresh profile is essential: preseeded catalogs can conceal missing migration data. */
async function verify(): Promise<void> {
  const [mode, input, output] = process.argv.slice(2);
  if (!['export','restore'].includes(mode) || !input || (mode === 'restore' && !output)) throw new Error('Usage: export OUTPUT | restore INPUT OUTPUT');
  const dir=mkdtempSync(join(tmpdir(),'migration-transfer-'));
  const db=new DatabaseSync(join(dir,'synthetic.sqlite'));
  try {
    const store=new CatalogStore(db,{backupDir:join(dir,'backups'),skipBackup:true});
    if(mode==='export') await seedMigrationProfile(store);
    else {
      const source=JSON.parse(readFileSync(input,'utf8'));
      await store.importSnapshotBundle(source);
      assert.deepEqual(store.exportMigrationBundle().tables,source.tables);
    }
    const bundle=store.exportMigrationBundle();
    const destination=mode==='export'?input:output;
    mkdirSync(dirname(destination),{recursive:true});
    writeFileSync(destination,JSON.stringify(bundle));
    console.log(JSON.stringify({platform:process.platform,arch:process.arch,mode,tables:Object.keys(bundle.tables).length,problems:bundle.tables.problems.length}));
  } finally {db.close();rmSync(dir,{recursive:true,force:true});}
}
await verify();
