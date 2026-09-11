import {beforeEach,afterEach,afterAll,expect,it} from 'vitest';
import {getAuthPool} from '@/lib/auth/authPool';
import {transferRestFixture} from './bankTransferRestFixture';
let f:Awaited<ReturnType<typeof transferRestFixture>>;
beforeEach(async()=>{f=await transferRestFixture();});afterEach(async()=>{if(f)await f.close();});afterAll(()=>getAuthPool().end());
const inverse=(bankTransactionId:string,originalIntentId:string)=>({action:'prepare_reverse',bankTransactionId,originalIntentId,reversalDate:'2026-09-10',reason:'Synthetic actual REST inverse'});
it('real REST transfer prepares, independently approves, posts once and reads either feed',async()=>{
 const p=await f.posted();expect(await f.journals()).toHaveLength(1);
 for(const id of [p.bank,p.opposite!]){const read=await f.read(id);expect(read.status).toBe(200);expect(read.body.data.currentOriginalIntentId).toBe(p.intentId);}
 expect((await f.request({action:'allocate',bankTransactionId:p.bank,intent_id:p.intentId,approval_id:p.approvalId})).status).toBe(200);
 expect(await f.journals()).toHaveLength(1);expect((await f.effects()).filter(e=>e.operation==='bank_allocation.post')).toHaveLength(1);
});
it('opposite feed inverse preparation returns the canonical bank for approved execution',async()=>{
 const p=await f.posted(),prepared=await f.request(inverse(p.opposite!,p.intentId));expect(prepared.status).toBe(200);
 expect(prepared.body.data.bankTransactionId).toBe(p.bank);const approvalId=await f.approved(prepared.body.data.operation);
 const body={action:'reverse',bankTransactionId:prepared.body.data.bankTransactionId,intent_id:prepared.body.data.intentId,approval_id:approvalId};
 const result=await f.request(body);expect(result.status).toBe(200);expect(result.body.data.reversed).toBe(true);
 for(const row of await f.banks())expect(row).toMatchObject({status:'imported',matched_journal_line_id:null,counterparty_account_id:null,transfer_journal_entry_id:null});
 expect((await f.request(body)).status).toBe(200);expect(await f.journals()).toHaveLength(2);
});
it('late-link intent and feed resolve to the same canonical inverse over HTTP',async()=>{
 const p=await f.posted(false),late=await f.bank(f.to,'115.23'),link=await f.postBank(late,f.from);
 expect((await f.read(late)).body.data.currentOriginalIntentId).toBe(p.intentId);
 const prepared=await f.request(inverse(late,link.intentId));expect(prepared.status).toBe(200);expect(prepared.body.data.bankTransactionId).toBe(p.bank);
 expect((await f.inverseRows())[0].original_intent_id).toBe(p.intentId);
 const approvalId=await f.approved(prepared.body.data.operation);
 expect((await f.request({action:'reverse',bankTransactionId:p.bank,intent_id:prepared.body.data.intentId,approval_id:approvalId})).status).toBe(200);
 expect(await f.journals()).toHaveLength(2);for(const row of await f.banks())expect(row.status).toBe('imported');
});
it('wrong owned and foreign feed identities refuse before inverse intent or effect',async()=>{
 const p=await f.posted(),wrong=await f.bank(),foreign=await f.foreignBank(),before=await f.snapshot();
 for(const id of [wrong,foreign])expect((await f.request(inverse(id,p.intentId))).status).toBeGreaterThanOrEqual(400);
 expect(await f.inverseRows()).toHaveLength(0);expect(await f.snapshot()).toEqual(before);
});
it('actual CSRF, maker self-decision and current posting revocation cannot publish',async()=>{
 const bank=await f.bank(),prepare={action:'prepare_allocate',allocationType:'transfer',bankTransactionId:bank,contraAccountId:f.to};
 expect((await f.request(prepare,'u1',false,false)).status).toBe(403);expect(await f.effects()).toHaveLength(0);
 const prepared=await f.request(prepare);expect(prepared.status).toBe(200);
 const pending=await f.request({action:'request',ref:prepared.body.data.operation},'u1',true);expect(pending.status).toBe(200);
 expect((await f.request({action:'decide',approvalId:pending.body.data.id,decision:'approved'},'u1',true)).status).toBeGreaterThanOrEqual(400);
 expect((await f.request({action:'decide',approvalId:pending.body.data.id,decision:'approved'},'u2',true)).status).toBe(200);
 await f.pool.query("INSERT INTO company_user_permissions(company_id,user_id,module_key,can_write) VALUES($1,$2,'accounts',false)",[f.f.companyA,f.f.u1.id]);
 const before=await f.snapshot();expect((await f.request({action:'allocate',bankTransactionId:bank,intent_id:prepared.body.data.intentId,approval_id:pending.body.data.id})).status).toBeGreaterThanOrEqual(400);
 expect(await f.snapshot()).toEqual(before);expect(await f.journals()).toHaveLength(0);
});
