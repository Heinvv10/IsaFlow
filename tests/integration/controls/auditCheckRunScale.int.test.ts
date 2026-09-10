import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {loadavg} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {Pool} from 'pg';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {provisionForensicFixture,validateFixtureTarget,type ForensicFixture} from '../forensic-fixture';
import {withControlRequest,requireControlTx} from '@/modules/accounting/services/controls/context';
import {withAuditWorkerTransaction} from '@/modules/accounting/services/controls/auditWorkerTransaction';
import {enqueueAuditCheckRuns} from '@/modules/accounting/services/controls/auditCheckRunJobService';
import {getAuditCheckRunSummary} from '@/modules/accounting/services/controls/auditCheckRunReadService';
import {AUDIT_CHECK_RUN_LIMITS} from '@/modules/accounting/services/controls/auditCheckRunContract';
import {AUDIT_PROCESS_LIMITS} from '@/modules/accounting/services/controls/auditJobProcessContract';
import {SCALE_CUTOFF,seedJournalRiskScale,seedMaxMessageFindings,type ScaleCensus} from './journalRiskScaleFixture';
import {getAuditCheckRunPage} from '@/modules/accounting/services/controls/auditCheckRunReadService';
import {startCheckRunWorker} from './checkRunWorkerChild';
import {statementCensus} from './checkRunStatementCensus';
/**
 * T2e (plan §5, v8 A34): 100 000 journals through the REAL worker executable, a real SIGKILL mid-stream, and the
 * runner's `unknown` path at the real slab bound. Opt-in and never against the shared fixture: it seeds a million
 * rows. The worker runs as a direct child, not under systemd-run (see checkRunWorkerChild.ts for what that gives up).
 * Skipped, not failed, without the opt-in — the repo's `describe.skipIf(!enabled)` convention
 * (forensic-invocations.int.test.ts); once opted in, a misconfiguration fails loudly.
 */
