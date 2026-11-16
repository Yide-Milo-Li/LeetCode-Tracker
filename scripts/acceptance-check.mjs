/** Read-only evidence validation. Never promote engineering results into field acceptance. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const readJson=async file=>JSON.parse((await fs.readFile(file,'utf8')).replace(/^\uFEFF/,''));
const nonempty=value=>typeof value==='string'&&value.trim().length>0;
/** Parse Node/Rust summaries from the supplied log, without fixed suite totals. */
export function testSummaries(log) {
  const node=[...log.matchAll(/(?:ℹ |# )tests (\d+)\r?\n(?:ℹ |# )suites \d+\r?\n(?:ℹ |# )pass (\d+)\r?\n(?:ℹ |# )fail (\d+)/g)].map(m=>({tests:+m[1],passed:+m[2],failed:+m[3]}));
  const rust=[...log.matchAll(/test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored/g)].map(m=>({tests:+m[1]+ +m[2]+ +m[3],passed:+m[1],failed:+m[2]}));
  return [...node,...rust];
}
/** Paths are relative to the containing JSON file. Every digest is recomputed from disk. */
export async function checkAcceptance(matrixPath,candidatePath) {
  const errors=[],engineering=[];
  const require=(condition,message)=>{if(!condition)errors.push(message);};
  const matrix=await readJson(matrixPath),candidate=await readJson(candidatePath);
  const base=path.dirname(path.resolve(candidatePath)),evidenceBase=path.dirname(path.resolve(matrixPath));
  require(matrix.schemaVersion===1&&candidate.schemaVersion===1,'Unsupported schema; legacy results must be corrected explicitly');
  require(nonempty(candidate.name)&&matrix.candidate===candidate.name,'Matrix candidate mismatch');
  const file=async(entry,root,label)=>{
    if(!entry||!nonempty(entry.path)||!entry.sha256?.match(/^[a-f0-9]{64}$/)){errors.push(label+': missing path/digest');return;}
    try {const bytes=await fs.readFile(path.resolve(root,entry.path));require(sha(bytes)===entry.sha256,label+': digest mismatch');if(entry.bytes!==undefined)require(entry.bytes===bytes.length,label+': size mismatch');return bytes;}
    catch(e){errors.push(label+': inaccessible file ('+e.code+')');}
  };
  const manifestBytes=await file(candidate.sourceManifest,base,'Source manifest');
  if(manifestBytes){
    try {
      const manifest=JSON.parse(manifestBytes.toString());
      require(Array.isArray(manifest.entries)&&manifest.entries.length>0,'Source manifest is empty');
      require(sha(JSON.stringify(manifest.entries))===candidate.sourceFingerprint,'Source fingerprint mismatch');
      const unique=new Set();
      for(const entry of manifest.entries??[]){
        require(!unique.has(entry.path),'Duplicate source path: '+entry.path);unique.add(entry.path);
        require(nonempty(entry.path)&&!path.isAbsolute(entry.path)&&!entry.path.split(/[\\/]/).includes('..')&&!/(^|\/)(\.local|AGENTS\.md)(\/|$)|\.sqlite|\.env$|\.key$/i.test(entry.path),'Restricted source path: '+entry.path);
        await file(entry,path.resolve(base,candidate.sourceRoot??'source'),'Source '+entry.path);
      }
    }catch(e){errors.push('Invalid source manifest: '+e.message);}
  }
  const kinds=new Set();
  for(const artifact of candidate.artifacts??[]){kinds.add(artifact.kind);await file(artifact,base,'Artifact '+artifact.kind);}
  for(const kind of ['formal-html','sidecar','proxy','private-node','tunnel','nsis'])require(kinds.has(kind),'Missing candidate artifact: '+kind);
  const environments=new Map((matrix.environments??[]).map(e=>[e.id,e]));
  const ids=new Set();
  for(const row of matrix.results??[]){
    const prefix=row.id??'Unnamed case';require(nonempty(row.id)&&!ids.has(row.id),prefix+': duplicate or missing ID');ids.add(row.id);
    require(['passed','passed_scoped','pending','blocked','failed'].includes(row.status),prefix+': invalid status');
    if(!['passed','passed_scoped'].includes(row.status)){
      require(nonempty(row.reason)&&nonempty(row.nextStep),prefix+': unresolved case needs reason and next step');continue;
    }
    require(row.candidate===candidate.name,prefix+': case candidate mismatch');
    const env=environments.get(row.environment);
    require(env?.candidate===candidate.name&&nonempty(env?.description),prefix+': missing matching environment');
    require(row.provenance==='computer_use'||row.provenance==='manual_field',prefix+': engineering/simulated evidence cannot pass a field case');
    require(nonempty(row.actual)&&nonempty(row.executedAt),prefix+': actual result and execution time required');
    if(row.status==='passed_scoped')require(nonempty(row.acceptedScope)&&nonempty(row.remainingScope),prefix+': scoped pass needs accepted and remaining scopes');
    const types=new Set(),records=new Map();
    for(const entry of row.evidence??[]){
      types.add(entry.type);
      require(entry.candidate===candidate.name&&entry.environment===row.environment,prefix+': evidence identity mismatch');
      require(!['engineering','synthetic','test-source'].includes(entry.type),prefix+': simulated evidence in field result');
      const bytes=await file(entry,evidenceBase,prefix+' '+entry.type);
      if(bytes&&['runtime-receipt','runtime-readback','observation'].includes(entry.type)){
        try {const record=JSON.parse(bytes.toString());records.set(entry.type,record);require(record.candidate===candidate.name&&record.environment===row.environment,prefix+': record identity mismatch');if(entry.type==='observation')require(nonempty(record.actual),prefix+': observation has no actual result');}catch{errors.push(prefix+': invalid '+entry.type+' record');}
      }
      if(bytes&&entry.type==='ui-screenshot')require(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))||bytes.subarray(0,3).equals(Buffer.from([255,216,255])),prefix+': screenshot is not PNG/JPEG');
    }
    require(types.has('ui-screenshot')&&types.has('observation'),prefix+': field screenshot and observation required');
    if(row.businessWrite){
      const receipt=records.get('runtime-receipt'),back=records.get('runtime-readback');
      require(nonempty(row.operationId)&&receipt?.operationId===row.operationId&&receipt?.status==='applied',prefix+': original applied operation receipt required');
      require(back?.operationId===row.operationId&&back?.persisted===true&&back?.matchesReceipt===true&&nonempty(back?.connectionId),prefix+': independent persisted readback required');
    }
  }
  for(const item of matrix.engineering??[]){
    require(item.candidate===candidate.name,'Engineering candidate mismatch');
    const bytes=await file(item.log,evidenceBase,'Engineering '+item.name);
    if(bytes){const summaries=testSummaries(bytes.toString());require(summaries.length>0,'Engineering log has no test summary: '+item.name);require(summaries.every(s=>s.failed===0),'Engineering failures: '+item.name);engineering.push({name:item.name,summaries});}
  }
  require(!matrix.closedGaps?.length,'Field validator does not authorize G-item closure');
  return {passed:errors.length===0,candidate:candidate.name,errors,engineering};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  const args=process.argv.slice(2),value=flag=>args[args.indexOf(flag)+1];
  try {
    if(!args.includes('--matrix')||!args.includes('--candidate'))throw new Error('Usage: acceptance:check -- --matrix <file> --candidate <file>');
    const result=await checkAcceptance(value('--matrix'),value('--candidate'));console.log(JSON.stringify(result,null,2));process.exitCode=result.passed?0:1;
  }catch(error){console.error(error.message);process.exitCode=1;}
}
