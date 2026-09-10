import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import {randomBytes,randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {provisionForensicFixture,validateFixtureTarget,type ForensicFixture} from '../forensic-fixture';
import {withControlRequest,withControlJobRequest,requireControlTx} from '@/modules/accounting/services/controls/context';
import {enqueueAuditCheckRuns} from '@/modules/accounting/services/controls/auditCheckRunJobService';
import {claimAuditJobForWorker,type AuditJobLease} from '@/modules/accounting/services/controls/auditJobLease';
import {AUDIT_WORKER_CLASS_KINDS} from '@/modules/accounting/services/controls/auditJobContract';
import {createAuditJobPoller} from '@/modules/accounting/services/controls/auditJobPoller';
import {withAuditWorkerTransaction} from '@/modules/accounting/services/controls/auditWorkerTransaction';
import {runAuditCheckRunPhase} from '@/modules/accounting/services/controls/auditCheckRunPhase';
import {AUDIT_PROCESS_LIMITS} from '@/modules/accounting/services/controls/auditJobProcessContract';
import {CUTOFF,seedJournalRiskPopulation} from './journalRiskCheckRunFixture';
process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');process.env.CONTROL_SNAPSHOT_SIGNING_KEY=randomBytes(32).toString('hex');
const config=fixtureConfigFromEnv(process.env),pool=new Pool({connectionString:validateFixtureTarget(config).connectionString,ssl:false,max:4});
const LONG=process.env.ISAFLOW_CHECK_RUN_LONG_GATES==='1';
let fixture:ForensicFixture;
beforeAll(async()=>{fixture=await provisionForensicFixture(config);await seedJournalRiskPopulation(pool,fixture);},180000);
afterAll(()=>pool.end());
const identity=(jobId:string)=>({companyId:fixture.companyA,personId:fixture.u1.id,jobId});
const actor=<T>(work:()=>Promise<T>)=>withAuditWorkerTransaction(pool,identity(randomUUID()),'read committed',Date.now()+60000,undefined,
 store=>withControlRequest(store,{companyId:fixture.companyA,personId:fixture.u1.id,authMethod:'cookie'},work));
async function queued():Promise<string>{
 const run=await actor(()=>enqueueAuditCheckRuns(requireControlTx(),{cutoff:CUTOFF,checks:['journal_risk_checks'],idempotencyKey:randomUUID()}));
 return run.jobs[0]!.id;
}
const claim=(jobId:string)=>withAuditWorkerTransaction(pool,identity(jobId),'read committed',Date.now()+5000,undefined,
 store=>claimAuditJobForWorker(store,jobId,AUDIT_WORKER_CLASS_KINDS.check_run));
/** The real phase in the real repeatable-read work transaction; holdSeconds keeps the backend busy, never idle. */
function phase(lease:AuditJobLease,holdSeconds:number,budgetMs=AUDIT_PROCESS_LIMITS.check_run.workDeadlineMs){
 const deadlineAt=Date.now()+budgetMs;
 return withAuditWorkerTransaction(pool,identity(lease.jobId),'repeatable read',deadlineAt,undefined,
  store=>withControlJobRequest(store,lease,async()=>{
   const ctx=requireControlTx();
   for(let left=holdSeconds;left>0;left-=10)await ctx.sql`SELECT pg_sleep(${Math.min(10,left)})`;
   return runAuditCheckRunPhase(ctx,lease,{deadlineAt});
  }),{idleInTransactionMs:AUDIT_PROCESS_LIMITS.check_run.idleInTransactionMs});
}
const job=async(jobId:string)=>(await pool.query('SELECT state,attempts,generation::int AS generation,result_check_run_id FROM control_audit_jobs WHERE company_id=$1 AND job_id=$2',[fixture.companyA,jobId])).rows[0];
const rowCounts=async(jobId:string)=>(await pool.query(`SELECT (SELECT count(*)::int FROM control_audit_check_results WHERE company_id=$1 AND job_id=$2) AS results,
 (SELECT count(*)::int FROM control_audit_check_findings WHERE company_id=$1 AND job_id=$2) AS findings`,[fixture.companyA,jobId])).rows[0];
it('rolls the whole run back with nothing readable when the work transaction crosses lease expiry',async()=>{
 const jobId=await queued(),lease=await claim(jobId);expect(lease).not.toBeNull();
 await pool.query("UPDATE control_audit_jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE company_id=$1 AND job_id=$2",[fixture.companyA,jobId]);
 await expect(phase(lease!,0),'a run crossing lease expiry must not publish').rejects.toThrow(/lease expired or was replaced/i);
 expect(await rowCounts(jobId)).toEqual({results:0,findings:0});
 expect(await job(jobId)).toMatchObject({state:'running',result_check_run_id:null});
},120000);
it('succeeds when the work finishes inside the grace remaining on its lease',async()=>{
 const jobId=await queued(),lease=await claim(jobId);expect(lease).not.toBeNull();
 const grace=AUDIT_PROCESS_LIMITS.check_run.workDeadlineMs===0?0:30;
 await pool.query("UPDATE control_audit_jobs SET lease_expires_at=clock_timestamp()+($3||' seconds')::interval WHERE company_id=$1 AND job_id=$2",[fixture.companyA,jobId,grace]);
 const result=await phase(lease!,0);
 expect(result.checkRunId).toBe(jobId);
 expect(await job(jobId)).toMatchObject({state:'succeeded',attempts:1,generation:1,result_check_run_id:jobId});
 expect((await rowCounts(jobId)).results).toBe(1);
},120000);
it.runIf(LONG)('publishes a run that outlives the legacy 65 s child cap',async()=>{
 const jobId=await queued(),lease=await claim(jobId);expect(lease).not.toBeNull();
 const started=Date.now(),result=await phase(lease!,130);
 expect(Date.now()-started,'the gate did not actually outlive the legacy cap').toBeGreaterThan(65000);
 expect(result.checkRunId).toBe(jobId);
 expect(await job(jobId)).toMatchObject({state:'succeeded',attempts:1,generation:1});
},500000);
it.runIf(LONG)('yields one generation and no spawn storm across three times the legacy lease',async()=>{
 const jobId=await queued(),lease=await claim(jobId);expect(lease).not.toBeNull();
 const executeJob=vi.fn(async()=>({state:'not_claimed' as const}));
 const pollers=[AUDIT_WORKER_CLASS_KINDS.audit,AUDIT_WORKER_CLASS_KINDS.check_run].map(kinds=>
  createAuditJobPoller({companyIds:[fixture.companyA],kinds:[...kinds],batchSize:10},{pool,executeJob}));
 let polling=true;
 const storm=(async()=>{while(polling){for(const poller of pollers)await poller.pollOnce();await new Promise(resolve=>setTimeout(resolve,2000));}})();
 const result=await phase(lease!,275);
 polling=false;await storm;
 expect(result.checkRunId).toBe(jobId);
 expect(executeJob.mock.calls.map(call=>(call as unknown as [{jobId:string}])[0].jobId),'a second unit was handed the running check run').not.toContain(jobId);
 expect(await job(jobId)).toMatchObject({state:'succeeded',attempts:1,generation:1,result_check_run_id:jobId});
 expect((await rowCounts(jobId)).results).toBe(1);
},500000);
