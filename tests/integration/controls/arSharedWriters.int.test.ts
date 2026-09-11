import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import {randomUUID,randomBytes} from 'node:crypto';
import {Pool} from 'pg';
import type {NextApiHandler,NextApiRequest,NextApiResponse} from 'next';
import {fixtureConfigFromEnv} from '../../../scripts/forensic/fixture-bootstrap';
import {provisionForensicFixture,validateFixtureTarget,ensureOpenPeriodForToday,type ForensicFixture} from '../forensic-fixture';
import {withControlRequest,requireControlTx} from '@/modules/accounting/services/controls/context';
import {createJournalEntry} from '@/modules/accounting/services/gl/journalEntryService';
import {approveCustomerInvoice} from '@/modules/accounting/services/ar/customerInvoiceApprovalService';
import {cancelCustomerInvoice} from '@/modules/accounting/services/ar/customerInvoiceCancelService';
import {confirmCustomerPayment,cancelCustomerPayment} from '@/modules/accounting/services/ar/customerPaymentAllocationService';
import {approveCreditNote} from '@/modules/accounting/services/ar/creditNoteApproveService';
import {cancelCreditNote,applyCreditNoteToInvoice} from '@/modules/accounting/services/ar/creditNoteCancelService';
import {prepareRecurringInvoiceRun,generateInvoiceFromRecurring} from '@/modules/accounting/services/ar/recurringInvoiceControl';
import {prepareCreditNoteApplication} from '@/modules/accounting/services/ar/creditNoteApplicationControl';
import {requestOperationApproval,decideOperationApproval} from '@/modules/accounting/services/controls/approvalRequestService';
import type {ControlTx,OperationRef} from '@/modules/accounting/services/controls/contracts';
process.env.ENCRYPTION_KEY=randomBytes(32).toString('hex');
process.env.CONTROL_FINGERPRINT_KEY=randomBytes(32).toString('hex');
vi.mock('@/modules/accounting/services/ar/invoicePdfSnapshotService',()=>({snapshotInvoicePdf:async()=>({documentId:null,wasExisting:false})}));
const config=fixtureConfigFromEnv(process.env),target=validateFixtureTarget(config);
const pool=new Pool({connectionString:target.connectionString,ssl:false,max:2});
vi.mock('@/lib/auth/gotrue',()=>({verifyToken:async(token:string)=>JSON.parse(Buffer.from(token,'base64url').toString())}));
vi.mock('@/lib/auth/authPool',()=>({getAuthPool:()=>pool}));
let invoiceRoute:NextApiHandler;
let fixture:ForensicFixture;const customer=randomUUID();
beforeAll(async()=>{
 fixture=await provisionForensicFixture(config);
 invoiceRoute=(await import('../../../pages/api/accounting/customer-invoices-detail')).default;
 await pool.query('INSERT INTO customers(id,company_id,name) VALUES($1,$2,$3)',[customer,fixture.companyA,'Synthetic AR material customer']);
 await pool.query(`INSERT INTO fiscal_periods(id,company_id,period_name,period_number,fiscal_year,start_date,end_date,status)
 VALUES($1,$2,'Synthetic AR September',9,2026,'2026-09-01','2026-09-30','open')`,[randomUUID(),fixture.companyA]);
 await ensureOpenPeriodForToday(pool,fixture.companyA,'Synthetic AR current');
 for(const [role,type] of Object.entries({receivable:'asset',default_revenue:'revenue',vat_output:'liability',bank:'asset',payable:'liability',default_expense:'expense',vat_input:'asset'})){
  const id=randomUUID();await pool.query(`INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance,is_active,is_system_account)
  VALUES($1,$2,$3,$4,$5,$6,$7,true,true)`,[id,fixture.companyA,id.slice(0,12),`Synthetic AR ${role}`,type,role,['liability','revenue'].includes(type)?'credit':'debit']);
 }
});
afterAll(async()=>{await pool.end();});
async function actor<T>(fn:(ctx:ControlTx)=>Promise<T>,person:'u1'|'u2'|'u3'='u1'){
 const user=fixture[person],client=await pool.connect();
 try{await client.query('BEGIN');await client.query('SET LOCAL ROLE app_user');
  await client.query("SELECT set_config('request.jwt.claims',$1,true),set_config('app.current_company_id',$2,true)",[JSON.stringify({sub:user.id,role:'authenticated',company_id:user.companyId}),user.companyId]);
  const result=await withControlRequest({client,userId:user.id,companyId:user.companyId,claims:{}},{personId:user.id,companyId:user.companyId,authMethod:'cookie'},()=>fn(requireControlTx()));
  await client.query('COMMIT');return result;
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
async function invoice(currency='ZAR'){
 const id=randomUUID();await pool.query(`INSERT INTO customer_invoices(id,company_id,customer_id,client_id,invoice_number,invoice_date,subtotal,tax_amount,total_amount,currency_code,exchange_rate,functional_total,created_by)
 VALUES($1,$2,$3,$3,$4,'2026-09-09',100,15,115,$5,1,115,$6)`,[id,fixture.companyA,customer,id,currency,fixture.u1.id]);
 await pool.query(`INSERT INTO customer_invoice_items(invoice_id,description,quantity,unit_price,amount,tax_rate) VALUES($1,'Service',1,100,100,15)`,[id]);return id;
}
async function payment(invoiceId:string,currency:string|null='ZAR'){
 const id=randomUUID();await pool.query(`INSERT INTO customer_payments(id,company_id,client_id,payment_number,payment_date,total_amount,currency_code,created_by)
 VALUES($1,$2,$3,$4,'2026-09-09',115,$5,$6)`,[id,fixture.companyA,customer,id.slice(0,28),currency,fixture.u1.id]);
 await pool.query('INSERT INTO customer_payment_allocations(payment_id,invoice_id,amount_allocated) VALUES($1,$2,115)',[id,invoiceId]);return id;
}
async function note(invoiceId:string){
 const id=randomUUID();await pool.query(`INSERT INTO credit_notes(id,company_id,type,client_id,customer_invoice_id,credit_note_number,credit_date,subtotal,tax_amount,total_amount,currency_code,created_by)
 VALUES($1,$2,'customer',$3,$4,$5,'2026-09-09',100,15,115,'ZAR',$6)`,[id,fixture.companyA,customer,invoiceId,id.slice(0,28),fixture.u1.id]);return id;
}
const invoiceRef=(id:string):OperationRef=>({entityType:'customer_invoice',entityId:id,operation:'customer_invoice.post'});

async function approval(ref:OperationRef){const result=await actor(ctx=>requestOperationApproval(ctx,ref));if(result.status==='pending')await actor(ctx=>decideOperationApproval(ctx,result.id,'approved'),'u2');return result.id;}
it('posts the actual invoice and cancels by a current dated contra while retaining original provenance',async()=>{
 const id=await invoice();const result=await actor(()=>approveCustomerInvoice(fixture.companyA,id,fixture.u1.id));
 expect(result.glJournalEntryId).toBeTruthy();
 const cancelled=await actor(()=>cancelCustomerInvoice(fixture.companyA,id,fixture.u1.id,{reversalDate:'2026-09-10'}));
 expect(cancelled.reversedJournalEntryId).toBeTruthy();
 const rows=await pool.query('SELECT status,gl_journal_entry_id FROM customer_invoices WHERE company_id=$1 AND id=$2',[fixture.companyA,id]);
 expect(rows.rows[0]).toMatchObject({status:'cancelled',gl_journal_entry_id:result.glJournalEntryId});
});
it('does not claim a second financial effect when a fresh request retries an already posted invoice',async()=>{
 const id=await invoice();const first=await actor(()=>approveCustomerInvoice(fixture.companyA,id,fixture.u1.id));
 const second=await actor(()=>approveCustomerInvoice(fixture.companyA,id,fixture.u1.id));
 expect(second.glJournalEntryId).toBe(first.glJournalEntryId);
 const result=await pool.query("SELECT id FROM control_operation_effects WHERE company_id=$1 AND entity_id=$2 AND operation='customer_invoice.post'",[fixture.companyA,id]);
 expect(result.rows).toHaveLength(1);
});
it('requires independent approval, refuses stale invoice edits, and rolls back attempted status transitions',async()=>{
 const rule=randomUUID();await pool.query("INSERT INTO approval_rules(id,company_id,name,document_type,condition_field,condition_operator,condition_value,approver_role) VALUES($1,$2,'AR synthetic policy','customer_invoice','amount','any',0,'admin')",[rule,fixture.companyA]);
 try{
  const id=await invoice();await expect(actor(()=>approveCustomerInvoice(fixture.companyA,id,fixture.u1.id))).rejects.toThrow('Independent');
  const approvalId=await approval(invoiceRef(id));
  await pool.query("UPDATE customer_invoices SET internal_notes='Changed after approval' WHERE company_id=$1 AND id=$2",[fixture.companyA,id]);
  await expect(actor(()=>approveCustomerInvoice(fixture.companyA,id,fixture.u1.id,{approvalId}))).rejects.toThrow('changed');
  expect((await pool.query('SELECT status,gl_journal_entry_id FROM customer_invoices WHERE company_id=$1 AND id=$2',[fixture.companyA,id])).rows[0]).toMatchObject({status:'draft',gl_journal_entry_id:null});
 }finally{await pool.query('DELETE FROM approval_rules WHERE company_id=$1 AND id=$2',[fixture.companyA,rule]);}
});
it('confirms and cancels a receipt with exactly inverse owned invoice balance and child history',async()=>{
 const id=await invoice();await actor(()=>approveCustomerInvoice(fixture.companyA,id,fixture.u1.id));const receipt=await payment(id);
 const posted=await actor(()=>confirmCustomerPayment(fixture.companyA,receipt,fixture.u1.id));expect(posted.glJournalEntryId).toBeTruthy();
 expect((await pool.query('SELECT amount_paid FROM customer_invoices WHERE company_id=$1 AND id=$2',[fixture.companyA,id])).rows[0].amount_paid).toBe('115.00');
 await actor(()=>cancelCustomerPayment(fixture.companyA,receipt,fixture.u1.id,'Synthetic reversal',{reversalDate:'2026-09-10'}));
 expect((await pool.query('SELECT amount_paid FROM customer_invoices WHERE company_id=$1 AND id=$2',[fixture.companyA,id])).rows[0].amount_paid).toBe('0.00');
 const changes=await pool.query('SELECT action FROM control_change_events WHERE company_id=$1 AND entity_id=$2',[fixture.companyA,id]);
 expect(changes.rows.map(row=>row.action)).toEqual(expect.arrayContaining(['payment_applied','payment_unapplied']));
});
it('approves a linked credit note once and cancels exactly the applied balance',async()=>{
 const id=await invoice();await actor(()=>approveCustomerInvoice(fixture.companyA,id,fixture.u1.id));const credit=await note(id);
 await actor(()=>approveCreditNote(fixture.companyA,credit,fixture.u1.id));
 expect((await pool.query('SELECT amount_paid FROM customer_invoices WHERE company_id=$1 AND id=$2',[fixture.companyA,id])).rows[0].amount_paid).toBe('115.00');
 await actor(()=>cancelCreditNote(fixture.companyA,credit,fixture.u1.id,'Synthetic cancellation',{reversalDate:'2026-09-10'}));
 expect((await pool.query('SELECT amount_paid FROM customer_invoices WHERE company_id=$1 AND id=$2',[fixture.companyA,id])).rows[0].amount_paid).toBe('0.00');
});
it('prepares an immutable application target before approval and applies the customer credit',async()=>{
 const id=await invoice();await actor(()=>approveCustomerInvoice(fixture.companyA,id,fixture.u1.id));const credit=await note(id);
 await pool.query('UPDATE credit_notes SET customer_invoice_id=NULL WHERE company_id=$1 AND id=$2',[fixture.companyA,credit]);
 await actor(()=>approveCreditNote(fixture.companyA,credit,fixture.u1.id));
 const ref=await actor(()=>prepareCreditNoteApplication(fixture.companyA,credit,id,fixture.u1.id));
 const approvalId=await approval(ref);
 await actor(()=>applyCreditNoteToInvoice(fixture.companyA,credit,id,fixture.u1.id,{applicationId:ref.entityId,approvalId}));
 expect((await pool.query('SELECT amount_paid FROM customer_invoices WHERE company_id=$1 AND id=$2',[fixture.companyA,id])).rows[0].amount_paid).toBe('115.00');
});

async function recurring(){const id=randomUUID();await pool.query(`INSERT INTO recurring_invoices(id,company_id,template_name,client_id,frequency,next_run_date,line_items,subtotal,tax_rate,tax_amount,total_amount,currency_code,created_by)
 VALUES($1,$2,'Synthetic guarded recurring',$3,'monthly','2026-09-09',$4::jsonb,100,15,15,115,'ZAR',$5)`,[id,fixture.companyA,customer,JSON.stringify([{description:'Service',quantity:1,unitPrice:100}]),fixture.u1.id]);return id;}
it('prepares a durable draft without advancing then executes the exact recurring run once',async()=>{
 const id=await recurring(),ref=await actor(()=>prepareRecurringInvoiceRun(fixture.companyA,id,fixture.u1.id));
 const prepared=await pool.query('SELECT invoice_id FROM control_recurring_invoice_runs WHERE company_id=$1 AND id=$2',[fixture.companyA,ref.entityId]);
 expect((await pool.query('SELECT status,gl_journal_entry_id FROM customer_invoices WHERE company_id=$1 AND id=$2',[fixture.companyA,prepared.rows[0].invoice_id])).rows[0]).toMatchObject({status:'draft',gl_journal_entry_id:null});
 const approvalId=await approval(ref);
 const invoiceId=await actor(()=>generateInvoiceFromRecurring(fixture.companyA,id,fixture.u1.id,{runId:ref.entityId,approvalId}));
 expect(invoiceId).toBe(prepared.rows[0].invoice_id);
 expect(await actor(()=>generateInvoiceFromRecurring(fixture.companyA,id,fixture.u1.id,{runId:ref.entityId,approvalId}))).toBe(invoiceId);
 expect((await pool.query('SELECT run_count,next_run_date::text FROM recurring_invoices WHERE company_id=$1 AND id=$2',[fixture.companyA,id])).rows[0]).toMatchObject({run_count:1,next_run_date:'2026-10-09'});
});
it('refuses a recurring template edit after preparation without advancing its schedule',async()=>{
 const id=await recurring(),ref=await actor(()=>prepareRecurringInvoiceRun(fixture.companyA,id,fixture.u1.id));
 await pool.query('UPDATE recurring_invoices SET line_items=$1::jsonb WHERE company_id=$2 AND id=$3',[JSON.stringify([{description:'Changed',quantity:1,unitPrice:100}]),fixture.companyA,id]);
 await expect(actor(()=>generateInvoiceFromRecurring(fixture.companyA,id,fixture.u1.id,{runId:ref.entityId}))).rejects.toThrow('match');
 expect((await pool.query('SELECT run_count FROM recurring_invoices WHERE company_id=$1 AND id=$2',[fixture.companyA,id])).rows[0].run_count).toBe(0);
});

it('refuses receipt confirmation against an unposted invoice',async()=>{
 const id=await invoice(),receipt=await payment(id);
 await expect(actor(()=>confirmCustomerPayment(fixture.companyA,receipt,fixture.u1.id))).rejects.toThrow('posted');
});
it('never floors a corrupted invoice balance when cancelling a receipt',async()=>{
 const id=await invoice(),receipt=await payment(id);
 await actor(()=>approveCustomerInvoice(fixture.companyA,id,fixture.u1.id));
 await actor(()=>confirmCustomerPayment(fixture.companyA,receipt,fixture.u1.id));
 await pool.query('UPDATE customer_invoices SET amount_paid=0 WHERE company_id=$1 AND id=$2',[fixture.companyA,id]);
 await expect(actor(()=>cancelCustomerPayment(fixture.companyA,receipt,fixture.u1.id))).rejects.toThrow('balance');
 expect((await pool.query('SELECT status FROM customer_payments WHERE company_id=$1 AND id=$2',[fixture.companyA,receipt])).rows[0].status).toBe('confirmed');
});

async function route(handler: NextApiHandler, body: Record<string, unknown>, url: string) {
  const csrf = randomBytes(32).toString('hex');
  const token = Buffer.from(JSON.stringify({ sub: fixture.u1.id, role: 'authenticated', company_id: fixture.companyA })).toString('base64url');
  const request = { method: 'POST', url, body, query: {}, cookies: { 'sb-access-token': token, active_company_id: fixture.companyA, isaflow_csrf: csrf },
    headers: { cookie: `sb-access-token=${token}; active_company_id=${fixture.companyA}`, 'x-csrf-token': csrf } } as unknown as NextApiRequest;
  let payload = '', ends = 0;
  const response = { statusCode: 200, headersSent: false, setHeader: vi.fn(), getHeader: vi.fn(),
    status(this: { statusCode: number }, code: number) { this.statusCode = code; return this; },
    json(this: { end: (value: string) => unknown }, value: unknown) { return this.end(JSON.stringify(value)); },
    end(value?: string) { payload = value ?? ''; ends++; return this; },
  } as unknown as NextApiResponse;
  await handler(request, response); expect(ends).toBe(1);
  return { status: response.statusCode, body: JSON.parse(payload) as { success: boolean; message?: string; data?: Record<string, unknown> } };
}

it('actual REST cookie, CSRF and transaction wrappers enforce approval and commit one authorized journal',async()=>{
 const id=await invoice(),rule=randomUUID();
 await pool.query("INSERT INTO approval_rules(id,company_id,name,document_type,condition_field,condition_operator,condition_value,approver_role) VALUES($1,$2,'AR route policy','customer_invoice','amount','any',0,'admin')",[rule,fixture.companyA]);
 try{
  const refused=await route(invoiceRoute,{id,action:'approve',approved:true,skipApproval:true},'/api/accounting/customer-invoices-detail');
  expect(refused.status).toBe(400);
  expect((await pool.query('SELECT gl_journal_entry_id FROM customer_invoices WHERE company_id=$1 AND id=$2',[fixture.companyA,id])).rows[0].gl_journal_entry_id).toBeNull();
  const approvalId=await approval(invoiceRef(id));
  const posted=await route(invoiceRoute,{id,action:'approve',approvalId},'/api/accounting/customer-invoices-detail');
  expect(posted.status).toBe(200);expect(posted.body.data?.glJournalEntryId).toBeTruthy();
 }finally{await pool.query('DELETE FROM approval_rules WHERE company_id=$1 AND id=$2',[fixture.companyA,rule]);}
});
it('serializes simultaneous fresh requests to one posted invoice and one effect',async()=>{
 const id=await invoice();const results=await Promise.all([actor(()=>approveCustomerInvoice(fixture.companyA,id,fixture.u1.id)),actor(()=>approveCustomerInvoice(fixture.companyA,id,fixture.u1.id))]);
 expect(results[0].glJournalEntryId).toBe(results[1].glJournalEntryId);
 expect((await pool.query("SELECT id FROM control_operation_effects WHERE company_id=$1 AND entity_id=$2 AND operation='customer_invoice.post'",[fixture.companyA,id])).rows).toHaveLength(1);
});
it('refuses foreign tenant AR services with no foreign effect',async()=>{
 const id=await invoice();await expect(actor(()=>approveCustomerInvoice(fixture.companyB,id,fixture.u3.id),'u3')).rejects.toThrow('not found');
 expect((await pool.query('SELECT gl_journal_entry_id FROM customer_invoices WHERE company_id=$1 AND id=$2',[fixture.companyA,id])).rows[0].gl_journal_entry_id).toBeNull();
});

it.each(['draft','reversed','unrelated'])('refuses a new invoice posting approval adopting a %s journal link',async kind=>{
 const id=await invoice();
 const accounts=await pool.query("SELECT id,account_subtype FROM gl_accounts WHERE company_id=$1 AND account_subtype IN ('receivable','default_revenue')",[fixture.companyA]);
 const receivable=accounts.rows.find(row=>row.account_subtype==='receivable').id,revenue=accounts.rows.find(row=>row.account_subtype==='default_revenue').id;
 const journal=await actor(()=>createJournalEntry(fixture.companyA,{entryDate:'2026-09-09',description:'Synthetic malformed invoice link',source:kind==='unrelated'?'manual':'auto_invoice',sourceRecordId:id,
  lines:[{glAccountId:receivable,debit:115,credit:0},{glAccountId:revenue,debit:0,credit:115}]},fixture.u1.id));
 if(kind!=='draft')await pool.query("UPDATE gl_journal_entries SET status='posted',reversed_at=CASE WHEN $3='reversed' THEN clock_timestamp() ELSE NULL END WHERE company_id=$1 AND id=$2",[fixture.companyA,journal.id,kind]);
 await pool.query('UPDATE customer_invoices SET gl_journal_entry_id=$1 WHERE company_id=$2 AND id=$3',[journal.id,fixture.companyA,id]);
 const approvalId=await approval(invoiceRef(id));
 await expect(actor(()=>approveCustomerInvoice(fixture.companyA,id,fixture.u1.id,{approvalId}))).rejects.toThrow('journal');
 expect((await pool.query('SELECT status FROM customer_invoices WHERE company_id=$1 AND id=$2',[fixture.companyA,id])).rows[0].status).toBe('draft');
});
it.each(['draft','cancelled'])('refuses preparing a credit application against a %s invoice',async status=>{
 const id=await invoice(),credit=await note(id);
 await pool.query('UPDATE credit_notes SET customer_invoice_id=NULL WHERE company_id=$1 AND id=$2',[fixture.companyA,credit]);
 await actor(()=>approveCreditNote(fixture.companyA,credit,fixture.u1.id));
 if(status==='cancelled')await actor(()=>cancelCustomerInvoice(fixture.companyA,id,fixture.u1.id));
 await expect(actor(()=>prepareCreditNoteApplication(fixture.companyA,credit,id,fixture.u1.id))).rejects.toThrow('posted');
 expect((await pool.query('SELECT amount_paid FROM customer_invoices WHERE company_id=$1 AND id=$2',[fixture.companyA,id])).rows[0].amount_paid).toBe('0.00');
});
it('refuses linked credit auto-application against an invoice without a live posted journal',async()=>{
 const id=await invoice(),credit=await note(id);
 await expect(actor(()=>approveCreditNote(fixture.companyA,credit,fixture.u1.id))).rejects.toThrow('posted');
 expect((await pool.query('SELECT status,gl_journal_entry_id FROM credit_notes WHERE company_id=$1 AND id=$2',[fixture.companyA,credit])).rows[0]).toMatchObject({status:'draft',gl_journal_entry_id:null});
});

it('invalidates a credit application approval when the target posted journal changes',async()=>{
 const id=await invoice();const posted=await actor(()=>approveCustomerInvoice(fixture.companyA,id,fixture.u1.id));const credit=await note(id);
 await pool.query('UPDATE credit_notes SET customer_invoice_id=NULL WHERE company_id=$1 AND id=$2',[fixture.companyA,credit]);
 await actor(()=>approveCreditNote(fixture.companyA,credit,fixture.u1.id));
 const ref=await actor(()=>prepareCreditNoteApplication(fixture.companyA,credit,id,fixture.u1.id)),approvalId=await approval(ref);
 await pool.query("UPDATE gl_journal_entries SET description='Synthetic edited source journal' WHERE company_id=$1 AND id=$2",[fixture.companyA,posted.glJournalEntryId]);
 await expect(actor(()=>applyCreditNoteToInvoice(fixture.companyA,credit,id,fixture.u1.id,{applicationId:ref.entityId,approvalId}))).rejects.toThrow('changed');
});

it('rechecks the original approver on an omitted-approval invoice receipt retry',async()=>{
 const id=await invoice(),rule=randomUUID();
 await pool.query("INSERT INTO approval_rules(id,company_id,name,document_type,condition_field,condition_operator,condition_value,approver_role) VALUES($1,$2,'AR retry policy','customer_invoice','amount','any',0,'admin')",[rule,fixture.companyA]);
 try{
  const approvalId=await approval(invoiceRef(id));
  await actor(()=>approveCustomerInvoice(fixture.companyA,id,fixture.u1.id,{approvalId}));
  await pool.query("UPDATE company_users SET role='viewer' WHERE company_id=$1 AND user_id=$2",[fixture.companyA,fixture.u2.id]);
  await expect(actor(()=>approveCustomerInvoice(fixture.companyA,id,fixture.u1.id))).rejects.toThrow();
  expect((await pool.query("SELECT id FROM control_operation_effects WHERE company_id=$1 AND entity_id=$2 AND operation='customer_invoice.post'",[fixture.companyA,id])).rows).toHaveLength(1);
 }finally{
  await pool.query("UPDATE company_users SET role='admin' WHERE company_id=$1 AND user_id=$2",[fixture.companyA,fixture.u2.id]);
  await pool.query('DELETE FROM approval_rules WHERE company_id=$1 AND id=$2',[fixture.companyA,rule]);
 }
});
