import {afterAll,beforeAll,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {seedBankAllocationSupplier} from './bankAllocationSupplierFixture';
import {bank39Fixture} from './bank39Fixture';
import {allocateTransaction,splitAllocateTransaction,reverseReconciledTransaction} from '@/modules/accounting/services/bank/bankAllocationService';
import {prepareBankAllocationReversal} from '@/modules/accounting/services/bank/bankAllocationReversal';
let b:Awaited<ReturnType<typeof bank39Fixture>>;
beforeAll(async()=>{b=await bank39Fixture();});afterAll(async()=>{await b?.close();});
for(const kind of ['account','split','customer'] as const)it(`${kind}: actual adapter keeps SAST March1 and the exact full bank amount`,async()=>{
 const tx=await b.source(kind==='customer'?'115':'-115');
 const plan=kind==='customer'?{version:1 as const,kind,bankTransactionId:tx,partyId:b.customer,applications:[]}:
  {version:1 as const,kind,bankTransactionId:tx,lines:[{accountId:b.expense,amount:'115',vatCode:'none' as const}]};
 const p=await b.prepare(plan);
 const result=await b.actor(()=>kind==='split'?splitAllocateTransaction(b.f.companyA,tx,[{contraAccountId:b.expense,amount:115}],b.f.u1.id,{intentId:p.intentId,approvalId:p.approvalId}):
  allocateTransaction(b.f.companyA,tx,kind==='customer'?null:b.expense,b.f.u1.id,undefined,kind,kind==='customer'?b.customer:undefined,undefined,undefined,undefined,undefined,undefined,{intentId:p.intentId,approvalId:p.approvalId,autoApply:false}));
 expect((await b.state(result.journalEntryId)).entry_date).toBe('2026-03-01');
 const lines=await b.lines(result.journalEntryId);expect(lines).toHaveLength(2);expect(lines.every(line=>line.vat_type===null)).toBe(true);
 expect(lines.reduce((sum,l)=>sum+Number(l.debit),0)).toBe(115);expect(lines.reduce((sum,l)=>sum+Number(l.credit),0)).toBe(115);
 if(kind==='customer')expect((await b.pool.query('SELECT payment_date::text,total_amount::text,gl_journal_entry_id FROM customer_payments WHERE company_id=$1 AND gl_journal_entry_id=$2',[b.f.companyA,result.journalEntryId])).rows).toEqual([{payment_date:'2026-03-01',total_amount:'115.00',gl_journal_entry_id:result.journalEntryId}]);
});
for(const pat of [false,true])it(`inverse adapter retains issued ${pat?'PAT':'cookie'} provenance and owned bank reset`,async()=>{
 const tx=await b.source('115'),p=await b.prepare({version:1,kind:'customer',bankTransactionId:tx,partyId:b.customer,applications:[]},pat);
 const posted=await b.actor(()=>allocateTransaction(b.f.companyA,tx,null,b.f.u1.id,undefined,'customer',b.customer,undefined,undefined,undefined,undefined,undefined,{intentId:p.intentId,approvalId:p.approvalId,autoApply:false}),'u1',pat);
 const inverse=await b.actor(ctx=>prepareBankAllocationReversal(ctx,{originalIntentId:p.intentId,reversalDate:'2026-04-01',reason:'BANK39 correction'}),'u1',pat),approvalId=await b.approve(inverse.operation,pat);
 await b.actor(()=>reverseReconciledTransaction(b.f.companyA,tx,b.f.u1.id,{intentId:inverse.intentId,approvalId,reversalDate:'2026-04-01',postingAgent:pat?'mcp:reverse_bank:v1':undefined}),'u1',pat);
 const rows=(await b.pool.query('SELECT actor_type,actor_token_jti,posting_agent FROM gl_journal_entries WHERE company_id=$1 AND reversal_of_id=$2',[b.f.companyA,posted.journalEntryId])).rows;
 expect(rows).toHaveLength(1);expect(rows[0].actor_type).toBe(pat?'agent':'human');expect(rows[0].actor_token_jti).toBe(pat?b.f.u1.tokens[0]!.id:null);
 if(pat)expect(rows[0].posting_agent).toBe('mcp:reverse_bank:v1');
 expect((await b.pool.query('SELECT status,matched_journal_line_id,allocation_batch_id FROM bank_transactions WHERE company_id=$1 AND id=$2',[b.f.companyA,tx])).rows).toEqual([{status:'imported',matched_journal_line_id:null,allocation_batch_id:null}]);
});

it('normal supplier payment ignores caller VAT without duplicate documents or speculative bill settlement',async()=>{
 await b.pool.query("INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance,is_active,is_system_account,level) VALUES($1,$2,left($1::uuid::text,20),'BANK39 AP','liability','payable','credit',true,true,3)",[randomUUID(),b.f.companyA]);
 const supplier=await seedBankAllocationSupplier(b.pool,b.f,(person,fn)=>b.actor(fn,person)),tx=await b.source();
 const before=(await b.pool.query('SELECT status,amount_paid::text FROM supplier_invoices WHERE company_id=$1 AND id=$2',[b.f.companyA,supplier.invoice])).rows;
 const p=await b.prepare({version:1,kind:'supplier',bankTransactionId:tx,partyId:supplier.supplier,applications:[]});
 const result=await b.actor(()=>allocateTransaction(b.f.companyA,tx,null,b.f.u1.id,undefined,'supplier',supplier.supplier,'standard',undefined,undefined,undefined,undefined,{intentId:p.intentId,approvalId:p.approvalId,autoApply:false}));
 const lines=await b.lines(result.journalEntryId);expect(lines).toHaveLength(2);expect(lines.every(line=>line.vat_type===null)).toBe(true);
 expect(lines.find(line=>line.gl_account_id===b.bank)).toMatchObject({debit:'0.00',credit:'115.00'});
 expect(lines.reduce((sum,line)=>sum+Number(line.debit),0)).toBe(115);
 expect((await b.pool.query('SELECT status,total_amount::text FROM supplier_payments WHERE company_id=$1 AND gl_journal_entry_id=$2',[b.f.companyA,result.journalEntryId])).rows).toEqual([{status:'processed',total_amount:'115.00'}]);
 expect((await b.pool.query('SELECT status,amount_paid::text FROM supplier_invoices WHERE company_id=$1 AND id=$2',[b.f.companyA,supplier.invoice])).rows).toEqual(before);
});
