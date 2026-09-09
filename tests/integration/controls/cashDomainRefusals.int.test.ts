import { afterAll, beforeAll, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { fixtureConfigFromEnv } from '../../../scripts/forensic/fixture-bootstrap';
import { provisionForensicFixture, validateFixtureTarget, type ForensicFixture } from '../forensic-fixture';
import { seedApAccounts } from './apSyntheticAccounts';
import { withControlRequest, requireControlTx } from '@/modules/accounting/services/controls/context';
import { requestOperationApproval, decideOperationApproval } from '@/modules/accounting/services/controls/approvalRequestService';
import { processSupplierPayment, voidSupplierPayment } from '@/modules/accounting/services/ap/supplierPaymentWorkflowService';
import type { ControlTx, OperationRef } from '@/modules/accounting/services/controls/contracts';

const config = fixtureConfigFromEnv(process.env), target = validateFixtureTarget(config);
const pool = new Pool({ connectionString: target.connectionString, ssl: false, max: 4 });
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex');
process.env.CONTROL_FINGERPRINT_KEY = randomBytes(32).toString('hex');
let fixture: ForensicFixture, accounts: Awaited<ReturnType<typeof seedApAccounts>>;
const supplier = randomUUID(), invoiceRule = randomUUID(), paymentRule = randomUUID();
beforeAll(async () => {
  fixture = await provisionForensicFixture(config); accounts = await seedApAccounts(pool, fixture.companyA);
  await pool.query('INSERT INTO suppliers(id,company_id,name) VALUES($1,$2,$3)', [supplier, fixture.companyA, 'Synthetic controlled supplier']);
  await pool.query(`INSERT INTO fiscal_periods(id,company_id,period_name,period_number,fiscal_year,start_date,end_date,status)
    VALUES($1,$2,'Synthetic September',9,2026,'2026-09-01','2026-09-30','open')`, [randomUUID(), fixture.companyA]);
  for (const [id, type] of [[invoiceRule, 'supplier_invoice'], [paymentRule, 'payment']]) await pool.query(`
    INSERT INTO approval_rules(id,company_id,name,document_type,condition_field,condition_operator,condition_value,approver_role)
    VALUES($1,$2,'Shared writer policy',$3,'amount','any',0,'admin')`, [id, fixture.companyA, type]);
});
afterAll(async () => { await pool.end(); });
async function actor<T>(person: 'u1' | 'u2', fn: (ctx: ControlTx) => Promise<T>) {
  const user = fixture[person], client = await pool.connect();
  try {
    await client.query('BEGIN'); await client.query('SET LOCAL ROLE app_user');
    await client.query("SELECT set_config('request.jwt.claims',$1,true),set_config('app.current_company_id',$2,true)",
      [JSON.stringify({ sub: user.id, role: 'authenticated', company_id: user.companyId }), user.companyId]);
    const result = await withControlRequest({ client, userId: user.id, companyId: user.companyId, claims: {} },
      { personId: user.id, companyId: user.companyId, authMethod: 'cookie' }, () => fn(requireControlTx()));
    await client.query('COMMIT'); return result;
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}
async function document() {
  const invoice = randomUUID(), payment = randomUUID();
  await pool.query(`INSERT INTO supplier_invoices(id,company_id,supplier_id,invoice_number,invoice_date,subtotal,tax_rate,tax_amount,total_amount,currency,status,created_by)
    VALUES($1::uuid,$2,$3,left($1::text,28),'2026-09-09',100,15,15,115,'ZAR','draft',$4)`, [invoice, fixture.companyA, supplier, fixture.u1.id]);
  await pool.query(`INSERT INTO supplier_invoice_items(supplier_invoice_id,description,quantity,unit_price,line_total,tax_rate,tax_amount,gl_account_id)
    VALUES($1,'Synthetic expense',1,100,100,15,15,$2)`, [invoice, accounts.default_expense]);
  await pool.query(`INSERT INTO supplier_payments(id,company_id,supplier_id,payment_number,payment_date,total_amount,status,created_by)
    VALUES($1::uuid,$2,$3,left($1::text,28),'2026-09-09',115,'approved',$4)`, [payment, fixture.companyA, supplier, fixture.u1.id]);
  await pool.query('INSERT INTO payment_allocations(payment_id,invoice_id,amount_allocated) VALUES($1,$2,115)', [payment, invoice]);
  return { invoice, payment };
}
const paymentRef = (id: string): OperationRef => ({ operation: 'supplier_payment.process', entityType: 'supplier_payment', entityId: id });
async function approval(ref: OperationRef) {
  const row = await actor('u1', ctx => requestOperationApproval(ctx, ref));
  await actor('u2', ctx => decideOperationApproval(ctx, row.id, 'approved')); return row.id;
}
async function financialState(payment:string,invoice:string){
 const company=fixture.companyA;
 return{
  payment:(await pool.query('SELECT status,gl_journal_entry_id FROM supplier_payments WHERE company_id=$1 AND id=$2',[company,payment])).rows,
  invoice:(await pool.query('SELECT status,amount_paid::text FROM supplier_invoices WHERE company_id=$1 AND id=$2',[company,invoice])).rows,
  allocations:(await pool.query('SELECT a.* FROM payment_allocations a JOIN supplier_payments p ON p.id=a.payment_id WHERE p.company_id=$1 AND p.id=$2 ORDER BY a.id',[company,payment])).rows,
  journals:(await pool.query('SELECT id,status,reversed_at,reversal_of_id FROM gl_journal_entries WHERE company_id=$1 ORDER BY id',[company])).rows,
  effects:(await pool.query('SELECT id FROM control_operation_effects WHERE company_id=$1 ORDER BY id',[company])).rows,
  changes:(await pool.query('SELECT id FROM control_change_events WHERE company_id=$1 ORDER BY id',[company])).rows,
 };
}
it('reconciled direct supplier payment reaches the domain refusal with fresh independent approval and preserves all effects',async()=>{
 const doc=await document(),processApproval=await approval(paymentRef(doc.payment));
 const processed=await actor('u1',()=>processSupplierPayment(fixture.companyA,doc.payment,fixture.u1.id,{approvalId:processApproval}));
 expect(processed.status).toBe('processed');expect(processed.glJournalEntryId).toBeTruthy();
 expect((await pool.query('SELECT status FROM gl_journal_entries WHERE company_id=$1 AND id=$2',[fixture.companyA,processed.glJournalEntryId])).rows[0].status).toBe('posted');
 expect((await pool.query('SELECT amount_paid::text FROM supplier_invoices WHERE company_id=$1 AND id=$2',[fixture.companyA,doc.invoice])).rows[0].amount_paid).toBe('115.00');
 // Model the pre-existing reconciliation state after actual processing; no synthetic kernel permit or bank-child origin.
 await pool.query("UPDATE supplier_payments SET status='reconciled' WHERE company_id=$1 AND id=$2",[fixture.companyA,doc.payment]);
 const ref:OperationRef={operation:'supplier_payment.void',entityType:'supplier_payment',entityId:doc.payment};
 const voidApproval=await approval(ref),before=await financialState(doc.payment,doc.invoice);
 await expect(actor('u1',()=>voidSupplierPayment(fixture.companyA,doc.payment,fixture.u1.id,{approvalId:voidApproval})))
  .rejects.toThrow('Cannot void a reconciled payment');
 expect(await financialState(doc.payment,doc.invoice)).toEqual(before);
 expect((await pool.query('SELECT status FROM control_operation_approvals WHERE company_id=$1 AND id=$2',[fixture.companyA,voidApproval])).rows[0].status).toBe('approved');
});
it('rejects an explicit foreign bank account despite dual membership before approval or journal writes',async()=>{
 const doc=await document(),foreign=randomUUID();
 await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin') ON CONFLICT(company_id,user_id) DO NOTHING",[fixture.companyB,fixture.u1.id]);
 await pool.query("INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance,is_active,is_system_account) VALUES($1,$2,left($1::uuid::text,12),'Foreign synthetic bank','asset','bank','debit',true,true)",[foreign,fixture.companyB]);
 await pool.query('UPDATE supplier_payments SET bank_account_id=$3 WHERE company_id=$1 AND id=$2',[fixture.companyA,doc.payment,accounts.bank]);
 // Positive approval material validates all other sources before substituting the foreign identity.
 const approved=await approval(paymentRef(doc.payment));
 await pool.query('UPDATE supplier_payments SET bank_account_id=$3 WHERE company_id=$1 AND id=$2',[fixture.companyA,doc.payment,foreign]);
 const before=await financialState(doc.payment,doc.invoice);
 await expect(actor('u1',ctx=>requestOperationApproval(ctx,paymentRef(doc.payment)))).rejects.toThrow('AP account is missing, foreign or inactive');
 await expect(actor('u1',()=>processSupplierPayment(fixture.companyA,doc.payment,fixture.u1.id,{approvalId:approved})))
  .rejects.toThrow('AP account is missing, foreign or inactive');
 expect(await financialState(doc.payment,doc.invoice)).toEqual(before);
});
