import {afterAll,beforeAll,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {bankControlReadFixture} from './bankControlReadFixture';
let f:Awaited<ReturnType<typeof bankControlReadFixture>>;
beforeAll(async()=>{f=await bankControlReadFixture();});afterAll(async()=>{if(f)await f.close();});
it('actual GET recovers own exact saved instructions and linked approved summary',async()=>{
 const p=await f.prepare(),approvalId=await f.approve(p.operation),response=await f.read(p.bankTransactionId,p.intentId);
 expect(response.status).toBe(200);expect(response.body.data).toMatchObject({currentOriginalIntentId:null,legacyProvenanceUnavailable:false,prepared:{total:1,hasMore:false}});
 expect(response.body.data.selected).toMatchObject({intentId:p.intentId,executed:false,plan:{kind:'account',lines:[{accountId:f.contra,amount:'115.23'}]},approval:{id:approvalId,status:'approved'},approvalVisibility:'visible'});
 expect(JSON.stringify(response.body.data)).not.toMatch(/source_fingerprint|binding_hash|beneficiaries/);
});
it('current original follows actual allocate, reverse, reallocation and executed detail',async()=>{
 const p=await f.prepare(),approval_id=await f.approve(p.operation);
 expect((await f.request({action:'allocate',bankTransactionId:p.bankTransactionId,intent_id:p.intentId,approval_id})).status).toBe(200);
 expect((await f.read(p.bankTransactionId,p.intentId)).body.data).toMatchObject({currentOriginalIntentId:p.intentId,selected:{executed:true},prepared:{total:0}});
 const reverse=await f.request({action:'prepare_reverse',bankTransactionId:p.bankTransactionId,originalIntentId:p.intentId,reversalDate:'2026-09-10',reason:'Synthetic reader inverse'});
 const inverseApproval=await f.approve(reverse.body.data.operation);
 expect((await f.read(p.bankTransactionId)).body.data.prepared.items[0]).toMatchObject({intentId:reverse.body.data.intentId,plan:{originalIntentId:p.intentId,reversalDate:'2026-09-10'}});
 expect((await f.request({action:'reverse',bankTransactionId:p.bankTransactionId,intent_id:reverse.body.data.intentId,approval_id:inverseApproval})).status).toBe(200);
 expect((await f.read(p.bankTransactionId)).body.data.currentOriginalIntentId).toBeNull();
 const again=await f.prepare(p.bankTransactionId),approved=await f.approve(again.operation);
 expect((await f.request({action:'allocate',bankTransactionId:p.bankTransactionId,intent_id:again.intentId,approval_id:approved})).status).toBe(200);
 expect((await f.read(p.bankTransactionId)).body.data.currentOriginalIntentId).toBe(again.intentId);
});
it('filters bank and maker before newest50 while selected older intent remains recoverable',async()=>{
 const p=await f.prepare();for(let i=0;i<51;i++)await f.prepare(p.bankTransactionId);
 await f.prepare(p.bankTransactionId,'u2');await f.prepare();
 const response=await f.read(p.bankTransactionId,p.intentId);
 expect(response.status).toBe(200);expect(response.body.data.prepared).toMatchObject({total:52,hasMore:true});expect(response.body.data.prepared.items).toHaveLength(50);
 expect(response.body.data.selected.intentId).toBe(p.intentId);
 expect((await f.read(p.bankTransactionId,undefined,'u2')).body.data.prepared.total).toBe(1);
},30000);
it('rejects foreign tenant, wrong bank, wrong maker and missing bank',async()=>{
 const p=await f.prepare();for(const result of [await f.read(p.bankTransactionId,p.intentId,'u3'),await f.read(await f.source(),p.intentId),await f.read(p.bankTransactionId,p.intentId,'u2'),await f.read(randomUUID())])expect(result.status).toBeGreaterThanOrEqual(400);
});
it('current rights revoke bank visibility and separately hide approval summary',async()=>{
 const p=await f.prepare();await f.approve(p.operation);
 await f.pool.query("INSERT INTO company_user_permissions(company_id,user_id,module_key,can_read) VALUES($1,$2,'approvals',false)",[f.fixture.companyA,f.fixture.u1.id]);
 try{const r=await f.read(p.bankTransactionId,p.intentId);expect(r.status).toBe(200);expect(r.body.data.selected).toMatchObject({approval:null,approvalVisibility:'denied'});}
 finally{await f.pool.query("DELETE FROM company_user_permissions WHERE company_id=$1 AND user_id=$2 AND module_key='approvals'",[f.fixture.companyA,f.fixture.u1.id]);}
 await f.pool.query("INSERT INTO company_user_permissions(company_id,user_id,module_key,can_read) VALUES($1,$2,'banking',false)",[f.fixture.companyA,f.fixture.u1.id]);
 try{expect((await f.read(p.bankTransactionId)).status).toBeGreaterThanOrEqual(400);}
 finally{await f.pool.query("DELETE FROM company_user_permissions WHERE company_id=$1 AND user_id=$2 AND module_key='banking'",[f.fixture.companyA,f.fixture.u1.id]);}
});