const env=process.env,enabled=env.ISAFLOW_AUDIT_SCALE_OPT_IN==='1';
const JOURNALS=100000,LIMITS=AUDIT_CHECK_RUN_LIMITS.journal_risk_checks,artifact=env.ISAFLOW_FORENSIC_AUDIT_ARTIFACT??'';
const container=env.ISAFLOW_CHECK_RUN_SCALE_CONTAINER??'',report=env.ISAFLOW_CHECK_RUN_SCALE_REPORT??'';
let pool:Pool,scale:ForensicFixture,census:ScaleCensus,config:ReturnType<typeof fixtureConfigFromEnv>;
const evidence:Record<string,unknown>={};
describe.skipIf(!enabled)('check runs at 100 000 journals through the real worker',()=>{
beforeAll(async()=>{
 config=fixtureConfigFromEnv(env);const target=validateFixtureTarget(config);
 if(env.ISAFLOW_AUDIT_SCALE_OPT_IN!=='1'||env.ISAFLOW_AUDIT_SCALE_RECORDS!==String(JOURNALS)||env.ISAFLOW_AUDIT_SCALE_LARGE_LEASE!==String(JOURNALS))
  throw new Error('Explicit 100 000-journal check-run scale opt-in and lease required');
 if(target.port===33149)throw new Error('The check-run scale suite never seeds the shared forensic fixture');
 if(!artifact.startsWith('/')||!report.startsWith('/')||!/^isaflow-t2e-[a-z0-9-]+$/.test(container))throw new Error('Absolute artifact, report path and owned container required');
 env.ISAFLOW_AUDIT_WORKER_DATABASE_URL=target.connectionString;env.DATABASE_SSL='disable';
 env.ENCRYPTION_KEY=randomBytes(32).toString('hex');env.CONTROL_SNAPSHOT_SIGNING_KEY=randomBytes(32).toString('hex');
 pool=new Pool({connectionString:target.connectionString,ssl:false,max:3});
 scale=await provisionForensicFixture(config);census=await seedJournalRiskScale(pool,scale,JOURNALS);
 evidence.environment={head:(await promisify(execFile)('git',['rev-parse','HEAD'])).stdout.trim(),
  artifactSha256:createHash('sha256').update(await readFile(artifact)).digest('hex'),node:process.version,container,
  server:(await pool.query('SELECT version() AS v')).rows[0].v,workerHeapMb:AUDIT_PROCESS_LIMITS.check_run.maxOldSpaceMb,
  harness:'real worker artifact as a direct child process; no systemd-run unit, so no RuntimeMaxSec/MemoryMax wall and no unit readback'};
 evidence.fixture={...census,profile:'mixed',loadAfterSeed:loadavg()};
},1800000);
afterAll(async()=>{if(report)await writeFile(report,JSON.stringify(evidence,null,1)+'\n');await pool?.end();});
const who=(fixture:ForensicFixture)=>({companyId:fixture.companyA,personId:fixture.u1.id});
const actor=<T>(fixture:ForensicFixture,work:()=>Promise<T>)=>withAuditWorkerTransaction(pool,{...who(fixture),jobId:randomUUID()},'read committed',Date.now()+60000,undefined,
 store=>withControlRequest(store,{...who(fixture),authMethod:'cookie'},work));
const enqueue=async(fixture:ForensicFixture,cutoff=SCALE_CUTOFF)=>(await actor(fixture,()=>enqueueAuditCheckRuns(requireControlTx(),{cutoff,checks:['journal_risk_checks'],idempotencyKey:randomUUID()}))).jobs[0]!.id;
const jobRow=async(fixture:ForensicFixture,jobId:string)=>(await pool.query(`SELECT state,attempts,generation::int AS generation,result_check_run_id,
 lease_expires_at>clock_timestamp() AS live FROM control_audit_jobs WHERE company_id=$1 AND job_id=$2`,[fixture.companyA,jobId])).rows[0];
const produced=async(fixture:ForensicFixture,jobId:string)=>(await pool.query(`SELECT (SELECT count(*)::int FROM control_audit_check_results WHERE company_id=$1 AND job_id=$2) AS results,
 (SELECT count(*)::int FROM control_audit_check_findings WHERE company_id=$1 AND job_id=$2) AS findings,
 (SELECT array_agg(DISTINCT generation::int) FROM control_audit_check_findings WHERE company_id=$1 AND job_id=$2) AS generations`,[fixture.companyA,jobId])).rows[0];
async function until<T>(probe:()=>Promise<T|null|false>,timeoutMs:number,what:string):Promise<T>{
 const stop=Date.now()+timeoutMs;
 for(;;){const value=await probe();if(value)return value as T;if(Date.now()>stop)throw new Error(`Timed out waiting for ${what}`);await new Promise(resolve=>setTimeout(resolve,25));}
}
it('streams 100 000 journals through the real worker, publishes once, and issues no per-row statement',async()=>{
 const jobId=await enqueue(scale),since=new Date(Date.now()-1000).toISOString(),load=loadavg();
 const worker=startCheckRunWorker(artifact,{...who(scale),jobId}),outcome=await worker.result;
 expect(outcome.reply,`the worker did not publish: ${JSON.stringify(outcome)}`).toMatchObject({state:'succeeded',checkRunId:jobId});
 const summary=await actor(scale,()=>getAuditCheckRunSummary(requireControlTx(),{checkRunId:jobId}));
 const statements=await statementCensus(container,since,`isaflow-audit:${jobId}`,['control_change_events','gl_journal_lines','control_audit_check_findings']);
 evidence.scaleRun={jobId,elapsedMs:outcome.elapsedMs,peakRssBytes:outcome.peakRssBytes,vmHwmBytes:outcome.hwmBytes,loadBefore:load,loadAfter:loadavg(),
  populationCount:summary.populationCount,findingCount:summary.findingCount,status:summary.status,statements};
 expect(summary.populationCount).toBe(census.journals);
 expect(outcome.elapsedMs,'the run did not fit its work deadline').toBeLessThan(AUDIT_PROCESS_LIMITS.check_run.workDeadlineMs);
 expect(outcome.hwmBytes,'the worker exceeded the class memory cap').toBeLessThan(AUDIT_PROCESS_LIMITS.check_run.memoryMaxBytes);
 // A17: one FETCH per 1 000 rows plus the empty one that ends the cursor, and the child tables only inside DECLARE
 // (plus the one SQL-SUM cross-check over lines). A per-parent query would put them in ~100 000 statements.
 expect(statements.byVerb.FETCH,'FETCH count is not one per page').toBe(Math.floor(summary.populationCount/LIMITS.fetchRows)+1);
 expect(statements.mentioning.control_change_events,'change events were queried outside the cursor').toBe(1);
 expect(statements.mentioning.gl_journal_lines,'journal lines were queried outside the cursor and the SUM cross-check').toBe(2);
 expect(statements.total,'the worker issued a statement per row').toBeLessThan(summary.populationCount/100);
},1800000);
it('a SIGKILL mid-stream leaves nothing, keeps the lease until it really expires, and the next run publishes once',async()=>{
 const jobId=await enqueue(scale),app=`isaflow-audit:${jobId}`;
 const worker=startCheckRunWorker(artifact,{...who(scale),jobId});
 // Mid-stream, by outcome: the worker's transaction holds the row lock of at least one finding INSERT and is FETCHing.
 const seen=await until(async()=>{
  if(worker.child.exitCode!==null||worker.child.signalCode!==null)throw new Error('The run finished before it could be killed mid-stream');
  const rows=(await pool.query(`SELECT a.pid FROM pg_stat_activity a WHERE a.application_name=$1 AND a.query LIKE 'FETCH%'
   AND EXISTS(SELECT 1 FROM pg_locks l WHERE l.pid=a.pid AND l.relation='control_audit_check_findings'::regclass AND l.mode='RowExclusiveLock')`,[app])).rows;
  return rows[0]??null;},600000,'the worker to be streaming with findings written') as {pid:number};
 process.kill(worker.pid,'SIGKILL');
 const killed=await worker.result;
 expect(killed.signal).toBe('SIGKILL');expect(killed.reply).toBeNull();
 await until(async()=>(await pool.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid=$1 OR application_name=$2',[seen.pid,app])).rows[0].n===0||null,60000,'the dead worker backend to end');
 expect(await produced(scale,jobId),'the killed transaction left a result or finding row').toMatchObject({results:0,findings:0});
 expect(await jobRow(scale,jobId)).toMatchObject({state:'running',attempts:1,generation:1,result_check_run_id:null,live:true});
 const early=await startCheckRunWorker(artifact,{...who(scale),jobId}).result;
 expect(early.reply,'a live lease was reclaimed before expiry').toEqual({state:'not_claimed'});
 const waitStarted=Date.now();
 await until(async()=>(await jobRow(scale,jobId)).live===false||null,(LIMITS.maxRuntimeMs+LIMITS.graceMs)+60000,'the killed run\'s lease to expire');
 const rerun=await startCheckRunWorker(artifact,{...who(scale),jobId}).result;
 expect(rerun.reply,`the rerun did not publish: ${JSON.stringify(rerun)}`).toMatchObject({state:'succeeded',checkRunId:jobId});
 const summary=await actor(scale,()=>getAuditCheckRunSummary(requireControlTx(),{checkRunId:jobId}));
 expect(await jobRow(scale,jobId)).toMatchObject({state:'succeeded',attempts:2,generation:2,result_check_run_id:jobId});
 expect(await produced(scale,jobId)).toMatchObject({results:1,findings:summary.findingCount,generations:[2]});
 expect(summary.generation).toBe(2);
 expect((await startCheckRunWorker(artifact,{...who(scale),jobId}).result).reply).toEqual({state:'not_claimed'});
 evidence.hardKill={jobId,killedAfterMs:killed.elapsedMs,leaseWaitMs:Date.now()-waitStarted,rerunElapsedMs:rerun.elapsedMs,generation:2,attempts:2,findingCount:summary.findingCount};
},1800000);
it('the runner publishes unknown one groupable row past the real slab bound, and a slab exactly at it publishes',async()=>{
 const edge=await provisionForensicFixture(config),bound=LIMITS.maxSlabRows,company=edge.companyA,account=randomUUID();
 await pool.query(`INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,normal_balance) VALUES($1,$2,'1000','Edge','asset','debit')`,[account,company]);
 await pool.query(`INSERT INTO approval_rules(id,company_id,name,document_type,condition_field,condition_operator,condition_value,approver_role,is_active)
  VALUES(gen_random_uuid(),$1,'Edge rule','journal_entry','amount','greater_than',1000000000,'admin',true)`,[company]);
 // bound+1 journals by one person on one Monday, all able to join the rule's group; the last one's accounting date
 // is a month later, so cutoff 2026-06-30 sees exactly `bound` of them and 2026-07-31 sees bound+1.
 await pool.query(`WITH src AS (SELECT gen_random_uuid() AS id,g FROM generate_series(1,$4::int) g),
  entries AS (INSERT INTO gl_journal_entries(id,company_id,entry_number,entry_date,status,source,posted_at,posted_by,created_at,created_by)
   SELECT id,$1,'E'||g,CASE WHEN g=$4 THEN date '2026-07-15' ELSE date '2026-06-08' END,'posted','manual',timestamptz '2026-06-08 10:00+02',$3::uuid,timestamptz '2026-06-08 10:00+02',$3::uuid
   FROM src RETURNING id)
  INSERT INTO gl_journal_lines(company_id,journal_entry_id,gl_account_id,debit,credit) SELECT $1,id,$2,100,0 FROM entries`,[company,account,edge.u1.id,bound+1]);
 const at=await enqueue(edge,'2026-06-30'),over=await enqueue(edge,'2026-07-31');
 const atRun=await startCheckRunWorker(artifact,{...who(edge),jobId:at}).result,overRun=await startCheckRunWorker(artifact,{...who(edge),jobId:over}).result;
 expect(atRun.reply).toMatchObject({state:'succeeded',checkRunId:at});expect(overRun.reply).toMatchObject({state:'succeeded',checkRunId:over});
 const [atSummary,overSummary]=[await actor(edge,()=>getAuditCheckRunSummary(requireControlTx(),{checkRunId:at})),await actor(edge,()=>getAuditCheckRunSummary(requireControlTx(),{checkRunId:over}))];
 expect(atSummary.missingSources,'a slab exactly at the bound was refused').not.toContain('resource_limit:slab_rows_exceed_limit');
 expect(atSummary).toMatchObject({populationCountBasis:'streamed',populationCount:bound});
 expect(overSummary).toMatchObject({status:'unknown',findingCount:0,populationCount:bound+1,populationCountBasis:'recount_after_limit',missingSources:['resource_limit:slab_rows_exceed_limit']});
 evidence.slabBound={bound,atElapsedMs:atRun.elapsedMs,overElapsedMs:overRun.elapsedMs,atPeakRssBytes:atRun.peakRssBytes,overPeakRssBytes:overRun.peakRssBytes};
},1800000);
it('publishes 100 000 worst-case findings at the real worker heap instead of aborting',async()=>{
 // Every journal carries all six signals and a split under each of 100 rules at bigint-wide versions: the longest
 // message the detector writes, 100 000 times. Retaining every full finding (twice, during the re-read) exhausted the
 // 1 536 MiB heap before any bound refused; the run must publish, and its peak is what the evidence records.
 const worst=await provisionForensicFixture(config),seeded=await seedMaxMessageFindings(pool,worst,JOURNALS);
 const jobId=await enqueue(worst,'2025-12-31'),load=loadavg();
 const outcome=await startCheckRunWorker(artifact,{...who(worst),jobId}).result;
 expect(outcome.reply,`the worst-case findings run did not publish: ${JSON.stringify({reply:outcome.reply,signal:outcome.signal,code:outcome.code})}`)
  .toMatchObject({state:'succeeded',checkRunId:jobId});
 const page=await actor(worst,()=>getAuditCheckRunPage(requireControlTx(),{checkRunId:jobId,limit:100}));
 expect(page).toMatchObject({status:'fail',populationCount:JOURNALS,findingCount:JOURNALS});
 const lengths=page.findings.map(finding=>finding.message.length);
 expect(Math.min(...lengths),'the fixture did not produce the longest message').toBeGreaterThan(8600);
 evidence.worstFindings={jobId,seedMs:seeded.seedMs,elapsedMs:outcome.elapsedMs,peakRssBytes:outcome.peakRssBytes,vmHwmBytes:outcome.hwmBytes,
  loadBefore:load,loadAfter:loadavg(),findingCount:page.findingCount,messageChars:{min:Math.min(...lengths),max:Math.max(...lengths)}};
 expect(outcome.hwmBytes,'the worker exceeded the class memory cap').toBeLessThan(AUDIT_PROCESS_LIMITS.check_run.memoryMaxBytes);
},1800000);
});

