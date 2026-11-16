/** Evidence validation uses temporary files, never edits dated acceptance records. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {checkAcceptance,testSummaries} from '../scripts/acceptance-check.mjs';

test('validator rejects missing evidence, candidate drift, synthetic promotion and incomplete write receipts',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'tracker-evidence-'));
  const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
  const put=async(name:string,value:string|Buffer)=>{const bytes=Buffer.from(value);await fs.mkdir(path.dirname(path.join(dir,name)),{recursive:true});await fs.writeFile(path.join(dir,name),bytes);return {path:name,bytes:bytes.length,sha256:hash(bytes)};};
  try {
    const source=await put('source/example.ts','export const value=1;');
    const entries=[{...source,path:'example.ts'}];
    const manifest=await put('manifest.json',JSON.stringify({entries}));
    const artifacts=[];for(const kind of ['formal-html','sidecar','proxy','private-node','tunnel','nsis'])artifacts.push({...await put(kind+'.bin',kind),kind});
    const candidate={schemaVersion:1,name:'candidate-r1',sourceManifest:manifest,sourceRoot:'source',sourceFingerprint:hash(Buffer.from(JSON.stringify(entries))),artifacts};
    const stamp={candidate:candidate.name,environment:'native'};
    const screenshot={...await put('screen.png',Buffer.from([137,80,78,71,13,10,26,10])),...stamp,type:'ui-screenshot'};
    const observation={...await put('observation.json',JSON.stringify({...stamp,actual:'Visible UI action'})),...stamp,type:'observation'};
    const row:any={id:'note',status:'passed',...stamp,provenance:'computer_use',actual:'Saved in isolated native instance',executedAt:'2026-10-08',evidence:[screenshot,observation]};
    const matrix:any={schemaVersion:1,candidate:candidate.name,environments:[{id:'native',candidate:candidate.name,description:'Isolated synthetic native'}],results:[row],engineering:[]};
    const c=path.join(dir,'candidate.json'),m=path.join(dir,'matrix.json');
    await fs.writeFile(c,JSON.stringify(candidate));
    const check=async()=>{await fs.writeFile(m,JSON.stringify(matrix));return checkAcceptance(m,c);};
    assert.equal((await check()).passed,true);
    row.provenance='automated_contract_suite';assert.match((await check()).errors.join('\n'),/cannot pass/);row.provenance='computer_use';
    row.candidate='wrong';assert.match((await check()).errors.join('\n'),/candidate mismatch/);row.candidate=candidate.name;
    row.status='passed_scoped';assert.match((await check()).errors.join('\n'),/remaining scopes/);row.acceptedScope='Local UI';row.remainingScope='Installed lifecycle';assert.equal((await check()).passed,true);
    row.businessWrite=true;row.operationId='original-id';assert.match((await check()).errors.join('\n'),/receipt required/);
    row.evidence.push({...await put('receipt.json',JSON.stringify({...stamp,operationId:row.operationId,status:'applied'})),...stamp,type:'runtime-receipt'});
    row.evidence.push({...await put('readback.json',JSON.stringify({...stamp,operationId:row.operationId,persisted:true,matchesReceipt:true,connectionId:'second-connection'})),...stamp,type:'runtime-readback'});
    assert.equal((await check()).passed,true);
    row.evidence[0].path='missing.png';assert.match((await check()).errors.join('\n'),/inaccessible/);
    row.evidence[0]=screenshot;await fs.writeFile(path.join(dir,'source/example.ts'),'changed');assert.match((await check()).errors.join('\n'),/digest mismatch/);
    assert.equal((await fs.readFile(m,'utf8')),JSON.stringify(matrix),'Validator is read-only');
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('test totals come from each actual Node and Rust summary',()=>{
  assert.deepEqual(testSummaries('ℹ tests 3\nℹ suites 0\nℹ pass 2\nℹ fail 1\ntest result: ok. 7 passed; 0 failed; 0 ignored'),[{tests:3,passed:2,failed:1},{tests:7,passed:7,failed:0}]);
});
