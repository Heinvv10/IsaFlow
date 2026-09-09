import {beforeAll,afterAll,expect,it} from 'vitest';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomUUID,randomBytes} from 'node:crypto';
import {Pool} from 'pg';
import {createIsolatedAuditJobRunner} from '@/modules/accounting/services/controls/auditJobProcess';
import {auditSystemctl} from '@/modules/accounting/services/controls/auditJobSystemd';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {validateFixtureTarget,provisionForensicFixture,type ForensicFixture} from '../forensic-fixture';
import {withAuditWorkerTransaction} from '@/modules/accounting/services/controls/auditWorkerTransaction';
import {requireControlTx,withControlRequest} from '@/modules/accounting/services/controls/context';
import {enqueueAuditSnapshot,getAuditJob} from '@/modules/accounting/services/controls/auditJobService';
let directory:string,pool:Pool,fixture:ForensicFixture;
const target=validateFixtureTarget(fixtureConfigFromEnv(process.env));
const nodePath=process.execPath,artifact=process.env.ISAFLOW_FORENSIC_AUDIT_ARTIFACT;
beforeAll(async()=>{
 if(process.env.ISAFLOW_FORENSIC_PROCESS_TEST!=='1'||!artifact||!artifact.startsWith('/'))throw new Error('Explicit isolated-process fixture opt-in/artifact required');
 directory=await mkdtemp(join(tmpdir(),'isaflow-audit-process-'));fixture=await provisionForensicFixture(fixtureConfigFromEnv(process.env));
 pool=new Pool({connectionString:target.connectionString,ssl:false,max:2});
 process.env.ISAFLOW_AUDIT_WORKER_DATABASE_URL=target.connectionString;process.env.DATABASE_SSL='disable';
 process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');process.env.CONTROL_SNAPSHOT_SIGNING_KEY=randomBytes(32).toString('hex');
});
afterAll(async()=>{if(pool)await pool.end();if(directory)await rm(directory,{recursive:true,force:true});});
const identity=(jobId:string=randomUUID())=>({companyId:fixture.companyA,personId:fixture.u1.id,jobId});
async function actor<T>(work:()=>Promise<T>){return withAuditWorkerTransaction(pool,identity(),'read committed',Date.now()+10000,undefined,
 store=>withControlRequest(store,{companyId:fixture.companyA,personId:fixture.u1.id,authMethod:'cookie'},work));}
async function script(name:string,source:string){const path=join(directory,name+'.cjs');await writeFile(path,source);return createIsolatedAuditJobRunner({nodePath,entryPath:path});}
it('real transient unit enforces cgroup caps and strict response while reporting actual peak',async()=>{
 const runner=await script('echo',"process.stdin.once('data',()=>process.stdout.write(JSON.stringify({version:1,result:{state:'not_claimed'}})+'\\n'));process.stdin.on('end',()=>process.exit(0));");
 const value=await runner.runIsolatedAuditJob(identity());expect(value.result).toEqual({state:'not_claimed'});expect(value.observation.memoryPeakBytes).toBeGreaterThan(0);expect(value.observation.oomKilled).toBe(false);
 expect(await auditSystemctl(['show',value.observation.unitName,'--property=LoadState'])).toContain('not-found');
});
it('cancel kills a blocked CPU child without running inside its event loop',async()=>{
 const runner=await script('spin',"process.stdin.once('data',()=>{while(true){}});");
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),1000);
 try{const value=await runner.runIsolatedAuditJob(identity(),{signal:controller.signal});expect(value.result).toMatchObject({state:'failed',code:'CANCELLED'});expect(value.observation.elapsedMs).toBeLessThan(8000);expect(value.observation.peakRssBytes).toBeGreaterThan(0);}
 finally{clearTimeout(timer);}
},15000);
it('refuses oversized process output and does not publish a claimed success',async()=>{
 const runner=await script('oversize',"process.stdin.once('data',()=>process.stdout.write('x'.repeat(4096)));setInterval(()=>{},1000);");
 const value=await runner.runIsolatedAuditJob(identity());expect(value.result).toMatchObject({state:'failed',code:'WORKER_ERROR',failureRecorded:false});
});
it('actual cold child authenticates saved delegation, publishes once and rechecks authority',async()=>{
 const runner=createIsolatedAuditJobRunner({nodePath,entryPath:resolve(artifact!)});
 const job=await actor(()=>enqueueAuditSnapshot(requireControlTx(),{cutoff:'2026-09-09',sources:['journals','payroll'],checks:[],idempotencyKey:randomUUID()}));
 const first=await runner.runIsolatedAuditJob(identity(job.id));expect(first.result,JSON.stringify(first)).toMatchObject({state:'succeeded',snapshotId:job.id});
 expect(await actor(()=>getAuditJob(requireControlTx(),job.id))).toMatchObject({state:'succeeded',attempts:1});
 expect((await runner.runIsolatedAuditJob(identity(job.id))).result).toEqual({state:'not_claimed'});
 const other=await actor(()=>enqueueAuditSnapshot(requireControlTx(),{cutoff:'2026-09-09',sources:['journals','payroll'],checks:[],idempotencyKey:randomUUID()}));
 await pool.query("INSERT INTO company_user_permissions(company_id,user_id,module_key,can_read) VALUES($1,$2,'payroll',false)",[fixture.companyA,fixture.u1.id]);
 try{expect((await runner.runIsolatedAuditJob(identity(other.id))).result).toMatchObject({state:'failed',code:'AUTHORITY_REVOKED'});}
 finally{await pool.query("DELETE FROM company_user_permissions WHERE company_id=$1 AND user_id=$2 AND module_key='payroll'",[fixture.companyA,fixture.u1.id]);}
});

