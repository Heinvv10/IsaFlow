import {afterAll,beforeAll,expect,it} from 'vitest';
import {randomBytes,randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {loadavg} from 'node:os';
import {Pool} from 'pg';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {provisionForensicFixture,validateFixtureTarget,type ForensicFixture} from '../forensic-fixture';
import {withControlRequest,requireControlTx} from '@/modules/accounting/services/controls/context';
import {withAuditWorkerTransaction} from '@/modules/accounting/services/controls/auditWorkerTransaction';
import {enqueueAuditCheckRuns} from '@/modules/accounting/services/controls/auditCheckRunJobService';
import {AUDIT_CHECK_RUN_LIMITS} from '@/modules/accounting/services/controls/auditCheckRunContract';
import {AUDIT_PROCESS_LIMITS} from '@/modules/accounting/services/controls/auditJobProcessContract';
import {seedJournalRiskScale,type ScaleCensus} from './journalRiskScaleFixture';
import {startCheckRunWorker,type WorkerOutcome} from './checkRunWorkerChild';
/**
 * Plan v8 A34: a run that passes its 300 s work deadline is `failed`, never `unknown`, so there is a largest population
 * that can publish at all. This measures it on a quiet 3 200 000-journal population (same per-row streaming cost as the
 * mixed fixture, few findings, so the findings bound cannot end a run first). One probe of 1 400 000 (measured earlier
 * to fit) gives throughput on
 * this machine at this moment; the next two bracket the extrapolated boundary at 0.85x and 1.15x, so the largest
 * population that published and the smallest that overran are both measured, not inferred. The overrun is also the
 * only real evidence of what the lease's grace window is for (plan §4 G2).
 */
const env=process.env,config=fixtureConfigFromEnv(env),target=validateFixtureTarget(config);
const SEEDED=3200000,PROBE=Number(env.ISAFLOW_CHECK_RUN_DEADLINE_PROBE??1400000),LIMITS=AUDIT_CHECK_RUN_LIMITS.journal_risk_checks;
// Re-measuring against a population already seeded in the disposable DB; the company must already hold it.
const EXISTING=env.ISAFLOW_CHECK_RUN_DEADLINE_EXISTING_COMPANY;
const artifact=env.ISAFLOW_FORENSIC_AUDIT_ARTIFACT??'',report=env.ISAFLOW_CHECK_RUN_DEADLINE_REPORT??'';
let pool:Pool,fixture:ForensicFixture,census:ScaleCensus;
interface Attempt {target:number;cutoff:string;population:number;jobId:string;outcome:WorkerOutcome;loadBefore:number[];
 job:{state:string;attempts:number;last_error_code:string|null;startedMs:number;completedMs:number|null};leaseExpiresMs:number|null;results:number;observerErrors:number}
const attempts:Attempt[]=[];
beforeAll(async()=>{
 if(env.ISAFLOW_CHECK_RUN_DEADLINE_OPT_IN!=='1')throw new Error('Explicit check-run deadline measurement opt-in required');
 if(target.port===33149)throw new Error('The deadline measurement never seeds the shared forensic fixture');
 if(!artifact.startsWith('/')||!report.startsWith('/'))throw new Error('Absolute artifact and report path required');
 env.ISAFLOW_AUDIT_WORKER_DATABASE_URL=target.connectionString;env.DATABASE_SSL='disable';
 env.ENCRYPTION_KEY=randomBytes(32).toString('hex');env.CONTROL_SNAPSHOT_SIGNING_KEY=randomBytes(32).toString('hex');
 pool=new Pool({connectionString:target.connectionString,ssl:false,max:3});
 if(!Number.isSafeInteger(PROBE)||PROBE<1||PROBE>SEEDED)throw new Error('Bounded probe size required');
 if(EXISTING){
  if(!/^[0-9a-f-]{36}$/.test(EXISTING))throw new Error('Existing company must be a uuid');
  const [owner]=(await pool.query("SELECT user_id::text AS id FROM company_users WHERE company_id=$1 AND role='admin' ORDER BY user_id LIMIT 1",[EXISTING])).rows;
  const [counted]=(await pool.query("SELECT count(*)::int AS journals FROM gl_journal_entries WHERE company_id=$1 AND status='posted'",[EXISTING])).rows;
  if(!owner||counted.journals<PROBE)throw new Error('Existing company does not hold the probe population');
  fixture={companyA:EXISTING,u1:{id:owner.id}} as ForensicFixture;census={journals:counted.journals,lines:0,changes:0,versions:0,rules:0,seedMs:0};
 }else{fixture=await provisionForensicFixture(config);census=await seedJournalRiskScale(pool,fixture,SEEDED,'quiet');}
},3600000);
afterAll(async()=>{
 if(report)await writeFile(report,JSON.stringify({fixture:{...census,profile:'quiet'},workDeadlineMs:AUDIT_PROCESS_LIMITS.check_run.workDeadlineMs,
  leaseMs:LIMITS.maxRuntimeMs+LIMITS.graceMs,attempts:attempts.map(({outcome,...rest})=>({...rest,elapsedMs:outcome.elapsedMs,reply:outcome.reply,
   peakRssBytes:outcome.peakRssBytes,vmHwmBytes:outcome.hwmBytes}))},null,1)+'\n');
 await pool?.end();
});
const who=()=>({companyId:fixture.companyA,personId:fixture.u1.id});
async function cutoffFor(population:number):Promise<{cutoff:string;population:number}>{
 const [row]=(await pool.query(`SELECT day::text AS cutoff,total::int AS population FROM (
   SELECT entry_date AS day,sum(count(*)) OVER(ORDER BY entry_date) AS total FROM gl_journal_entries WHERE company_id=$1 AND status='posted' GROUP BY entry_date) t
  WHERE total>=$2 ORDER BY day LIMIT 1`,[fixture.companyA,population])).rows;
 if(!row)throw new Error(`No cutoff reaches ${population} journals`);return row;
}
it('measures the largest population that publishes inside the 300 s work deadline',async()=>{
 const deadline=AUDIT_PROCESS_LIMITS.check_run.workDeadlineMs,goals:number[]=[PROBE];
 for(let index=0;index<goals.length;index++){
  const goal=goals[index]!;
  const {cutoff,population}=await cutoffFor(goal);
  const jobId=(await withAuditWorkerTransaction(pool,{...who(),jobId:randomUUID()},'read committed',Date.now()+60000,undefined,
   store=>withControlRequest(store,{...who(),authMethod:'cookie'},()=>enqueueAuditCheckRuns(requireControlTx(),{cutoff,checks:['journal_risk_checks'],idempotencyKey:randomUUID()})))).jobs[0]!.id;
  const loadBefore=loadavg(),worker=startCheckRunWorker(artifact,{...who(),jobId});
  // The lease's expiry is only visible while the job runs; the failure record clears it.
  let leaseExpiresMs:number|null=null,observerErrors=0;
  const watch=setInterval(()=>{void pool.query("SELECT (extract(epoch FROM lease_expires_at)*1000)::float8 AS at FROM control_audit_jobs WHERE company_id=$1 AND job_id=$2 AND state='running'",[fixture.companyA,jobId])
   .then(result=>{leaseExpiresMs=result.rows[0]?.at??leaseExpiresMs;},()=>{observerErrors++;});},1000);
  const outcome=await worker.result;clearInterval(watch);
  const job=(await pool.query(`SELECT state,attempts,last_error_code,(extract(epoch FROM started_at)*1000)::float8 AS "startedMs",
   (extract(epoch FROM completed_at)*1000)::float8 AS "completedMs" FROM control_audit_jobs WHERE company_id=$1 AND job_id=$2`,[fixture.companyA,jobId])).rows[0];
  const results=(await pool.query('SELECT count(*)::int AS n FROM control_audit_check_results WHERE company_id=$1 AND job_id=$2',[fixture.companyA,jobId])).rows[0].n;
  attempts.push({target:goal,cutoff,population,jobId,outcome,loadBefore,job,leaseExpiresMs,results,observerErrors});
  if(index===0){
   if(outcome.reply?.state!=='succeeded')break;
   const boundary=population*deadline/outcome.elapsedMs;
   goals.push(Math.min(SEEDED,Math.round(boundary*0.85)),Math.min(SEEDED,Math.round(boundary*1.15)));
  }else if(outcome.reply?.state!=='succeeded')break;
 }
 // A measurement, so the assertion is the contract, not a guess about this machine: every run either published inside
 // the deadline or failed RESOURCE_LIMIT with its failure recorded and nothing published — never late, never unknown.
 for(const attempt of attempts){
  if(attempt.outcome.reply?.state==='succeeded'){expect(attempt.outcome.elapsedMs).toBeLessThan(deadline);expect(attempt.results).toBe(1);}
  else{expect(attempt.outcome.reply).toEqual({state:'failed',code:'RESOURCE_LIMIT',failureRecorded:true});expect(attempt.results).toBe(0);}
 }
},7200000);
it('a run past the work deadline records RESOURCE_LIMIT inside the lease grace, under the same lease, publishing nothing',async()=>{
 const overrun=attempts.find(attempt=>attempt.outcome.reply?.state!=='succeeded');
 expect(overrun,`no target overran the deadline; the largest measured (${attempts.at(-1)?.population}) still fits`).toBeDefined();
 expect(overrun!.outcome.reply).toEqual({state:'failed',code:'RESOURCE_LIMIT',failureRecorded:true});
 expect(overrun!.results,'an overrun published a result').toBe(0);
 expect(overrun!.job).toMatchObject({state:'failed',attempts:1,last_error_code:'RESOURCE_LIMIT'});
 // failureRecorded is only true when the failure UPDATE saw the lease still live; the database clock places it after
 // the work deadline and before the lease's own expiry, which is the grace window.
 const {completedMs,startedMs}=overrun!.job,expires=overrun!.leaseExpiresMs;
 expect(completedMs,'the failure record has no completion time').not.toBeNull();expect(expires,'the lease expiry was never observed').not.toBeNull();
 const completed=completedMs!,started=startedMs;
 expect(completed-started,'the failure was recorded before the work could have overrun').toBeGreaterThanOrEqual(AUDIT_PROCESS_LIMITS.check_run.workDeadlineMs-10000);
 expect(completed,'the failure record landed after the lease expired').toBeLessThan(expires!);
},60000);
