import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import {randomBytes,randomUUID} from 'node:crypto';
import {Pool,type PoolClient} from 'pg';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {provisionForensicFixture,validateFixtureTarget,type ForensicFixture} from '../forensic-fixture';
import {withControlRequest,requireControlTx} from '@/modules/accounting/services/controls/context';
import {enqueueAuditSnapshot,getAuditJob} from '@/modules/accounting/services/controls/auditJobService';
import {enqueueAuditCheckRuns} from '@/modules/accounting/services/controls/auditCheckRunJobService';
import {claimAuditJob,claimAuditJobForWorker} from '@/modules/accounting/services/controls/auditJobLease';
import {AUDIT_WORKER_CLASS_KINDS,type AuditJobKind} from '@/modules/accounting/services/controls/auditJobContract';
import {runAuditJob} from '@/modules/accounting/services/controls/auditJobRunner';
import {createAuditJobPoller} from '@/modules/accounting/services/controls/auditJobPoller';
import {withAuditWorkerTransaction} from '@/modules/accounting/services/controls/auditWorkerTransaction';
process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');process.env.CONTROL_SNAPSHOT_SIGNING_KEY=randomBytes(32).toString('hex');
const config=fixtureConfigFromEnv(process.env),pool=new Pool({connectionString:validateFixtureTarget(config).connectionString,ssl:false,max:3});
let fixture:ForensicFixture;
beforeAll(async()=>{fixture=await provisionForensicFixture(config);});afterAll(()=>pool.end());
const identity=(jobId:string)=>({companyId:fixture.companyA,personId:fixture.u1.id,jobId});
const actor=<T>(work:()=>Promise<T>)=>withAuditWorkerTransaction(pool,identity(randomUUID()),'read committed',Date.now()+10000,undefined,
 store=>withControlRequest(store,{companyId:fixture.companyA,personId:fixture.u1.id,authMethod:'cookie'},work));
const checkRun=async()=>(await actor(()=>enqueueAuditCheckRuns(requireControlTx(),{cutoff:'2026-09-09',checks:['journal_risk_checks'],idempotencyKey:randomUUID()}))).jobs[0]!.id;
const snapshot=async()=>(await actor(()=>enqueueAuditSnapshot(requireControlTx(),{cutoff:'2026-09-09',sources:['journals'],checks:[],idempotencyKey:randomUUID()}))).id;
const row=async(jobId:string)=>(await pool.query('SELECT row_to_json(j)::text AS row FROM control_audit_jobs j WHERE company_id=$1 AND job_id=$2',[fixture.companyA,jobId])).rows[0].row as string;
const remainingSeconds=async(jobId:string)=>Number((await pool.query('SELECT extract(epoch FROM lease_expires_at-clock_timestamp()) AS s FROM control_audit_jobs WHERE company_id=$1 AND job_id=$2',[fixture.companyA,jobId])).rows[0].s);
const workerClaim=(jobId:string,kinds:readonly string[])=>withAuditWorkerTransaction(pool,identity(jobId),'read committed',Date.now()+5000,undefined,
 store=>claimAuditJobForWorker(store,jobId,kinds as never));
