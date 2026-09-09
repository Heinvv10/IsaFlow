import {afterAll,beforeAll,expect,it} from 'vitest';
import {randomBytes,randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {provisionForensicFixture,validateFixtureTarget,type ForensicFixture} from '../forensic-fixture';
import {withControlRequest,requireControlTx} from '@/modules/accounting/services/controls/context';
import {enqueueAuditSnapshot} from '@/modules/accounting/services/controls/auditJobService';
import {runAuditSnapshotJob} from '@/modules/accounting/services/controls/auditJobRunner';
import {withAuditWorkerTransaction} from '@/modules/accounting/services/controls/auditWorkerTransaction';
import {readRetainedAuditSnapshot} from '@/modules/accounting/services/controls/auditSnapshotPublication';
const config=fixtureConfigFromEnv(process.env),pool=new Pool({connectionString:validateFixtureTarget(config).connectionString,ssl:false,max:3});
let fixture:ForensicFixture;
process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');
process.env.CONTROL_SNAPSHOT_SIGNING_KEY='synthetic-worker-signing-key-outside-database';
beforeAll(async()=>{fixture=await provisionForensicFixture(config);});afterAll(()=>pool.end());
const identity=(jobId:string)=>({companyId:fixture.companyA,personId:fixture.u1.id,jobId});
async function actor<T>(action:()=>Promise<T>){
 return withAuditWorkerTransaction(pool,identity(randomUUID()),'read committed',Date.now()+10000,undefined,store=>
  withControlRequest(store,{companyId:fixture.companyA,personId:fixture.u1.id,authMethod:'cookie'},action));
}
async function enqueue(){return actor(()=>enqueueAuditSnapshot(requireControlTx(),{cutoff:'2026-09-09',sources:['journals'],checks:[],idempotencyKey:randomUUID()}));}
it('cold claims, captures in a fresh transaction, retains and atomically publishes an actual queued snapshot',async()=>{
 const job=await enqueue();const result=await runAuditSnapshotJob(identity(job.id),{pool});
 expect(result).toMatchObject({state:'succeeded',snapshotId:job.id});
 const stored=await actor(()=>readRetainedAuditSnapshot(requireControlTx(),job.id));
 expect(stored.snapshot.populations.map(p=>p.source).sort()).toEqual(['journal_entry','journal_line']);
 expect(stored.snapshot.missingSources).not.toContain('retained_evidence_not_attached');
 expect((await pool.query('SELECT state,attempts FROM control_audit_jobs WHERE company_id=$1 AND job_id=$2',[fixture.companyA,job.id])).rows[0]).toEqual({state:'succeeded',attempts:1});
 expect(await runAuditSnapshotJob(identity(job.id),{pool})).toMatchObject({state:'not_claimed'});
});
it('cancels an actual in-flight SQL statement and rolls back before releasing the work connection',async()=>{
 const controller=new AbortController(),started=Date.now();let timer:ReturnType<typeof setTimeout>|undefined;
 try{
  await expect(withAuditWorkerTransaction(pool,identity(randomUUID()),'repeatable read',Date.now()+10000,controller.signal,async store=>{
   timer=setTimeout(()=>controller.abort(new Error('Synthetic cancel')),100);
   await store.client.query('SELECT pg_sleep(10)');
  })).rejects.toThrow();
  expect(Date.now()-started).toBeLessThan(3000);
  expect((await pool.query('SELECT 1 AS usable')).rows[0].usable).toBe(1);
 }finally{if(timer)clearTimeout(timer);}
});
it('refuses concurrent duplicate work and preserves exactly one publication',async()=>{
 const job=await enqueue();const results=await Promise.all([runAuditSnapshotJob(identity(job.id),{pool}),runAuditSnapshotJob(identity(job.id),{pool})]);
 expect(results.filter(row=>row.state==='succeeded')).toHaveLength(1);
 expect((await pool.query('SELECT id FROM control_audit_snapshots WHERE company_id=$1 AND id=$2',[fixture.companyA,job.id])).rows).toHaveLength(1);
});

function betweenClaimAndWork(action:()=>Promise<void>):Pool{
 let connections=0;
 return{connect:async()=>{if(++connections===2)await action();return pool.connect();}} as Pool;
}
it('records authority revocation observed after the committed claim before any snapshot publication',async()=>{
 const job=await enqueue();
 const instrumented=betweenClaimAndWork(async()=>{
  expect((await pool.query('SELECT state FROM control_audit_jobs WHERE company_id=$1 AND job_id=$2',[fixture.companyA,job.id])).rows[0].state).toBe('running');
  await pool.query("INSERT INTO company_user_permissions(company_id,user_id,module_key,can_read) VALUES($1,$2,'reports',false)",[fixture.companyA,fixture.u1.id]);
 });
 try{
  expect(await runAuditSnapshotJob(identity(job.id),{pool:instrumented})).toMatchObject({state:'failed',code:'AUTHORITY_REVOKED',failureRecorded:true});
  expect((await pool.query('SELECT state,last_error_code FROM control_audit_jobs WHERE company_id=$1 AND job_id=$2',[fixture.companyA,job.id])).rows[0]).toEqual({state:'failed',last_error_code:'AUTHORITY_REVOKED'});
  expect((await pool.query('SELECT id FROM control_audit_snapshots WHERE company_id=$1 AND id=$2',[fixture.companyA,job.id])).rows).toEqual([]);
 }finally{await pool.query("DELETE FROM company_user_permissions WHERE company_id=$1 AND user_id=$2 AND module_key='reports'",[fixture.companyA,fixture.u1.id]);}
});
it('records explicit cancellation after claim and never publishes a partial result',async()=>{
 const job=await enqueue(),controller=new AbortController();
 const instrumented=betweenClaimAndWork(async()=>{controller.abort(new Error('Synthetic cancellation after claim'));});
 expect(await runAuditSnapshotJob(identity(job.id),{pool:instrumented,signal:controller.signal})).toMatchObject({state:'failed',code:'CANCELLED',failureRecorded:true});
 expect((await pool.query('SELECT id FROM control_audit_snapshots WHERE company_id=$1 AND id=$2',[fixture.companyA,job.id])).rows).toEqual([]);
});
it('recovers an expired claim on retry and preserves one successful snapshot',async()=>{
 const job=await enqueue();
 const instrumented=betweenClaimAndWork(async()=>{await pool.query("UPDATE control_audit_jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE company_id=$1 AND job_id=$2",[fixture.companyA,job.id]);});
 expect(await runAuditSnapshotJob(identity(job.id),{pool:instrumented})).toMatchObject({state:'failed',failureRecorded:false});
 expect(await runAuditSnapshotJob(identity(job.id),{pool})).toMatchObject({state:'succeeded',snapshotId:job.id});
 expect((await pool.query('SELECT attempts FROM control_audit_jobs WHERE company_id=$1 AND job_id=$2',[fixture.companyA,job.id])).rows[0].attempts).toBe(2);
 expect((await pool.query('SELECT id FROM control_audit_snapshots WHERE company_id=$1 AND id=$2',[fixture.companyA,job.id])).rows).toHaveLength(1);
});
it('cancels promptly with a single-connection work pool',async()=>{
 const single=new Pool({connectionString:validateFixtureTarget(config).connectionString,ssl:false,max:1,connectionTimeoutMillis:250});
 const controller=new AbortController(),started=Date.now();let timer:ReturnType<typeof setTimeout>|undefined;
 try{
  await expect(withAuditWorkerTransaction(single,identity(randomUUID()),'repeatable read',Date.now()+10000,controller.signal,async store=>{
   timer=setTimeout(()=>controller.abort(new Error('Single pool cancellation')),100);
   await store.client.query('SELECT pg_sleep(4)');
  })).rejects.toThrow();
  expect(Date.now()-started).toBeLessThan(1500);
 }finally{if(timer)clearTimeout(timer);await single.end();}
},10000);
it('cancels while waiting for initial connection acquisition without leaking a late connection',async()=>{
 const single=new Pool({connectionString:validateFixtureTarget(config).connectionString,ssl:false,max:1,connectionTimeoutMillis:2000});
 const held=await single.connect(),controller=new AbortController(),started=Date.now();
 const timer=setTimeout(()=>controller.abort(new Error('Acquisition cancelled')),100);
 try{
  await expect(withAuditWorkerTransaction(single,identity(randomUUID()),'repeatable read',Date.now()+10000,controller.signal,async()=>undefined)).rejects.toThrow();
  expect(Date.now()-started).toBeLessThan(1000);
 }finally{clearTimeout(timer);held.release();await single.end();}
},5000);
