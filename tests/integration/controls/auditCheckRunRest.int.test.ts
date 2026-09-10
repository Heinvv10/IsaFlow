import {afterAll,beforeAll,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {auditCheckRunRestFixture} from './auditCheckRunRestFixture';
import {openAuditJobRequest} from '@/modules/accounting/services/controls/auditJobProtection';
import {withAuditWorkerTransaction} from '@/modules/accounting/services/controls/auditWorkerTransaction';
import {claimAuditJobForWorker,failAuditJobForWorker} from '@/modules/accounting/services/controls/auditJobLease';
import {AUDIT_WORKER_CLASS_KINDS} from '@/modules/accounting/services/controls/auditJobContract';
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
 // Not published yet is a 409 with a body that says so — never a 500, which a crash would also produce.
 const early=await f.request('GET',{checkRunId});
 expect(early.status).toBe(409);
 expect(early.body.error).toMatchObject({code:'CONFLICT',message:'Check run is not published yet'});
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
 // A foreign tenant's run and an absent one are indistinguishable 404s: no existence is disclosed across tenants.
 for(const [label,response] of [['foreign',await f.request('GET',{checkRunId},'u3')],['absent',await f.request('GET',{checkRunId:randomUUID()})]] as const){
  expect(response.status,`${label} run`).toBe(404);
  expect(response.body.error,`${label} run`).toMatchObject({code:'NOT_FOUND',message:'Check run not found'});
 }
 expect((await f.request('GET',{checkRunId,limit:101})).status).toBe(400);
 expect((await f.request('GET',{checkRunId,cursor:'not-a-cursor'})).status).toBe(400);
 expect((await f.request('GET',{})).status).toBe(400);
 expect((await f.request('POST',{...body(),idempotencyKey:randomUUID(),checks:['not_a_check']})).status).toBe(400);
 expect((await f.request('POST',body(),'u1',false)).status).toBe(403);
 expect((await f.request('DELETE',{checkRunId})).status).toBe(405);
},60000);
it('requires write:audit to enqueue but not to read',async()=>{
 await f.pool.query("INSERT INTO company_user_permissions(company_id,user_id,module_key,can_read,can_write) VALUES($1,$2,'audit',true,false)",[f.f.companyA,f.f.u1.id]);
 try{
  const refused=await f.request('POST',{...body(),idempotencyKey:randomUUID()});
  expect(refused.status,'a member without write:audit enqueued a check run').toBe(403);
  expect((await f.request('GET',{checkRunId})).status,'write:audit was demanded for a read').toBe(200);
 }finally{await f.pool.query("DELETE FROM company_user_permissions WHERE company_id=$1 AND user_id=$2 AND module_key='audit'",[f.f.companyA,f.f.u1.id]);}
},60000);
it('forbids the page read with 403 once current read:reports is revoked',async()=>{
 await f.pool.query("INSERT INTO company_user_permissions(company_id,user_id,module_key,can_read) VALUES($1,$2,'reports',false)",[f.f.companyA,f.f.u1.id]);
 try{
  const refused=await f.request('GET',{checkRunId});
  expect(refused.status,'a reader without current read:reports was served a findings page').toBe(403);
  const before=(await f.pool.query("SELECT count(*)::int AS n FROM control_audit_job_intents WHERE company_id=$1 AND kind='audit_check_run'",[f.f.companyA])).rows[0].n;
  expect((await f.request('POST',{...body(),idempotencyKey:randomUUID()})).status).toBe(403);
  // A 403 is a 4xx, and withAuth COMMITs the transaction on 4xx. The refusal must therefore land BEFORE the
  // intent is written, or a requester who no longer holds read:reports leaves a committed check-run intent behind.
  const after=(await f.pool.query("SELECT count(*)::int AS n FROM control_audit_job_intents WHERE company_id=$1 AND kind='audit_check_run'",[f.f.companyA])).rows[0].n;
  expect(after,'a revoked requester committed a check-run intent before being refused').toBe(before);
 }finally{await f.pool.query("DELETE FROM company_user_permissions WHERE company_id=$1 AND user_id=$2 AND module_key='reports'",[f.f.companyA,f.f.u1.id]);}
 expect((await f.request('GET',{checkRunId})).status).toBe(200);
},60000);
it('answers a failed run with a terminal status of its own, never the retry-later 409',async()=>{
 const posted=await f.request('POST',{...body(),idempotencyKey:randomUUID()});
 const jobId=(posted.body.data as {jobs:Array<{id:string}>}).jobs[0]!.id,who={companyId:f.f.companyA,personId:f.f.u1.id,jobId};
 const lease=await withAuditWorkerTransaction(f.pool,who,'read committed',Date.now()+5000,undefined,store=>claimAuditJobForWorker(store,jobId,AUDIT_WORKER_CLASS_KINDS.check_run));
 expect(lease).not.toBeNull();
 await withAuditWorkerTransaction(f.pool,who,'read committed',Date.now()+5000,undefined,store=>failAuditJobForWorker(store,lease!,'RESOURCE_LIMIT',false));
 // A polling client keys on the status: 409 means "ask again", so a run that will never publish must not answer it.
 const read=await f.request('GET',{checkRunId:jobId});
 expect(read.status,'a failed run answered as if it might still publish').toBe(422);
 expect(read.body.error).toMatchObject({code:'BUSINESS_RULE_VIOLATION',message:'Check run failed and will not publish (RESOURCE_LIMIT)'});
},60000);
it('answers a refused enqueue quota with 429, not a server error',async()=>{
 await f.pool.query(`WITH seeded AS (INSERT INTO control_audit_job_intents(company_id,id,requester_person_id,kind,idempotency_key,request_hash,protected_request)
   SELECT $1,gen_random_uuid(),$2,'audit_check_run','seed-'||gen_random_uuid(),repeat('0',64),'{"seed":true}'::jsonb FROM generate_series(1,40) RETURNING company_id,id)
  INSERT INTO control_audit_jobs(company_id,job_id,generation,state,last_error_code,completed_at) SELECT company_id,id,1,'failed','CANCELLED',clock_timestamp() FROM seeded`,[f.f.companyA,f.f.u1.id]);
 const refused=await f.request('POST',{...body(),idempotencyKey:randomUUID()});
 expect(refused.status,'a quota refusal surfaced as a server error').toBe(429);
 expect(refused.body.error).toMatchObject({code:'RATE_LIMIT'});
},60000);
