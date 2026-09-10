import {beforeAll,afterAll,it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {auditComparisonRestFixture} from './auditComparisonRestFixture';
import {openAuditJobRequest} from '@/modules/accounting/services/controls/auditJobProtection';
let f:Awaited<ReturnType<typeof auditComparisonRestFixture>>,jobId:string;
const key=randomUUID();
beforeAll(async()=>{f=await auditComparisonRestFixture();},30000);afterAll(async()=>{if(f)await f.close();});
const body=()=>({firstSnapshotId:f.first,secondSnapshotId:f.second,idempotencyKey:key});
async function jobs(){return(await f.pool.query("SELECT id FROM control_audit_job_intents WHERE company_id=$1 AND kind='audit_compare' ORDER BY id",[f.f.companyA])).rows;}
it('queues through actual cookie auth without financial write scope and retains original person delegation',async()=>{
 await f.pool.query("INSERT INTO company_user_permissions(company_id,user_id,module_key,can_write) VALUES($1,$2,'accounts',false)",[f.f.companyA,f.f.u1.id]);
 const response=await f.request('POST',body());expect(response.status).toBe(200);jobId=response.body.data.id;
 expect(response.body.data).toMatchObject({kind:'audit_compare',state:'queued',attempts:0,resultComparisonId:null});
 expect((await f.request('POST',body())).body.data.id).toBe(jobId);expect(await jobs()).toHaveLength(1);
 const stored=(await f.pool.query('SELECT * FROM control_audit_job_intents WHERE company_id=$1 AND id=$2',[f.f.companyA,jobId])).rows[0];
 expect(openAuditJobRequest(stored)).toMatchObject({authority:{personId:f.f.u1.id,authMethod:'cookie',connectionId:null,grantId:null},request:{permissions:['read:payroll','read:reports']}});
 expect((await f.pool.query('SELECT job_id FROM control_audit_comparison_results WHERE company_id=$1 AND job_id=$2',[f.f.companyA,jobId])).rows).toEqual([]);
});
it('runs the real worker and returns complete authenticated result pages over HTTP',async()=>{
 expect(await f.run(jobId)).toMatchObject({state:'succeeded',comparisonId:jobId});
 const first=await f.request('GET',{comparisonId:jobId,section:'records',limit:1});expect(first.status).toBe(200);
 const second=await f.request('GET',{comparisonId:jobId,section:'records',limit:1,cursor:first.body.data.nextCursor});expect(second.status).toBe(200);
 expect(first.body.data).toMatchObject({total:2,nextCursor:'1',counts:{records:{added:2,removed:0,changed:0}}});
 expect(second.body.data).toMatchObject({nextCursor:null,canonicalHash:first.body.data.canonicalHash});
 const items=[...first.body.data.items,...second.body.data.items];expect(items).toHaveLength(2);
 expect(items.map(item=>item.identity.id).sort()).toEqual([...f.records].sort());
 expect(items.every(item=>item.kind==='added'&&item.before===null&&item.after.snapshotId===f.second)).toBe(true);
});
it('refuses current source revocation for both repeated enqueue and retained read, then recovers',async()=>{
 await f.pool.query("INSERT INTO company_user_permissions(company_id,user_id,module_key,can_read) VALUES($1,$2,'payroll',false)",[f.f.companyA,f.f.u1.id]);
 try{expect((await f.request('POST',body())).status).toBe(403);expect((await f.request('GET',{comparisonId:jobId,section:'records'})).status).toBe(403);}
 finally{await f.pool.query("DELETE FROM company_user_permissions WHERE company_id=$1 AND user_id=$2 AND module_key='payroll'",[f.f.companyA,f.f.u1.id]);}
 expect((await f.request('GET',{comparisonId:jobId,section:'records'})).status).toBe(200);expect(await jobs()).toHaveLength(1);
});
it('refuses a foreign tenant source and result without returning either retained identity',async()=>{
 for(const response of [await f.request('POST',body(),'u3'),await f.request('GET',{comparisonId:jobId,section:'records'},'u3')]){
  expect(response.status).toBeGreaterThanOrEqual(400);expect(response.body.data??null).toBeNull();
  expect(JSON.stringify(response.body)).not.toContain(f.records[0]);
 }
});
it('rejects bad CSRF, extra authority and array query fields without queue mutation',async()=>{
 const before=await jobs();expect((await f.request('POST',{...body(),idempotencyKey:randomUUID()},'u1',false)).status).toBe(403);
 expect((await f.request('POST',{...body(),companyId:f.f.companyA})).status).toBe(400);
 const query=new URLSearchParams({comparisonId:jobId,section:'records'});query.append('limit','1');query.append('limit','2');
 expect((await f.request('GET',query)).status).toBe(400);expect((await f.request('GET',{comparisonId:jobId,section:'records',personId:f.f.u1.id})).status).toBe(400);
 expect(await jobs()).toEqual(before);
});
