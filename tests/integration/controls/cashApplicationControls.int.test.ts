import {prepareCashApplicationReversal,executeCashApplicationReversal} from '@/modules/accounting/services/shared/cashApplicationReversalControl';
import {confirmCustomerPayment} from '@/modules/accounting/services/ar/customerPaymentAllocationService';
import {getUnappliedReceipts} from '@/modules/accounting/services/ar/unappliedReceiptService';
import {lockCustomerPaymentForUpdate} from '@/modules/accounting/services/core/paymentLock';
import {loadCashApplicationSources} from '@/modules/accounting/services/shared/cashApplicationSources';
import {prepareCashApplication,executeCashApplication} from '@/modules/accounting/services/shared/cashApplicationControl';
import {planReceiptApplication,applyReceiptPlan} from '@/modules/accounting/services/ar/receiptApplicationService';
import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import {randomUUID,randomBytes} from 'node:crypto';
import {Pool} from 'pg';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {provisionForensicFixture,validateFixtureTarget,type ForensicFixture} from '../forensic-fixture';
import {prepareBankAllocation,executeBankAllocation} from '@/modules/accounting/services/bank/bankAllocationControl';
import {requireControlTx,withControlRequest} from '@/modules/accounting/services/controls/context';
import {requestOperationApproval,decideOperationApproval} from '@/modules/accounting/services/controls/approvalRequestService';
import {approveCustomerInvoice} from '@/modules/accounting/services/ar/customerInvoiceApprovalService';
process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');
process.env.CONTROL_FINGERPRINT_KEY=randomBytes(32).toString('hex');
vi.mock('@/modules/accounting/services/ar/invoicePdfSnapshotService',()=>({snapshotInvoicePdf:async()=>({documentId:null,wasExisting:false})}));
const config=fixtureConfigFromEnv(process.env),target=validateFixtureTarget(config);
const pool=new Pool({connectionString:target.connectionString,ssl:false,max:2});
let fixture:ForensicFixture;
const customer=randomUUID(),bank=randomUUID(),rule=randomUUID();
beforeAll(async()=>{
 fixture=await provisionForensicFixture(config);
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

async function postedCash(){
 const invoice=randomUUID(),tx=randomUUID();
 await pool.query(`INSERT INTO customer_invoices(id,company_id,customer_id,client_id,invoice_number,invoice_date,subtotal,tax_amount,total_amount,currency_code,exchange_rate,functional_total,created_by)
 VALUES($1,$2,$3,$3,$4,'2026-09-09',100,15,115,'ZAR',1,115,$5)`,[invoice,fixture.companyA,customer,invoice,fixture.u1.id]);
 await pool.query("INSERT INTO customer_invoice_items(invoice_id,description,quantity,unit_price,amount,tax_rate) VALUES($1,'Existing receipt target',1,100,100,15)",[invoice]);
 await actor(()=>approveCustomerInvoice(fixture.companyA,invoice,fixture.u1.id));
 await pool.query("INSERT INTO bank_transactions(id,company_id,bank_account_id,transaction_date,amount,description,status) VALUES($1,$2,$3,'2026-09-09',115,'Originally unapplied receipt','imported')",[tx,fixture.companyA,bank]);
 const prepared=await actor(()=>prepareBankAllocation(requireControlTx(),{version:1,kind:'customer',bankTransactionId:tx,partyId:customer,applications:[]}));
 const approval=await actor(()=>requestOperationApproval(requireControlTx(),prepared.operation));await actor(()=>decideOperationApproval(requireControlTx(),approval.id,'approved'),'u2');
 const posted=await actor(()=>executeBankAllocation(requireControlTx(),prepared.intentId,{approvalId:approval.id}));
 return{invoice,posted};
}
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
