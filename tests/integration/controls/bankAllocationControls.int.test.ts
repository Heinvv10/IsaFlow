import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import {randomUUID,randomBytes} from 'node:crypto';
import {Pool} from 'pg';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {provisionForensicFixture,validateFixtureTarget,type ForensicFixture} from '../forensic-fixture';
import {prepareBankAllocationReversal,executeBankAllocationReversal} from '@/modules/accounting/services/bank/bankAllocationReversal';
import {prepareBankAllocation,executeBankAllocation} from '@/modules/accounting/services/bank/bankAllocationControl';
import {requireControlTx,withControlRequest} from '@/modules/accounting/services/controls/context';
import {requestOperationApproval,decideOperationApproval} from '@/modules/accounting/services/controls/approvalRequestService';
import {cancelCustomerPayment} from '@/modules/accounting/services/ar/customerPaymentAllocationService';
import {approveCustomerInvoice} from '@/modules/accounting/services/ar/customerInvoiceApprovalService';
import {seedApAccounts} from './apSyntheticAccounts';
import {seedBankAllocationSupplier} from './bankAllocationSupplierFixture';
import {voidSupplierPayment} from '@/modules/accounting/services/ap/supplierPaymentWorkflowService';
import {approveSupplierInvoice} from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import {allocateTransaction} from '@/modules/accounting/services/bank/bankAllocationService';
process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');
process.env.CONTROL_FINGERPRINT_KEY=randomBytes(32).toString('hex');
vi.mock('@/modules/accounting/services/ar/invoicePdfSnapshotService',()=>({snapshotInvoicePdf:async()=>({documentId:null,wasExisting:false})}));
const config=fixtureConfigFromEnv(process.env),target=validateFixtureTarget(config);
const pool=new Pool({connectionString:target.connectionString,ssl:false,max:2});
let fixture:ForensicFixture;let apAccounts:Awaited<ReturnType<typeof seedApAccounts>>;
const customer=randomUUID(),bank=randomUUID(),rule=randomUUID();
beforeAll(async()=>{
 fixture=await provisionForensicFixture(config);apAccounts=await seedApAccounts(pool,fixture.companyA);
 await pool.query("INSERT INTO approval_rules(id,company_id,name,document_type,condition_field,condition_operator,condition_value,approver_role) VALUES($1,$2,'Synthetic receipt approval','payment','amount','any',0,'admin')",[rule,fixture.companyA]);

 await pool.query('INSERT INTO customers(id,company_id,name) VALUES($1,$2,$3)',[customer,fixture.companyA,'Synthetic allocation customer']);
 await pool.query("INSERT INTO fiscal_periods(id,company_id,period_name,period_number,fiscal_year,start_date,end_date,status) VALUES($1,$2,'Synthetic allocation September',9,2026,'2026-09-01','2026-09-30','open')",[randomUUID(),fixture.companyA]);
 for(const [id,role] of [[bank,'bank'],[randomUUID(),'receivable']])await pool.query("INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance,is_active,is_system_account,level) VALUES($1,$2,$3,$4,'asset',$4,'debit',true,true,3)",[id,fixture.companyA,id!.slice(0,12),role]);
 for(const [role,type] of [['default_revenue','revenue'],['vat_output','liability']]){const id=randomUUID();await pool.query("INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance,is_active,is_system_account,level) VALUES($1,$2,$3,$4,$5,$4,'credit',true,true,3)",[id,fixture.companyA,id.slice(0,12),role,type]);}
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
it('refuses customer receipt creation through bank allocation without the required independent approval',async()=>{
 const tx=randomUUID();
 await pool.query("INSERT INTO bank_transactions(id,company_id,bank_account_id,transaction_date,amount,description,status) VALUES($1,$2,$3,'2026-09-09',115,'Synthetic receipt','imported')",[tx,fixture.companyA,bank]);
 await expect(actor(()=>allocateTransaction(fixture.companyA,tx,null,fixture.u1.id,undefined,'customer',customer,undefined,undefined,undefined,undefined,undefined,{autoApply:false}))).rejects.toThrow(/approval|intent/i);
 expect((await pool.query('SELECT id FROM customer_payments WHERE company_id=$1 AND client_id=$2',[fixture.companyA,customer])).rows).toHaveLength(0);
 expect((await pool.query('SELECT status FROM bank_transactions WHERE company_id=$1 AND id=$2',[fixture.companyA,tx])).rows[0].status).toBe('imported');
});

it('prepares an immutable owned exact receipt without creating a journal or payment',async()=>{
 const tx=randomUUID();
 await pool.query("INSERT INTO bank_transactions(id,company_id,bank_account_id,transaction_date,amount,description,status) VALUES($1,$2,$3,'2026-09-09',23.45,'Synthetic preparation','imported')",[tx,fixture.companyA,bank]);
 const prepared=await actor(()=>prepareBankAllocation(requireControlTx(),{version:1,kind:'customer',bankTransactionId:tx,partyId:customer,applications:[]}));
 expect(prepared.operation.operation).toBe('bank_allocation.post');
 expect((await pool.query('SELECT amount::text,currency FROM control_bank_allocation_intents WHERE company_id=$1 AND id=$2',[fixture.companyA,prepared.intentId])).rows[0]).toEqual({amount:'23.45000000',currency:'ZAR'});
 expect((await pool.query('SELECT id FROM gl_journal_entries WHERE company_id=$1 AND source_record_id=$2',[fixture.companyA,tx])).rows).toHaveLength(0);
});

it('requires payment approval on the actual immutable receipt executor',async()=>{
 const tx=randomUUID();
 await pool.query("INSERT INTO bank_transactions(id,company_id,bank_account_id,transaction_date,amount,description,status) VALUES($1,$2,$3,'2026-09-09',34.56,'Synthetic executor','imported')",[tx,fixture.companyA,bank]);
 const prepared=await actor(()=>prepareBankAllocation(requireControlTx(),{version:1,kind:'customer',bankTransactionId:tx,partyId:customer,applications:[]}));
 await expect(actor(()=>executeBankAllocation(requireControlTx(),prepared.intentId))).rejects.toThrow(/approval/i);
 expect((await pool.query('SELECT id FROM gl_journal_entries WHERE company_id=$1 AND source_record_id=$2',[fixture.companyA,tx])).rows).toHaveLength(0);
});

it('posts an approved exact receipt once with child evidence and current-authority replay',async()=>{
 const tx=randomUUID();
 await pool.query("INSERT INTO bank_transactions(id,company_id,bank_account_id,transaction_date,amount,description,status) VALUES($1,$2,$3,'2026-09-09',45.67,'Synthetic approved executor','imported')",[tx,fixture.companyA,bank]);
 const prepared=await actor(()=>prepareBankAllocation(requireControlTx(),{version:1,kind:'customer',bankTransactionId:tx,partyId:customer,applications:[]}));
 const approval=await actor(()=>requestOperationApproval(requireControlTx(),prepared.operation));
 await actor(()=>decideOperationApproval(requireControlTx(),approval.id,'approved'),'u2');
 const result=await actor(()=>executeBankAllocation(requireControlTx(),prepared.intentId,{approvalId:approval.id}));
 expect(result.paymentId).toBeTruthy();
 expect(await actor(()=>executeBankAllocation(requireControlTx(),prepared.intentId))).toEqual(result);
 expect((await pool.query('SELECT source,source_record_id,status FROM gl_journal_entries WHERE company_id=$1 AND id=$2',[fixture.companyA,result.journalEntryId])).rows[0]).toEqual({source:'auto_payment',source_record_id:tx,status:'posted'});
 expect((await pool.query('SELECT action FROM control_change_events WHERE company_id=$1 AND entity_id=$2',[fixture.companyA,result.paymentId])).rows).toEqual([{action:'bank_allocation.payment_created'}]);
 await pool.query("UPDATE company_users SET role='viewer' WHERE company_id=$1 AND user_id=$2",[fixture.companyA,fixture.u2.id]);
 try{await expect(actor(()=>executeBankAllocation(requireControlTx(),prepared.intentId))).rejects.toThrow('authority');}
 finally{await pool.query("UPDATE company_users SET role='admin' WHERE company_id=$1 AND user_id=$2",[fixture.companyA,fixture.u2.id]);}
});

async function approvedReceipt(amount='56.78'){
 const tx=randomUUID();
 await pool.query("INSERT INTO bank_transactions(id,company_id,bank_account_id,transaction_date,amount,description,status) VALUES($1,$2,$3,'2026-09-09',$4,'Synthetic adversarial receipt','imported')",[tx,fixture.companyA,bank,amount]);
 const prepared=await actor(()=>prepareBankAllocation(requireControlTx(),{version:1,kind:'customer',bankTransactionId:tx,partyId:customer,applications:[]}));
 const approval=await actor(()=>requestOperationApproval(requireControlTx(),prepared.operation));
 await actor(()=>decideOperationApproval(requireControlTx(),approval.id,'approved'),'u2');
 return{tx,...prepared,approvalId:approval.id};
}
it('serializes concurrent execution into one receipt and one exact financial effect',async()=>{
 const prepared=await approvedReceipt();
 const results=await Promise.all([1,2].map(()=>actor(()=>executeBankAllocation(requireControlTx(),prepared.intentId,{approvalId:prepared.approvalId}))));
 expect(results[0]).toEqual(results[1]);
 expect((await pool.query('SELECT id FROM gl_journal_entries WHERE company_id=$1 AND source_record_id=$2',[fixture.companyA,prepared.tx])).rows).toHaveLength(1);
 expect((await pool.query("SELECT id FROM control_operation_effects WHERE company_id=$1 AND entity_id=$2 AND operation='bank_allocation.post'",[fixture.companyA,prepared.intentId])).rows).toHaveLength(1);
});
it('rejects stale bank amount approvals and leaves no journal or receipt',async()=>{
 const prepared=await approvedReceipt();
 await pool.query('UPDATE bank_transactions SET amount=amount+1 WHERE company_id=$1 AND id=$2',[fixture.companyA,prepared.tx]);
 await expect(actor(()=>executeBankAllocation(requireControlTx(),prepared.intentId,{approvalId:prepared.approvalId}))).rejects.toThrow('changed');
 expect((await pool.query('SELECT id FROM gl_journal_entries WHERE company_id=$1 AND source_record_id=$2',[fixture.companyA,prepared.tx])).rows).toHaveLength(0);
});
it('rolls back the actual posted journal, receipt, evidence and consumed approval together',async()=>{
 const prepared=await approvedReceipt();
 await expect(actor(async()=>{await executeBankAllocation(requireControlTx(),prepared.intentId,{approvalId:prepared.approvalId});throw new Error('Synthetic outer rollback');})).rejects.toThrow('Synthetic outer rollback');
 expect((await pool.query('SELECT id FROM gl_journal_entries WHERE company_id=$1 AND source_record_id=$2',[fixture.companyA,prepared.tx])).rows).toHaveLength(0);
 expect((await pool.query('SELECT status FROM control_operation_approvals WHERE company_id=$1 AND id=$2',[fixture.companyA,prepared.approvalId])).rows[0].status).toBe('approved');
 expect((await pool.query("SELECT id FROM control_change_events WHERE company_id=$1 AND entity_id=$2 AND action='bank_allocation.posted'",[fixture.companyA,prepared.tx])).rows).toHaveLength(0);
 expect((await actor(()=>executeBankAllocation(requireControlTx(),prepared.intentId,{approvalId:prepared.approvalId}))).status).toBe('allocated');
});
it('refuses a receipt replay after the generated journal monetary lines changed',async()=>{
 const prepared=await approvedReceipt(),posted=await actor(()=>executeBankAllocation(requireControlTx(),prepared.intentId,{approvalId:prepared.approvalId}));
 await pool.query('UPDATE gl_journal_lines SET debit=debit*2,credit=credit*2 WHERE company_id=$1 AND journal_entry_id=$2',[fixture.companyA,posted.journalEntryId]);
 await expect(actor(()=>executeBankAllocation(requireControlTx(),prepared.intentId))).rejects.toThrow('changed');
});

it('reverses an approved bank receipt in an explicit open later period while retaining original provenance',async()=>{
 const prepared=await approvedReceipt(),posted=await actor(()=>executeBankAllocation(requireControlTx(),prepared.intentId,{approvalId:prepared.approvalId}));
 await pool.query("INSERT INTO fiscal_periods(id,company_id,period_name,period_number,fiscal_year,start_date,end_date,status) VALUES($1,$2,'Synthetic October reversal',10,2026,'2026-10-01','2026-10-31','open')",[randomUUID(),fixture.companyA]);
 await pool.query("UPDATE fiscal_periods SET status='closed' WHERE company_id=$1 AND period_number=9",[fixture.companyA]);
 try{
  const reversal=await actor(()=>prepareBankAllocationReversal(requireControlTx(),{originalIntentId:prepared.intentId,reversalDate:'2026-10-01',reason:'Synthetic correction'}));
  const approval=await actor(()=>requestOperationApproval(requireControlTx(),reversal.operation));
  await actor(()=>decideOperationApproval(requireControlTx(),approval.id,'approved'),'u2');
  const result=await actor(()=>executeBankAllocationReversal(requireControlTx(),reversal.intentId,{approvalId:approval.id}));
  expect(result.originalJournalEntryId).toBe(posted.journalEntryId);
  expect(await actor(()=>executeBankAllocationReversal(requireControlTx(),reversal.intentId))).toEqual(result);
  expect((await pool.query('SELECT status,gl_journal_entry_id FROM customer_payments WHERE company_id=$1 AND id=$2',[fixture.companyA,posted.paymentId])).rows[0]).toEqual({status:'cancelled',gl_journal_entry_id:posted.journalEntryId});
  expect((await pool.query('SELECT entry_date::text,reversal_of_id FROM gl_journal_entries WHERE company_id=$1 AND id=$2',[fixture.companyA,result.reversalJournalEntryId])).rows[0]).toEqual({entry_date:'2026-10-01',reversal_of_id:posted.journalEntryId});
 }finally{await pool.query("UPDATE fiscal_periods SET status='open' WHERE company_id=$1 AND period_number=9",[fixture.companyA]);}
});

it('records actual PAT actor and token provenance on the financial journal',async()=>{
 const tx=randomUUID();
 await pool.query("INSERT INTO bank_transactions(id,company_id,bank_account_id,transaction_date,amount,description,status) VALUES($1,$2,$3,'2026-09-09',67.89,'Synthetic PAT receipt','imported')",[tx,fixture.companyA,bank]);
 const prepared=await actor(()=>prepareBankAllocation(requireControlTx(),{version:1,kind:'customer',bankTransactionId:tx,partyId:customer,applications:[]}),'u1',true);
 const approval=await actor(()=>requestOperationApproval(requireControlTx(),prepared.operation),'u1',true);
 await actor(()=>decideOperationApproval(requireControlTx(),approval.id,'approved'),'u2');
 const posted=await actor(()=>executeBankAllocation(requireControlTx(),prepared.intentId,{approvalId:approval.id,postingAgent:'mcp:allocate_bank_transaction:v1',actorType:'human',actorTokenJti:'forged'}),'u1',true);
 expect((await pool.query('SELECT actor_type,actor_token_jti,posting_agent FROM gl_journal_entries WHERE company_id=$1 AND id=$2',[fixture.companyA,posted.journalEntryId])).rows[0]).toEqual({actor_type:'agent',actor_token_jti:fixture.u1.tokens[0]!.id,posting_agent:'mcp:allocate_bank_transaction:v1'});
});

it('settles a selected actually posted customer invoice and refuses standalone child cancellation',async()=>{
 const invoice=randomUUID(),tx=randomUUID();
 await pool.query(`INSERT INTO customer_invoices(id,company_id,customer_id,client_id,invoice_number,invoice_date,subtotal,tax_amount,total_amount,currency_code,exchange_rate,functional_total,created_by)
 VALUES($1,$2,$3,$3,$4,'2026-09-09',100,15,115,'ZAR',1,115,$5)`,[invoice,fixture.companyA,customer,invoice,fixture.u1.id]);
 await pool.query("INSERT INTO customer_invoice_items(invoice_id,description,quantity,unit_price,amount,tax_rate) VALUES($1,'Synthetic selected service',1,100,100,15)",[invoice]);
 await actor(()=>approveCustomerInvoice(fixture.companyA,invoice,fixture.u1.id));
 await pool.query("INSERT INTO bank_transactions(id,company_id,bank_account_id,transaction_date,amount,description,status) VALUES($1,$2,$3,'2026-09-09',115,'Selected invoice receipt','imported')",[tx,fixture.companyA,bank]);
 const prepared=await actor(()=>prepareBankAllocation(requireControlTx(),{version:1,kind:'customer',bankTransactionId:tx,partyId:customer,applications:[{invoiceId:invoice,amount:'115'}]}));
 const approval=await actor(()=>requestOperationApproval(requireControlTx(),prepared.operation));await actor(()=>decideOperationApproval(requireControlTx(),approval.id,'approved'),'u2');
 const posted=await actor(()=>executeBankAllocation(requireControlTx(),prepared.intentId,{approvalId:approval.id}));
 expect((await pool.query('SELECT status,amount_paid FROM customer_invoices WHERE company_id=$1 AND id=$2',[fixture.companyA,invoice])).rows[0]).toMatchObject({status:'paid',amount_paid:'115.00'});
 expect((await pool.query('SELECT gl_journal_entry_id FROM customer_payments WHERE company_id=$1 AND id=$2',[fixture.companyA,posted.paymentId])).rows[0].gl_journal_entry_id).toBe(posted.journalEntryId);
 await expect((async()=>{
  const ref={entityType:'customer_payment',entityId:posted.paymentId!,operation:'customer_payment.cancel' as const,reversalDate:'2026-09-10'};
  const cancellation=await actor(()=>requestOperationApproval(requireControlTx(),ref));
  await actor(()=>decideOperationApproval(requireControlTx(),cancellation.id,'approved'),'u2');
  return actor(()=>cancelCustomerPayment(fixture.companyA,posted.paymentId!,fixture.u1.id,'Standalone bank child',{approvalId:cancellation.id,reversalDate:'2026-09-10'}));
 })()).rejects.toThrow();
 expect((await pool.query('SELECT status FROM bank_transactions WHERE company_id=$1 AND id=$2',[fixture.companyA,tx])).rows[0].status).toBe('allocated');
 expect((await pool.query('SELECT status FROM customer_payments WHERE company_id=$1 AND id=$2',[fixture.companyA,posted.paymentId])).rows[0].status).toBe('confirmed');
 const reverse=await actor(()=>prepareBankAllocationReversal(requireControlTx(),{originalIntentId:prepared.intentId,reversalDate:'2026-09-10',reason:'Selected receipt correction'}));
 const reverseApproval=await actor(()=>requestOperationApproval(requireControlTx(),reverse.operation));await actor(()=>decideOperationApproval(requireControlTx(),reverseApproval.id,'approved'),'u2');
 await actor(()=>executeBankAllocationReversal(requireControlTx(),reverse.intentId,{approvalId:reverseApproval.id}));
 expect((await pool.query('SELECT status,amount_paid FROM customer_invoices WHERE company_id=$1 AND id=$2',[fixture.companyA,invoice])).rows[0]).toMatchObject({status:'approved',amount_paid:'0.00'});
 expect((await pool.query('SELECT status,gl_journal_entry_id FROM customer_payments WHERE company_id=$1 AND id=$2',[fixture.companyA,posted.paymentId])).rows[0]).toMatchObject({status:'cancelled',gl_journal_entry_id:posted.journalEntryId});
});

it('settles a selected actually posted supplier invoice with independently verified beneficiary',async()=>{
 const supplier=await seedBankAllocationSupplier(pool,fixture,(person,fn)=>actor(()=>fn(requireControlTx()),person)),tx=randomUUID();
 await pool.query("UPDATE supplier_invoices SET subtotal=100,tax_rate=15,tax_amount=15,total_amount=115,currency='ZAR' WHERE company_id=$1 AND id=$2",[fixture.companyA,supplier.invoice]);
 await pool.query("INSERT INTO supplier_invoice_items(supplier_invoice_id,description,quantity,unit_price,line_total,tax_rate,tax_amount,gl_account_id) VALUES($1,'Selected expense',1,100,100,15,15,$2)",[supplier.invoice,apAccounts.default_expense]);
 await actor(()=>approveSupplierInvoice(fixture.companyA,supplier.invoice,fixture.u1.id));
 await pool.query("INSERT INTO bank_transactions(id,company_id,bank_account_id,transaction_date,amount,description,status) VALUES($1,$2,$3,'2026-09-09',-115,'Selected supplier settlement','imported')",[tx,fixture.companyA,bank]);
 const prepared=await actor(()=>prepareBankAllocation(requireControlTx(),{version:1,kind:'supplier',bankTransactionId:tx,partyId:supplier.supplier,applications:[{invoiceId:supplier.invoice,amount:'115'}]}));
 const approval=await actor(()=>requestOperationApproval(requireControlTx(),prepared.operation));await actor(()=>decideOperationApproval(requireControlTx(),approval.id,'approved'),'u2');
 const posted=await actor(()=>executeBankAllocation(requireControlTx(),prepared.intentId,{approvalId:approval.id}));
 expect((await pool.query('SELECT status,amount_paid FROM supplier_invoices WHERE company_id=$1 AND id=$2',[fixture.companyA,supplier.invoice])).rows[0]).toMatchObject({status:'paid',amount_paid:'115.00'});
 expect((await pool.query('SELECT status,gl_journal_entry_id FROM supplier_payments WHERE company_id=$1 AND id=$2',[fixture.companyA,posted.paymentId])).rows[0]).toMatchObject({status:'processed',gl_journal_entry_id:posted.journalEntryId});
 const repeated=await actor(()=>executeBankAllocation(requireControlTx(),prepared.intentId));expect(repeated).toEqual(posted);
 await expect((async()=>{
  const ref={entityType:'supplier_payment',entityId:posted.paymentId!,operation:'supplier_payment.void' as const};
  const cancellation=await actor(()=>requestOperationApproval(requireControlTx(),ref));
  await actor(()=>decideOperationApproval(requireControlTx(),cancellation.id,'approved'),'u2');
  return actor(()=>voidSupplierPayment(fixture.companyA,posted.paymentId!,fixture.u1.id,{approvalId:cancellation.id}));
 })()).rejects.toThrow();
 expect((await pool.query('SELECT status FROM bank_transactions WHERE company_id=$1 AND id=$2',[fixture.companyA,tx])).rows[0].status).toBe('allocated');
 expect((await pool.query('SELECT status FROM supplier_payments WHERE company_id=$1 AND id=$2',[fixture.companyA,posted.paymentId])).rows[0].status).toBe('processed');
 const reverse=await actor(()=>prepareBankAllocationReversal(requireControlTx(),{originalIntentId:prepared.intentId,reversalDate:'2026-09-10',reason:'Selected supplier correction'}));
 const reverseApproval=await actor(()=>requestOperationApproval(requireControlTx(),reverse.operation));await actor(()=>decideOperationApproval(requireControlTx(),reverseApproval.id,'approved'),'u2');
 await actor(()=>executeBankAllocationReversal(requireControlTx(),reverse.intentId,{approvalId:reverseApproval.id}));
 expect((await pool.query('SELECT status,amount_paid FROM supplier_invoices WHERE company_id=$1 AND id=$2',[fixture.companyA,supplier.invoice])).rows[0]).toMatchObject({status:'approved',amount_paid:'0.00'});
 expect((await pool.query('SELECT status,gl_journal_entry_id FROM supplier_payments WHERE company_id=$1 AND id=$2',[fixture.companyA,posted.paymentId])).rows[0]).toMatchObject({status:'cancelled',gl_journal_entry_id:posted.journalEntryId});
});

it('prevents the intent maker approving their own allocation through a proxy approval requester',async()=>{
 const tx=randomUUID();
 await pool.query("INSERT INTO bank_transactions(id,company_id,bank_account_id,transaction_date,amount,description,status) VALUES($1,$2,$3,'2026-09-09',100,'Synthetic proxy requester','imported')",[tx,fixture.companyA,bank]);
 const prepared=await actor(()=>prepareBankAllocation(requireControlTx(),{version:1,kind:'customer',bankTransactionId:tx,partyId:customer,applications:[]}));
 await expect((async()=>{
  const approval=await actor(()=>requestOperationApproval(requireControlTx(),prepared.operation),'u2');
  await actor(()=>decideOperationApproval(requireControlTx(),approval.id,'approved'),'u1');
  return actor(()=>executeBankAllocation(requireControlTx(),prepared.intentId,{approvalId:approval.id}),'u1');
 })()).rejects.toThrow('Original intent requester');
 expect((await pool.query('SELECT status FROM bank_transactions WHERE company_id=$1 AND id=$2',[fixture.companyA,tx])).rows[0].status).toBe('imported');
});
