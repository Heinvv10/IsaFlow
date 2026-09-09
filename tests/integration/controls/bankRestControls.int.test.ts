import {afterAll,beforeAll,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {bankRestFixture} from './bankRestFixture';
let f:Awaited<ReturnType<typeof bankRestFixture>>;
beforeAll(async()=>{f=await bankRestFixture();});afterAll(async()=>{if(f)await f.close();});
async function prepare(){const bankTransactionId=await f.source();const response=await f.request({action:'prepare_allocate',bankTransactionId,allocationType:'account',contraAccountId:f.contra});expect(response.status).toBe(200);return{bankTransactionId,...response.body.data};}
it('actual wrapped HTTP prepares, independently approved execution retries, and exact inverse commits',async()=>{
 const p=await prepare(),approval_id=await f.approve(p.operation),body={action:'allocate',bankTransactionId:p.bankTransactionId,intent_id:p.intentId,approval_id};
 const posted=await f.request(body);expect(posted.status).toBe(200);expect((await f.request(body)).body.data.journalEntryId).toBe(posted.body.data.journalEntryId);
 const r=await f.request({action:'prepare_reverse',bankTransactionId:p.bankTransactionId,originalIntentId:p.intentId,reversalDate:'2026-09-10',reason:'Synthetic REST correction'});expect(r.status).toBe(200);
 const inverseApproval=await f.approve(r.body.data.operation);
 const reversed=await f.request({action:'reverse',bankTransactionId:p.bankTransactionId,intent_id:r.body.data.intentId,approval_id:inverseApproval,reversalDate:'2026-09-10',reason:'Synthetic REST correction'});expect(reversed.status).toBe(200);
 expect((await f.pool.query('SELECT status FROM bank_transactions WHERE company_id=$1 AND id=$2',[f.fixture.companyA,p.bankTransactionId])).rows[0].status).toBe('imported');
});
it('old UI execution receives concrete action-required response without preparing or posting',async()=>{
 const bankTransactionId=await f.source();
 const response=await f.request({action:'allocate',bankTransactionId,allocationType:'account',contraAccountId:f.contra});
 expect(response.status).toBe(400);expect(response.body.error.details).toMatchObject({code:'ACTION_REQUIRED',prepareAction:'prepare_allocate'});
 expect((await f.pool.query('SELECT id FROM control_bank_allocation_intents WHERE company_id=$1 AND bank_transaction_id=$2',[f.fixture.companyA,bankTransactionId])).rows).toEqual([]);
});
it('requires approval reference and rejects mixed execution plans before writes',async()=>{
 const p=await prepare();
 const missing=await f.request({action:'allocate',bankTransactionId:p.bankTransactionId,intent_id:p.intentId});expect(missing.body.error.details.code).toBe('ACTION_REQUIRED');
 const approval_id=await f.approve(p.operation);
 const mixed=await f.request({action:'allocate',bankTransactionId:p.bankTransactionId,intent_id:p.intentId,approval_id,contraAccountId:f.bank});expect(mixed.status).toBe(400);
 expect((await f.pool.query('SELECT id FROM gl_journal_entries WHERE company_id=$1 AND source_record_id=$2',[f.fixture.companyA,p.bankTransactionId])).rows).toEqual([]);
});
it('refuses mismatched bank, action kind and approval references',async()=>{
 const p=await prepare(),other=await prepare(),approval_id=await f.approve(p.operation);
 for(const body of [
  {action:'allocate',bankTransactionId:other.bankTransactionId,intent_id:p.intentId,approval_id},
  {action:'split_allocate',bankTransactionId:p.bankTransactionId,intent_id:p.intentId,approval_id},
  {action:'allocate',bankTransactionId:other.bankTransactionId,intent_id:other.intentId,approval_id},
 ])expect((await f.request(body)).status).toBeGreaterThanOrEqual(400);
 expect((await f.pool.query('SELECT id FROM gl_journal_entries WHERE company_id=$1 AND source_record_id=ANY($2::uuid[])',[f.fixture.companyA,[p.bankTransactionId,other.bankTransactionId]])).rows).toEqual([]);
});
it('party default preparation and split preparation use actual shared services',async()=>{
 const bankTransactionId=await f.source('115.23');
 const party=await f.request({action:'prepare_allocate',bankTransactionId,allocationType:'customer',entityId:f.customer});expect(party.status).toBe(200);
 expect((await f.pool.query('SELECT payload FROM control_bank_allocation_intents WHERE company_id=$1 AND id=$2',[f.fixture.companyA,party.body.data.intentId])).rows[0].payload).toMatchObject({kind:'customer',partyId:f.customer,applications:[]});
 const split=await f.request({action:'prepare_split_allocate',bankTransactionId:await f.source(),lines:[{contraAccountId:f.contra,amount:'50'},{contraAccountId:f.contra,amount:'65.23'}]});expect(split.status).toBe(200);
});
it('foreign tenant, missing CSRF and revoked current permission refuse HTTP effects',async()=>{
 const p=await prepare(),approval_id=await f.approve(p.operation),body={action:'allocate',bankTransactionId:p.bankTransactionId,intent_id:p.intentId,approval_id};
 expect((await f.request(body,'u3')).status).toBeGreaterThanOrEqual(400);expect((await f.request(body,'u1',false)).status).toBe(403);
 await f.pool.query("INSERT INTO company_user_permissions(company_id,user_id,module_key,can_write) VALUES($1,$2,'banking',false)",[f.fixture.companyA,f.fixture.u1.id]);
 try{expect((await f.request(body)).status).toBeGreaterThanOrEqual(400);}
 finally{await f.pool.query("DELETE FROM company_user_permissions WHERE company_id=$1 AND user_id=$2 AND module_key='banking'",[f.fixture.companyA,f.fixture.u1.id]);}
 expect((await f.pool.query('SELECT id FROM gl_journal_entries WHERE company_id=$1 AND source_record_id=$2',[f.fixture.companyA,p.bankTransactionId])).rows).toEqual([]);
});
it('stale approval HTTP refusal leaves journals, effects and approval unconsumed',async()=>{
 const p=await prepare(),approval_id=await f.approve(p.operation);
 await f.pool.query('UPDATE bank_transactions SET amount=amount*2 WHERE company_id=$1 AND id=$2',[f.fixture.companyA,p.bankTransactionId]);
 expect((await f.request({action:'allocate',bankTransactionId:p.bankTransactionId,intent_id:p.intentId,approval_id})).status).toBeGreaterThanOrEqual(400);
 expect((await f.pool.query('SELECT status FROM control_operation_approvals WHERE company_id=$1 AND id=$2',[f.fixture.companyA,approval_id])).rows[0].status).toBe('approved');
 expect((await f.pool.query('SELECT id FROM control_operation_effects WHERE company_id=$1 AND entity_id=$2',[f.fixture.companyA,p.intentId])).rows).toEqual([]);
});
it('inverse preparation and execution reject mismatched bank/date/reason references',async()=>{
 const p=await prepare(),approval_id=await f.approve(p.operation);expect((await f.request({action:'allocate',bankTransactionId:p.bankTransactionId,intent_id:p.intentId,approval_id})).status).toBe(200);
 expect((await f.request({action:'prepare_reverse',bankTransactionId:await f.source(),originalIntentId:p.intentId,reversalDate:'2026-09-10',reason:'Synthetic inverse'})).status).toBe(400);
 const reverse=await f.request({action:'prepare_reverse',bankTransactionId:p.bankTransactionId,originalIntentId:p.intentId,reversalDate:'2026-09-10',reason:'Synthetic inverse'});expect(reverse.status).toBe(200);
 const inverseApproval=await f.approve(reverse.body.data.operation);
 for(const change of [{reversalDate:'2026-09-11'},{reason:'Different instruction'},{bankTransactionId:randomUUID()}])expect((await f.request({action:'reverse',bankTransactionId:p.bankTransactionId,intent_id:reverse.body.data.intentId,approval_id:inverseApproval,...change})).status).toBe(400);
});