it('hard service walltime kills CPU spin that cannot handle its SIGTERM',async()=>{
 const runner=await script('hard-spin',"process.on('SIGTERM',()=>{});process.stdin.once('data',()=>{while(true){}});");
 const value=await runner.runIsolatedAuditJob(identity());expect(value.result).toMatchObject({state:'failed',code:'RESOURCE_LIMIT'});
 expect(value.observation.elapsedMs).toBeGreaterThanOrEqual(64000);expect(value.observation.elapsedMs).toBeLessThan(73000);
},80000);
it('actual OOM in its own lowered128MiB test unit is observed without claiming an8GiB pressure test',async()=>{
 const marker=join(directory,'oom-limit.json');
 const source=`const fs=require('node:fs'),cp=require('node:child_process');process.stdin.once('data',()=>{
 const group=fs.readFileSync('/proc/self/cgroup','utf8').trim().split('::')[1],unit=group.split('/').pop();
 if(!/^isaflow-audit-[a-f0-9-]{36}\\.service$/.test(unit))process.exit(2);
 const root='/sys/fs/cgroup'+group,initial=Number(fs.readFileSync(root+'/memory.max','utf8'));if(initial!==8589934592)process.exit(3);
 cp.execFileSync('/usr/bin/systemctl',['--user','set-property','--runtime',unit,'MemoryMax=134217728']);
 const effective=Number(fs.readFileSync(root+'/memory.max','utf8'));fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({initial,effective}));
 if(effective!==134217728)process.exit(4);global.hold=Buffer.alloc(256*1024*1024,1);setInterval(()=>{},1000);
 });`;
 const runner=await script('small-oom',source),value=await runner.runIsolatedAuditJob(identity());
 expect(JSON.parse(await readFile(marker,'utf8'))).toEqual({initial:8589934592,effective:134217728});
 expect(value.result).toMatchObject({state:'failed',code:'RESOURCE_LIMIT',failureRecorded:false});expect(value.observation.oomKilled).toBe(true);
});

