import {afterAll,beforeAll,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {auditCheckRunRestFixture} from './auditCheckRunRestFixture';
import {openAuditJobRequest} from '@/modules/accounting/services/controls/auditJobProtection';
let f:Awaited<ReturnType<typeof auditCheckRunRestFixture>>,checkRunId:string;
const key=randomUUID();
beforeAll(async()=>{f=await auditCheckRunRestFixture();},60000);
afterAll(async()=>{if(f)await f.close();});
const body=()=>({cutoff:'2026-09-09',checks:['journal_risk_checks'],idempotencyKey:key});
it('queues one job per check through actual cookie auth and retains the original person delegation',async()=>{
 const response=await f.request('POST',body());
 expect(response.status,`enqueue refused: ${JSON.stringify(response.body)}`).toBe(200);
 const first=response.body.data as {runGroupId:string;jobs:Array<{id:string;kind:string;state:string;attempts:number;checkId:string;resultCheckRunId:string|null}>};
 expect(first.jobs).toHaveLength(1);
 expect(first.jobs[0]).toMatchObject({kind:'audit_check_run',state:'queued',attempts:0,checkId:'journal_risk_checks',resultCheckRunId:null});
 checkRunId=first.jobs[0]!.id;
 const repeat=await f.request('POST',body());
 expect(repeat.status).toBe(200);
 expect((repeat.body.data as typeof first).jobs.map(job=>job.id)).toEqual([checkRunId]);
 expect((repeat.body.data as typeof first).runGroupId).toBe(first.runGroupId);
 const intents=await f.pool.query("SELECT id FROM control_audit_job_intents WHERE company_id=$1 AND kind='audit_check_run'",[f.f.companyA]);
 expect(intents.rows,'a repeat enqueue created a second intent').toHaveLength(1);
 const stored=(await f.pool.query('SELECT * FROM control_audit_job_intents WHERE company_id=$1 AND id=$2',[f.f.companyA,checkRunId])).rows[0];
 expect(openAuditJobRequest(stored)).toMatchObject({kind:'audit_check_run',authority:{personId:f.f.u1.id,authMethod:'cookie',connectionId:null,grantId:null},
  request:{checkId:'journal_risk_checks',permissions:['read:reports']}});
 // Metadata-only enqueue: the transport never scans, so no result row exists yet.
 expect((await f.pool.query('SELECT job_id FROM control_audit_check_results WHERE company_id=$1 AND job_id=$2',[f.f.companyA,checkRunId])).rows).toEqual([]);
},60000);
it('refuses a read before publication, then serves complete authenticated pages over HTTP',async()=>{
 expect((await f.request('GET',{checkRunId})).status).toBe(500);
 expect(await f.run(checkRunId)).toMatchObject({state:'succeeded',checkRunId});
 const first=await f.request('GET',{checkRunId,limit:1});
 expect(first.status,`page refused: ${JSON.stringify(first.body)}`).toBe(200);
 const page=first.body.data as {findingCount:number;findings:unknown[];nextCursor:string|null;canonicalHash:string;status:string;
  populationCountBasis:string;sourceVersions:{available:boolean;reason:string;count:number};checkId:string};
 expect(page).toMatchObject({checkId:'journal_risk_checks',populationCountBasis:'streamed'});
 expect(page.sourceVersions).toMatchObject({available:false,reason:'deferred_paged_source_versions'});
 expect(page.findingCount).toBeGreaterThanOrEqual(2);
 expect(page.findings).toHaveLength(1);expect(page.nextCursor).toBe('1');
 const second=await f.request('GET',{checkRunId,limit:1,cursor:page.nextCursor!});
 expect(second.status).toBe(200);
 expect((second.body.data as typeof page).canonicalHash).toBe(page.canonicalHash);
 const whole=await f.request('GET',{checkRunId});
 expect((whole.body.data as typeof page).findings).toHaveLength(page.findingCount);
 expect((whole.body.data as typeof page).nextCursor).toBeNull();
},60000);
it('refuses a foreign tenant, a bad cursor, a missing CSRF token and an unsupported method',async()=>{
 expect((await f.request('GET',{checkRunId},'u3')).status).toBe(500);
 expect((await f.request('GET',{checkRunId,limit:101})).status).toBe(400);
 expect((await f.request('GET',{checkRunId,cursor:'not-a-cursor'})).status).toBe(400);
 expect((await f.request('GET',{})).status).toBe(400);
 expect((await f.request('POST',{...body(),idempotencyKey:randomUUID(),checks:['not_a_check']})).status).toBe(400);
 expect((await f.request('POST',body(),'u1',false)).status).toBe(403);
 expect((await f.request('DELETE',{checkRunId})).status).toBe(405);
},60000);
it('forbids the page read with 403 once current read:reports is revoked',async()=>{
 await f.pool.query("INSERT INTO company_user_permissions(company_id,user_id,module_key,can_read) VALUES($1,$2,'reports',false)",[f.f.companyA,f.f.u1.id]);
 try{
  const refused=await f.request('GET',{checkRunId});
  expect(refused.status,'a reader without current read:reports was served a findings page').toBe(403);
  expect((await f.request('POST',{...body(),idempotencyKey:randomUUID()})).status).toBe(403);
 }finally{await f.pool.query("DELETE FROM company_user_permissions WHERE company_id=$1 AND user_id=$2 AND module_key='reports'",[f.f.companyA,f.f.u1.id]);}
 expect((await f.request('GET',{checkRunId})).status).toBe(200);
},60000);
