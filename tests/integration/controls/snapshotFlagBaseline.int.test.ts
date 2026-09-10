import {afterAll,beforeAll,expect,it} from 'vitest';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Pool} from 'pg';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {validateFixtureTarget} from '../forensic-fixture';
import {canonicalJson} from '@/modules/accounting/services/controls/canonical';
import {ledgerSnapshotSources,type SnapshotRow} from '@/modules/accounting/services/controls/auditSnapshotCaptureQueries';
import {actorAs,type Identity} from './intentReceiptRows';
// Rows the snapshot source returned at 45e4d3981, before forked records carried control_lineage_forked.
const COMMIT='45e4d3981',ENV='ISAFLOW_SNAPSHOT_FLAG_BASELINE';
const DUMP='tests/integration/controls/snapshotFlagBaselineDump.ts',CONFIG='tests/integration/controls/snapshotFlagBaselineDump.config.ts';
const pool=new Pool({connectionString:validateFixtureTarget(fixtureConfigFromEnv(process.env)).connectionString,ssl:false,max:2});
let baseline:{user:Identity;plain:string[];forked:string[];rows:SnapshotRow[]};
beforeAll(async()=>{
 const cwd=process.env[ENV];if(!cwd)throw new Error(`Set ${ENV} to the isolated ${COMMIT} worktree containing copies of ${DUMP} and ${CONFIG}`);
 const run=promisify(execFile);
 expect((await run('git',['rev-parse','--short=9','HEAD'],{cwd})).stdout.trim()).toBe(COMMIT);
 await run('git',['diff','--exit-code',COMMIT,'--','src','scripts/migrations/sql','tests/integration/controls/intentReceiptRows.ts'],{cwd});
 for(const file of [DUMP,CONFIG])expect(await readFile(path.join(cwd,file),'utf8'),`baseline ${file} differs`).toBe(await readFile(path.resolve(file),'utf8'));
 const directory=await mkdtemp(path.join(tmpdir(),'isaflow-snapshot-flag-')),artifact=path.join(directory,'dump.json');
 const env:NodeJS.ProcessEnv={...process.env,ISAFLOW_SNAPSHOT_DUMP_OUT:artifact};
 for(const key of Object.keys(env))if(key.startsWith('VITEST'))delete env[key];
 try{
  await run(path.join(cwd,'node_modules/.bin/vitest'),['run','--config',CONFIG],{cwd,env,timeout:300000,maxBuffer:16*1024*1024});
  baseline=JSON.parse(await readFile(artifact,'utf8'));
 }finally{await rm(directory,{recursive:true,force:true});}
},400000);
afterAll(async()=>{await pool.end();});
it('non-forked snapshot records are byte-identical to the pre-flag source; forked ones differ only by the flag',async()=>{
 const source=ledgerSnapshotSources.find(row=>row.source==='bank_transaction')!;
 const head=await actorAs(pool,baseline.user,ctx=>source.page(ctx,'2026-12-31',null));
 expect(head.map(row=>row.id)).toEqual(baseline.rows.map(row=>row.id));
 const before=new Map(baseline.rows.map(row=>[row.id,row]));
 for(const row of head){
  const prior=before.get(row.id)!;
  if(baseline.forked.includes(row.id)){
   const {control_lineage_forked:flag,...rest}=row.data;
   expect(flag).toBe(true);expect(canonicalJson({...row,data:rest})).toBe(canonicalJson(prior));
  }else expect(canonicalJson(row)).toBe(canonicalJson(prior));
 }
 expect(baseline.plain.every(id=>head.some(row=>row.id===id))).toBe(true);
});
