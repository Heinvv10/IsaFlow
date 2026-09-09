import {seedBankAllocationSupplier} from './bankAllocationSupplierFixture';
import {expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {actor,customer,fixture,pool,postedCash} from './cashApplicationFixture';
import {requireControlTx} from '@/modules/accounting/services/controls/context';
import type {OperationRef} from '@/modules/accounting/services/controls/contracts';
import {requestOperationApproval,decideOperationApproval} from '@/modules/accounting/services/controls/approvalRequestService';
import {confirmCustomerPayment,cancelCustomerPayment} from '@/modules/accounting/services/ar/customerPaymentAllocationService';
import {prepareCashApplication,executeCashApplication} from '@/modules/accounting/services/shared/cashApplicationControl';
import {prepareCashApplicationReversal,executeCashApplicationReversal} from '@/modules/accounting/services/shared/cashApplicationReversalControl';
import {getUnappliedReceipts} from '@/modules/accounting/services/ar/unappliedReceiptService';
async function approve(ref:OperationRef){const row=await actor(()=>requestOperationApproval(requireControlTx(),ref));await actor(()=>decideOperationApproval(requireControlTx(),row.id,'approved'),'u2');return row.id;}
async function appliedDirectCash(){
 const {invoice}=await postedCash(),paymentId=randomUUID();
 await pool.query("INSERT INTO customer_payments(id,company_id,client_id,payment_number,payment_date,total_amount,currency_code,created_by) VALUES($1,$2,$3,left($1::uuid::text,28),'2026-09-09',115,'ZAR',$4)",[paymentId,fixture.companyA,customer,fixture.u1.id]);
 const confirmation=await approve({entityType:'customer_payment',entityId:paymentId,operation:'customer_payment.confirm'});
 await actor(()=>confirmCustomerPayment(fixture.companyA,paymentId,fixture.u1.id,{approvalId:confirmation}));
 const application=await actor(()=>prepareCashApplication(requireControlTx(),{version:1,kind:'customer',paymentId,accountingDate:'2026-09-10',applications:[{invoiceId:invoice,amount:'115.00'}]}));
 const approvalId=await approve(application.operation);await actor(()=>executeCashApplication(requireControlTx(),application.intentId,{approvalId}));
 return{paymentId,application};
}
async function unapply(originalIntentId:string){
 const inverse=await actor(()=>prepareCashApplicationReversal(requireControlTx(),{originalIntentId,reversalDate:'2026-09-11',reason:'Synthetic historical reader proof'}));
 const approvalId=await approve(inverse.operation);await actor(()=>executeCashApplicationReversal(requireControlTx(),inverse.intentId,{approvalId}));return inverse;
}
it('retains dated historical receipt balances after a later actual controlled parent cancellation',async()=>{
 const {paymentId,application}=await appliedDirectCash();await unapply(application.intentId);
 const before=await actor(()=>getUnappliedReceipts(fixture.companyA,{asAt:'2026-09-11',limit:500}));
 expect(before.rows.find(row=>row.paymentId===paymentId)?.unappliedAmount).toBe(115);
 const cancellation=await approve({entityType:'customer_payment',entityId:paymentId,operation:'customer_payment.cancel',reversalDate:'2026-09-12'});
 await actor(()=>cancelCustomerPayment(fixture.companyA,paymentId,fixture.u1.id,'Synthetic historical cancellation',{approvalId:cancellation,reversalDate:'2026-09-12'}));
 for(const [asAt,amount] of [['2026-09-09',115],['2026-09-10',0],['2026-09-11',115],['2026-09-12',0]] as const){
  const report=await actor(()=>getUnappliedReceipts(fixture.companyA,{asAt,limit:500}));expect(report.rows.find(row=>row.paymentId===paymentId)?.unappliedAmount??0).toBe(amount);
 }
});
it('advances receipt postedThrough when approved unapplication changes retained history',async()=>{
 const {application}=await appliedDirectCash();
 const before=await actor(()=>getUnappliedReceipts(fixture.companyA,{asAt:'2026-09-11',limit:500}));
 const inverse=await unapply(application.intentId);
 const timestamp=(await pool.query('SELECT created_at FROM control_cash_application_reversal_intents WHERE company_id=$1 AND id=$2',[fixture.companyA,inverse.intentId])).rows[0].created_at;
 expect(new Date(timestamp).getTime()).toBeGreaterThan(new Date(before.postedThrough).getTime());
 const after=await actor(()=>getUnappliedReceipts(fixture.companyA,{asAt:'2026-09-11',limit:500}));
 expect(new Date(after.postedThrough).getTime()).toBeGreaterThan(new Date(before.postedThrough).getTime());
});
it('retains supplier cash at earlier cutoffs after its actual approved bank-parent inverse',async()=>{
 const {prepareBankAllocation,executeBankAllocation}=await import('@/modules/accounting/services/bank/bankAllocationControl');
 const {prepareBankAllocationReversal,executeBankAllocationReversal}=await import('@/modules/accounting/services/bank/bankAllocationReversal');
 const {getUnappliedPayments}=await import('@/modules/accounting/services/ap/unappliedPaymentService');
 const {bank}=await import('./cashApplicationFixture');
 const payable=randomUUID();await pool.query("INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance,is_active,is_system_account,level) VALUES($1,$2,left($1::uuid::text,12),'Synthetic payable','liability','payable','credit',true,true,3)",[payable,fixture.companyA]);
 const supplier=await seedBankAllocationSupplier(pool,fixture,(person,fn)=>actor(()=>fn(requireControlTx()),person)),tx=randomUUID();
 await pool.query("INSERT INTO bank_transactions(id,company_id,bank_account_id,transaction_date,amount,description,status) VALUES($1,$2,$3,'2026-09-09',-115,'Synthetic historical supplier cash','imported')",[tx,fixture.companyA,bank]);
 const original=await actor(()=>prepareBankAllocation(requireControlTx(),{version:1,kind:'supplier',bankTransactionId:tx,partyId:supplier.supplier,applications:[]}));
 const originalApproval=await approve(original.operation),posted=await actor(()=>executeBankAllocation(requireControlTx(),original.intentId,{approvalId:originalApproval}));
 expect((await actor(()=>getUnappliedPayments(fixture.companyA,{asAt:'2026-09-09',limit:500}))).rows.find(row=>row.paymentId===posted.paymentId)?.unappliedAmount).toBe(115);
 const inverse=await actor(()=>prepareBankAllocationReversal(requireControlTx(),{originalIntentId:original.intentId,reversalDate:'2026-09-10',reason:'Synthetic historical supplier bank inverse'}));
 const inverseApproval=await approve(inverse.operation);await actor(()=>executeBankAllocationReversal(requireControlTx(),inverse.intentId,{approvalId:inverseApproval}));
 for(const [asAt,amount] of [['2026-09-09',115],['2026-09-10',0]] as const){
  const report=await actor(()=>getUnappliedPayments(fixture.companyA,{asAt,limit:500}));expect(report.rows.find(row=>row.paymentId===posted.paymentId)?.unappliedAmount??0).toBe(amount);
 }
});
it('exposes missing legacy dates as incomplete and keeps origin/listing totals consistent',async()=>{
 const {posted,invoice}=await postedCash();
 const {getUnappliedReceiptOrigins}=await import('@/modules/accounting/services/ar/unappliedReceiptOrigin');
 await pool.query('INSERT INTO customer_payment_allocations(payment_id,invoice_id,amount_allocated) VALUES($1,$2,10)',[posted.paymentId,invoice]);
 const report=await actor(()=>getUnappliedReceipts(fixture.companyA,{asAt:'2026-09-09',limit:500}));
 expect(report.rows.some(row=>row.paymentId===posted.paymentId)).toBe(false);
 expect(report.historyCoverage).toMatchObject({status:'partial',unresolvedAllocationCount:1});
 const origins=await actor(()=>getUnappliedReceiptOrigins(fixture.companyA,'2026-09-09'));
 expect(origins.historyCoverage).toEqual(report.historyCoverage);
 expect(origins.total.unapplied).toBe(report.totalUnapplied+report.totalUnattributed);
});
it('keeps owned population totals complete beyond a page and refuses foreign tenant visibility',async()=>{
 const {posted}=await postedCash();
 const small=await actor(()=>getUnappliedReceipts(fixture.companyA,{asAt:'2026-09-09',limit:1}));
 const full=await actor(()=>getUnappliedReceipts(fixture.companyA,{asAt:'2026-09-09',limit:500}));
 expect(small.rows).toHaveLength(1);expect(small.rowsTotal).toBe(full.rowsTotal);expect(small.totalUnapplied).toBe(full.totalUnapplied);
 const foreign=await actor(()=>getUnappliedReceipts(fixture.companyA,{asAt:'2026-09-09',limit:500}),'u3');
 expect(foreign.rows.some(row=>row.paymentId===posted.paymentId)).toBe(false);expect(foreign.universeTotal).toBe(0);
});

it('independent same-snapshot census detects deliberately omitted history details',async()=>{
 const {queryUnappliedCashHistory}=await import('@/modules/accounting/services/shared/unappliedCashHistoryQuery');
 const {analyzeUnappliedCashHistory}=await import('@/modules/accounting/services/shared/unappliedCashHistory');
 await postedCash();
 const source=await actor(()=>queryUnappliedCashHistory(fixture.companyA,'customer','2026-09-09'));
 const independentlyCounted=(await pool.query("SELECT count(*)::int AS count FROM customer_payments WHERE company_id=$1 AND payment_date<='2026-09-09'",[fixture.companyA])).rows[0].count;
 expect(source.populationCount).toBe(independentlyCounted);
 expect(()=>analyzeUnappliedCashHistory(source.rows.slice(1),'2026-09-09',source.populationCount)).toThrow(/population|census/i);
 const report=await actor(()=>getUnappliedReceipts(fixture.companyA,{asAt:'2026-09-09',limit:1}));
 expect(report.historyCoverage.population.sourceCount).toBe(independentlyCounted);
 expect(report).not.toHaveProperty('universeTotal');
});
it('soft-deleted party cash remains in the independent population and orphan money',async()=>{
 const {posted}=await postedCash();
 await pool.query('UPDATE customers SET deleted_at=NOW() WHERE company_id=$1 AND id=$2',[fixture.companyA,customer]);
 try{
  const report=await actor(()=>getUnappliedReceipts(fixture.companyA,{asAt:'2026-09-09',limit:1}));
  expect(report.unattributed.find(row=>row.paymentId===posted.paymentId)?.unappliedAmount).toBe(115);
  const p=report.historyCoverage.population;
  expect(p.sourceCount).toBe(p.recognizedRemainderCount+p.fullyAppliedCount+p.inactiveCount+p.unresolvedCount);
 }finally{await pool.query('UPDATE customers SET deleted_at=NULL WHERE company_id=$1 AND id=$2',[fixture.companyA,customer]);}
});
