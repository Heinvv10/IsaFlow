import {prepareBankAllocation,executeBankAllocation} from '@/modules/accounting/services/bank/bankAllocationControl';
import {prepareBankAllocationReversal} from '@/modules/accounting/services/bank/bankAllocationReversal';
import {als} from '@/lib/als';
import {voidPaymentDocument} from '@/modules/accounting/services/core/paymentVoidService';
import {unwindOnePayment,unwindBankAllocationApplication} from '@/modules/accounting/services/bank/bankAllocationUnwind';
import {confirmCustomerPayment,cancelCustomerPayment} from '@/modules/accounting/services/ar/customerPaymentAllocationService';
import {processSupplierPayment,voidSupplierPayment} from '@/modules/accounting/services/ap/supplierPaymentWorkflowService';
import {prepareCashApplication,executeCashApplication} from '@/modules/accounting/services/shared/cashApplicationControl';
import {prepareCashApplicationReversal,executeCashApplicationReversal} from '@/modules/accounting/services/shared/cashApplicationReversalControl';
import type {OperationRef} from '@/modules/accounting/services/controls/contracts';
import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import {randomUUID,randomBytes} from 'node:crypto';
import {Pool} from 'pg';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {provisionForensicFixture,validateFixtureTarget,type ForensicFixture} from '../forensic-fixture';
import {requireControlTx,withControlRequest} from '@/modules/accounting/services/controls/context';
import {requestOperationApproval,decideOperationApproval} from '@/modules/accounting/services/controls/approvalRequestService';
import {approveCustomerInvoice} from '@/modules/accounting/services/ar/customerInvoiceApprovalService';
import {seedApAccounts} from './apSyntheticAccounts';
import {approveSupplierInvoice} from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';
process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');
process.env.CONTROL_FINGERPRINT_KEY=randomBytes(32).toString('hex');
vi.mock('@/modules/accounting/services/ar/invoicePdfSnapshotService',()=>({snapshotInvoicePdf:async()=>({documentId:null,wasExisting:false})}));
const config=fixtureConfigFromEnv(process.env),target=validateFixtureTarget(config);
const pool=new Pool({connectionString:target.connectionString,ssl:false,max:3});
let fixture:ForensicFixture;let apAccounts:Awaited<ReturnType<typeof seedApAccounts>>;
const customer=randomUUID(),bank=randomUUID(),rule=randomUUID();
beforeAll(async()=>{
 fixture=await provisionForensicFixture(config);apAccounts=await seedApAccounts(pool,fixture.companyA);
 await pool.query("INSERT INTO approval_rules(id,company_id,name,document_type,condition_field,condition_operator,condition_value,approver_role) VALUES($1,$2,'Synthetic receipt approval','payment','amount','any',0,'admin')",[rule,fixture.companyA]);

 await pool.query('INSERT INTO customers(id,company_id,name) VALUES($1,$2,$3)',[customer,fixture.companyA,'Synthetic allocation customer']);
 await pool.query("INSERT INTO fiscal_periods(id,company_id,period_name,period_number,fiscal_year,start_date,end_date,status) VALUES($1,$2,'Synthetic allocation September',9,2026,'2026-09-01','2026-09-30','open')",[randomUUID(),fixture.companyA]);
 for(const [id,role] of [[bank,'bank'],[randomUUID(),'receivable']])await pool.query("INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance,is_active,is_system_account,level) VALUES($1,$2,$3,$4,'asset',$4,'debit',true,true,3)",[id,fixture.companyA,id!.slice(0,12),role]);
 for(const [role,type] of [['default_revenue','revenue'],['vat_output','liability']]){const id=randomUUID();await pool.query("INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance,is_active,is_system_account,level) VALUES($1,$2,$3,$4,$5,$4,'credit',true,true,3)",[id,fixture.companyA,id.slice(0,12),role,type]);}
 await pool.query('UPDATE gl_accounts SET is_system_account=false WHERE company_id=$1 AND id=$2',[fixture.companyA,bank]);
 await pool.query("INSERT INTO bank_accounts(company_id,account_name,gl_account_id,currency) VALUES($1,'Synthetic allocation bank',$2,'ZAR')",[fixture.companyA,bank]);
});
afterAll(async()=>{await pool.end();});
async function actor<T>(fn:()=>Promise<T>,person:'u1'|'u2'='u1',bearer=false){
 const client=await pool.connect(),user=fixture[person];
 try{
  await client.query('BEGIN');await client.query('SET LOCAL ROLE app_user');
  const claims={sub:user.id,role:'authenticated',company_id:fixture.companyA};
  await client.query("SELECT set_config('request.jwt.claims',$1,true),set_config('app.current_company_id',$2,true)",[JSON.stringify(claims),fixture.companyA]);
  const result=await withControlRequest({client,userId:user.id,companyId:fixture.companyA,claims},{personId:user.id,companyId:fixture.companyA,authMethod:bearer?'pat':'cookie',...(bearer?{connectionId:user.tokens[0]!.id,grantId:user.tokens[0]!.id,grantedScopes:['write:bank-tx','write:post','write:approvals']}: {})},fn);
  await client.query('COMMIT');return result;
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}


type Kind='customer'|'supplier';
async function approval(ref:OperationRef){
 const row=await actor(()=>requestOperationApproval(requireControlTx(),ref));
 await actor(()=>decideOperationApproval(requireControlTx(),row.id,'approved'),'u2');return row.id;
}
async function document(kind:Kind,legacy=false){
 const invoice=randomUUID(),payment=randomUUID(),party=kind==='customer'?customer:randomUUID();
 if(kind==='customer'){
  await pool.query(`INSERT INTO customer_invoices(id,company_id,customer_id,client_id,invoice_number,invoice_date,subtotal,tax_amount,total_amount,currency_code,exchange_rate,functional_total,created_by)
   VALUES($1,$2,$3,$3,$4,'2026-09-09',100,15,115,'ZAR',1,115,$5)`,[invoice,fixture.companyA,party,invoice,fixture.u1.id]);
  await pool.query("INSERT INTO customer_invoice_items(invoice_id,description,quantity,unit_price,amount,tax_rate) VALUES($1,'Synthetic void service',1,100,100,15)",[invoice]);
  await actor(()=>approveCustomerInvoice(fixture.companyA,invoice,fixture.u1.id));
  await pool.query("INSERT INTO customer_payments(id,company_id,client_id,payment_number,payment_date,total_amount,currency_code,created_by,status) VALUES($1,$2,$3,left($1::uuid::text,28),'2026-09-09',115,'ZAR',$4,$5)",[payment,fixture.companyA,party,fixture.u1.id,legacy?'confirmed':'draft']);
 }else{
  await pool.query("INSERT INTO suppliers(id,company_id,name) VALUES($1,$2,'Synthetic legacy void supplier')",[party,fixture.companyA]);
  await pool.query(`INSERT INTO supplier_invoices(id,company_id,supplier_id,invoice_number,invoice_date,subtotal,tax_rate,tax_amount,total_amount,currency,status,created_by)
   VALUES($1,$2,$3,$4,'2026-09-09',100,15,15,115,'ZAR','draft',$5)`,[invoice,fixture.companyA,party,invoice,fixture.u1.id]);
  await pool.query("INSERT INTO supplier_invoice_items(supplier_invoice_id,description,quantity,unit_price,line_total,tax_rate,tax_amount,gl_account_id) VALUES($1,'Synthetic void expense',1,100,100,15,15,$2)",[invoice,apAccounts.default_expense]);
  await actor(()=>approveSupplierInvoice(fixture.companyA,invoice,fixture.u1.id));
  await pool.query("INSERT INTO supplier_payments(id,company_id,supplier_id,payment_number,payment_date,total_amount,status,created_by) VALUES($1,$2,$3,left($1::uuid::text,28),'2026-09-09',115,$4,$5)",[payment,fixture.companyA,party,legacy?'processed':'approved',fixture.u1.id]);
 }
 if(kind==='customer')await pool.query('UPDATE customer_payments SET bank_account_id=$3 WHERE company_id=$1 AND id=$2',[fixture.companyA,payment,bank]);
 if(kind==='supplier'&&!legacy)await pool.query('INSERT INTO payment_allocations(payment_id,invoice_id,amount_allocated) VALUES($1,$2,115)',[payment,invoice]);
 if(legacy){
  // Reproduce a pre-existing applied, journal-less legacy document, never certify its provenance.
  if(kind==='customer'){
   await pool.query('INSERT INTO customer_payment_allocations(payment_id,invoice_id,amount_allocated) VALUES($1,$2,115)',[payment,invoice]);
   await pool.query("UPDATE customer_invoices SET amount_paid=115,status='paid',paid_at=now() WHERE company_id=$1 AND id=$2",[fixture.companyA,invoice]);
  }else{
   await pool.query('INSERT INTO payment_allocations(payment_id,invoice_id,amount_allocated) VALUES($1,$2,115)',[payment,invoice]);
   await pool.query("UPDATE supplier_invoices SET amount_paid=115,status='paid',paid_at=now(),payment_matched=true,payment_matched_at=now() WHERE company_id=$1 AND id=$2",[fixture.companyA,invoice]);
  }
 }else{
  const ref:OperationRef={entityType:`${kind}_payment`,entityId:payment,operation:kind==='customer'?'customer_payment.confirm':'supplier_payment.process'};
  const approved=await approval(ref);
  if(kind==='customer')await actor(()=>confirmCustomerPayment(fixture.companyA,payment,fixture.u1.id,{approvalId:approved}));
  else await actor(()=>processSupplierPayment(fixture.companyA,payment,fixture.u1.id,{approvalId:approved}));
 }
 return{invoice,payment};
}
async function state(kind:Kind,payment:string,invoice:string){
 const company=fixture.companyA;
 return{
  payment:(kind==='customer'?await pool.query('SELECT * FROM customer_payments WHERE company_id=$1 AND id=$2',[company,payment]):await pool.query('SELECT * FROM supplier_payments WHERE company_id=$1 AND id=$2',[company,payment])).rows,
  invoice:(kind==='customer'?await pool.query('SELECT amount_paid,status,paid_at FROM customer_invoices WHERE company_id=$1 AND id=$2',[company,invoice]):await pool.query('SELECT amount_paid,status,paid_at,payment_matched,payment_matched_at FROM supplier_invoices WHERE company_id=$1 AND id=$2',[company,invoice])).rows,
  allocations:(kind==='customer'?await pool.query('SELECT a.* FROM customer_payment_allocations a JOIN customer_payments p ON p.id=a.payment_id WHERE p.company_id=$1 AND p.id=$2',[company,payment]):await pool.query('SELECT a.* FROM payment_allocations a JOIN supplier_payments p ON p.id=a.payment_id WHERE p.company_id=$1 AND p.id=$2',[company,payment])).rows,
 };
}
async function unissued<T>(fn:()=>Promise<T>){
 const client=await pool.connect();
 try{
  await client.query('BEGIN');await client.query('SET LOCAL ROLE app_user');
  const claims={sub:fixture.u1.id,company_id:fixture.companyA,role:'authenticated'};
  await client.query("SELECT set_config('request.jwt.claims',$1,true),set_config('app.current_company_id',$2,true)",[JSON.stringify(claims),fixture.companyA]);
  const result=await als.run({client,userId:fixture.u1.id,companyId:fixture.companyA,claims},fn);await client.query('COMMIT');return result;
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
for(const kind of ['customer','supplier'] as const){
 it(`${kind}: journal-less legacy void cannot mutate with unissued ALS context`,async()=>{
  const doc=await document(kind,true),before=await state(kind,doc.payment,doc.invoice);
  await expect(unissued(()=>voidPaymentDocument(fixture.companyA,kind,doc.payment,fixture.u1.id))).rejects.toThrow(/control|authenticated/i);
  expect(await state(kind,doc.payment,doc.invoice)).toEqual(before);
 });
 it(`${kind}: journal-less legacy void cannot bypass independent approval`,async()=>{
  const doc=await document(kind,true),before=await state(kind,doc.payment,doc.invoice);
  await expect(actor(()=>voidPaymentDocument(fixture.companyA,kind,doc.payment,fixture.u1.id))).rejects.toThrow(/approval|journal|source|controlled/i);
  expect(await state(kind,doc.payment,doc.invoice)).toEqual(before);
 });
 it(`${kind}: revoked current authority refuses legacy void before financial mutation`,async()=>{
  const doc=await document(kind,true),before=await state(kind,doc.payment,doc.invoice);
  await pool.query("UPDATE company_users SET role='viewer' WHERE company_id=$1 AND user_id=$2",[fixture.companyA,fixture.u1.id]);
  try{await expect(actor(()=>voidPaymentDocument(fixture.companyA,kind,doc.payment,fixture.u1.id))).rejects.toThrow(/permission|authority|denied/i);}
  finally{await pool.query("UPDATE company_users SET role='admin' WHERE company_id=$1 AND user_id=$2",[fixture.companyA,fixture.u1.id]);}
  expect(await state(kind,doc.payment,doc.invoice)).toEqual(before);
 });
 it(`${kind}: exported raw unwind cannot erase settlement without an immutable inverse`,async()=>{
  const doc=await document(kind,true),before=await state(kind,doc.payment,doc.invoice);
  await expect(actor(()=>unwindOnePayment(fixture.companyA,kind,doc.payment))).rejects.toThrow(/approved|inverse|controlled/i);
  expect(await state(kind,doc.payment,doc.invoice)).toEqual(before);
 });
 it(`${kind}: approved non-bank void preserves independently reversed cash history and rollback`,async()=>{
  const doc=await document(kind);
  if(kind==='supplier'){
   const ref:OperationRef={entityType:'supplier_payment',entityId:doc.payment,operation:'supplier_payment.void'};
   const approved=await approval(ref),before=await state(kind,doc.payment,doc.invoice),opts={approvalId:approved};
   await expect(actor(async()=>{await voidPaymentDocument(fixture.companyA,kind,doc.payment,fixture.u1.id,opts);throw new Error('Synthetic void rollback');})).rejects.toThrow('Synthetic void rollback');
   expect(await state(kind,doc.payment,doc.invoice)).toEqual(before);
   const result=await actor(()=>voidPaymentDocument(fixture.companyA,kind,doc.payment,fixture.u1.id,opts));
   expect(result).toMatchObject({paymentId:doc.payment,kind,bankTransactionId:null,invoicesReopened:1,amountUnapplied:115});
   const after=await state(kind,doc.payment,doc.invoice);
   expect(after.payment[0].status).toBe('cancelled');expect(after.invoice[0]).toMatchObject({status:'approved',amount_paid:'0.00'});
   expect(after.allocations).toEqual(before.allocations);return;
  }
  const application=await actor(()=>prepareCashApplication(requireControlTx(),{version:1,kind,paymentId:doc.payment,accountingDate:'2026-09-10',applications:[{invoiceId:doc.invoice,amount:'115'}]}));
  const applyApproval=await approval(application.operation as OperationRef);
  await actor(()=>executeCashApplication(requireControlTx(),application.intentId,{approvalId:applyApproval}));
  const active=await state(kind,doc.payment,doc.invoice);
  await expect(actor(()=>voidPaymentDocument(fixture.companyA,kind,doc.payment,fixture.u1.id))).rejects.toThrow();
  expect(await state(kind,doc.payment,doc.invoice)).toEqual(active);
  const inverse=await actor(()=>prepareCashApplicationReversal(requireControlTx(),{originalIntentId:application.intentId,reversalDate:'2026-09-11',reason:'Synthetic independent unapplication'}));
  const inverseApproval=await approval(inverse.operation);
  await actor(()=>executeCashApplicationReversal(requireControlTx(),inverse.intentId,{approvalId:inverseApproval}));
  const ref:OperationRef={entityType:`${kind}_payment`,entityId:doc.payment,operation:kind==='customer'?'customer_payment.cancel':'supplier_payment.void',...(kind==='customer'?{reversalDate:'2026-09-12'}:{})};
  const voidApproval=await approval(ref),before=await state(kind,doc.payment,doc.invoice);
  const opts={approvalId:voidApproval,reversalDate:kind==='customer'?'2026-09-12':undefined};
  await expect(actor(async()=>{await voidPaymentDocument(fixture.companyA,kind,doc.payment,fixture.u1.id,opts);throw new Error('Synthetic void rollback');})).rejects.toThrow('Synthetic void rollback');
  expect(await state(kind,doc.payment,doc.invoice)).toEqual(before);
  const result=await actor(()=>voidPaymentDocument(fixture.companyA,kind,doc.payment,fixture.u1.id,opts));
  expect(result).toMatchObject({paymentId:doc.payment,kind,bankTransactionId:null,invoicesReopened:0,amountUnapplied:0});
  const after=await state(kind,doc.payment,doc.invoice);
  expect(after.payment[0].status).toBe('cancelled');expect(after.invoice).toEqual(before.invoice);
  expect(after.allocations).toEqual(before.allocations);expect(after.allocations[0].reversal_intent_id).toBe(inverse.intentId);
  expect(await actor(()=>voidPaymentDocument(fixture.companyA,kind,doc.payment,fixture.u1.id,opts))).toEqual({refusal:'already_cancelled'});
 });
}
it('exported journal-wide raw unwind refuses an unapproved mutation request',async()=>{
 await expect(actor(()=>unwindBankAllocationApplication(fixture.companyA,randomUUID()))).rejects.toThrow(/approved|inverse|controlled/i);
});

it('bank-backed document delegates its exact independently approved immutable inverse',async()=>{
 const tx=randomUUID(),targetInvoice=(await document('customer')).invoice;
 await pool.query("INSERT INTO bank_transactions(id,company_id,bank_account_id,transaction_date,amount,description,status) VALUES($1,$2,$3,'2026-09-09',115,'Synthetic document-addressed bank inverse','imported')",[tx,fixture.companyA,bank]);
 const prepared=await actor(()=>prepareBankAllocation(requireControlTx(),{version:1,kind:'customer',bankTransactionId:tx,partyId:customer,applications:[{invoiceId:targetInvoice,amount:'115'}]}));
 const approved=await approval(prepared.operation);
 const posted=await actor(()=>executeBankAllocation(requireControlTx(),prepared.intentId,{approvalId:approved}));
 const duplicate=randomUUID();
 await pool.query("INSERT INTO bank_transactions(id,company_id,bank_account_id,transaction_date,amount,description,status,matched_journal_line_id) SELECT $1,company_id,bank_account_id,transaction_date,amount,'Synthetic ambiguous bank relationship','allocated',matched_journal_line_id FROM bank_transactions WHERE company_id=$2 AND id=$3",[duplicate,fixture.companyA,tx]);
 expect(await actor(()=>voidPaymentDocument(fixture.companyA,'customer',posted.paymentId!,fixture.u1.id))).toEqual({refusal:'ambiguous_bank_lines',count:2});
 await pool.query('DELETE FROM bank_transactions WHERE company_id=$1 AND id=$2',[fixture.companyA,duplicate]);
 const inverse=await actor(()=>prepareBankAllocationReversal(requireControlTx(),{originalIntentId:prepared.intentId,reversalDate:'2026-09-12',reason:'Synthetic document inverse'}));
 const inverseApproval=await approval(inverse.operation);
 const result=await actor(()=>voidPaymentDocument(fixture.companyA,'customer',posted.paymentId!,fixture.u1.id,{intentId:inverse.intentId,approvalId:inverseApproval,reversalDate:'2026-09-12'}));
 expect(result).toMatchObject({paymentId:posted.paymentId,bankTransactionId:tx,journalEntryId:posted.journalEntryId,invoicesReopened:1,amountUnapplied:115});
 expect((await pool.query('SELECT status FROM bank_transactions WHERE company_id=$1 AND id=$2',[fixture.companyA,tx])).rows[0].status).toBe('imported');
 expect((await pool.query('SELECT status FROM customer_payments WHERE company_id=$1 AND id=$2',[fixture.companyA,posted.paymentId])).rows[0].status).toBe('cancelled');
});

it('foreign payment is indistinguishable from missing and does not change owned balances',async()=>{
 const foreignCustomer=randomUUID(),foreignPayment=randomUUID();
 await pool.query("INSERT INTO customers(id,company_id,name) VALUES($1,$2,'Synthetic foreign customer')",[foreignCustomer,fixture.companyB]);
 await pool.query("INSERT INTO customer_payments(id,company_id,client_id,payment_number,payment_date,total_amount,currency_code,created_by) VALUES($1,$2,$3,left($1::uuid::text,28),'2026-09-09',115,'ZAR',$4)",[foreignPayment,fixture.companyB,foreignCustomer,fixture.u3.id]);
 expect(await actor(()=>voidPaymentDocument(fixture.companyA,'customer',foreignPayment,fixture.u1.id))).toEqual({refusal:'not_found'});
 expect(await actor(()=>voidPaymentDocument(fixture.companyA,'customer',randomUUID(),fixture.u1.id))).toEqual({refusal:'not_found'});
 expect((await pool.query('SELECT status FROM customer_payments WHERE company_id=$1 AND id=$2',[fixture.companyB,foreignPayment])).rows[0].status).toBe('draft');
});
for(const kind of ['customer','supplier'] as const)it(`${kind}: unapplied draft-stage document refuses before changing invoice or history`,async()=>{
 const doc=await document(kind,true),status=kind==='customer'?'draft':'approved';
 if(kind==='customer')await pool.query('UPDATE customer_payments SET status=$3 WHERE company_id=$1 AND id=$2',[fixture.companyA,doc.payment,status]);
 else await pool.query('UPDATE supplier_payments SET status=$3 WHERE company_id=$1 AND id=$2',[fixture.companyA,doc.payment,status]);
 const before=await state(kind,doc.payment,doc.invoice);
 expect(await actor(()=>voidPaymentDocument(fixture.companyA,kind,doc.payment,fixture.u1.id))).toEqual({refusal:'not_applied',status});
 expect(await state(kind,doc.payment,doc.invoice)).toEqual(before);
});

it('refuses an approved single-payment void when its journal also backs another live payment',async()=>{
 const doc=await document('customer'),sibling=randomUUID();
 const before=await state('customer',doc.payment,doc.invoice),journal=before.payment[0].gl_journal_entry_id;
 await pool.query("INSERT INTO customer_payments(id,company_id,client_id,payment_number,payment_date,total_amount,currency_code,created_by,status,gl_journal_entry_id,bank_account_id) VALUES($1,$2,$3,left($1::uuid::text,28),'2026-09-09',115,'ZAR',$4,'confirmed',$5,$6)",[sibling,fixture.companyA,customer,fixture.u1.id,journal,bank]);
 await expect((async()=>{const approved=await approval({entityType:'customer_payment',entityId:doc.payment,operation:'customer_payment.cancel',reversalDate:'2026-09-12'});
  return actor(()=>voidPaymentDocument(fixture.companyA,'customer',doc.payment,fixture.u1.id,{approvalId:approved,reversalDate:'2026-09-12'}));})()).rejects.toThrow(/shared|ambiguous|multiple/i);
 expect(await state('customer',doc.payment,doc.invoice)).toEqual(before);
 expect((await pool.query('SELECT reversed_at FROM gl_journal_entries WHERE company_id=$1 AND id=$2',[fixture.companyA,journal])).rows[0].reversed_at).toBeNull();
});

for(const kind of ['customer','supplier'] as const)for(const timing of ['before','after'] as const)it(`${kind}: direct approved inverse rejects shared journal added ${timing} approval`,async()=>{
 const doc=await document(kind),before=await state(kind,doc.payment,doc.invoice),journal=before.payment[0].gl_journal_entry_id,sibling=randomUUID();
 const ref:OperationRef={entityType:`${kind}_payment`,entityId:doc.payment,operation:kind==='customer'?'customer_payment.cancel':'supplier_payment.void',reversalDate:'2026-09-12'};
 let approved:string|undefined;if(timing==='after')approved=await approval(ref);
 if(kind==='customer')await pool.query("INSERT INTO customer_payments(id,company_id,client_id,payment_number,payment_date,total_amount,currency_code,created_by,status,gl_journal_entry_id,bank_account_id) VALUES($1,$2,$3,left($1::uuid::text,28),'2026-09-09',115,'ZAR',$4,'confirmed',$5,$6)",[sibling,fixture.companyA,customer,fixture.u1.id,journal,bank]);
 else await pool.query("INSERT INTO supplier_payments(id,company_id,supplier_id,payment_number,payment_date,total_amount,status,created_by,gl_journal_entry_id) VALUES($1,$2,$3,left($1::uuid::text,28),'2026-09-09',115,'processed',$4,$5)",[sibling,fixture.companyA,before.payment[0].supplier_id,fixture.u1.id,journal]);
 await expect((async()=>{approved??=await approval(ref);return actor(()=>kind==='customer'?cancelCustomerPayment(fixture.companyA,doc.payment,fixture.u1.id,undefined,{approvalId:approved,reversalDate:'2026-09-12'}):voidSupplierPayment(fixture.companyA,doc.payment,fixture.u1.id,{approvalId:approved,reversalDate:'2026-09-12'}));})()).rejects.toThrow(/shared|ambiguous|multiple/i);
 expect(await state(kind,doc.payment,doc.invoice)).toEqual(before);
 expect((await pool.query('SELECT reversed_at FROM gl_journal_entries WHERE company_id=$1 AND id=$2',[fixture.companyA,journal])).rows[0].reversed_at).toBeNull();
});
for(const kind of ['customer','supplier'] as const)it(`${kind}: bank journal sibling cannot impersonate original allocation payment`,async()=>{
 const tx=randomUUID(),sibling=randomUUID();
 await pool.query("INSERT INTO bank_transactions(id,company_id,bank_account_id,transaction_date,amount,description,status) VALUES($1,$2,$3,'2026-09-09',115,'Synthetic bank child identity','imported')",[tx,fixture.companyA,bank]);
 const prepared=await actor(()=>prepareBankAllocation(requireControlTx(),{version:1,kind:'customer',bankTransactionId:tx,partyId:customer,applications:[]}));
 const approved=await approval(prepared.operation),posted=await actor(()=>executeBankAllocation(requireControlTx(),prepared.intentId,{approvalId:approved}));
 if(kind==='customer')await pool.query("INSERT INTO customer_payments(id,company_id,client_id,payment_number,payment_date,total_amount,currency_code,created_by,status,gl_journal_entry_id,bank_account_id) VALUES($1,$2,$3,left($1::uuid::text,28),'2026-09-09',115,'ZAR',$4,'confirmed',$5,$6)",[sibling,fixture.companyA,customer,fixture.u1.id,posted.journalEntryId,bank]);
 else{const party=randomUUID();await pool.query("INSERT INTO suppliers(id,company_id,name) VALUES($1,$2,'Synthetic sibling supplier')",[party,fixture.companyA]);await pool.query("INSERT INTO supplier_payments(id,company_id,supplier_id,payment_number,payment_date,total_amount,status,created_by,gl_journal_entry_id) VALUES($1,$2,$3,left($1::uuid::text,28),'2026-09-09',115,'processed',$4,$5)",[sibling,fixture.companyA,party,fixture.u1.id,posted.journalEntryId]);}
 const inverse=await actor(()=>prepareBankAllocationReversal(requireControlTx(),{originalIntentId:prepared.intentId,reversalDate:'2026-09-12',reason:'Synthetic child identity'}));
 const inverseApproval=await approval(inverse.operation);
 await expect(actor(()=>voidPaymentDocument(fixture.companyA,kind,sibling,fixture.u1.id,{intentId:inverse.intentId,approvalId:inverseApproval,reversalDate:'2026-09-12'}))).rejects.toThrow(/identity|original.*payment|owned.*payment/i);
 expect((await pool.query('SELECT status FROM bank_transactions WHERE company_id=$1 AND id=$2',[fixture.companyA,tx])).rows[0].status).toBe('allocated');
 expect((await pool.query('SELECT status FROM customer_payments WHERE company_id=$1 AND id=$2',[fixture.companyA,posted.paymentId])).rows[0].status).toBe('confirmed');
});

it('adapter and direct approved cancellation share policy-before-payment lock order',async()=>{
 const doc=await document('customer');
 const originalJournal=(await state('customer',doc.payment,doc.invoice)).payment[0].gl_journal_entry_id;
 const approved=await approval({entityType:'customer_payment',entityId:doc.payment,operation:'customer_payment.cancel',reversalDate:'2026-09-12'});
 let policyReady!:()=>void,allowDirect!:()=>void,adapterReady!:(pid:number)=>void;
 const held=new Promise<void>(resolve=>{policyReady=resolve;}),proceed=new Promise<void>(resolve=>{allowDirect=resolve;}),started=new Promise<number>(resolve=>{adapterReady=resolve;});
 const direct=actor(async()=>{
  await requireControlTx().sql`SELECT pg_advisory_xact_lock(hashtextextended(${`control-policy:${fixture.companyA}`},0))`;
  policyReady();await proceed;
  return cancelCustomerPayment(fixture.companyA,doc.payment,fixture.u1.id,undefined,{approvalId:approved,reversalDate:'2026-09-12'});
 });
 await held;
 const adapter=actor(async()=>{
  const [row]=await requireControlTx().sql`SELECT pg_backend_pid() AS pid` as {pid:number}[];adapterReady(row!.pid);
  return voidPaymentDocument(fixture.companyA,'customer',doc.payment,fixture.u1.id,{approvalId:approved,reversalDate:'2026-09-12'});
 });
 // Observe the real contender waiting for the held advisory lock before releasing the direct caller.
 const pid=await started;let waiting=false;
 try{
  for(let attempt=0;attempt<100&&!waiting;attempt++){
   waiting=(await pool.query("SELECT 1 FROM pg_locks WHERE pid=$1 AND locktype='advisory' AND NOT granted",[pid])).rowCount===1;
   if(!waiting)await new Promise(resolve=>setTimeout(resolve,10));
  }
 }finally{allowDirect();}
 const results=await Promise.allSettled([direct,adapter]);
 expect(waiting).toBe(true);expect(results.map(result=>result.status==='fulfilled'?'fulfilled':String(result.reason?.code??result.reason))).toEqual(['fulfilled','fulfilled']);
 expect((await pool.query('SELECT id FROM gl_journal_entries WHERE company_id=$1 AND reversal_of_id=$2',[fixture.companyA,originalJournal])).rows).toHaveLength(1);
 expect((await state('customer',doc.payment,doc.invoice)).payment[0].status).toBe('cancelled');
});