it('leaves an out-of-class job byte-identical and never claims on a status read',async()=>{
 const check=await checkRun(),snap=await snapshot(),before=[await row(check),await row(snap)];
 expect(await workerClaim(check,AUDIT_WORKER_CLASS_KINDS.audit)).toBeNull();
 expect(await workerClaim(snap,AUDIT_WORKER_CLASS_KINDS.check_run)).toBeNull();
 for(let n=0;n<3;n++)expect(await actor(()=>getAuditJob(requireControlTx(),check))).toMatchObject({state:'queued',attempts:0});
 expect([await row(check),await row(snap)]).toEqual(before);
});
it('sets the lease from the claimed kind: maxRuntime plus grace for a check run, 90 s otherwise',async()=>{
 const check=await checkRun(),snap=await snapshot();
 expect(await workerClaim(check,AUDIT_WORKER_CLASS_KINDS.check_run)).not.toBeNull();
 expect(await workerClaim(snap,AUDIT_WORKER_CLASS_KINDS.audit)).not.toBeNull();
 const [checkLease,snapLease]=[await remainingSeconds(check),await remainingSeconds(snap)];
 expect(checkLease).toBeGreaterThan(325);expect(checkLease).toBeLessThanOrEqual(330);
 expect(snapLease).toBeGreaterThan(85);expect(snapLease).toBeLessThanOrEqual(90);
 const viaStatus=await checkRun();expect(await actor(()=>claimAuditJob(requireControlTx(),viaStatus,AUDIT_WORKER_CLASS_KINDS.audit))).toBeNull();
 expect(await actor(()=>claimAuditJob(requireControlTx(),viaStatus,AUDIT_WORKER_CLASS_KINDS.check_run))).not.toBeNull();
 expect(await remainingSeconds(viaStatus)).toBeGreaterThan(325);
 // A running check run inside its lease is invisible to every poller class: no second unit is started.
 const seen:string[]=[];
 for(const kinds of [AUDIT_WORKER_CLASS_KINDS.check_run,AUDIT_WORKER_CLASS_KINDS.audit]){
  const poller=createAuditJobPoller({companyIds:[fixture.companyA],kinds:[...kinds],batchSize:10},{pool,executeJob:async id=>{seen.push(id.jobId);return{state:'not_claimed'};}});
  while((await poller.pollOnce()).attempted>0);
 }
 for(const id of [check,viaStatus,snap])expect(seen).not.toContain(id);
});
interface Seen {statement:number;idle:number}
function observing(target:Pool,seen:Seen[]):Pool{
 return{connect:async()=>{
  const client=await target.connect(),query=client.query.bind(client),release=client.release.bind(client);
  const patched=client as unknown as {query:(...args:unknown[])=>Promise<unknown>;release:(error?:Error|boolean)=>void};
  patched.query=async(...args:unknown[])=>{
   if(args[0]==='SELECT pg_backend_pid() AS pid'){
    const settings=await query("SELECT (SELECT setting::int FROM pg_settings WHERE name='statement_timeout') AS statement,(SELECT setting::int FROM pg_settings WHERE name='idle_in_transaction_session_timeout') AS idle");
    seen.push(settings.rows[0] as Seen);
   }
   return (query as (...a:unknown[])=>Promise<unknown>)(...args);
  };
  patched.release=(error?:Error|boolean)=>{patched.query=query as never;patched.release=release as never;release(error);};
  return client as PoolClient;
 }} as unknown as Pool;
}
it('observes a <=5 s claim timeout, the class work timeout and the per-class idle timeout in PostgreSQL',async()=>{
 const check=await checkRun(),checkSeen:Seen[]=[];
 const result=await runAuditJob(identity(check),{pool:observing(pool,checkSeen),workerClass:'check_run'});
 expect(result).toMatchObject({state:'failed',code:'WORKER_ERROR',failureRecorded:true});
 expect(checkSeen).toHaveLength(3);
 // Until the T2c phase exists a claimed check run fails closed, once, and is never reclaimed.
 expect((await pool.query('SELECT state,last_error_code,attempts,lease_id FROM control_audit_jobs WHERE company_id=$1 AND job_id=$2',[fixture.companyA,check])).rows[0])
  .toEqual({state:'failed',last_error_code:'WORKER_ERROR',attempts:1,lease_id:null});
 const again=vi.fn(async()=>({state:'not_claimed' as const})),poller=createAuditJobPoller({companyIds:[fixture.companyA],kinds:['audit_check_run'],batchSize:10},{pool,executeJob:again});
 while((await poller.pollOnce()).attempted>0);
 expect(again.mock.calls.map(call=>(call as unknown as [{jobId:string}])[0].jobId)).not.toContain(check);
 expect(await runAuditJob(identity(check),{pool,workerClass:'check_run'})).toEqual({state:'not_claimed'});
 expect(checkSeen[0]!.statement).toBeLessThanOrEqual(5000);expect(checkSeen[0]!.statement).toBeGreaterThan(0);
 expect(checkSeen[1]!.statement).toBeGreaterThan(295000);expect(checkSeen[1]!.statement).toBeLessThanOrEqual(300000);
 for(const seen of checkSeen)expect(seen.idle).toBe(15000);
 expect((await pool.query('SELECT count(*)::int AS n FROM control_audit_check_results WHERE company_id=$1 AND job_id=$2',[fixture.companyA,check])).rows[0].n).toBe(0);
 const snap=await snapshot(),snapSeen:Seen[]=[];
 expect(await runAuditJob(identity(snap),{pool:observing(pool,snapSeen),workerClass:'audit'})).toMatchObject({state:'succeeded',snapshotId:snap});
 expect(snapSeen).toHaveLength(2);
 expect(snapSeen[0]!.statement).toBeLessThanOrEqual(5000);expect(snapSeen[1]!.statement).toBeGreaterThan(55000);expect(snapSeen[1]!.statement).toBeLessThanOrEqual(60000);
 for(const seen of snapSeen)expect(seen.idle).toBe(0);
});
it('each poller class discovers only its own kinds',async()=>{
 const check=await checkRun(),snap=await snapshot();
 const discovered=async(kinds:readonly AuditJobKind[])=>{
  const executeJob=vi.fn(async()=>({state:'not_claimed' as const}));
  const poller=createAuditJobPoller({companyIds:[fixture.companyA],kinds:[...kinds],batchSize:10},{pool,executeJob});
  while((await poller.pollOnce()).attempted>0);
  return executeJob.mock.calls.map(call=>(call as unknown as [{jobId:string}])[0].jobId);
 };
 const audit=await discovered(AUDIT_WORKER_CLASS_KINDS.audit),checks=await discovered(AUDIT_WORKER_CLASS_KINDS.check_run);
 expect(audit).toContain(snap);expect(audit).not.toContain(check);
 expect(checks).toContain(check);expect(checks).not.toContain(snap);
});
