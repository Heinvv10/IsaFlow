import {beforeAll,afterAll,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {exceptionHttpFixture} from './exceptionHttpFixture';
import {seedExceptionMismatch} from './exceptionSourceFixture';
import type {RpcReply} from './client';
let f:Awaited<ReturnType<typeof exceptionHttpFixture>>,source:Awaited<ReturnType<typeof seedExceptionMismatch>>,id:string;
const check_id='three_way_match_exceptions';
const dto=<T>(r:RpcReply):T=>{expect(r.result?.isError).not.toBe(true);return JSON.parse(r.result!.content!.map(row=>row.text).join('\n')) as T;};
beforeAll(async()=>{f=await exceptionHttpFixture();source=await seedExceptionMismatch(f.pool,f.f);},30000);afterAll(async()=>{if(f)await f.close();});
it('captures actual findings, reads without writes and assigns once despite retries with current-domain replay authority',async()=>{
 const captured=dto<{exceptionIds:string[]}>(await f.rpc('capture_control_exceptions',{check_id,idempotency_key:randomUUID()}));expect(captured.exceptionIds).toHaveLength(1);id=captured.exceptionIds[0]!;
 const counts=async()=>(await f.pool.query('SELECT count(*)::int count FROM control_exception_decisions WHERE company_id=$1',[f.f.companyA])).rows[0].count;
 const before=await counts();const retained=dto<{exceptions:Array<{id:string;severity:string;version:number}>}>(await f.rpc('control_exceptions',{check_id,limit:1}));expect(retained.exceptions[0]).toMatchObject({id,severity:'high',version:1});expect(await counts()).toBe(before);
 const assign={exception_id:id,expected_version:1,owner_person_id:f.f.u1.id,due_at:null,idempotency_key:randomUUID()};
 const assigned=dto<{version:number}>(await f.rpc('assign_exception',assign));expect(assigned.version).toBe(2);expect(dto(await f.rpc('assign_exception',assign))).toEqual(assigned);expect(await counts()).toBe(before+1);
 expect((await f.rpc('assign_exception',{...assign,idempotency_key:randomUUID()})).result?.isError).toBe(true);
 await f.pool.query("INSERT INTO company_user_permissions(company_id,user_id,module_key,can_read) VALUES($1,$2,'suppliers',false)",[f.f.companyA,f.f.u1.id]);
 try{expect((await f.rpc('assign_exception',assign)).result?.isError).toBe(true);}finally{await f.pool.query("DELETE FROM company_user_permissions WHERE company_id=$1 AND user_id=$2 AND module_key='suppliers'",[f.f.companyA,f.f.u1.id]);}
 expect((await f.rpc('assign_exception',{...assign,expected_version:2,idempotency_key:randomUUID()},'u3')).result?.isError).toBe(true);
},30000);
it('requires independent actual human, retains failed recheck, accepted risk expiry and reopened recurrence',async()=>{
 const resolve={exception_id:id,expected_version:2,resolution:'fixed',reason:'Synthetic corrective review',idempotency_key:randomUUID()};
 expect((await f.rpc('resolve_exception',resolve,'u1',1)).result?.isError).toBe(true);expect((await f.rpc('resolve_exception',{...resolve,idempotency_key:randomUUID()},'u2')).result?.isError).toBe(true);
 const human={action:'resolve',exceptionId:id,expectedVersion:2,resolution:'fixed',reason:'Synthetic independent review'};
 expect((await f.request(human,'u2',false)).status).toBe(403);expect((await f.request(human,'u1')).status).not.toBe(200);
 const blocked=await f.request(human,'u2');expect(blocked.status).toBe(200);expect(blocked.body.data).toMatchObject({outcome:'recheck_blocked',exception:{status:'open',version:3,lastRecheck:{status:'fail'}}});
 const expired=await f.request({...human,expectedVersion:3,resolution:'accepted_risk',expiresAt:'2020-01-01T00:00:00Z'},'u2');expect(expired.status).toBe(400);
 const accepted=await f.request({...human,expectedVersion:3,resolution:'accepted_risk',expiresAt:new Date(Date.now()+2500).toISOString()},'u2');expect(accepted.status).toBe(200);expect(accepted.body.data.exception).toMatchObject({status:'accepted_risk',version:4,reviewerPersonId:f.f.u2.id});
 await new Promise(resolve=>setTimeout(resolve,2600));const retained=dto<{exceptions:Array<{status:string;riskExpired:boolean}>}>(await f.rpc('control_exceptions',{check_id}));expect(retained.exceptions[0]).toMatchObject({status:'accepted_risk',riskExpired:true});
 const recurring=dto<{exceptionIds:string[]}>(await f.rpc('capture_control_exceptions',{check_id,idempotency_key:randomUUID()}));expect(recurring.exceptionIds).toEqual([id]);
 expect(dto<{exceptions:unknown[]}>(await f.rpc('control_exceptions',{check_id})).exceptions[0]).toMatchObject({status:'open',occurrenceCount:2,version:5});
 // Synthetic source correction for the real checker, not fabricated check output or a financial posting.
 await f.pool.query('UPDATE supplier_invoice_items i SET unit_price=100,line_total=1000 FROM supplier_invoices s WHERE s.company_id=$1 AND s.id=$2 AND i.supplier_invoice_id=s.id',[f.f.companyA,source.invoice]);
 const fixed=await f.request({...human,expectedVersion:5},'u2');expect(fixed.status).toBe(200);expect(fixed.body.data).toMatchObject({outcome:'fixed',exception:{status:'fixed',version:6,lastRecheck:{status:'pass',findingCount:0}}});
},30000);
