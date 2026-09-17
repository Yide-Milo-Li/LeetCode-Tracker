/** Synthetic cross-platform migration fixture; never reads a user profile. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {CatalogStore} from '../../packages/database/src/store.ts';
import {buildApp} from '../../apps/server/src/app.ts';

/** Populate each migration table, including history and replay records that v1 omitted. */
export async function seedMigrationProfile(store: CatalogStore) {
  await store.importJsonl(JSON.stringify({id:'1', title:'Synthetic 数组', difficulty:'Easy', tags:['Array']}));
  await store.updateSettings({timezone:'UTC', language:'zh', theme:'dark', openaiApiKey:'synthetic-source-secret'});
  await store.createPracticeRecord({questionFrontendId:'1', practicedAt:'2026-09-01', timePrecision:'date', completed:true, durationMinutes:12, operationId:randomUUID()});
  store.upsertProblemNote('1', '# Synthetic note\n跨设备');
  const db = store.db;
  db.prepare('INSERT INTO progress_import_history VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run('import-1',1,1,1,1,0,0,0,0,0,'manual',null);
  db.prepare('INSERT INTO progress_import_results VALUES(?,?)').run('import-1','{"synthetic":true}');
  db.prepare('INSERT INTO progress_snapshots VALUES(?,?,?,?,?,?,?,?,?,?,?)').run('1','2026-09-01','date','Accepted',2,1,'manual',1,'active',1,'UTC');
  db.prepare('INSERT INTO progress_snapshot_history VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run('history-1','1',1,'2026-09-01','date','Accepted',2,'manual','active',1,'import-1','import');
  db.prepare('INSERT INTO snapshot_successes VALUES(?,?,?,?,?,?)').run('1',1,'2026-09-01','date','UTC',1);
  await store.planning.saveStrategy({name:'Synthetic strategy', weekdays:[0,1,2,3,4,5,6], rules:{dailyCount:1,difficulty:{Easy:100,Medium:0,Hard:0},tags:[],premium:false,reviewEnabled:true,reviewPercent:100,preference:''}});
  const app = await buildApp({store, disableStatic:true});
  try {
    const result = await app.inject({method:'POST',url:'/api/v1/daily-plans/ensure',payload:{date:'2099-01-01'}});
    assert.equal(result.statusCode,200,result.body);
  } finally { await app.close(); }
}
