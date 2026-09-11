import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import type { NextApiHandler, NextApiRequest, NextApiResponse } from 'next';
import { fixtureConfigFromEnv } from '../../../scripts/forensic/fixture-bootstrap';
import { provisionForensicFixture, validateFixtureTarget, type ForensicFixture } from '../forensic-fixture';
import { seedApAccounts } from './apSyntheticAccounts';
import { withControlRequest, requireControlTx } from '@/modules/accounting/services/controls/context';
import { requestOperationApproval, decideOperationApproval } from '@/modules/accounting/services/controls/approvalRequestService';
import { processSupplierPayment, voidSupplierPayment } from '@/modules/accounting/services/ap/supplierPaymentWorkflowService';
import { approveSupplierInvoice, cancelSupplierInvoice, postSupplierInvoiceToGL } from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import type { ControlTx, OperationRef } from '@/modules/accounting/services/controls/contracts';
import { SuppliedApprovalRefusal } from '@/modules/accounting/services/controls/suppliedApprovalRefusal';

const config = fixtureConfigFromEnv(process.env), target = validateFixtureTarget(config);
const pool = new Pool({ connectionString: target.connectionString, ssl: false, max: 4 });
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex');
process.env.CONTROL_FINGERPRINT_KEY = randomBytes(32).toString('hex');
// External cookie verification is synthetic; actual withAuth, RLS, transaction and route execute.
vi.mock('@/lib/auth/gotrue', () => ({ verifyToken: async (token: string) => JSON.parse(Buffer.from(token, 'base64url').toString()) }));
vi.mock('@/lib/auth/authPool', () => ({ getAuthPool: () => pool }));
let fixture: ForensicFixture, accounts: Awaited<ReturnType<typeof seedApAccounts>>;
let paymentRoute: NextApiHandler, invoiceRoute: NextApiHandler;
const supplier = randomUUID(), invoiceRule = randomUUID(), paymentRule = randomUUID();
beforeAll(async () => {
  fixture = await provisionForensicFixture(config); accounts = await seedApAccounts(pool, fixture.companyA);
  await pool.query('INSERT INTO suppliers(id,company_id,name) VALUES($1,$2,$3)', [supplier, fixture.companyA, 'Synthetic controlled supplier']);
  await pool.query(`INSERT INTO fiscal_periods(id,company_id,period_name,period_number,fiscal_year,start_date,end_date,status)
    VALUES($1,$2,'Synthetic September',9,2026,'2026-09-01','2026-09-30','open')`, [randomUUID(), fixture.companyA]);
  for (const [id, type] of [[invoiceRule, 'supplier_invoice'], [paymentRule, 'payment']]) await pool.query(`
    INSERT INTO approval_rules(id,company_id,name,document_type,condition_field,condition_operator,condition_value,approver_role)
    VALUES($1,$2,'Shared writer policy',$3,'amount','any',0,'admin')`, [id, fixture.companyA, type]);
  paymentRoute = (await import('../../../pages/api/accounting/supplier-payments-action')).default;
  invoiceRoute = (await import('../../../pages/api/accounting/supplier-invoices-action')).default;
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
// The one source of "today" the calendar-dependent tests below derive everything from — a single
// place to point at a different clock when proving that derivation is calendar-agnostic.
async function serverToday(): Promise<string> {
  return (await pool.query("SELECT (clock_timestamp() AT TIME ZONE 'Africa/Johannesburg')::date::text AS day")).rows[0].day;
}
function firstOfPreviousMonth(dateStr: string): string {
  const date = new Date(`${dateStr}T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() - 1, 1);
  return date.toISOString().slice(0, 10);
}
function addDays(dateStr: string, days: number): string {
  const date = new Date(`${dateStr}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
/** Reuses an existing open period covering `dateStr`, or creates a single-day one scoped to it —
 * never an unconditional insert, which could collide with fiscal_periods_no_overlap (migration 502). */
async function ensureOpenPeriod(dateStr: string): Promise<string> {
  const covering = await pool.query(
    "SELECT id FROM fiscal_periods WHERE company_id=$1 AND status='open' AND start_date<=$2::date AND end_date>=$2::date",
    [fixture.companyA, dateStr]);
  if (covering.rows[0]) return covering.rows[0].id as string;
  const id = randomUUID(), date = new Date(`${dateStr}T00:00:00Z`);
  await pool.query(`INSERT INTO fiscal_periods(id,company_id,period_name,period_number,fiscal_year,start_date,end_date,status)
    VALUES($1,$2,'Synthetic derived period',$3,$4,$5::date,$5::date,'open')`,
    [id, fixture.companyA, date.getUTCMonth() + 1, date.getUTCFullYear(), dateStr]);
  return id;
}
const paymentRef = (id: string): OperationRef => ({ operation: 'supplier_payment.process', entityType: 'supplier_payment', entityId: id });
const invoiceRef = (id: string): OperationRef => ({ operation: 'supplier_invoice.post', entityType: 'supplier_invoice', entityId: id });
async function approval(ref: OperationRef) {
  const row = await actor('u1', ctx => requestOperationApproval(ctx, ref));
  await actor('u2', ctx => decideOperationApproval(ctx, row.id, 'approved')); return row.id;
}
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
it('actual REST action wrappers and shared-service ingress both refuse missing approval before GL writes', async () => {
  const doc = await document();
  const before = await pool.query('SELECT id FROM gl_journal_entries WHERE company_id=$1', [fixture.companyA]);
  for (const [handler, body, path] of [[paymentRoute, { action: 'process', paymentId: doc.payment }, 'supplier-payments-action'],
    [invoiceRoute, { action: 'approve', invoiceId: doc.invoice }, 'supplier-invoices-action']] as const) {
    const result = await route(handler, { ...body, skipApproval: true, approved: true }, `/api/accounting/${path}`);
    expect(result.status).toBe(400); expect(result.body.success).toBe(false);
  }
  await expect(actor('u1', () => processSupplierPayment(fixture.companyA, doc.payment, fixture.u1.id))).rejects.toMatchObject({ code: 'OPERATION_APPROVAL_REQUIRED' });
  expect((await pool.query('SELECT id FROM gl_journal_entries WHERE company_id=$1', [fixture.companyA])).rows).toEqual(before.rows);
});
it('posts one actual payment journal and versions the allocated invoice, then controls its reversal', async () => {
  const doc = await document(), id = await approval(paymentRef(doc.payment));
  const response = await route(paymentRoute, { action: 'process', paymentId: doc.payment, approvalId: id }, '/api/accounting/supplier-payments-action');
  expect(response.status).toBe(200); const result = response.body.data!;
  expect(result.status).toBe('processed');
  const replay = await actor('u1', () => processSupplierPayment(fixture.companyA, doc.payment, fixture.u1.id, { approvalId: id }));
  expect(replay).toEqual(result);
  expect((await pool.query('SELECT amount_paid::text FROM supplier_invoices WHERE company_id=$1 AND id=$2', [fixture.companyA, doc.invoice])).rows[0].amount_paid).toBe('115.00');
  expect((await pool.query("SELECT id FROM control_change_events WHERE company_id=$1 AND entity_id=$2 AND action='payment_applied'", [fixture.companyA, doc.invoice])).rows).toHaveLength(1);
  await expect(actor('u1', () => voidSupplierPayment(fixture.companyA, doc.payment, fixture.u1.id))).rejects.toMatchObject({ code: 'OPERATION_APPROVAL_REQUIRED' });
  const reversal = await approval({ ...paymentRef(doc.payment), operation: 'supplier_payment.void' });
  expect((await actor('u1', () => voidSupplierPayment(fixture.companyA, doc.payment, fixture.u1.id, { approvalId: reversal }))).status).toBe('cancelled');
});
it('invoice approve/post share one actual financial result and preserve public return shapes', async () => {
  const doc = await document(), id = await approval(invoiceRef(doc.invoice));
  const response = await route(invoiceRoute, { action: 'approve', invoiceId: doc.invoice, approvalId: id }, '/api/accounting/supplier-invoices-action');
  expect(response.status).toBe(200);
  const posted = await actor('u1', () => postSupplierInvoiceToGL(fixture.companyA, doc.invoice, fixture.u1.id, { approvalId: id }));
  expect(posted.alreadyPosted).toBe(true);
  const approved = await actor('u1', () => approveSupplierInvoice(fixture.companyA, doc.invoice, fixture.u1.id, { approvalId: id }));
  expect(approved.glJournalEntryId).toBe(posted.journalEntryId); expect(approved.status).toBe('approved');
  expect((await pool.query('SELECT id FROM gl_journal_entries WHERE company_id=$1 AND source_record_id=$2', [fixture.companyA, doc.invoice])).rows).toHaveLength(1);
});
it('refuses changed account mapping and line material after independent approval', async () => {
  for (const change of ['account', 'line']) {
    const doc = await document(), id = await approval(invoiceRef(doc.invoice));
    const replacement = randomUUID();
    try {
      if (change === 'account') {
        await pool.query('UPDATE gl_accounts SET is_system_account=false WHERE company_id=$1 AND id=$2', [fixture.companyA, accounts.payable]);
        await pool.query(`INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,account_subtype,normal_balance,is_active,is_system_account)
          VALUES($1,$2,$3,'Replacement payable','liability','payable','credit',true,true)`, [replacement, fixture.companyA, replacement.slice(0, 12)]);
      } else await pool.query("UPDATE supplier_invoice_items SET gl_account_id=$1 WHERE supplier_invoice_id=$2", [accounts.bank, doc.invoice]);
      await expect(actor('u1', () => approveSupplierInvoice(fixture.companyA, doc.invoice, fixture.u1.id, { approvalId: id }))).rejects.toThrow('material');
      expect((await pool.query('SELECT id FROM gl_journal_entries WHERE company_id=$1 AND source_record_id=$2', [fixture.companyA, doc.invoice])).rows).toHaveLength(0);
    } finally {
      await pool.query('UPDATE gl_accounts SET is_system_account=false WHERE company_id=$1 AND id=$2', [fixture.companyA, replacement]);
      await pool.query('UPDATE gl_accounts SET is_system_account=true WHERE company_id=$1 AND id=$2', [fixture.companyA, accounts.payable]);
    }
  }
});
it('REST failure after journal draft creation rolls back GL and preserves a valid approval retry', async () => {
  const doc = await document(), id = await approval(paymentRef(doc.payment));
  try {
    await pool.query("UPDATE fiscal_periods SET status='closed' WHERE company_id=$1", [fixture.companyA]);
    const refused = await route(paymentRoute, { action: 'process', paymentId: doc.payment, approvalId: id }, '/api/accounting/supplier-payments-action');
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect((await pool.query('SELECT id FROM gl_journal_entries WHERE company_id=$1 AND source_record_id=$2', [fixture.companyA, doc.payment])).rows).toHaveLength(0);
    expect((await pool.query('SELECT status FROM control_operation_approvals WHERE company_id=$1 AND id=$2', [fixture.companyA, id])).rows[0].status).toBe('approved');
  } finally { await pool.query("UPDATE fiscal_periods SET status='open' WHERE company_id=$1", [fixture.companyA]); }
  expect((await route(paymentRoute, { action: 'process', paymentId: doc.payment, approvalId: id }, '/api/accounting/supplier-payments-action')).status).toBe(200);
});
it('records baseline and versioned status approval while keeping financial processing gated', async () => {
  const doc = await document();
  await pool.query("UPDATE supplier_payments SET status='draft' WHERE company_id=$1 AND id=$2", [fixture.companyA, doc.payment]);
  expect((await route(paymentRoute, { action: 'approve', paymentId: doc.payment }, '/api/accounting/supplier-payments-action')).status).toBe(200);
  const events = await pool.query('SELECT action,new_version FROM control_change_events WHERE company_id=$1 AND entity_id=$2 ORDER BY new_version', [fixture.companyA, doc.payment]);
  expect(events.rows.map(row => row.action)).toEqual(['baseline_observed', 'status_approved']);
  expect((await route(paymentRoute, { action: 'process', paymentId: doc.payment }, '/api/accounting/supplier-payments-action')).status).toBe(400);
  expect((await pool.query('SELECT id FROM gl_journal_entries WHERE company_id=$1 AND source_record_id=$2', [fixture.companyA, doc.payment])).rows).toHaveLength(0);
});
it('binds a closed original period reversal to the open server-day target and refuses a changed target', async () => {
  // `today` is the single source every derived date below is computed from (serverToday()), so the
  // whole arrangement — a genuinely prior, genuinely closed original period; an open period covering
  // today; an uncovered changed target with its own period — holds on any calendar day, not just
  // whichever month happens to match a hard-coded literal (month end, year end included).
  const today = await serverToday();
  // Strictly before `today`'s period and in a different one: first of last month is never in the
  // same (start_date, end_date) range as whatever covers `today`, so closing it can't also close
  // the period the void's target date needs.
  const priorDate = firstOfPreviousMonth(today);
  const originalPeriod = await ensureOpenPeriod(priorDate);
  const doc = await document();
  await pool.query("UPDATE supplier_payments SET payment_date=$1 WHERE company_id=$2 AND id=$3", [priorDate, fixture.companyA, doc.payment]);
  const processApproval = await approval(paymentRef(doc.payment));
  const processed = await actor('u1', () => processSupplierPayment(fixture.companyA, doc.payment, fixture.u1.id, { approvalId: processApproval }));
  await pool.query("UPDATE fiscal_periods SET status='closed' WHERE company_id=$1 AND id=$2", [fixture.companyA, originalPeriod]);
  // The original period closing must never also close today's: the void's target (computed by the
  // kernel from the real server clock) needs an open period covering `today` to exist independently.
  const todayPeriod = await ensureOpenPeriod(today);
  expect(todayPeriod).not.toBe(originalPeriod);
  const ref: OperationRef = { ...paymentRef(doc.payment), operation: 'supplier_payment.void' };
  const id = await approval(ref);
  const stored = await pool.query('SELECT binding FROM control_operation_approvals WHERE company_id=$1 AND id=$2', [fixture.companyA, id]);
  expect(stored.rows[0].binding.accountingDate).toBe(today);
  const { executeControlledOperation } = await import('@/modules/accounting/services/controls/approvalExecutionService');
  const callback = vi.fn();
  // Guaranteed to differ from `today` (the bound accountingDate), unlike a hard-coded literal
  // that only fails to refuse on the one day it happens to equal the server's current date.
  const changedTargetStr = addDays(today, 1);
  // The kernel resolves the reversal target's fiscal period before it compares the binding
  // (apReversalMaterial.ts), so an uncovered date throws 'Target AP fiscal period missing or
  // ambiguous' instead of the refusal this test names — reintroducing a calendar dependency
  // (month/year end) that a fixed +1 day cannot see. ensureOpenPeriod reuses the fixture's own
  // covering period when there is one, and only creates a new one when there isn't — an
  // unconditional insert on an already-covered date would hit fiscal_periods_no_overlap
  // (migration 502).
  await ensureOpenPeriod(changedTargetStr);
  // Specifically the binding-mismatch refusal (assertApprovalExecutable in approvalExecutionService.ts),
  // not any refusal a changed date could trigger for an unrelated reason (a closed/missing period).
  let refusal: unknown;
  try {
    await actor('u1', ctx => executeControlledOperation(ctx,
      { ...ref, reversalDate: changedTargetStr } as OperationRef, id, callback));
  } catch (error) { refusal = error; }
  expect(refusal).toBeInstanceOf(SuppliedApprovalRefusal);
  expect(refusal).toMatchObject({ message: 'Approval material changed' });
  expect(callback).not.toHaveBeenCalled();
  await actor('u1', () => voidSupplierPayment(fixture.companyA, doc.payment, fixture.u1.id, { approvalId: id }));
  const contra = await pool.query('SELECT entry_date::text FROM gl_journal_entries WHERE company_id=$1 AND reversal_of_id=$2', [fixture.companyA, processed.glJournalEntryId]);
  expect(contra.rows).toEqual([{ entry_date: today }]);
});
it('cancels a closed-period invoice preserving its original journal and replays one committed cancellation', async () => {
  const originalPeriod = randomUUID(), doc = await document();
  await pool.query(`INSERT INTO fiscal_periods(id,company_id,period_name,period_number,fiscal_year,start_date,end_date,status)
    VALUES($1,$2,'Synthetic July',7,2026,'2026-07-01','2026-07-31','open')`, [originalPeriod, fixture.companyA]);
  await pool.query("UPDATE supplier_invoices SET invoice_date='2026-07-15' WHERE company_id=$1 AND id=$2", [fixture.companyA, doc.invoice]);
  const postId = await approval(invoiceRef(doc.invoice));
  const posted = await actor('u1', () => approveSupplierInvoice(fixture.companyA, doc.invoice, fixture.u1.id, { approvalId: postId }));
  await pool.query("UPDATE fiscal_periods SET status='closed' WHERE company_id=$1 AND id=$2", [fixture.companyA, originalPeriod]);
  const ref: OperationRef = { ...invoiceRef(doc.invoice), operation: 'supplier_invoice.cancel' };
  const id = await approval(ref);
  const response = await route(invoiceRoute, { action: 'cancel', invoiceId: doc.invoice, approvalId: id }, '/api/accounting/supplier-invoices-action');
  expect(response.status).toBe(200);
  expect(response.body.data).toMatchObject({ status: 'cancelled', glJournalEntryId: posted.glJournalEntryId });
  const replay = await actor('u1', () => cancelSupplierInvoice(fixture.companyA, doc.invoice, fixture.u1.id, { approvalId: id }));
  expect(replay).toEqual(response.body.data);
  const today = (await pool.query("SELECT (clock_timestamp() AT TIME ZONE 'Africa/Johannesburg')::date::text AS day")).rows[0].day;
  const contra = await pool.query('SELECT entry_date::text FROM gl_journal_entries WHERE company_id=$1 AND reversal_of_id=$2', [fixture.companyA, posted.glJournalEntryId]);
  expect(contra.rows).toEqual([{ entry_date: today }]);
  const stored = await pool.query('SELECT status,gl_journal_entry_id FROM supplier_invoices WHERE company_id=$1 AND id=$2', [fixture.companyA, doc.invoice]);
  expect(stored.rows).toEqual([{ status: 'cancelled', gl_journal_entry_id: posted.glJournalEntryId }]);
});
it.each(['invoice', 'payment'])('refuses %s currency without a bound ledger conversion', async kind => {
  const doc = await document();
  await pool.query("UPDATE supplier_invoices SET currency='USD' WHERE company_id=$1 AND id=$2", [fixture.companyA, doc.invoice]);
  const ref = kind === 'invoice' ? invoiceRef(doc.invoice) : paymentRef(doc.payment);
  await expect(approval(ref)).rejects.toThrow('currency');
  expect((await pool.query('SELECT id FROM gl_journal_entries WHERE company_id=$1 AND source_record_id=$2', [fixture.companyA, ref.entityId])).rows).toHaveLength(0);
});
it('refuses a changed ledger currency after approval before posting the nominal amount', async () => {
  const doc = await document(), id = await approval(invoiceRef(doc.invoice));
  try {
    await pool.query("UPDATE companies SET default_currency='USD' WHERE id=$1", [fixture.companyA]);
    await expect(actor('u1', () => approveSupplierInvoice(fixture.companyA, doc.invoice, fixture.u1.id, { approvalId: id }))).rejects.toThrow();
    expect((await pool.query('SELECT id FROM gl_journal_entries WHERE company_id=$1 AND source_record_id=$2', [fixture.companyA, doc.invoice])).rows).toHaveLength(0);
  } finally { await pool.query("UPDATE companies SET default_currency='ZAR' WHERE id=$1", [fixture.companyA]); }
});
