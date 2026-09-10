import {afterAll,beforeAll,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {auditDeliveryFixture} from './auditDeliveryFixture';
import {runAuditJob} from '@/modules/accounting/services/controls/auditJobRunner';
import type {ControlFinding} from '@/modules/accounting/services/controls/contracts';
type Job={id:string;state:string;attempts:number;kind:string;checkId?:string;runGroupId?:string;resultCheckRunId?:string|null};
type Enqueued={runGroupId:string;jobs:Job[]};
type Summary={version:number;companyId:string;checkRunId:string;generation:number;canonicalHash:string;permissions:string[];
 checkId:string;checkVersion:number;cutoff:string;status:string;populationCount:number;excludedCount:number;findingCount:number;
 populationCountBasis:string;amountTotals:Record<string,string>;coverage:string[];missingSources:string[];populationDigest:string;
 sourceVersions:{available:boolean;reason:string;count:number}};
type Page=Summary&{findings:ControlFinding[];nextCursor:string|null};
let f:Awaited<ReturnType<typeof auditDeliveryFixture>>,checkRunId:string;
const key=randomUUID();
beforeAll(async()=>{
 f=await auditDeliveryFixture();
 // Two journals posted on a Saturday evening against a backdated accounting date: three signals each, so the
 // findings page has something to page through. No lines: the threshold path is exercised by the controls suite.
 for(const _row of [0,1])await f.pool.query(`INSERT INTO gl_journal_entries(id,company_id,entry_number,entry_date,status,source,created_by,posted_by,posted_at)
  VALUES(gen_random_uuid(),$1,left(gen_random_uuid()::text,20),'2026-08-31','posted','auto_migration',$2,$2,'2026-09-05T20:00:00+02:00')`,[f.fixture.companyA,f.fixture.u1.id]);
},60000);
afterAll(async()=>{if(f)await f.close();});
const args={cutoff:'2026-09-09',checks:['journal_risk_checks'],idempotency_key:key};
it('enqueues one check run per check, refuses every read before publication and delivers the sealed result',async()=>{
 const [a,b]=await Promise.all([f.call<Enqueued>('run_control_checks',{...args,company_id:f.fixture.companyA}),f.call<Enqueued>('run_control_checks',args)]);
 expect(a.runGroupId).toBe(b.runGroupId);
 expect(a.jobs.map(job=>job.id)).toEqual(b.jobs.map(job=>job.id));
 expect(a.jobs).toHaveLength(1);checkRunId=a.jobs[0]!.id;
 expect(await f.call<Job>('audit_job_status',{job_id:checkRunId})).toMatchObject({kind:'audit_check_run',state:'queued',attempts:0,checkId:'journal_risk_checks',resultCheckRunId:null});
 for(const tool of ['control_check_run','control_check_run_findings'])
  expect((await f.rpc(tool,{check_run_id:checkRunId})).result?.isError,`${tool} served an unpublished generation`).toBe(true);
 expect(await runAuditJob({companyId:f.fixture.companyA,personId:f.fixture.u1.id,jobId:checkRunId},{pool:f.pool,workerClass:'check_run'})).toMatchObject({state:'succeeded',checkRunId});
 expect(await f.call<Job>('audit_job_status',{job_id:checkRunId})).toMatchObject({state:'succeeded',resultCheckRunId:checkRunId});
 const summary=await f.call<Summary>('control_check_run',{check_run_id:checkRunId},'u2');
 expect(summary).toMatchObject({version:1,companyId:f.fixture.companyA,checkRunId,checkId:'journal_risk_checks',checkVersion:1,
  cutoff:'2026-09-09',excludedCount:0,populationCountBasis:'streamed',permissions:['read:reports']});
 expect(summary.findingCount).toBeGreaterThanOrEqual(2);
 expect(summary.populationCount).toBeGreaterThanOrEqual(3);
 // A8 finding 12: the run's public shape is CheckRunResult, which declares the deferred per-row versions rather than faking them.
 expect(summary.sourceVersions).toEqual({available:false,reason:'deferred_paged_source_versions',count:expect.any(Number)});
 expect(Object.keys(summary)).not.toContain('findings');
 const findings:ControlFinding[]=[];let cursor:string|undefined,pages=0,total=0;
 do{
  const page=await f.call<Page>('control_check_run_findings',{check_run_id:checkRunId,limit:1,...(cursor?{cursor}:{})},'u2');
  expect(page.canonicalHash).toBe(summary.canonicalHash);expect(page.findingCount).toBe(summary.findingCount);
  findings.push(...page.findings);total=page.findingCount;cursor=page.nextCursor??undefined;pages++;
 }while(cursor);
 expect(findings).toHaveLength(total);expect(pages).toBe(total);
 expect(new Set(findings.map(finding=>finding.key)).size).toBe(total);
 for(const finding of findings)expect(finding).toMatchObject({kind:'journal_investigation_lead',severity:'medium',classification:'candidate',evidence:[]});
 expect(findings.some(finding=>finding.message.includes('weekend_actual_time'))).toBe(true);
},60000);
it('refuses a foreign tenant, an oversized page, an unknown property and a forged run id',async()=>{
 // Positive control first: an unregistered tool also answers isError, so without this the refusals below pass vacuously.
 expect(await f.call<Summary>('control_check_run',{check_run_id:checkRunId})).toMatchObject({checkRunId});
 expect((await f.rpc('control_check_run_findings',{check_run_id:checkRunId,limit:100})).result?.isError).toBe(false);
 for(const tool of ['control_check_run','control_check_run_findings'])
  expect((await f.rpc(tool,{check_run_id:checkRunId},'u3')).result?.isError,`${tool} served a foreign tenant`).toBe(true);
 expect((await f.rpc('run_control_checks',{...args,idempotency_key:randomUUID()},'u3')).result?.isError).toBe(true);
 expect((await f.rpc('control_check_run_findings',{check_run_id:checkRunId,limit:101})).result?.isError).toBe(true);
 expect((await f.rpc('control_check_run',{check_run_id:checkRunId,permissions:['read:reports']})).result?.isError).toBe(true);
 expect((await f.rpc('run_control_checks',{...args,idempotency_key:randomUUID(),permissions:['read:reports']})).result?.isError).toBe(true);
 expect((await f.rpc('control_check_run',{check_run_id:randomUUID()})).result?.isError).toBe(true);
});
it('forbids both reads and a new run once current read:reports is revoked',async()=>{
 await f.pool.query("INSERT INTO company_user_permissions(company_id,user_id,module_key,can_read) VALUES($1,$2,'reports',false)",[f.fixture.companyA,f.fixture.u2.id]);
 try{
  for(const tool of ['control_check_run','control_check_run_findings'])
   expect((await f.rpc(tool,{check_run_id:checkRunId},'u2')).result?.isError,`${tool} served a reader without current read:reports`).toBe(true);
 }finally{await f.pool.query("DELETE FROM company_user_permissions WHERE company_id=$1 AND user_id=$2 AND module_key='reports'",[f.fixture.companyA,f.fixture.u2.id]);}
 await f.pool.query("INSERT INTO company_user_permissions(company_id,user_id,module_key,can_read) VALUES($1,$2,'reports',false)",[f.fixture.companyA,f.fixture.u1.id]);
 try{
  expect((await f.rpc('run_control_checks',{...args,idempotency_key:randomUUID()})).result?.isError).toBe(true);
  expect((await f.rpc('control_check_run',{check_run_id:checkRunId})).result?.isError).toBe(true);
 }finally{await f.pool.query("DELETE FROM company_user_permissions WHERE company_id=$1 AND user_id=$2 AND module_key='reports'",[f.fixture.companyA,f.fixture.u1.id]);}
 expect(await f.call<Summary>('control_check_run',{check_run_id:checkRunId})).toMatchObject({checkRunId});
});