function pauseName(){return `forensic_pause_${fixture.runId.replaceAll('-','')}`;}
async function pausedPublication(jobId:string){
 if(![fixture.companyA,jobId].every(value=>/^[a-f0-9-]{36}$/.test(value)))throw new Error('Synthetic pause identity invalid');
 const name=pauseName();
 await pool.query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.company_id::text=TG_ARGV[0] AND NEW.id::text=TG_ARGV[1] THEN PERFORM pg_sleep(30); END IF; RETURN NEW; END $$`);
 await pool.query(`CREATE TRIGGER ${name} BEFORE INSERT ON control_audit_snapshots FOR EACH ROW EXECUTE FUNCTION ${name}('${fixture.companyA}','${jobId}')`);
}
async function unpausePublication(){const name=pauseName();await pool.query(`DROP TRIGGER IF EXISTS ${name} ON control_audit_snapshots`);await pool.query(`DROP FUNCTION IF EXISTS ${name}()`);}
async function waitForPublication(jobId:string){
 for(let n=0;n<100;n++){
  const rows=(await pool.query("SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND application_name=$1 AND wait_event='PgSleep'",[`isaflow-audit:${jobId}`])).rows;
  if(rows.length)return;await new Promise(resolve=>setTimeout(resolve,50));
 }throw new Error('Actual child publication did not reach PG sleep');
}
it('graceful process cancellation cancels real publication SQL with a two-connection child pool',async()=>{
 const job=await actor(()=>enqueueAuditSnapshot(requireControlTx(),{cutoff:'2026-09-09',sources:['journals'],checks:[],idempotencyKey:randomUUID()}));
 const runner=createIsolatedAuditJobRunner({nodePath,entryPath:resolve(artifact!)}),controller=new AbortController();
 await pausedPublication(job.id);const work=runner.runIsolatedAuditJob(identity(job.id),{signal:controller.signal});
 try{
  await waitForPublication(job.id);controller.abort();
  expect((await work).result).toMatchObject({state:'failed',code:'CANCELLED',failureRecorded:true});
  expect((await pool.query('SELECT state,last_error_code FROM control_audit_jobs WHERE company_id=$1 AND job_id=$2',[fixture.companyA,job.id])).rows[0]).toEqual({state:'failed',last_error_code:'CANCELLED'});
  expect((await pool.query('SELECT id FROM control_audit_snapshots WHERE company_id=$1 AND id=$2',[fixture.companyA,job.id])).rows).toEqual([]);
 }finally{controller.abort();await work;await unpausePublication();}
});
it('hard-killed publication rolls back and expired authenticated claim recovers with a new generation',async()=>{
 const job=await actor(()=>enqueueAuditSnapshot(requireControlTx(),{cutoff:'2026-09-09',sources:['journals'],checks:[],idempotencyKey:randomUUID()}));
 const marker=join(directory,'own-unit.txt');
 const marked=await script('real-marked',`const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(marker)},fs.readFileSync('/proc/self/cgroup','utf8'));require(${JSON.stringify(artifact)});`);
 const controller=new AbortController();await pausedPublication(job.id);const work=marked.runIsolatedAuditJob(identity(job.id),{signal:controller.signal});
 try{
  await waitForPublication(job.id);const unit=(await readFile(marker,'utf8')).trim().split('/').at(-1)!;
  expect(unit).toMatch(/^isaflow-audit-[a-f0-9-]{36}\.service$/);
  await auditSystemctl(['kill','--kill-whom=all','--signal=SIGKILL',unit]);
  const killed=await work;expect(killed.result).toMatchObject({state:'failed',failureRecorded:false});
  expect(killed.observation.elapsedMs).toBeLessThan(8000);
  expect(await auditSystemctl(['show',unit,'--property=LoadState'])).toContain('not-found');
  expect((await pool.query('SELECT id FROM control_audit_snapshots WHERE company_id=$1 AND id=$2',[fixture.companyA,job.id])).rows).toEqual([]);
  expect((await pool.query('SELECT state,attempts FROM control_audit_jobs WHERE company_id=$1 AND job_id=$2',[fixture.companyA,job.id])).rows[0]).toEqual({state:'running',attempts:1});
 }finally{controller.abort();await work;await unpausePublication();}
 expect((await pool.query("SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND application_name=$1",[`isaflow-audit:${job.id}`])).rows).toEqual([]);
 await pool.query("UPDATE control_audit_jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE company_id=$1 AND job_id=$2",[fixture.companyA,job.id]);
 const runner=createIsolatedAuditJobRunner({nodePath,entryPath:resolve(artifact!)});
 expect((await runner.runIsolatedAuditJob(identity(job.id))).result).toMatchObject({state:'succeeded',snapshotId:job.id});
 expect((await pool.query('SELECT state,attempts,generation FROM control_audit_jobs WHERE company_id=$1 AND job_id=$2',[fixture.companyA,job.id])).rows[0]).toEqual({state:'succeeded',attempts:2,generation:'2'});
},45000);

it('publication pause does not delay another job or another company',async()=>{
 const selected=await actor(()=>enqueueAuditSnapshot(requireControlTx(),{cutoff:'2026-09-09',sources:['journals'],checks:[],idempotencyKey:randomUUID()}));
 await pausedPublication(selected.id);
 try{
  const runner=createIsolatedAuditJobRunner({nodePath,entryPath:resolve(artifact!)});
  for(const user of [fixture.u1,fixture.u3]){
   const who={companyId:user.companyId,personId:user.id,jobId:randomUUID()};
   const other=await withAuditWorkerTransaction(pool,who,'read committed',Date.now()+10000,undefined,
    store=>withControlRequest(store,{companyId:user.companyId,personId:user.id,authMethod:'cookie'},()=>enqueueAuditSnapshot(requireControlTx(),{cutoff:'2026-09-09',sources:['journals'],checks:[],idempotencyKey:randomUUID()})));
   expect((await runner.runIsolatedAuditJob({...who,jobId:other.id},{signal:AbortSignal.timeout(2000)})).result).toMatchObject({state:'succeeded',snapshotId:other.id});
  }
 }finally{await unpausePublication();}
});
