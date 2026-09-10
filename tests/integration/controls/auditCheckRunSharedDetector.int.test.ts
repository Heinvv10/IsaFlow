import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
/**
 * A16: the adapter must call the SAME extracted functions the sync detector calls. Every export of the shared module is
 * replaced with a marker; a private copy of the missing-reasons loop, the finding builder or the coverage constant in
 * either path leaves that path without its marker, and this test fails.
 */
vi.mock('@/modules/accounting/services/controls/journalRiskShared',()=>({
 JOURNAL_RISK_COVERAGE:Object.freeze(['mutation_marker_coverage']),
 journalRiskMissingReasons:()=>['mutation_marker_missing'],
 buildJournalRiskFinding:(input:{row:{id:string;amount:string;currency:string};reasons:readonly string[];classification:'candidate'})=>({
  amount:input.row.amount,currency:input.row.currency,
  finding:{key:createHash('sha256').update(input.row.id).digest('hex'),kind:'mutation_marker_kind',severity:'medium' as const,
   classification:input.classification,entities:[],message:'mutation_marker_message',evidence:[]}}),
}));
const {Pool}=await import('pg');
const {fixtureConfigFromEnv}=await import('../../../scripts/forensic/fixture-bootstrap');
const {provisionForensicFixture,validateFixtureTarget}=await import('../forensic-fixture');
const {withControlRequest,requireControlTx}=await import('@/modules/accounting/services/controls/context');
const {enqueueAuditCheckRuns}=await import('@/modules/accounting/services/controls/auditCheckRunJobService');
const {runAuditJob}=await import('@/modules/accounting/services/controls/auditJobRunner');
const {withAuditWorkerTransaction}=await import('@/modules/accounting/services/controls/auditWorkerTransaction');
const {checkJournalRisks}=await import('@/modules/accounting/services/controls/journalRiskChecks');
const {collectSnapshotCheckPages}=await import('@/modules/accounting/services/controls/auditSnapshotCheckCapture');
const {getAuditCheckRunPage}=await import('@/modules/accounting/services/controls/auditCheckRunReadService');
const {CUTOFF,seedJournalRiskPopulation}=await import('./journalRiskCheckRunFixture');
type Fixture=Awaited<ReturnType<typeof provisionForensicFixture>>;
process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');process.env.CONTROL_SNAPSHOT_SIGNING_KEY=randomBytes(32).toString('hex');
const config=fixtureConfigFromEnv(process.env),pool=new Pool({connectionString:validateFixtureTarget(config).connectionString,ssl:false,max:4});
let fixture:Fixture;
beforeAll(async()=>{fixture=await provisionForensicFixture(config);await seedJournalRiskPopulation(pool,fixture);},180000);
afterAll(()=>pool.end());
const actor=<T>(work:()=>Promise<T>)=>withAuditWorkerTransaction(pool,{companyId:fixture.companyA,personId:fixture.u1.id,jobId:randomUUID()},
 'read committed',Date.now()+120000,undefined,store=>withControlRequest(store,{companyId:fixture.companyA,personId:fixture.u1.id,authMethod:'cookie'},work));
it('reflects a stub of every shared detector export in BOTH the sync check and the published run',async()=>{
 const sync=await actor(()=>collectSnapshotCheckPages(cursor=>checkJournalRisks(requireControlTx(),{cutoff:CUTOFF,limit:100,...(cursor?{cursor}:{})}),()=>undefined));
 const run=await actor(()=>enqueueAuditCheckRuns(requireControlTx(),{cutoff:CUTOFF,checks:['journal_risk_checks'],idempotencyKey:randomUUID()}));
 const jobId=run.jobs[0]!.id;
 expect(await runAuditJob({companyId:fixture.companyA,personId:fixture.u1.id,jobId},{pool,workerClass:'check_run'})).toMatchObject({state:'succeeded',checkRunId:jobId});
 const page=await actor(()=>getAuditCheckRunPage(requireControlTx(),{checkRunId:jobId,limit:100}));
 for(const [label,coverage,missing,findings] of [['sync',sync.coverage,sync.missingSources,sync.findings],['run',page.coverage,page.missingSources,page.findings]] as const){
  expect(coverage,`${label} coverage did not come from the shared constant`).toEqual(['mutation_marker_coverage']);
  expect(missing,`${label} missing sources did not come from the shared reasons loop`).toContain('mutation_marker_missing');
  expect(findings.length,`${label} produced no findings to check`).toBeGreaterThan(0);
  for(const finding of findings)expect(finding.kind,`${label} did not build findings with the shared builder`).toBe('mutation_marker_kind');
 }
},180000);
