/**
 * Plan v8 A34 / v9 A37 measurement, not a gate: where a check run stops fitting its 300 s work deadline on THIS
 * machine at THIS moment. It seeds (or re-uses) a quiet population in an owned disposable database, probes once,
 * brackets the extrapolated boundary at 0.85x and 1.15x, and writes every attempt to the observation file. The only
 * thing it refuses on is the product contract: each attempt publishes inside the deadline with one result row, or
 * fails RESOURCE_LIMIT with its failure recorded and nothing published. Whether any attempt overruns is recorded.
 *
 * bun scripts/forensic/measure-check-run-deadline.ts <observation.json>
 *  env: ISAFLOW_FORENSIC_FIXTURE_* (a generated port, never 33149), ISAFLOW_FORENSIC_AUDIT_ARTIFACT, ISAFLOW_WORKER_NODE_PATH,
 *       optional ISAFLOW_CHECK_RUN_DEADLINE_PROBE (default 1 400 000) and ISAFLOW_CHECK_RUN_DEADLINE_EXISTING_COMPANY.
 */
import {randomBytes,randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {loadavg} from 'node:os';
import {Pool} from 'pg';
import {fixtureConfigFromEnv} from './fixture-bootstrap';
import {provisionForensicFixture,validateFixtureTarget,type ForensicFixture} from '../../tests/integration/forensic-fixture';
import {seedJournalRiskScale} from '../../tests/integration/controls/journalRiskScaleFixture';
import {startCheckRunWorker} from '../../tests/integration/controls/checkRunWorkerChild';
import {withControlRequest,requireControlTx} from '../../src/modules/accounting/services/controls/context';
import {withAuditWorkerTransaction} from '../../src/modules/accounting/services/controls/auditWorkerTransaction';
import {enqueueAuditCheckRuns} from '../../src/modules/accounting/services/controls/auditCheckRunJobService';
import {AUDIT_PROCESS_LIMITS} from '../../src/modules/accounting/services/controls/auditJobProcessContract';
const output=process.argv[2],env=process.env,SEEDED=3200000,PROBE=Number(env.ISAFLOW_CHECK_RUN_DEADLINE_PROBE??1400000);
const artifact=env.ISAFLOW_FORENSIC_AUDIT_ARTIFACT??'',nodePath=env.ISAFLOW_WORKER_NODE_PATH??'',existing=env.ISAFLOW_CHECK_RUN_DEADLINE_EXISTING_COMPANY;
async function main(){
 if(!output?.startsWith('/'))throw new Error('Usage: bun scripts/forensic/measure-check-run-deadline.ts <absolute observation.json>');
 const config=fixtureConfigFromEnv(env),target=validateFixtureTarget(config);
 if(target.port===33149)throw new Error('Never measured against the shared forensic fixture');
 if(!artifact.startsWith('/')||!nodePath.startsWith('/')||!Number.isSafeInteger(PROBE)||PROBE<1||PROBE>SEEDED)throw new Error('Artifact, node binary and a bounded probe required');
 env.ISAFLOW_AUDIT_WORKER_DATABASE_URL=target.connectionString;env.DATABASE_SSL='disable';
 env.ENCRYPTION_KEY=randomBytes(32).toString('hex');env.CONTROL_SNAPSHOT_SIGNING_KEY=randomBytes(32).toString('hex');
 const pool=new Pool({connectionString:target.connectionString,ssl:false,max:3}),deadline=AUDIT_PROCESS_LIMITS.check_run.workDeadlineMs,attempts:unknown[]=[];
 try{
  let fixture:ForensicFixture;
  if(existing){
   const [owner]=(await pool.query("SELECT user_id::text AS id FROM company_users WHERE company_id=$1 AND role='admin' ORDER BY user_id LIMIT 1",[existing])).rows;
   if(!owner)throw new Error('Existing company has no admin to act as requester');
   fixture={companyA:existing,u1:{id:owner.id}} as ForensicFixture;
  }else{fixture=await provisionForensicFixture(config);await seedJournalRiskScale(pool,fixture,SEEDED,'quiet');}
  const who={companyId:fixture.companyA,personId:fixture.u1.id},goals=[PROBE];
  for(let index=0;index<goals.length;index++){
   const [bound]=(await pool.query(`SELECT day::text AS cutoff,total::int AS population FROM (SELECT entry_date AS day,sum(count(*)) OVER(ORDER BY entry_date) AS total
    FROM gl_journal_entries WHERE company_id=$1 AND status='posted' GROUP BY entry_date) t WHERE total>=$2 ORDER BY day LIMIT 1`,[who.companyId,goals[index]])).rows;
   if(!bound)break;
   const jobId=(await withAuditWorkerTransaction(pool,{...who,jobId:randomUUID()},'read committed',Date.now()+60000,undefined,store=>withControlRequest(store,{...who,authMethod:'cookie'},
    ()=>enqueueAuditCheckRuns(requireControlTx(),{cutoff:bound.cutoff,checks:['journal_risk_checks'],idempotencyKey:randomUUID()})))).jobs[0]!.id;
   const loadBefore=loadavg(),outcome=await startCheckRunWorker(artifact,{...who,jobId},nodePath).result;
   const [job]=(await pool.query(`SELECT state,last_error_code,(extract(epoch FROM completed_at-started_at)*1000)::float8 AS "workMs",
    (SELECT count(*)::int FROM control_audit_check_results r WHERE r.company_id=j.company_id AND r.job_id=j.job_id) AS results FROM control_audit_jobs j WHERE company_id=$1 AND job_id=$2`,[who.companyId,jobId])).rows;
   const published=outcome.reply?.state==='succeeded';
   if(published?!(outcome.elapsedMs<deadline&&job.results===1):!(outcome.reply?.state==='failed'&&outcome.reply.code==='RESOURCE_LIMIT'&&outcome.reply.failureRecorded&&job.results===0))
    throw new Error(`Contract broken at ${bound.population}: ${JSON.stringify({reply:outcome.reply,job})}`);
   attempts.push({population:bound.population,cutoff:bound.cutoff,jobId,elapsedMs:outcome.elapsedMs,reply:outcome.reply,job,loadBefore,peakRssBytes:outcome.peakRssBytes});
   if(index===0&&published){const at=bound.population*deadline/outcome.elapsedMs;goals.push(Math.min(SEEDED,Math.round(at*0.85)),Math.min(SEEDED,Math.round(at*1.15)));}
   else if(!published)break;
  }
 }finally{await writeFile(output,JSON.stringify({measuredAt:new Date().toISOString(),workDeadlineMs:deadline,attempts},null,1)+'\n');await pool.end();}
}
main().then(()=>process.exit(0),(error:unknown)=>{process.stderr.write(`${error instanceof Error?error.message:'measurement failed'}\n`);process.exit(1);});
