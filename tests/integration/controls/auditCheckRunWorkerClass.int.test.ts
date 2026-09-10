import {afterAll,beforeAll,expect,it} from 'vitest';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {randomBytes,randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {provisionForensicFixture,validateFixtureTarget,type ForensicFixture} from '../forensic-fixture';
import {withControlRequest,requireControlTx} from '@/modules/accounting/services/controls/context';
import {enqueueAuditSnapshot} from '@/modules/accounting/services/controls/auditJobService';
import {enqueueAuditCheckRuns} from '@/modules/accounting/services/controls/auditCheckRunJobService';
import {withAuditWorkerTransaction} from '@/modules/accounting/services/controls/auditWorkerTransaction';
import {createIsolatedAuditJobRunner} from '@/modules/accounting/services/controls/auditJobProcess';
import {AUDIT_PROCESS_LIMITS} from '@/modules/accounting/services/controls/auditJobProcessContract';
import {auditSystemctl,auditUnitCapsMatch,readAuditUnitCaps} from '@/modules/accounting/services/controls/auditJobSystemd';
const exec=promisify(execFile),target=validateFixtureTarget(fixtureConfigFromEnv(process.env)),artifact=process.env.ISAFLOW_FORENSIC_AUDIT_ARTIFACT;
let directory:string,pool:Pool,fixture:ForensicFixture;
beforeAll(async()=>{
 if(process.env.ISAFLOW_FORENSIC_PROCESS_TEST!=='1'||!artifact?.startsWith('/'))throw new Error('Explicit isolated-process fixture opt-in/artifact required');
 directory=await mkdtemp(join(tmpdir(),'isaflow-check-run-class-'));fixture=await provisionForensicFixture(fixtureConfigFromEnv(process.env));
 pool=new Pool({connectionString:target.connectionString,ssl:false,max:2});
 process.env.ISAFLOW_AUDIT_WORKER_DATABASE_URL=target.connectionString;process.env.DATABASE_SSL='disable';
 process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');process.env.CONTROL_SNAPSHOT_SIGNING_KEY=randomBytes(32).toString('hex');
});
afterAll(async()=>{if(pool)await pool.end();if(directory)await rm(directory,{recursive:true,force:true});});
const identity=(jobId:string=randomUUID())=>({companyId:fixture.companyA,personId:fixture.u1.id,jobId});
const actor=<T>(work:()=>Promise<T>)=>withAuditWorkerTransaction(pool,identity(),'read committed',Date.now()+10000,undefined,
 store=>withControlRequest(store,{companyId:fixture.companyA,personId:fixture.u1.id,authMethod:'cookie'},work));
const checkRun=async()=>(await actor(()=>enqueueAuditCheckRuns(requireControlTx(),{cutoff:'2026-09-09',checks:['journal_risk_checks'],idempotencyKey:randomUUID()}))).jobs[0]!.id;
const snapshot=async()=>(await actor(()=>enqueueAuditSnapshot(requireControlTx(),{cutoff:'2026-09-09',sources:['journals'],checks:[],idempotencyKey:randomUUID()}))).id;
const row=async(jobId:string)=>(await pool.query('SELECT row_to_json(j)::text AS row FROM control_audit_jobs j WHERE company_id=$1 AND job_id=$2',[fixture.companyA,jobId])).rows[0].row as string;
type WorkerClass='audit'|'check_run';
async function script(workerClass:WorkerClass,name:string,source:string){
 const path=join(directory,`${name}-${workerClass}.cjs`);await writeFile(path,source);return createIsolatedAuditJobRunner({nodePath:process.execPath,entryPath:path,workerClass});
}
const reply=(result:unknown)=>`process.stdin.once('data',()=>process.stdout.write(JSON.stringify({version:1,result:${JSON.stringify(result)}})+'\\n'));process.stdin.on('end',()=>process.exit(0));`;
it('a real unit of each class runs with the class runtime, memory, heap, class variable and spawn timestamp',async()=>{
 const testStart=Date.now(),expected={audit:{runtime:'1min 5s',memory:8589934592,heap:'--max-old-space-size=4096'},check_run:{runtime:'5min 40s',memory:2147483648,heap:'--max-old-space-size=1536'}};
 for(const workerClass of ['audit','check_run'] as const){
  const marker=join(directory,`caps-${workerClass}.json`);
  const runner=await script(workerClass,'caps',`const fs=require('node:fs'),cp=require('node:child_process');
   const group=fs.readFileSync('/proc/self/cgroup','utf8').trim().split('::')[1],unit=group.split('/').pop();
   const runtime=cp.execFileSync('/usr/bin/systemctl',['--user','show',unit,'--property=RuntimeMaxUSec','--value'],{encoding:'utf8'}).trim();
   fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({runtime,memory:Number(fs.readFileSync('/sys/fs/cgroup'+group+'/memory.max','utf8')),
    heap:process.execArgv.find(a=>a.startsWith('--max-old-space-size'))??null,workerClass:process.env.ISAFLOW_AUDIT_WORKER_CLASS,startedAt:Number(process.env.ISAFLOW_AUDIT_WORKER_STARTED_AT)}));${reply({state:'not_claimed'})}`);
  expect((await runner.runIsolatedAuditJob(identity())).result).toEqual({state:'not_claimed'});
  const {startedAt,...seen}=JSON.parse(await readFile(marker,'utf8')) as {startedAt:number};
  expect(seen).toEqual({...expected[workerClass],workerClass});expect(Number.isSafeInteger(startedAt)).toBe(true);
  expect(startedAt).toBeGreaterThanOrEqual(testStart);expect(startedAt).toBeLessThanOrEqual(Date.now());
 }
});
it('reads real unit caps over D-Bus and refuses a unit whose RuntimeMaxSec differs from the class',async()=>{
 const units={wrong:`isaflow-audit-${randomUUID()}.service`,right:`isaflow-audit-${randomUUID()}.service`};
 try{
  for(const [name,runtime] of [[units.wrong,'99s'],[units.right,'340s']] as const)
   await exec('/usr/bin/systemd-run',['--user','--quiet',`--unit=${name}`,`--property=RuntimeMaxSec=${runtime}`,'--property=MemoryMax=2147483648','--property=MemorySwapMax=0','/usr/bin/sleep','30']);
  const wrong=await readAuditUnitCaps(units.wrong),right=await readAuditUnitCaps(units.right);
  expect(wrong.runtimeMaxUSec).toBe(99_000_000);expect(auditUnitCapsMatch(wrong,AUDIT_PROCESS_LIMITS.check_run)).toBe(false);
  expect(right.runtimeMaxUSec).toBe(340_000_000);expect(auditUnitCapsMatch(right,AUDIT_PROCESS_LIMITS.check_run)).toBe(true);
  expect(auditUnitCapsMatch(right,AUDIT_PROCESS_LIMITS.audit)).toBe(false);
 }finally{for(const name of Object.values(units)){await auditSystemctl(['stop',name]).catch(()=>undefined);await auditSystemctl(['reset-failed',name]).catch(()=>undefined);}}
});
it('the parent rejects a success variant its class does not permit',async()=>{
 const id=randomUUID(),hash='b'.repeat(64);
 const cases:[WorkerClass,unknown,boolean][]=[['check_run',{state:'succeeded',snapshotId:id,canonicalHash:hash},false],['audit',{state:'succeeded',checkRunId:id,canonicalHash:hash},false],
  ['check_run',{state:'succeeded',checkRunId:id,canonicalHash:hash},true]];
 for(const [workerClass,result,accepted] of cases){
  const value=(await (await script(workerClass,`variant-${accepted}`,reply(result))).runIsolatedAuditJob(identity())).result;
  expect(value).toEqual(accepted?result:{state:'failed',code:'WORKER_ERROR',failureRecorded:false});
 }
});
it('a real child of either class returns not_claimed for an out-of-class job and leaves its row untouched',async()=>{
 const check=await checkRun(),snap=await snapshot(),before=[await row(check),await row(snap)];
 const audit=createIsolatedAuditJobRunner({nodePath:process.execPath,entryPath:resolve(artifact!),workerClass:'audit'});
 const checks=createIsolatedAuditJobRunner({nodePath:process.execPath,entryPath:resolve(artifact!),workerClass:'check_run'});
 expect((await audit.runIsolatedAuditJob(identity(check))).result).toEqual({state:'not_claimed'});
 expect((await checks.runIsolatedAuditJob(identity(snap))).result).toEqual({state:'not_claimed'});
 expect([await row(check),await row(snap)]).toEqual(before);
});
it('a child started without a valid class variable or spawn timestamp exits non-zero before claiming',async()=>{
 const snap=await snapshot(),before=await row(snap);
 for(const [value,startedAt] of [[undefined,String(Date.now())],['admin',String(Date.now())],['audit',undefined],['audit',String(Date.now()+60000)],['audit','soon']] as const){
  const env:NodeJS.ProcessEnv={NODE_ENV:'production',ISAFLOW_AUDIT_WORKER_DATABASE_URL:target.connectionString,DATABASE_SSL:'disable'};
  for(const [name,entry] of Object.entries({PATH:process.env.PATH,ENCRYPTION_KEY:process.env.ENCRYPTION_KEY,PGPASSWORD:process.env.PGPASSWORD,
   ISAFLOW_AUDIT_WORKER_CLASS:value,ISAFLOW_AUDIT_WORKER_STARTED_AT:startedAt}))if(entry!==undefined)env[name]=entry;
  const child=spawn(process.execPath,[resolve(artifact!)],{env,stdio:['pipe','pipe','pipe']});let stdout='',stderr='',pipe:string|null=null;
  child.stdout.on('data',(chunk:Buffer)=>{stdout+=chunk.toString();});child.stderr.on('data',(chunk:Buffer)=>{stderr+=chunk.toString();});
  child.stdin.on('error',(error:Error)=>{pipe=error.message;});
  child.stdin.end(JSON.stringify({version:1,...identity(snap)})+'\n');
  const code=await new Promise<number|null>(done=>child.once('close',done));
  expect(code,pipe??'').not.toBe(0);expect(stdout).toBe('');expect(stderr.length).toBeLessThanOrEqual(256);expect(stderr).toMatch(/worker class|spawn timestamp/i);
 }
 expect(await row(snap)).toBe(before);
},20000);
it('a snapshot completes in an audit unit while a check-run unit is still running',async()=>{
 const snap=await snapshot(),started=Date.now();
 const sleeper=(await script('check_run','sleeper',`process.stdin.once('data',()=>setTimeout(()=>process.stdout.write(JSON.stringify({version:1,result:{state:'not_claimed'}})+'\\n'),6000));process.stdin.on('end',()=>process.exit(0));`)).runIsolatedAuditJob(identity()).then(value=>({value,at:Date.now()-started}));
 const audit=createIsolatedAuditJobRunner({nodePath:process.execPath,entryPath:resolve(artifact!),workerClass:'audit'});
 const done=await audit.runIsolatedAuditJob(identity(snap));const snapshotAt=Date.now()-started;
 expect(done.result).toMatchObject({state:'succeeded',snapshotId:snap});
 const slept=await sleeper;expect(slept.value.result).toEqual({state:'not_claimed'});expect(snapshotAt).toBeLessThan(slept.at);
},30000);
it('the worker CLI --class selects the kinds it polls and rejects an unknown or repeated class',async()=>{
 const snap=await snapshot(),env={...process.env,DATABASE_SSL:'disable',ISAFLOW_AUDIT_WORKER_DATABASE_URL:target.connectionString,
  ISAFLOW_AUDIT_WORKER_NODE_PATH:process.execPath,ISAFLOW_AUDIT_WORKER_ENTRY_PATH:artifact};
 const run=(args:string[])=>exec('bun',['scripts/forensic/run-audit-worker.ts',...args],{cwd:resolve('.'),timeout:20000,maxBuffer:32768,env});
 const cli=(workerClass:string)=>run(['--company',fixture.companyA,'--once','--class',workerClass]);
 expect((await cli('check_run')).stdout).toContain('Audit queue worker stopped');
 expect((await run(['--class','check_run','--once',`--companies=${fixture.companyA}`])).stdout).toContain('Audit queue worker stopped');
 await expect(run(['--class','check_run','--once',`--companies=${fixture.companyA}`,'--class','audit'])).rejects.toMatchObject({code:1});
 expect((await pool.query('SELECT state,attempts FROM control_audit_jobs WHERE company_id=$1 AND job_id=$2',[fixture.companyA,snap])).rows[0]).toEqual({state:'queued',attempts:0});
 await expect(cli('admin')).rejects.toMatchObject({code:1});
},45000);
it.runIf(process.env.ISAFLOW_CHECK_RUN_LONG_GATES==='1')('a check-run child outlives the legacy 65 s cap and completes at 130 s',async()=>{
 const runner=await script('check_run','long',`process.stdin.once('data',()=>setTimeout(()=>{process.stdout.write(JSON.stringify({version:1,result:{state:'not_claimed'}})+'\\n');},130000));process.stdin.on('end',()=>process.exit(0));`);
 const value=await runner.runIsolatedAuditJob(identity());
 expect(value.result).toEqual({state:'not_claimed'});expect(value.observation.elapsedMs).toBeGreaterThanOrEqual(130000);expect(value.observation.oomKilled).toBe(false);
},300000);
