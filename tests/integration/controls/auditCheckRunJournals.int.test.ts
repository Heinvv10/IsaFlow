import {afterAll,beforeAll,expect,it} from 'vitest';
import {randomBytes,randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {provisionForensicFixture,validateFixtureTarget,type ForensicFixture} from '../forensic-fixture';
import {withControlRequest,requireControlTx} from '@/modules/accounting/services/controls/context';
import {enqueueAuditCheckRuns} from '@/modules/accounting/services/controls/auditCheckRunJobService';
import {runAuditJob} from '@/modules/accounting/services/controls/auditJobRunner';
import {withAuditWorkerTransaction} from '@/modules/accounting/services/controls/auditWorkerTransaction';
import {checkJournalRisks} from '@/modules/accounting/services/controls/journalRiskChecks';
import {collectSnapshotCheckPages} from '@/modules/accounting/services/controls/auditSnapshotCheckCapture';
import {getAuditCheckRunPage,readAuditCheckRunHeader} from '@/modules/accounting/services/controls/auditCheckRunReadService';
import {canonicalJson} from '@/modules/accounting/services/controls/canonical';
import {journalRiskThresholdGroupKey} from '@/modules/accounting/services/controls/journalRiskAnalysis';
import type {ControlCheckResult,ControlFinding} from '@/modules/accounting/services/controls/contracts';
import {CUTOFF,OVERFLOW_CUTOFF,STRADDLE_ROWS,seedJournalRiskPopulation} from './journalRiskCheckRunFixture';
process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');process.env.CONTROL_SNAPSHOT_SIGNING_KEY=randomBytes(32).toString('hex');
const config=fixtureConfigFromEnv(process.env),pool=new Pool({connectionString:validateFixtureTarget(config).connectionString,ssl:false,max:4});
let fixture:ForensicFixture;
beforeAll(async()=>{fixture=await provisionForensicFixture(config);await seedJournalRiskPopulation(pool,fixture);},180000);
afterAll(()=>pool.end());
const identity=(jobId:string)=>({companyId:fixture.companyA,personId:fixture.u1.id,jobId});
const actor=<T>(work:()=>Promise<T>,person:'u1'|'u2'='u1')=>withAuditWorkerTransaction(pool,{companyId:fixture[person].companyId,personId:fixture[person].id,jobId:randomUUID()},
 'read committed',Date.now()+120000,undefined,store=>withControlRequest(store,{companyId:fixture[person].companyId,personId:fixture[person].id,authMethod:'cookie'},work));
async function published(cutoff:string):Promise<string>{
 const run=await actor(()=>enqueueAuditCheckRuns(requireControlTx(),{cutoff,checks:['journal_risk_checks'],idempotencyKey:randomUUID()}));
 const jobId=run.jobs[0]!.id,result=await runAuditJob(identity(jobId),{pool,workerClass:'check_run'});
 expect(result,`check run ${cutoff} did not publish: ${canonicalJson(result)}`).toMatchObject({state:'succeeded',checkRunId:jobId});
 return jobId;
}
async function readAll(jobId:string){
 const first=await actor(()=>getAuditCheckRunPage(requireControlTx(),{checkRunId:jobId,limit:100}));
 const findings:ControlFinding[]=[...first.findings];let cursor=first.nextCursor;
 while(cursor){const page=await actor(()=>getAuditCheckRunPage(requireControlTx(),{checkRunId:jobId,limit:100,cursor}));
  expect(page.canonicalHash).toBe(first.canonicalHash);findings.push(...page.findings);cursor=page.nextCursor;}
 return{...first,findings};
}
const oracle=()=>actor(()=>collectSnapshotCheckPages(cursor=>checkJournalRisks(requireControlTx(),{cutoff:CUTOFF,limit:100,...(cursor?{cursor}:{})}),()=>undefined));
const byKey=(result:{findings:readonly ControlFinding[]})=>new Map(result.findings.map(finding=>[finding.key,
 {kind:finding.kind,severity:finding.severity,classification:finding.classification,entities:finding.entities,message:finding.message,evidence:finding.evidence}]));
it('publishes a complete-population run equal to the sync detector on every field the equality contract names',async()=>{
 const jobId=await published(CUTOFF),run=await readAll(jobId),sync:ControlCheckResult=await oracle();
 for(const field of ['checkId','checkVersion','cutoff','status','populationCount','excludedCount','findingCount'] as const)
  expect(canonicalJson(run[field]),`run.${field} differs from the sync detector`).toBe(canonicalJson(sync[field]));
 for(const field of ['amountTotals','coverage','missingSources'] as const)
  expect(canonicalJson(run[field]),`run.${field} differs from the sync detector`).toBe(canonicalJson(sync[field]));
 expect(run.missingSources).toContain('unsupported_or_bounded_current_journal_policy');
 expect(run.missingSources).toContain('journal_change_history_exceeds_100');
 expect(run.missingSources).toContain('journal_line_material_exceeds_100');
 expect(run.missingSources).not.toContain('async_scan_required:journal_population_exceeds_10000');
 const [runFindings,syncFindings]=[byKey(run),byKey(sync)];
 expect([...runFindings.keys()].sort(),'run finding keys differ from the sync detector').toEqual([...syncFindings.keys()].sort());
 for(const [key,value] of runFindings)expect(canonicalJson(value),`finding ${key} differs from the sync detector`).toBe(canonicalJson(syncFindings.get(key)));
 expect(run.sourceVersions).toEqual({available:false,reason:'deferred_paged_source_versions',count:sync.sourceVersions.length});
 expect(run.populationCountBasis).toBe('streamed');
},180000);
it('carries a threshold slab across the FETCH boundary instead of splitting it into two under-threshold groups',async()=>{
 const jobId=await published(CUTOFF),run=await readAll(jobId);
 const split=run.findings.filter(finding=>finding.message.includes('possible_threshold_split'));
 expect(split.length,'the straddling slab lost findings across the FETCH page boundary').toBeGreaterThanOrEqual(STRADDLE_ROWS);
 const [{n}]=(await pool.query('SELECT count(*)::int AS n FROM control_audit_check_findings WHERE company_id=$1 AND job_id=$2',[fixture.companyA,jobId])).rows;
 expect(n).toBe(run.findingCount);
},180000);
it('publishes unknown with a recounted population when a slab exceeds its resource limit',async()=>{
 const jobId=await published(OVERFLOW_CUTOFF),run=await readAll(jobId);
 expect(run.status).toBe('unknown');expect(run.findingCount).toBe(0);expect(run.findings).toEqual([]);
 expect(run.missingSources).toEqual(['resource_limit:slab_rows_exceed_limit']);
 expect(run.amountTotals).toEqual({});expect(run.excludedCount).toBe(0);
 expect(run.populationCountBasis).toBe('recount_after_limit');
 const [{n}]=(await pool.query('SELECT count(*)::int AS n FROM gl_journal_entries WHERE company_id=$1 AND status=$2 AND entry_date<=$3',[fixture.companyA,'posted',OVERFLOW_CUTOFF])).rows;
 expect(run.populationCount).toBe(n);
 const rows=await pool.query('SELECT count(*)::int AS n FROM control_audit_check_findings WHERE company_id=$1 AND job_id=$2',[fixture.companyA,jobId]);
 expect(rows.rows[0].n).toBe(0);
},180000);
it('refuses a duplicate finding key, a tampered seal, an unpublished generation and a foreign-tenant reader',async()=>{
 const jobId=await published(CUTOFF);
 await expect(actor(()=>readAuditCheckRunHeader(requireControlTx(),randomUUID()))).rejects.toThrow(/unavailable/i);
 const other=await actor(()=>enqueueAuditCheckRuns(requireControlTx(),{cutoff:CUTOFF,checks:['journal_risk_checks'],idempotencyKey:randomUUID()}));
 await expect(actor(()=>readAuditCheckRunHeader(requireControlTx(),other.jobs[0]!.id))).rejects.toThrow(/unavailable/i);
 await expect(actor(()=>readAuditCheckRunHeader(requireControlTx(),jobId),'u3')).rejects.toThrow(/unavailable/i);
 // The writer's RETURNING identity check rests on this constraint: one key may occupy only one ordinal per generation.
 await expect(pool.query(`INSERT INTO control_audit_check_findings(company_id,job_id,generation,lease_id,ordinal,finding_key,protected_item)
  SELECT company_id,job_id,generation,lease_id,999999,finding_key,protected_item FROM control_audit_check_findings
  WHERE company_id=$1 AND job_id=$2 AND ordinal=0`,[fixture.companyA,jobId])).rejects.toMatchObject({code:'23505'});
 await pool.query(`UPDATE control_audit_check_findings SET protected_item=jsonb_set(protected_item,'{authentication}',to_jsonb($3::text))
  WHERE company_id=$1 AND job_id=$2 AND ordinal=0`,[fixture.companyA,jobId,'0'.repeat(64)]);
 await expect(actor(()=>getAuditCheckRunPage(requireControlTx(),{checkRunId:jobId,limit:100}))).rejects.toThrow(/authentication failed/i);
 const truncated=await published(CUTOFF);
 await pool.query('DELETE FROM control_audit_check_findings WHERE company_id=$1 AND job_id=$2 AND ordinal=0',[fixture.companyA,truncated]);
 await expect(actor(()=>readAuditCheckRunHeader(requireControlTx(),truncated))).rejects.toThrow(/population incomplete/i);
},180000);
it('never groups two rows in one threshold group that the SQL slab tuple would separate',async()=>{
 // One-directional (plan A20): same detector group key implies the same SQL tuple. SAST edge instants included.
 const instants=['2026-03-01T21:59:00Z','2026-03-01T22:00:00Z','2026-03-01T23:59:00Z','2026-03-02T00:00:00Z','2026-06-30T22:00:01Z','2026-12-31T21:59:59Z'];
 for(let index=0;index<60;index++)instants.push(new Date(Date.UTC(2026,index%12,1+(index%27),index%24,(index*7)%60)).toISOString());
 const rows=await pool.query(`SELECT x.at::text AS at,((x.at) AT TIME ZONE 'Africa/Johannesburg')::date::text AS slab_day
  FROM unnest($1::timestamptz[]) AS x(at)`,[instants]);
 for(const row of rows.rows){
  const key=journalRiskThresholdGroupKey({actualAt:row.at,personId:'p',currency:'ZAR'});
  expect(key,`detector group key disagrees with the SQL slab tuple at ${row.at}`).toBe(JSON.stringify([row.slab_day,'p','ZAR']));
 }
});
it('exposes no monetary or entity-derived value to a same-tenant member reading the raw tables',async()=>{
 const jobId=await published(CUTOFF);
 const results=await pool.query('SELECT * FROM control_audit_check_results WHERE company_id=$1 AND job_id=$2',[fixture.companyA,jobId]);
 const findings=await pool.query('SELECT * FROM control_audit_check_findings WHERE company_id=$1 AND job_id=$2 ORDER BY ordinal LIMIT 5',[fixture.companyA,jobId]);
 const plain=canonicalJson([results.rows.map(row=>({...row,protected_header:Object.keys(row.protected_header).sort()})),
  findings.rows.map(row=>({...row,protected_item:Object.keys(row.protected_item).sort()}))]);
 const sync=await oracle();
 for(const amount of Object.values(sync.amountTotals))expect(plain,'a monetary total leaked outside the sealed envelope').not.toContain(amount);
 for(const finding of sync.findings.slice(0,5))for(const entity of finding.entities)expect(plain,'an entity id leaked outside the sealed envelope').not.toContain(entity.entityId);
},180000);
