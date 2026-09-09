import {afterAll,beforeAll,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {bankDimensionsFixture} from './bankDimensionsFixture';
import {requireControlTx} from '@/modules/accounting/services/controls/context';
import {prepareBankAllocation,executeBankAllocation} from '@/modules/accounting/services/bank/bankAllocationControl';
import {prepareBankAllocationReversal,executeBankAllocationReversal} from '@/modules/accounting/services/bank/bankAllocationReversal';
import {loadBankAllocationIntent} from '@/modules/accounting/services/bank/bankAllocationMaterial';
import {reverseJournalEntry} from '@/modules/accounting/services/gl/journalEntryPostingService';
import {materializeGlOperation} from '@/modules/accounting/services/controls/glOperationMaterializer';
import {allocateTransaction} from '@/modules/accounting/services/bank/bankAllocationService';
import {readBankControlState} from '@/modules/accounting/services/bank/bankControlReadService';
let f:Awaited<ReturnType<typeof bankDimensionsFixture>>;
beforeAll(async()=>{f=await bankDimensionsFixture();});afterAll(async()=>{if(f)await f.close();});
async function planned(){const bankTransactionId=await f.source(),dims=await f.dimensions();return{bankTransactionId,dims,plan:{version:1,kind:'account',bankTransactionId,lines:[{accountId:f.contra,amount:'115.23',...dims}]}};}
it('actual owned dimension preparation posts exact classifications and preserves them on approved inverse',async()=>{
 const p=await planned(),intent=await f.actor(()=>prepareBankAllocation(requireControlTx(),p.plan)),approvalId=await f.approve(intent.operation);
 const posted=await f.actor(()=>executeBankAllocation(requireControlTx(),intent.intentId,{approvalId}));
 const lines=(await f.pool.query('SELECT gl_account_id,cc1_id,cc2_id,bu_id,cost_center_id FROM gl_journal_lines WHERE company_id=$1 AND journal_entry_id=$2',[f.fixture.companyA,posted.journalEntryId])).rows;
 expect(lines.find(l=>l.gl_account_id===f.contra)).toMatchObject({cc1_id:p.dims.cc1Id,cost_center_id:p.dims.cc1Id,cc2_id:p.dims.cc2Id,bu_id:p.dims.buId});
 expect(lines.find(l=>l.gl_account_id===f.bank)).toMatchObject({cc1_id:null,cc2_id:null,bu_id:null});
 const reverse=await f.actor(()=>prepareBankAllocationReversal(requireControlTx(),{originalIntentId:intent.intentId,reversalDate:'2026-09-10',reason:'Synthetic dimension correction'})),reverseApproval=await f.approve(reverse.operation);
 const inverse=await f.actor(()=>executeBankAllocationReversal(requireControlTx(),reverse.intentId,{approvalId:reverseApproval}));
 expect((await f.pool.query('SELECT cc1_id,cc2_id,bu_id,cost_center_id FROM gl_journal_lines WHERE company_id=$1 AND journal_entry_id=$2 AND gl_account_id=$3',[f.fixture.companyA,inverse.reversalJournalEntryId,f.contra])).rows[0]).toMatchObject({cc1_id:p.dims.cc1Id,cc2_id:p.dims.cc2Id,bu_id:p.dims.buId,cost_center_id:p.dims.cc1Id});
});
it('selected dimension changes invalidate prepared approval before financial effects',async()=>{
 const p=await planned(),intent=await f.actor(()=>prepareBankAllocation(requireControlTx(),p.plan)),approvalId=await f.approve(intent.operation);
 await f.pool.query("UPDATE cost_centres SET code='changed-'||left(id::text,8),updated_at=clock_timestamp() WHERE company_id=$1 AND id=$2",[f.fixture.companyA,p.dims.cc2Id]);
 await expect(f.actor(()=>executeBankAllocation(requireControlTx(),intent.intentId,{approvalId}))).rejects.toThrow(/changed|stale/i);
 expect((await f.pool.query('SELECT id FROM gl_journal_entries WHERE company_id=$1 AND source_record_id=$2',[f.fixture.companyA,p.bankTransactionId])).rows).toEqual([]);
});
it('foreign, inactive and wrong-type dimensions refuse preparation',async()=>{
 const p=await planned(),foreign=await f.dimensions(f.fixture.companyB);
 for(const patch of [{cc1Id:foreign.cc1Id},{cc2Id:foreign.cc2Id},{buId:foreign.buId},{cc1Id:p.dims.cc2Id}])await expect(f.actor(()=>prepareBankAllocation(requireControlTx(),{...p.plan,lines:[{...p.plan.lines[0],...patch}]}))).rejects.toThrow(/dimension|owned|type/i);
 await f.pool.query('UPDATE business_units SET is_active=false WHERE company_id=$1 AND id=$2',[f.fixture.companyA,p.dims.buId]);
 await expect(f.actor(()=>prepareBankAllocation(requireControlTx(),p.plan))).rejects.toThrow(/dimension|active/i);
});
it('posted journal CC2 tampering invalidates the controlled receipt observation',async()=>{
 const p=await planned(),intent=await f.actor(()=>prepareBankAllocation(requireControlTx(),p.plan)),approvalId=await f.approve(intent.operation);
 const posted=await f.actor(()=>executeBankAllocation(requireControlTx(),intent.intentId,{approvalId})),other=await f.dimensions();
 await expect(f.changedJournal(posted.journalEntryId,other.cc2Id,()=>loadBankAllocationIntent(requireControlTx(),intent.intentId))).rejects.toThrow(/changed|receipt/i);
});
it('nonbank journal inverse preserves independent CC1 and CC2 columns',async()=>{
 const dims=await f.dimensions(),id=randomUUID();
 await f.pool.query("INSERT INTO approval_rules(id,company_id,name,document_type,condition_field,condition_operator,condition_value,approver_role) VALUES($1,$2,'Synthetic GL dimension rule','journal_entry','amount','any',0,'admin')",[randomUUID(),f.fixture.companyA]);
 await f.pool.query("INSERT INTO gl_journal_entries(id,company_id,entry_date,fiscal_period_id,description,source,status,created_by) SELECT $1,$2,'2026-09-09',id,'Synthetic manual dimensions','manual','posted',$3 FROM fiscal_periods WHERE company_id=$2 AND start_date='2026-09-01'",[id,f.fixture.companyA,f.fixture.u1.id]);
 await f.pool.query('INSERT INTO gl_journal_lines(company_id,journal_entry_id,gl_account_id,debit,credit,cost_center_id,cc1_id,cc2_id,bu_id) VALUES($1,$2,$3,115.23,0,$5,$5,$6,$7),($1,$2,$4,0,115.23,NULL,NULL,NULL,NULL)',[f.fixture.companyA,id,f.contra,f.bank,dims.cc1Id,dims.cc2Id,dims.buId]);
 const ref={entityType:'journal_entry',entityId:id,operation:'journal.reverse' as const,reversalDate:'2026-09-10'},approvalId=await f.approve(ref);
 const inverse=await f.actor(()=>reverseJournalEntry(f.fixture.companyA,id,f.fixture.u1.id,{approvalId,reversalDate:'2026-09-10'}));
 expect((await f.pool.query('SELECT cc1_id,cc2_id,bu_id,cost_center_id FROM gl_journal_lines WHERE company_id=$1 AND journal_entry_id=$2 AND gl_account_id=$3',[f.fixture.companyA,inverse.id,f.contra])).rows[0]).toMatchObject({cc1_id:dims.cc1Id,cc2_id:dims.cc2Id,bu_id:dims.buId,cost_center_id:dims.cc1Id});
});
it('dimension-free journal material preserves absent CC1 and CC2 fingerprint fields',async()=>{
 const bankTransactionId=await f.source(),intent=await f.actor(()=>prepareBankAllocation(requireControlTx(),{version:1,kind:'account',bankTransactionId,lines:[{accountId:f.contra,amount:'115.23'}]})),approvalId=await f.approve(intent.operation);
 const posted=await f.actor(()=>executeBankAllocation(requireControlTx(),intent.intentId,{approvalId}));
 const material=await f.actor(()=>materializeGlOperation(requireControlTx(),{entityType:'journal_entry',entityId:posted.journalEntryId,operation:'journal.post'}));
 const facts=material.observedSources[0]!.facts as {lines:Record<string,unknown>[]};for(const line of facts.lines){expect(line).not.toHaveProperty('cc1_id');expect(line).not.toHaveProperty('cc2_id');}
});
it('actual party-refund REST preparation and execution preserve nonbank dimensions only',async()=>{
 const dims=await f.dimensions(),bankTransactionId=await f.source();
 const prepared=await f.request({action:'prepare_allocate',bankTransactionId,allocationType:'customer',entityId:f.customer,...dims});expect(prepared.status).toBe(200);
 const approval_id=await f.approve(prepared.body.data.operation),posted=await f.request({action:'allocate',bankTransactionId,intent_id:prepared.body.data.intentId,approval_id});expect(posted.status).toBe(200);expect(posted.body.data.paymentId).toBeNull();
 const rows=(await f.pool.query('SELECT gl_account_id,cc1_id,cc2_id,bu_id FROM gl_journal_lines WHERE company_id=$1 AND journal_entry_id=$2',[f.fixture.companyA,posted.body.data.journalEntryId])).rows;
 expect(rows.find(row=>row.gl_account_id!==f.bank)).toMatchObject({cc1_id:dims.cc1Id,cc2_id:dims.cc2Id,bu_id:dims.buId});expect(rows.find(row=>row.gl_account_id===f.bank)).toMatchObject({cc1_id:null,cc2_id:null,bu_id:null});
});
it('actual split REST retains separate line dimensions and refuses mixed execution material',async()=>{
 const a=await f.dimensions(),b=await f.dimensions(),bankTransactionId=await f.source();
 const p=await f.request({action:'prepare_split_allocate',bankTransactionId,lines:[{contraAccountId:f.contra,amount:'50',...a},{contraAccountId:f.contra,amount:'65.23',...b}]});expect(p.status).toBe(200);
 const approval_id=await f.approve(p.body.data.operation);expect((await f.request({action:'split_allocate',bankTransactionId,intent_id:p.body.data.intentId,approval_id,cc1Id:a.cc1Id})).status).toBe(400);
 const posted=await f.request({action:'split_allocate',bankTransactionId,intent_id:p.body.data.intentId,approval_id});expect(posted.status).toBe(200);
 const rows=(await f.pool.query('SELECT cc1_id,cc2_id,bu_id FROM gl_journal_lines WHERE company_id=$1 AND journal_entry_id=$2 AND gl_account_id=$3',[f.fixture.companyA,posted.body.data.journalEntryId,f.contra])).rows;
 expect(rows).toEqual(expect.arrayContaining([{cc1_id:a.cc1Id,cc2_id:a.cc2Id,bu_id:a.buId},{cc1_id:b.cc1Id,cc2_id:b.cc2Id,bu_id:b.buId}]));
});
it.each(['inverse','reader'])('cost-center-only journal tampering refuses %s original proof',async path=>{
 const p=await planned(),intent=await f.actor(()=>prepareBankAllocation(requireControlTx(),p.plan)),approvalId=await f.approve(intent.operation);
 const posted=await f.actor(()=>executeBankAllocation(requireControlTx(),intent.intentId,{approvalId})),other=await f.dimensions();
 await expect(f.changedJournal(posted.journalEntryId,other.cc1Id,()=>path==='inverse'
  ?prepareBankAllocationReversal(requireControlTx(),{originalIntentId:intent.intentId,reversalDate:'2026-09-10',reason:'Synthetic changed legacy dimension'})
  :readBankControlState(requireControlTx(),{bankTransactionId:p.bankTransactionId}),true)).rejects.toThrow(/changed|inconsistent/i);
});
it('legacy party adapter preserves supplied dimensions in its actual saved plan and journal',async()=>{
 const local=f;
  await local.pool.query('DELETE FROM approval_rules WHERE company_id=$1',[local.fixture.companyA]);
  const dims=await local.dimensions(),bankTransactionId=await local.source();
  const posted=await local.actor(()=>allocateTransaction(local.fixture.companyA,bankTransactionId,null,local.fixture.u1.id,undefined,'customer',local.customer,undefined,dims.cc1Id,dims.cc2Id,dims.buId));
  const [intent]=(await local.pool.query('SELECT payload FROM control_bank_allocation_intents WHERE company_id=$1 AND bank_transaction_id=$2',[local.fixture.companyA,bankTransactionId])).rows;
  expect(intent.payload).toMatchObject(dims);
  expect((await local.pool.query('SELECT cc1_id,cc2_id,bu_id FROM gl_journal_lines WHERE company_id=$1 AND journal_entry_id=$2 AND gl_account_id<>$3',[local.fixture.companyA,posted.journalEntryId,local.bank])).rows[0]).toMatchObject({cc1_id:dims.cc1Id,cc2_id:dims.cc2Id,bu_id:dims.buId});
});
