import {afterAll,beforeAll,expect,it} from 'vitest';
import {randomBytes,randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {provisionForensicFixture,validateFixtureTarget,type ForensicFixture} from '../forensic-fixture';
import {withControlRequest,withControlJobRequest,requireControlTx} from '@/modules/accounting/services/controls/context';
import {enqueueAuditCheckRuns} from '@/modules/accounting/services/controls/auditCheckRunJobService';
import {claimAuditJobForWorker,failAuditJobForWorker,type AuditJobLease} from '@/modules/accounting/services/controls/auditJobLease';
import {AUDIT_WORKER_CLASS_KINDS} from '@/modules/accounting/services/controls/auditJobContract';
import {withAuditWorkerTransaction} from '@/modules/accounting/services/controls/auditWorkerTransaction';
import {runAuditCheckRunPhase} from '@/modules/accounting/services/controls/auditCheckRunPhase';
import {publishAuditCheckRunUnknown} from '@/modules/accounting/services/controls/auditCheckRunUnknown';
import {CheckRunResourceLimitError} from '@/modules/accounting/services/controls/auditCheckRunBudget';
import {getAuditCheckRunPage,getAuditCheckRunSummary} from '@/modules/accounting/services/controls/auditCheckRunReadService';
import {runAuditJob} from '@/modules/accounting/services/controls/auditJobRunner';
import {AUDIT_CHECK_RUN_LIMITS} from '@/modules/accounting/services/controls/auditCheckRunContract';
import {AUDIT_PROCESS_LIMITS} from '@/modules/accounting/services/controls/auditJobProcessContract';
process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');process.env.CONTROL_SNAPSHOT_SIGNING_KEY=randomBytes(32).toString('hex');
const config=fixtureConfigFromEnv(process.env),pool=new Pool({connectionString:validateFixtureTarget(config).connectionString,ssl:false,max:4});
const PRODUCTION=AUDIT_CHECK_RUN_LIMITS.journal_risk_checks,NARROW='2026-06-30',WIDE='2026-07-31',DEV_ROWS=2500;
let slab:ForensicFixture,dev:ForensicFixture,pair:ForensicFixture,none:ForensicFixture;
/**
 * One (Saturday, person, ZAR) slab under one usable rule at 1000. Every row is a weekend finding. Only rows at or
 * below the rule can join its group: amount 100 can, 5000 (above it) and 0 (not positive) never can. G4 carries a later
 * accounting date, so the NARROW cutoff sees 3 groupable of 9 rows and the WIDE one 4 groupable of 10.
 */
async function seed(fixture:ForensicFixture,rows:Array<[amount:string,entryDate:string]>,postedAt:string,rule:string|Array<[operator:string,amount:string]>){
 const account=randomUUID(),person=randomUUID(),company=fixture.companyA;
 await pool.query(`INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,normal_balance) VALUES($1,$2,'1000','Limits','asset','debit')`,[account,company]);
 for(const [operator,amount] of typeof rule==='string'?[['greater_than',rule]]:rule)
  await pool.query(`INSERT INTO approval_rules(id,company_id,name,document_type,condition_field,condition_operator,condition_value,approver_role,is_active)
   VALUES(gen_random_uuid(),$1,'Limit rule','journal_entry','amount',$2,$3,'admin',true)`,[company,operator,amount]);
 await pool.query(`WITH src AS (SELECT gen_random_uuid() AS id,r.amount,r.entry FROM jsonb_to_recordset($4::jsonb) AS r(amount numeric,entry date)),
  entries AS (INSERT INTO gl_journal_entries(id,company_id,entry_number,entry_date,status,source,posted_at,posted_by,created_at,created_by)
   SELECT id,$1,left(id::text,20),entry,'posted','manual',$2::timestamptz,$3::uuid,$2::timestamptz,$5 FROM src RETURNING id)
  INSERT INTO gl_journal_lines(company_id,journal_entry_id,gl_account_id,debit,credit) SELECT $1,s.id,$6,s.amount,0 FROM src s JOIN entries e ON e.id=s.id`,
 [company,postedAt,person,JSON.stringify(rows.map(([amount,entry])=>({amount,entry}))),fixture.u1.id,account]);
}
beforeAll(async()=>{
 slab=await provisionForensicFixture(config);dev=await provisionForensicFixture(config);pair=await provisionForensicFixture(config);none=await provisionForensicFixture(config);
 const day='2026-06-06',saturday='2026-06-06T10:00:00+02:00';
 await seed(slab,[['100',day],['100',day],['100',day],['5000',day],['5000',day],['5000',day],['5000',day],['5000',day],['0',day],['100','2026-07-15']],saturday,'1000');
 // Dev-shaped: one user's batch day, every journal an ordinary amount that CAN join a threshold group (plan v8 A27).
 await seed(dev,Array.from({length:DEV_ROWS},()=>['100','2026-06-08'] as [string,string]),'2026-06-08T10:00:00+02:00','1000000000');
 // Two usable rules: 100 can join both groups, 500 only the 1000 group (it is already past 200 on its own).
 await seed(pair,[['100',day],['100',day],['500',day],['500',day]],saturday,[['greater_than','1000'],['greater_than','200']]);
 // No usable rule at all ('any' is door 3 of plan A24): nothing can join a group, whatever the slab's size.
 await seed(none,Array.from({length:5},()=>['100',day] as [string,string]),saturday,[['any','0']]);
},120000);
afterAll(()=>pool.end());
const who=(fixture:ForensicFixture)=>({companyId:fixture.companyA,personId:fixture.u1.id});
const actor=<T>(fixture:ForensicFixture,work:()=>Promise<T>)=>withAuditWorkerTransaction(pool,{...who(fixture),jobId:randomUUID()},'read committed',Date.now()+60000,undefined,
 store=>withControlRequest(store,{...who(fixture),authMethod:'cookie'},work));
async function leased(fixture:ForensicFixture,cutoff:string):Promise<AuditJobLease>{
 const run=await actor(fixture,()=>enqueueAuditCheckRuns(requireControlTx(),{cutoff,checks:['journal_risk_checks'],idempotencyKey:randomUUID()}));
 const jobId=run.jobs[0]!.id;
 const lease=await withAuditWorkerTransaction(pool,{...who(fixture),jobId},'read committed',Date.now()+5000,undefined,store=>claimAuditJobForWorker(store,jobId,AUDIT_WORKER_CLASS_KINDS.check_run));
 if(!lease)throw new Error('Synthetic check-run claim failed');return lease;
}
/** The real phase in the real work transaction, with limits that may only tighten the production ones. */
function phase(lease:AuditJobLease,limits:Partial<typeof PRODUCTION>){
 const deadlineAt=Date.now()+AUDIT_PROCESS_LIMITS.check_run.workDeadlineMs;
 return withAuditWorkerTransaction(pool,{companyId:lease.companyId,personId:lease.personId,jobId:lease.jobId},'repeatable read',deadlineAt,undefined,
  store=>withControlJobRequest(store,lease,()=>runAuditCheckRunPhase(requireControlTx(),lease,{deadlineAt},{...PRODUCTION,...limits})),
  {idleInTransactionMs:AUDIT_PROCESS_LIMITS.check_run.idleInTransactionMs});
}
const refusal=(reason:string)=>expect.objectContaining({name:'CheckRunResourceLimitError',reason});
/**
 * A refused phase, followed by what the runner does after one: record the failure under the same lease, through the
 * production path, so the job stops counting as active. Without it, every refusal here would hold an active slot.
 */
async function refused(lease:AuditJobLease,limits:Partial<typeof PRODUCTION>):Promise<unknown>{
 // A phase that PUBLISHED returns null, and the caller's expectation of a refusal fails on its own message.
 const error=await phase(lease,limits).then(()=>null,(caught:unknown)=>caught);
 if(error!==null)await withAuditWorkerTransaction(pool,{companyId:lease.companyId,personId:lease.personId,jobId:lease.jobId},'read committed',Date.now()+5000,undefined,
  store=>failAuditJobForWorker(store,lease,'RESOURCE_LIMIT',false));
 return error;
}
it('counts only rows that can join a threshold group, and accepts a slab at exactly the bound',async()=>{
 // Positive control: a bound one below the groupable count must refuse, or the tightened limit is being ignored and
 // the acceptance below proves nothing.
 expect(await refused(await leased(slab,NARROW),{maxSlabRows:2}),'the tightened slab bound was not applied').toEqual(refusal('slab_rows_exceed_limit'));
 const lease=await leased(slab,NARROW);
 expect(await phase(lease,{maxSlabRows:3}),'three groupable rows among nine refused a bound of three').toMatchObject({checkRunId:lease.jobId});
 expect(await actor(slab,()=>getAuditCheckRunSummary(requireControlTx(),{checkRunId:lease.jobId}))).toMatchObject({status:'fail',populationCount:9,findingCount:9});
});
it('refuses the first groupable row past the slab bound',async()=>{
 expect(await refused(await leased(slab,WIDE),{maxSlabRows:3}),'one groupable row past the bound was accepted').toEqual(refusal('slab_rows_exceed_limit'));
});
it('accepts exactly maxFindings and refuses the first finding past it',async()=>{
 const at=await leased(slab,NARROW);
 expect(await phase(at,{maxFindings:9}),'exactly maxFindings findings was refused').toMatchObject({checkRunId:at.jobId});
 expect(await refused(await leased(slab,WIDE),{maxFindings:9}),'one finding past maxFindings was accepted').toEqual(refusal('findings_exceed_limit'));
});
it('lets a caller tighten the limits but never widen one',async()=>{
 for(const widened of [{maxSlabRows:PRODUCTION.maxSlabRows+1},{maxFindings:PRODUCTION.maxFindings+1},{fetchRows:PRODUCTION.fetchRows+1}])
  expect(await refused(await leased(slab,NARROW),widened),`${Object.keys(widened)[0]} was widened`).toEqual(expect.objectContaining({message:expect.stringMatching(/may only tighten/i)}));
});
it('publishes unknown with a recounted population in a fresh transaction under the same lease after a limit',async()=>{
 const lease=await leased(slab,WIDE);
 await expect(phase(lease,{maxSlabRows:3})).rejects.toBeInstanceOf(CheckRunResourceLimitError);
 // Phase A rolled back. This is what the runner does next, in its own read-committed transaction and budget.
 const unknown=await withAuditWorkerTransaction(pool,{companyId:lease.companyId,personId:lease.personId,jobId:lease.jobId},'read committed',Date.now()+10000,undefined,
  store=>withControlJobRequest(store,lease,()=>publishAuditCheckRunUnknown(requireControlTx(),lease,'slab_rows_exceed_limit')));
 expect(unknown.checkRunId).toBe(lease.jobId);
 expect(await actor(slab,()=>getAuditCheckRunSummary(requireControlTx(),{checkRunId:lease.jobId}))).toMatchObject({status:'unknown',findingCount:0,
  populationCount:10,excludedCount:0,amountTotals:{},missingSources:['resource_limit:slab_rows_exceed_limit'],populationCountBasis:'recount_after_limit'});
 expect((await pool.query('SELECT count(*)::int AS n FROM control_audit_check_findings WHERE company_id=$1 AND job_id=$2',[lease.companyId,lease.jobId])).rows[0].n).toBe(0);
});
it(`publishes a dev-shaped slab of ${DEV_ROWS} groupable journals by one user on one day at production limits`,async()=>{
 const run=await actor(dev,()=>enqueueAuditCheckRuns(requireControlTx(),{cutoff:'2026-09-09',checks:['journal_risk_checks'],idempotencyKey:randomUUID()}));
 const jobId=run.jobs[0]!.id;
 expect(await runAuditJob({...who(dev),jobId},{pool,workerClass:'check_run'})).toMatchObject({state:'succeeded',checkRunId:jobId});
 const summary=await actor(dev,()=>getAuditCheckRunSummary(requireControlTx(),{checkRunId:jobId}));
 expect(summary.missingSources,'one busy posting day made the run unknown').not.toContain('resource_limit:slab_rows_exceed_limit');
 expect(summary).toMatchObject({populationCountBasis:'streamed',populationCount:DEV_ROWS});
},120000);
it('holds a row that can join ANY usable rule\'s group, not only one that can join all of them',async()=>{
 // 500 can join the 1000 group but not the 200 one. Counting only rows eligible under EVERY rule would hold two rows,
 // analyse the 500s alone and lose the split they share with the 100s under 1000.
 expect(await refused(await leased(pair,NARROW),{maxSlabRows:3}),'a row eligible under one rule of two was not held').toEqual(refusal('slab_rows_exceed_limit'));
 const lease=await leased(pair,NARROW);
 expect(await phase(lease,{maxSlabRows:4})).toMatchObject({checkRunId:lease.jobId});
 const [rule]=(await pool.query("SELECT id::text AS id FROM approval_rules WHERE company_id=$1 AND condition_value=1000",[pair.companyA])).rows;
 const page=await actor(pair,()=>getAuditCheckRunPage(requireControlTx(),{checkRunId:lease.jobId,limit:100}));
 expect(page.findingCount).toBe(4);
 for(const finding of page.findings)expect(finding.message,'a row lost the split it shares under the 1000 rule').toContain(`possible_threshold_split:${rule.id}:v1`);
});
it('holds nothing when no rule is usable, so a slab of any size publishes past a tightened bound',async()=>{
 const lease=await leased(none,NARROW);
 expect(await phase(lease,{maxSlabRows:2}),'rows that can join no group were held against the slab bound').toMatchObject({checkRunId:lease.jobId});
 expect(await actor(none,()=>getAuditCheckRunSummary(requireControlTx(),{checkRunId:lease.jobId}))).toMatchObject({populationCount:5,findingCount:5});
});
