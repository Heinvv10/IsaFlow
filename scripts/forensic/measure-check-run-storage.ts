/**
 * Plan v10 measurement, not a gate: what one check-run finding costs on disk — heap, both indexes and TOAST — for three
 * message shapes, measured as pg_relation_size / pg_indexes_size / pg_total_relation_size deltas around a real worker run
 * in an owned disposable database with nothing else writing. It derives bytes per run at maxFindings and bytes per day
 * at the company's enqueue cap. It does not choose the cap: that is Hein's decision with this number in front of him.
 *
 * bun scripts/forensic/measure-check-run-storage.ts <observation.json>
 *  env: ISAFLOW_FORENSIC_FIXTURE_* (a generated port, never 33149), ISAFLOW_FORENSIC_AUDIT_ARTIFACT, ISAFLOW_WORKER_NODE_PATH.
 */
import {randomBytes,randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {Pool} from 'pg';
import {fixtureConfigFromEnv} from './fixture-bootstrap';
import {provisionForensicFixture,validateFixtureTarget,type ForensicFixture} from '../../tests/integration/forensic-fixture';
import {seedJournalRiskScale,seedMaxMessageFindings} from '../../tests/integration/controls/journalRiskScaleFixture';
import {startCheckRunWorker} from '../../tests/integration/controls/checkRunWorkerChild';
import {withControlRequest,requireControlTx} from '../../src/modules/accounting/services/controls/context';
import {withAuditWorkerTransaction} from '../../src/modules/accounting/services/controls/auditWorkerTransaction';
import {enqueueAuditCheckRuns} from '../../src/modules/accounting/services/controls/auditCheckRunJobService';
import {getAuditCheckRunPage} from '../../src/modules/accounting/services/controls/auditCheckRunReadService';
import {AUDIT_CHECK_RUN_LIMITS} from '../../src/modules/accounting/services/controls/auditCheckRunContract';
import {AUDIT_ENQUEUE_QUOTAS} from '../../src/modules/accounting/services/controls/auditEnqueueQuota';
const output=process.argv[2],env=process.env,JOURNALS=20000,artifact=env.ISAFLOW_FORENSIC_AUDIT_ARTIFACT??'',nodePath=env.ISAFLOW_WORKER_NODE_PATH??'';
type Shape='typical'|'mixed'|'worst';
/** One weekend signal per journal and no usable rule: the shortest real finding message. */
async function seedTypical(pool:Pool,fixture:ForensicFixture){
 const account=randomUUID();
 await pool.query(`INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,normal_balance) VALUES($1,$2,'1000','Typical','asset','debit')`,[account,fixture.companyA]);
 await pool.query(`WITH e AS (INSERT INTO gl_journal_entries(id,company_id,entry_number,entry_date,status,source,posted_at,posted_by,created_at,created_by)
   SELECT gen_random_uuid(),$1,'T'||g,date '2026-06-06'+7*(g%12),'posted','manual',((date '2026-06-06'+7*(g%12))::timestamp+interval '10 hours') AT TIME ZONE 'Africa/Johannesburg',
    $2::uuid,now(),$2::uuid FROM generate_series(1,$3::int) g RETURNING id)
  INSERT INTO gl_journal_lines(company_id,journal_entry_id,gl_account_id,debit,credit) SELECT $1,id,$4,100,0 FROM e`,[fixture.companyA,fixture.u1.id,JOURNALS,account]);
}
async function sizes(pool:Pool){
 const [row]=(await pool.query(`SELECT pg_relation_size('control_audit_check_findings')::float8 AS heap,pg_indexes_size('control_audit_check_findings')::float8 AS indexes,
  pg_total_relation_size('control_audit_check_findings')::float8 AS findings,pg_total_relation_size('control_audit_check_results')::float8 AS results`)).rows;
 return{heap:row.heap as number,indexes:row.indexes as number,toast:(row.findings-row.heap-row.indexes) as number,findings:row.findings as number,results:row.results as number};
}
async function measure(pool:Pool,config:ReturnType<typeof fixtureConfigFromEnv>,shape:Shape){
 const fixture=await provisionForensicFixture(config),who={companyId:fixture.companyA,personId:fixture.u1.id};
 if(shape==='typical')await seedTypical(pool,fixture);else if(shape==='mixed')await seedJournalRiskScale(pool,fixture,JOURNALS);else await seedMaxMessageFindings(pool,fixture,JOURNALS);
 const actor=<T>(work:()=>Promise<T>)=>withAuditWorkerTransaction(pool,{...who,jobId:randomUUID()},'read committed',Date.now()+60000,undefined,store=>withControlRequest(store,{...who,authMethod:'cookie'},work));
 const jobId=(await actor(()=>enqueueAuditCheckRuns(requireControlTx(),{cutoff:'2026-09-09',checks:['journal_risk_checks'],idempotencyKey:randomUUID()}))).jobs[0]!.id;
 await pool.query('CHECKPOINT');const before=await sizes(pool);
 const outcome=await startCheckRunWorker(artifact,{...who,jobId},nodePath).result;
 if(outcome.reply?.state!=='succeeded')throw new Error(`${shape} run did not publish: ${JSON.stringify(outcome.reply)}`);
 await pool.query('CHECKPOINT');const after=await sizes(pool);
 const page=await actor(()=>getAuditCheckRunPage(requireControlTx(),{checkRunId:jobId,limit:100})),lengths=page.findings.map(finding=>finding.message.length);
 const delta={heap:after.heap-before.heap,indexes:after.indexes-before.indexes,toast:after.toast-before.toast,findings:after.findings-before.findings,results:after.results-before.results};
 const perFinding=delta.findings/page.findingCount,limits=AUDIT_CHECK_RUN_LIMITS.journal_risk_checks,cap=AUDIT_ENQUEUE_QUOTAS.audit_check_run;
 const perRunAtMax=perFinding*limits.maxFindings+delta.results;
 return{shape,journals:JOURNALS,findingCount:page.findingCount,elapsedMs:outcome.elapsedMs,
  messageChars:{mean:Math.round(lengths.reduce((a,b)=>a+b,0)/lengths.length),min:Math.min(...lengths),max:Math.max(...lengths)},
  bytes:delta,bytesPerFinding:Math.round(perFinding),bytesPerRunAtMaxFindings:Math.round(perRunAtMax),
  bytesPerDayAtCompanyCap:Math.round(perRunAtMax*cap.perCompany),bytesPerDayAtMemberShare:Math.round(perRunAtMax*cap.perPrincipal)};
}
async function main(){
 if(!output?.startsWith('/'))throw new Error('Usage: bun scripts/forensic/measure-check-run-storage.ts <absolute observation.json>');
 const config=fixtureConfigFromEnv(env),target=validateFixtureTarget(config);
 if(target.port===33149)throw new Error('Never measured against the shared forensic fixture');
 if(!artifact.startsWith('/')||!nodePath.startsWith('/'))throw new Error('Absolute worker artifact and node binary required');
 env.ISAFLOW_AUDIT_WORKER_DATABASE_URL=target.connectionString;env.DATABASE_SSL='disable';
 env.ENCRYPTION_KEY=randomBytes(32).toString('hex');env.CONTROL_SNAPSHOT_SIGNING_KEY=randomBytes(32).toString('hex');
 const pool=new Pool({connectionString:target.connectionString,ssl:false,max:3}),shapes:unknown[]=[];
 try{for(const shape of ['typical','mixed','worst'] as Shape[])shapes.push(await measure(pool,config,shape));}
 finally{await writeFile(output,JSON.stringify({measuredAt:new Date().toISOString(),method:'pg_relation_size/pg_indexes_size/pg_total_relation_size deltas after CHECKPOINT around one real worker run per shape',shapes},null,1)+'\n');await pool.end();}
}
main().then(()=>process.exit(0),(error:unknown)=>{process.stderr.write(`${error instanceof Error?error.message:'measurement failed'}\n`);process.exit(1);});
