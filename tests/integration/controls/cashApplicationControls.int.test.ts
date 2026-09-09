import {actor,bank,customer,fixture,pool,postedCash} from './cashApplicationFixture';
import {seedBankAllocationSupplier} from './bankAllocationSupplierFixture';
import {approveSupplierInvoice} from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import {getUnappliedPayments} from '@/modules/accounting/services/ap/unappliedPaymentService';
import {planSupplierPaymentApplication} from '@/modules/accounting/services/ap/supplierPaymentApplicationService';
import {prepareCashApplicationReversal,executeCashApplicationReversal} from '@/modules/accounting/services/shared/cashApplicationReversalControl';
import {confirmCustomerPayment,cancelCustomerPayment} from '@/modules/accounting/services/ar/customerPaymentAllocationService';
import {getUnappliedReceipts} from '@/modules/accounting/services/ar/unappliedReceiptService';
import {lockCustomerPaymentForUpdate} from '@/modules/accounting/services/core/paymentLock';
import {loadCashApplicationSources} from '@/modules/accounting/services/shared/cashApplicationSources';
import {prepareCashApplication,executeCashApplication} from '@/modules/accounting/services/shared/cashApplicationControl';
import {planReceiptApplication,applyReceiptPlan} from '@/modules/accounting/services/ar/receiptApplicationService';
import {expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {prepareBankAllocation,executeBankAllocation} from '@/modules/accounting/services/bank/bankAllocationControl';
import {requireControlTx} from '@/modules/accounting/services/controls/context';
import {requestOperationApproval,decideOperationApproval} from '@/modules/accounting/services/controls/approvalRequestService';
it('refuses a later cash application without a fresh approval despite original receipt approval',async()=>{
 const {invoice,posted}=await postedCash();
 await expect(actor(async()=>{
  const plan=await planReceiptApplication(fixture.companyA,posted.paymentId!,[{invoiceId:invoice,amount:115}]);
  return applyReceiptPlan(fixture.companyA,plan,fixture.u1.id);
 })).rejects.toThrow(/approval|intent|controlled/i);
 expect((await pool.query('SELECT amount_paid FROM customer_invoices WHERE company_id=$1 AND id=$2',[fixture.companyA,invoice])).rows[0].amount_paid).toBe('0.00');
});

it('prepares an immutable application without changing posted cash or invoice balances',async()=>{
 const {invoice,posted}=await postedCash();
 const prepared=await actor(()=>prepareCashApplication(requireControlTx(),{version:1,kind:'customer',paymentId:posted.paymentId!,accountingDate:'2026-09-10',applications:[{invoiceId:invoice,amount:'115.00'}]}));
 expect((await pool.query('SELECT kind,payment_id,accounting_date::text,amount::text,currency FROM control_cash_application_intents WHERE company_id=$1 AND id=$2',[fixture.companyA,prepared.intentId])).rows[0]).toMatchObject({kind:'customer',payment_id:posted.paymentId,accounting_date:'2026-09-10',amount:'115.00000000',currency:'ZAR'});
 expect((await pool.query('SELECT amount_paid FROM customer_invoices WHERE company_id=$1 AND id=$2',[fixture.companyA,invoice])).rows[0].amount_paid).toBe('0.00');
 expect((await pool.query('SELECT a.id FROM customer_payment_allocations a JOIN customer_payments p ON p.id=a.payment_id WHERE p.company_id=$1 AND p.id=$2',[fixture.companyA,posted.paymentId])).rows).toHaveLength(0);
});

it('refuses fresh cash source adoption after balanced bank journal and payment amount tampering',async()=>{
 const {invoice,posted}=await postedCash();
 await pool.query('UPDATE customer_payments SET total_amount=230 WHERE company_id=$1 AND id=$2',[fixture.companyA,posted.paymentId]);
 await pool.query('UPDATE gl_journal_lines SET debit=debit*2,credit=credit*2 WHERE company_id=$1 AND journal_entry_id=$2',[fixture.companyA,posted.journalEntryId]);
 await expect(actor(()=>loadCashApplicationSources(requireControlTx(),{version:1,kind:'customer',paymentId:posted.paymentId!,accountingDate:'2026-09-10',applications:[{invoiceId:invoice,amount:'115.00'}]}))).rejects.toThrow(/origin|bank|source|amount/i);
});

it('refuses fresh cash source adoption after reversing the original bank journal direction',async()=>{
 const {invoice,posted}=await postedCash();
 await pool.query('UPDATE gl_journal_lines SET debit=credit,credit=debit WHERE company_id=$1 AND journal_entry_id=$2',[fixture.companyA,posted.journalEntryId]);
 await expect(actor(()=>loadCashApplicationSources(requireControlTx(),{version:1,kind:'customer',paymentId:posted.paymentId!,accountingDate:'2026-09-10',applications:[{invoiceId:invoice,amount:'115.00'}]}))).rejects.toThrow(/origin|bank|source|lines/i);
});
it('accepts unchanged receipt-backed original cash source and exact target facts',async()=>{
 const {invoice,posted}=await postedCash();
 const source=await actor(()=>loadCashApplicationSources(requireControlTx(),{version:1,kind:'customer',paymentId:posted.paymentId!,accountingDate:'2026-09-10',applications:[{invoiceId:invoice,amount:'115.00'}]}));
 expect(source.bankOriginProof?.intentId).toBeTruthy();expect(source.payment.id).toBe(posted.paymentId);expect(source.invoices[0]!.invoice.id).toBe(invoice);
});

it('refuses a target invoice date that no longer agrees with its actual posted journal',async()=>{
 const {invoice,posted}=await postedCash();
 await pool.query("UPDATE customer_invoices SET invoice_date='2026-09-10' WHERE company_id=$1 AND id=$2",[fixture.companyA,invoice]);
 await expect(actor(()=>loadCashApplicationSources(requireControlTx(),{version:1,kind:'customer',paymentId:posted.paymentId!,accountingDate:'2026-09-10',applications:[{invoiceId:invoice,amount:'115.00'}]}))).rejects.toThrow(/date|journal/i);
});

async function retainedInverseCash(){
 const {invoice,posted}=await postedCash(),intent=randomUUID(),inverse=randomUUID();
 // Synthetic storage lifecycle isolates the production reader; this does not certify the inverse writer.
 const payload=JSON.stringify({version:1,kind:'customer',paymentId:posted.paymentId,accountingDate:'2026-09-10',applications:[{invoiceId:invoice,amount:'115.00'}]});
 await pool.query("INSERT INTO control_cash_application_intents(company_id,id,requester_person_id,payment_id,kind,accounting_date,amount,currency,payload,source_fingerprint) VALUES($1,$2,$3,$4,'customer','2026-09-10',115,'ZAR',$5,repeat('a',64))",[fixture.companyA,intent,fixture.u1.id,posted.paymentId,payload]);
 await pool.query('INSERT INTO customer_payment_allocations(payment_id,invoice_id,amount_allocated,application_intent_id) VALUES($1,$2,115,$3)',[posted.paymentId,invoice,intent]);
 await pool.query("INSERT INTO control_cash_application_reversal_intents(company_id,id,requester_person_id,original_intent_id,reversal_date,reason) VALUES($1,$2,$3,$4,'2026-09-11','Synthetic reader inverse')",[fixture.companyA,inverse,fixture.u1.id,intent]);
 await pool.query('UPDATE customer_payment_allocations SET reversed_at=clock_timestamp(),reversal_intent_id=$1 WHERE application_intent_id=$2',[inverse,intent]);
 return{posted,intent};
}
it('excludes retained reversed application history from the actual payment write lock balance',async()=>{
 const {posted,intent}=await retainedInverseCash();
 const locked=await actor(()=>lockCustomerPaymentForUpdate(fixture.companyA,posted.paymentId!));
 expect(Number(locked!.allocated_amount)).toBe(0);
 expect((await pool.query('SELECT amount_allocated::text FROM customer_payment_allocations WHERE application_intent_id=$1',[intent])).rows).toEqual([{amount_allocated:'115.00'}]);
});

for(const [asAt,expected] of [['2026-09-09',115],['2026-09-10',0],['2026-09-11',115]] as const)it(`reports retained application history at its accounting date ${asAt}`,async()=>{
 const {posted}=await retainedInverseCash();
 const report=await actor(()=>getUnappliedReceipts(fixture.companyA,{asAt,limit:500}));
 const receipt=report.rows.find(row=>row.paymentId===posted.paymentId);
 expect(receipt?.unappliedAmount??0).toBe(expected);
});

it('refuses target cash application after balanced invoice journal direction tampering',async()=>{
 const {invoice,posted}=await postedCash();
 await pool.query('UPDATE gl_journal_lines SET debit=credit,credit=debit WHERE company_id=$1 AND journal_entry_id=(SELECT gl_journal_entry_id FROM customer_invoices WHERE company_id=$1 AND id=$2)',[fixture.companyA,invoice]);
 await expect(actor(()=>loadCashApplicationSources(requireControlTx(),{version:1,kind:'customer',paymentId:posted.paymentId!,accountingDate:'2026-09-10',applications:[{invoiceId:invoice,amount:'115.00'}]}))).rejects.toThrow(/journal|direction|source|receivable/i);
});

it('refuses legacy direct receipt source after balanced cash journal direction tampering',async()=>{
 const {invoice}=await postedCash(),paymentId=randomUUID();
 await pool.query("INSERT INTO customer_payments(id,company_id,client_id,payment_number,payment_date,total_amount,currency_code,created_by) VALUES($1,$2,$3,left($1::uuid::text,28),'2026-09-09',115,'ZAR',$4)",[paymentId,fixture.companyA,customer,fixture.u1.id]);
 const ref={entityType:'customer_payment',entityId:paymentId,operation:'customer_payment.confirm' as const};
 const approval=await actor(()=>requestOperationApproval(requireControlTx(),ref));
 await actor(()=>decideOperationApproval(requireControlTx(),approval.id,'approved'),'u2');
 const payment=await actor(()=>confirmCustomerPayment(fixture.companyA,paymentId,fixture.u1.id,{approvalId:approval.id}));
 await pool.query('UPDATE gl_journal_lines SET debit=credit,credit=debit WHERE company_id=$1 AND journal_entry_id=$2',[fixture.companyA,payment.glJournalEntryId]);
 await expect(actor(()=>loadCashApplicationSources(requireControlTx(),{version:1,kind:'customer',paymentId,accountingDate:'2026-09-10',applications:[{invoiceId:invoice,amount:'115.00'}]}))).rejects.toThrow(/journal|direction|source|receivable/i);
});

it('binds fresh application approval to original maker and permits an independent decision',async()=>{
 const {invoice,posted}=await postedCash();
 const prepared=await actor(()=>prepareCashApplication(requireControlTx(),{version:1,kind:'customer',paymentId:posted.paymentId!,accountingDate:'2026-09-10',applications:[{invoiceId:invoice,amount:'115.00'}]}));
 await expect(actor(()=>requestOperationApproval(requireControlTx(),prepared.operation as Parameters<typeof requestOperationApproval>[1]),'u2')).rejects.toThrow('Original intent requester');
 const approval=await actor(()=>requestOperationApproval(requireControlTx(),prepared.operation as Parameters<typeof requestOperationApproval>[1]));
 await expect(actor(()=>decideOperationApproval(requireControlTx(),approval.id,'approved'))).rejects.toThrow(/Self/);
 await expect(actor(()=>decideOperationApproval(requireControlTx(),approval.id,'approved'),'u1',true)).rejects.toThrow(/Self|authenticated human/);
 await actor(()=>decideOperationApproval(requireControlTx(),approval.id,'approved'),'u2');
 expect((await pool.query('SELECT amount_paid::text FROM customer_invoices WHERE company_id=$1 AND id=$2',[fixture.companyA,invoice])).rows[0].amount_paid).toBe('0.00');
});

it('applies approved existing cash once and reverses only its retained allocation history',async()=>{
 const {invoice,posted}=await postedCash();
 const prepared=await actor(()=>prepareCashApplication(requireControlTx(),{version:1,kind:'customer',paymentId:posted.paymentId!,accountingDate:'2026-09-10',applications:[{invoiceId:invoice,amount:'115.00'}]}));
 await expect(actor(()=>executeCashApplication(requireControlTx(),prepared.intentId))).rejects.toThrow(/approval/i);
 const approval=await actor(()=>requestOperationApproval(requireControlTx(),prepared.operation));
 await actor(()=>decideOperationApproval(requireControlTx(),approval.id,'approved'),'u2');
 const applied=await actor(()=>executeCashApplication(requireControlTx(),prepared.intentId,{approvalId:approval.id}));
 expect(await actor(()=>executeCashApplication(requireControlTx(),prepared.intentId))).toEqual(applied);
 expect((await pool.query('SELECT amount_paid::text FROM customer_invoices WHERE company_id=$1 AND id=$2',[fixture.companyA,invoice])).rows[0].amount_paid).toBe('115.00');
 const reversal=await actor(()=>prepareCashApplicationReversal(requireControlTx(),{originalIntentId:prepared.intentId,reversalDate:'2026-09-11',reason:'Synthetic incorrect application'}));
 const inverseApproval=await actor(()=>requestOperationApproval(requireControlTx(),reversal.operation));
 await actor(()=>decideOperationApproval(requireControlTx(),inverseApproval.id,'approved'),'u2');
 const reversed=await actor(()=>executeCashApplicationReversal(requireControlTx(),reversal.intentId,{approvalId:inverseApproval.id}));
 expect(await actor(()=>executeCashApplicationReversal(requireControlTx(),reversal.intentId))).toEqual(reversed);
 expect((await pool.query('SELECT amount_paid::text FROM customer_invoices WHERE company_id=$1 AND id=$2',[fixture.companyA,invoice])).rows[0].amount_paid).toBe('0.00');
 expect((await pool.query('SELECT amount_allocated::text,reversal_intent_id FROM customer_payment_allocations WHERE application_intent_id=$1',[prepared.intentId])).rows).toEqual([{amount_allocated:'115.00',reversal_intent_id:reversal.intentId}]);
 expect((await pool.query('SELECT gl_journal_entry_id,status FROM customer_payments WHERE company_id=$1 AND id=$2',[fixture.companyA,posted.paymentId])).rows[0]).toMatchObject({gl_journal_entry_id:posted.journalEntryId,status:'confirmed'});
});

it('executes the legacy receipt adapter only with its exact approved immutable intent',async()=>{
 const {invoice,posted}=await postedCash();
 const prepared=await actor(()=>prepareCashApplication(requireControlTx(),{version:1,kind:'customer',paymentId:posted.paymentId!,accountingDate:'2026-09-10',applications:[{invoiceId:invoice,amount:'115.00'}]}));
 const preview=await actor(()=>planReceiptApplication(fixture.companyA,posted.paymentId!,[{invoiceId:invoice,amount:115}]));
 const approval=await actor(()=>requestOperationApproval(requireControlTx(),prepared.operation));
 await actor(()=>decideOperationApproval(requireControlTx(),approval.id,'approved'),'u2');
 const options={intentId:prepared.intentId,approvalId:approval.id};
 await expect(actor(()=>applyReceiptPlan(fixture.companyA,{...preview,lines:preview.lines.map(line=>({...line,amount:114}))},fixture.u1.id,options))).rejects.toThrow(/immutable intent/);
 await actor(()=>applyReceiptPlan(fixture.companyA,preview,fixture.u1.id,options));
 expect((await pool.query('SELECT amount_paid::text FROM customer_invoices WHERE company_id=$1 AND id=$2',[fixture.companyA,invoice])).rows[0].amount_paid).toBe('115.00');
});

it('cancels direct receipt after approved unapplication without subtracting retained history again',async()=>{
 const {invoice}=await postedCash(),paymentId=randomUUID();
 await pool.query("INSERT INTO customer_payments(id,company_id,client_id,payment_number,payment_date,total_amount,currency_code,created_by) VALUES($1,$2,$3,left($1::uuid::text,28),'2026-09-09',115,'ZAR',$4)",[paymentId,fixture.companyA,customer,fixture.u1.id]);
 const confirmation=await actor(()=>requestOperationApproval(requireControlTx(),{entityType:'customer_payment',entityId:paymentId,operation:'customer_payment.confirm'}));
 await actor(()=>decideOperationApproval(requireControlTx(),confirmation.id,'approved'),'u2');
 await actor(()=>confirmCustomerPayment(fixture.companyA,paymentId,fixture.u1.id,{approvalId:confirmation.id}));
 const application=await actor(()=>prepareCashApplication(requireControlTx(),{version:1,kind:'customer',paymentId,accountingDate:'2026-09-10',applications:[{invoiceId:invoice,amount:'115.00'}]}));
 const approval=await actor(()=>requestOperationApproval(requireControlTx(),application.operation));
 await actor(()=>decideOperationApproval(requireControlTx(),approval.id,'approved'),'u2');
 await actor(()=>executeCashApplication(requireControlTx(),application.intentId,{approvalId:approval.id}));
 const inverse=await actor(()=>prepareCashApplicationReversal(requireControlTx(),{originalIntentId:application.intentId,reversalDate:'2026-09-11',reason:'Synthetic before cancellation'}));
 const inverseApproval=await actor(()=>requestOperationApproval(requireControlTx(),inverse.operation));
 await actor(()=>decideOperationApproval(requireControlTx(),inverseApproval.id,'approved'),'u2');
 await actor(()=>executeCashApplicationReversal(requireControlTx(),inverse.intentId,{approvalId:inverseApproval.id}));
 const legacyAgain=await actor(()=>planReceiptApplication(fixture.companyA,paymentId,[{invoiceId:invoice,amount:115}]));
 expect(legacyAgain.lines[0]!.amount).toBe(115);
 const again=await actor(()=>prepareCashApplication(requireControlTx(),{version:1,kind:'customer',paymentId,accountingDate:'2026-09-11',applications:[{invoiceId:invoice,amount:'115.00'}]}));
 const againApproval=await actor(()=>requestOperationApproval(requireControlTx(),again.operation));
 await actor(()=>decideOperationApproval(requireControlTx(),againApproval.id,'approved'),'u2');
 await actor(()=>executeCashApplication(requireControlTx(),again.intentId,{approvalId:againApproval.id}));
 const againInverse=await actor(()=>prepareCashApplicationReversal(requireControlTx(),{originalIntentId:again.intentId,reversalDate:'2026-09-12',reason:'Synthetic repeated unapply'}));
 const againInverseApproval=await actor(()=>requestOperationApproval(requireControlTx(),againInverse.operation));
 await actor(()=>decideOperationApproval(requireControlTx(),againInverseApproval.id,'approved'),'u2');
 await actor(()=>executeCashApplicationReversal(requireControlTx(),againInverse.intentId,{approvalId:againInverseApproval.id}));
 const cancellation=await actor(()=>requestOperationApproval(requireControlTx(),{entityType:'customer_payment',entityId:paymentId,operation:'customer_payment.cancel',reversalDate:'2026-09-12'}));
 await actor(()=>decideOperationApproval(requireControlTx(),cancellation.id,'approved'),'u2');
 await actor(()=>cancelCustomerPayment(fixture.companyA,paymentId,fixture.u1.id,'Synthetic cancel',{approvalId:cancellation.id,reversalDate:'2026-09-12'}));
 expect((await pool.query('SELECT amount_paid::text FROM customer_invoices WHERE company_id=$1 AND id=$2',[fixture.companyA,invoice])).rows[0].amount_paid).toBe('0.00');
 expect((await pool.query('SELECT status FROM customer_payments WHERE company_id=$1 AND id=$2',[fixture.companyA,paymentId])).rows[0].status).toBe('cancelled');
 expect((await pool.query('SELECT amount_allocated::text,reversal_intent_id FROM customer_payment_allocations WHERE application_intent_id=$1',[application.intentId])).rows).toEqual([{amount_allocated:'115.00',reversal_intent_id:inverse.intentId}]);
});

it('applies and reverses supplier bank cash and reports immutable accounting dates',async()=>{
 const expense=randomUUID();
 for(const [id,role,type,balance] of [[randomUUID(),'payable','liability','credit'],[expense,'default_expense','expense','debit'],[randomUUID(),'vat_input','asset','debit']])await pool.query("INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance,is_active,is_system_account,level) VALUES($1,$2,left($1::uuid::text,12),$3,$4,$3,$5,true,true,3)",[id,fixture.companyA,role,type,balance]);
 const supplier=await seedBankAllocationSupplier(pool,fixture,(person,fn)=>actor(()=>fn(requireControlTx()),person)),tx=randomUUID();
 await pool.query("UPDATE supplier_invoices SET subtotal=100,tax_rate=15,tax_amount=15,total_amount=115,currency='ZAR' WHERE company_id=$1 AND id=$2",[fixture.companyA,supplier.invoice]);
 await pool.query("INSERT INTO supplier_invoice_items(supplier_invoice_id,description,quantity,unit_price,line_total,tax_rate,tax_amount,gl_account_id) VALUES($1,'Cash target expense',1,100,100,15,15,$2)",[supplier.invoice,expense]);
 await actor(()=>approveSupplierInvoice(fixture.companyA,supplier.invoice,fixture.u1.id));
 await pool.query("INSERT INTO bank_transactions(id,company_id,bank_account_id,transaction_date,amount,description,status) VALUES($1,$2,$3,'2026-09-09',-115,'Unapplied supplier cash','imported')",[tx,fixture.companyA,bank]);
 const bankIntent=await actor(()=>prepareBankAllocation(requireControlTx(),{version:1,kind:'supplier',bankTransactionId:tx,partyId:supplier.supplier,applications:[]}));
 const bankApproval=await actor(()=>requestOperationApproval(requireControlTx(),bankIntent.operation));
 await actor(()=>decideOperationApproval(requireControlTx(),bankApproval.id,'approved'),'u2');
 const posted=await actor(()=>executeBankAllocation(requireControlTx(),bankIntent.intentId,{approvalId:bankApproval.id}));
 const application=await actor(()=>prepareCashApplication(requireControlTx(),{version:1,kind:'supplier',paymentId:posted.paymentId!,accountingDate:'2026-09-10',applications:[{invoiceId:supplier.invoice,amount:'115.00'}]}));
 const approval=await actor(()=>requestOperationApproval(requireControlTx(),application.operation));
 await actor(()=>decideOperationApproval(requireControlTx(),approval.id,'approved'),'u2');
 await actor(()=>executeCashApplication(requireControlTx(),application.intentId,{approvalId:approval.id}));
 const inverse=await actor(()=>prepareCashApplicationReversal(requireControlTx(),{originalIntentId:application.intentId,reversalDate:'2026-09-11',reason:'Synthetic supplier unapply'}));
 const inverseApproval=await actor(()=>requestOperationApproval(requireControlTx(),inverse.operation));
 await actor(()=>decideOperationApproval(requireControlTx(),inverseApproval.id,'approved'),'u2');
 await actor(()=>executeCashApplicationReversal(requireControlTx(),inverse.intentId,{approvalId:inverseApproval.id}));
 const legacyAgain=await actor(()=>planSupplierPaymentApplication(fixture.companyA,posted.paymentId!,[{invoiceId:supplier.invoice,amount:115}]));
 expect(legacyAgain.lines[0]!.amount).toBe(115);
 for(const [asAt,expected] of [['2026-09-09',115],['2026-09-10',0],['2026-09-11',115]] as const){
  const report=await actor(()=>getUnappliedPayments(fixture.companyA,{asAt,limit:500}));
  expect(report.rows.find(row=>row.paymentId===posted.paymentId)?.unappliedAmount??0).toBe(expected);
 }
 expect((await pool.query('SELECT amount_paid::text,payment_matched FROM supplier_invoices WHERE company_id=$1 AND id=$2',[fixture.companyA,supplier.invoice])).rows[0]).toEqual({amount_paid:'0.00',payment_matched:false});
 expect((await pool.query('SELECT amount_allocated::text,reversal_intent_id FROM payment_allocations WHERE application_intent_id=$1',[application.intentId])).rows).toEqual([{amount_allocated:'115.00',reversal_intent_id:inverse.intentId}]);
});

it('requires approved unapplication before cancelling cash with active controlled allocations',async()=>{
 const {invoice}=await postedCash(),paymentId=randomUUID();
 await pool.query("INSERT INTO customer_payments(id,company_id,client_id,payment_number,payment_date,total_amount,currency_code,created_by) VALUES($1,$2,$3,left($1::uuid::text,28),'2026-09-09',115,'ZAR',$4)",[paymentId,fixture.companyA,customer,fixture.u1.id]);
 const confirmation=await actor(()=>requestOperationApproval(requireControlTx(),{entityType:'customer_payment',entityId:paymentId,operation:'customer_payment.confirm'}));
 await actor(()=>decideOperationApproval(requireControlTx(),confirmation.id,'approved'),'u2');
 await actor(()=>confirmCustomerPayment(fixture.companyA,paymentId,fixture.u1.id,{approvalId:confirmation.id}));
 const application=await actor(()=>prepareCashApplication(requireControlTx(),{version:1,kind:'customer',paymentId,accountingDate:'2026-09-10',applications:[{invoiceId:invoice,amount:'50.00'}]}));
 const approval=await actor(()=>requestOperationApproval(requireControlTx(),application.operation));
 await actor(()=>decideOperationApproval(requireControlTx(),approval.id,'approved'),'u2');
 await actor(()=>executeCashApplication(requireControlTx(),application.intentId,{approvalId:approval.id}));
 const ref={entityType:'customer_payment',entityId:paymentId,operation:'customer_payment.cancel' as const,reversalDate:'2026-09-12'};
 await expect(actor(()=>requestOperationApproval(requireControlTx(),ref))).rejects.toThrow(/unapplication|application|controlled/i);
 expect((await pool.query("SELECT id FROM control_operation_approvals WHERE company_id=$1 AND entity_id=$2 AND operation='customer_payment.cancel'",[fixture.companyA,paymentId])).rows).toHaveLength(0);
 expect((await pool.query('SELECT amount_paid::text FROM customer_invoices WHERE company_id=$1 AND id=$2',[fixture.companyA,invoice])).rows[0].amount_paid).toBe('50.00');
});

it('serializes concurrent execution of one approved cash intent into one effect and allocation',async()=>{
 const {invoice,posted}=await postedCash();
 const application=await actor(()=>prepareCashApplication(requireControlTx(),{version:1,kind:'customer',paymentId:posted.paymentId!,accountingDate:'2026-09-10',applications:[{invoiceId:invoice,amount:'115.00'}]}));
 const approval=await actor(()=>requestOperationApproval(requireControlTx(),application.operation));
 await actor(()=>decideOperationApproval(requireControlTx(),approval.id,'approved'),'u2');
 const results=await Promise.all([actor(()=>executeCashApplication(requireControlTx(),application.intentId,{approvalId:approval.id})),actor(()=>executeCashApplication(requireControlTx(),application.intentId,{approvalId:approval.id}))]);
 expect(results[1]).toEqual(results[0]);
 expect((await pool.query('SELECT count(*)::int AS n FROM customer_payment_allocations WHERE application_intent_id=$1',[application.intentId])).rows[0].n).toBe(1);
 expect((await pool.query("SELECT count(*)::int AS n FROM control_operation_effects WHERE company_id=$1 AND entity_type='cash_application_intent' AND entity_id=$2",[fixture.companyA,application.intentId])).rows[0].n).toBe(1);
});

it('derives invoice settled timestamp when cash is applied and clears it on approved inverse',async()=>{
 const {invoice,posted}=await postedCash();
 const application=await actor(()=>prepareCashApplication(requireControlTx(),{version:1,kind:'customer',paymentId:posted.paymentId!,accountingDate:'2026-09-10',applications:[{invoiceId:invoice,amount:'115.00'}]}));
 const approval=await actor(()=>requestOperationApproval(requireControlTx(),application.operation));
 await actor(()=>decideOperationApproval(requireControlTx(),approval.id,'approved'),'u2');
 await actor(()=>executeCashApplication(requireControlTx(),application.intentId,{approvalId:approval.id}));
 expect((await pool.query('SELECT paid_at FROM customer_invoices WHERE company_id=$1 AND id=$2',[fixture.companyA,invoice])).rows[0].paid_at).not.toBeNull();
 const inverse=await actor(()=>prepareCashApplicationReversal(requireControlTx(),{originalIntentId:application.intentId,reversalDate:'2026-09-11',reason:'Synthetic timestamp inverse'}));
 const inverseApproval=await actor(()=>requestOperationApproval(requireControlTx(),inverse.operation));
 await actor(()=>decideOperationApproval(requireControlTx(),inverseApproval.id,'approved'),'u2');
 await actor(()=>executeCashApplicationReversal(requireControlTx(),inverse.intentId,{approvalId:inverseApproval.id}));
 expect((await pool.query('SELECT paid_at FROM customer_invoices WHERE company_id=$1 AND id=$2',[fixture.companyA,invoice])).rows[0].paid_at).toBeNull();
});
