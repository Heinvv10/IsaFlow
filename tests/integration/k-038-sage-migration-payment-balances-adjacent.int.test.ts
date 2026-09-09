/**
 * K-038 adjacent cases — the Sage migration must carry the source's already
 * settled amount onto BOTH subledgers, derive the status from it, and leave
 * everything else exactly as it was.
 *
 * AR mocks postCustomerInvoiceToGL for the same reason the RED test does: GL
 * posting is not part of this claim. AP runs the real posting path, so the
 * journal it writes is asserted balanced and equal to the invoice total —
 * the fix must not move the control account.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';

assertDisposable();

vi.mock('@/modules/accounting/services/ar/customerPaymentAllocationService', () => ({
  postCustomerInvoiceToGL: vi.fn(async () => undefined),
}));

const { commitARInvoice, commitAPInvoice } = await import('@/modules/admin/services/sageMigrationCommitService');
const { mapSageARInvoices, mapSageAPInvoices } = await import('@/modules/accounting/services/core/sageAutoImportService');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companyId = randomUUID();
const otherCompanyId = randomUUID();
const userId = randomUUID();
const tag = companyId.slice(0, 8);

const arSource = (num: string, total: number, amountDue: number) => ({
  ID: 1, CustomerId: 1, Customer: { Name: 'K-038 Customer' },
  DocumentNumber: num, Reference: num,
  Date: '2026-03-01T00:00:00', DueDate: '2026-03-31T00:00:00',
  Exclusive: Math.round((total / 1.15) * 100) / 100,
  Tax: Math.round((total - total / 1.15) * 100) / 100,
  Total: total, AmountDue: amountDue, Status: 'x',
});

const apSource = (num: string, total: number, amountDue: number) => ({
  ID: 1, SupplierId: 1, Supplier: { Name: 'K-038 Supplier' },
  DocumentNumber: num, Reference: num,
  Date: '2026-03-01T00:00:00', DueDate: '2026-03-31T00:00:00',
  Exclusive: Math.round((total / 1.15) * 100) / 100,
  Tax: Math.round((total - total / 1.15) * 100) / 100,
  Total: total, AmountDue: amountDue, Status: 'x',
});

async function arRow(id: string) {
  const { rows } = await pool.query(
    'SELECT total_amount, amount_paid, balance, status, paid_at FROM customer_invoices WHERE id=$1', [id]);
  return rows[0]!;
}

async function apRow(id: string) {
  const { rows } = await pool.query(
    'SELECT total_amount, amount_paid, balance, status, paid_at, payment_matched, gl_journal_entry_id FROM supplier_invoices WHERE id=$1', [id]);
  return rows[0]!;
}

beforeAll(async () => {
  for (const id of [companyId, otherCompanyId]) {
    await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [id, `K-038 adj ${id.slice(0, 8)}`]);
  }
  await pool.query(
    "INSERT INTO users(id,email,role,is_active,account_type) VALUES($1,$2,'admin',true,'direct')",
    [userId, `${userId}@k038adj.test.local`]);
  for (const id of [companyId, otherCompanyId]) {
    await pool.query('INSERT INTO customers(company_id,name,is_active) VALUES($1,$2,TRUE)', [id, 'K-038 Customer']);
    await pool.query('INSERT INTO suppliers(company_id,name,is_active) VALUES($1,$2,TRUE)', [id, 'K-038 Supplier']);
    await pool.query(
      `INSERT INTO gl_accounts(company_id,account_code,account_name,account_type,account_subtype,normal_balance,is_active,is_system_account)
       VALUES ($1,'2100','K038 AP','liability','payable','credit',true,true),
              ($1,'2200','K038 VAT Input','asset','vat_input','debit',true,true),
              ($1,'6000','K038 Expense','expense','default_expense','debit',true,true)`, [id]);
  }
});

afterAll(async () => {
  for (const id of [companyId, otherCompanyId]) {
    await pool.query('DELETE FROM customer_invoice_items WHERE invoice_id IN (SELECT id FROM customer_invoices WHERE company_id=$1)', [id]);
    await pool.query('DELETE FROM customer_invoices WHERE company_id=$1', [id]);
    await pool.query('UPDATE supplier_invoices SET gl_journal_entry_id=NULL WHERE company_id=$1', [id]);
    await pool.query('DELETE FROM supplier_invoice_items WHERE supplier_invoice_id IN (SELECT id FROM supplier_invoices WHERE company_id=$1)', [id]);
    await pool.query('DELETE FROM supplier_invoices WHERE company_id=$1', [id]);
    await pool.query('DELETE FROM gl_journal_lines WHERE company_id=$1', [id]);
    await pool.query('DELETE FROM gl_journal_entries WHERE company_id=$1', [id]);
    await pool.query('DELETE FROM gl_account_balances WHERE gl_account_id IN (SELECT id FROM gl_accounts WHERE company_id=$1)', [id]);
    await pool.query('DELETE FROM gl_accounts WHERE company_id=$1', [id]);
    await pool.query('DELETE FROM fiscal_periods WHERE company_id=$1', [id]);
    await pool.query('DELETE FROM customers WHERE company_id=$1', [id]);
    await pool.query('DELETE FROM suppliers WHERE company_id=$1', [id]);
    await pool.query('DELETE FROM companies WHERE id=$1', [id]);
  }
  await pool.query('DELETE FROM users WHERE id=$1', [userId]);
  await pool.end();
}, 60000);

describe('K-038 adjacent — AR', () => {
  it('a fully settled source invoice lands paid with a zero balance', async () => {
    const [m] = mapSageARInvoices([arSource(`${tag}-AR-FULL`, 1150, 0)]);
    const { invoiceId } = await commitARInvoice(companyId, userId, m as never);
    const row = await arRow(invoiceId);
    expect(Number(row.amount_paid)).toBe(1150);
    expect(Number(row.balance)).toBe(0);
    expect(row.status).toBe('paid');
    expect(row.paid_at).not.toBeNull();
  });

  it('an unsettled source invoice is unchanged — approved, nothing paid', async () => {
    const [m] = mapSageARInvoices([arSource(`${tag}-AR-OPEN`, 1150, 1150)]);
    const { invoiceId } = await commitARInvoice(companyId, userId, m as never);
    const row = await arRow(invoiceId);
    expect(Number(row.amount_paid)).toBe(0);
    expect(Number(row.balance)).toBe(1150);
    expect(row.status).toBe('approved');
    expect(row.paid_at).toBeNull();
  });

  it('an overpaid source (AmountDue negative) clamps at the total and REPORTS the discarded credit', async () => {
    const [m] = mapSageARInvoices([arSource(`${tag}-AR-OVER`, 1150, -200)]);
    expect(m!.amountPaid).toBe(1350);
    const { invoiceId, warning } = await commitARInvoice(companyId, userId, m as never);
    const row = await arRow(invoiceId);
    expect(Number(row.amount_paid)).toBe(1150);
    expect(Number(row.balance)).toBe(0);
    expect(row.status).toBe('paid');
    // The R200 credit leaves no other trace, so the operator must be told.
    expect(warning).toContain('200');
    expect(warning).toContain(`${tag}-AR-OVER`);
  });

  it('a non-numeric source paid amount is refused, never written as NaN', async () => {
    // AmountDue absent is the real shape: `Total - undefined` is NaN, `numeric`
    // ACCEPTS NaN, and one NaN balance turns the company's whole sub-ledger sum
    // into NaN. Must import as unpaid, with a warning.
    const src = { ...arSource(`${tag}-AR-NAN`, 1150, 0) } as Record<string, unknown>;
    delete src.AmountDue;
    const [m] = mapSageARInvoices([src as never]);
    expect(Number.isNaN(m!.amountPaid)).toBe(true);

    const { invoiceId, warning } = await commitARInvoice(companyId, userId, m as never);
    const row = await arRow(invoiceId);
    expect(Number(row.amount_paid)).toBe(0);
    expect(Number(row.balance)).toBe(1150);
    expect(Number.isNaN(Number(row.balance))).toBe(false);
    expect(row.status).toBe('approved');
    expect(warning).toContain('finite');

    // And the company's sub-ledger sum stays a number.
    const { rows } = await pool.query(
      'SELECT SUM(balance) AS s FROM customer_invoices WHERE company_id=$1', [companyId]);
    expect(Number.isNaN(Number(rows[0]!.s))).toBe(false);
  });

  it('a negative source paid amount is refused, not stored as a balance above the total', async () => {
    const [m] = mapSageARInvoices([arSource(`${tag}-AR-NEG`, 1000, 1400)]);
    expect(m!.amountPaid).toBe(-400);
    const { invoiceId, warning } = await commitARInvoice(companyId, userId, m as never);
    const row = await arRow(invoiceId);
    expect(Number(row.amount_paid)).toBe(0);
    expect(Number(row.balance)).toBe(1000);
    expect(warning).toContain('negative');
  });

  it('writes into the named company only — the second tenant sees nothing', async () => {
    const [m] = mapSageARInvoices([arSource(`${tag}-AR-TENANT`, 500, 100)]);
    await commitARInvoice(companyId, userId, m as never);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM customer_invoices WHERE company_id=$1', [otherCompanyId]);
    expect(rows[0]!.n).toBe(0);
  });

  it('a re-run of the same invoice number neither duplicates nor re-settles', async () => {
    const [m] = mapSageARInvoices([arSource(`${tag}-AR-RERUN`, 1150, 500)]);
    const first = await commitARInvoice(companyId, userId, m as never);
    const second = await commitARInvoice(companyId, userId, m as never);
    expect(second.created).toBe(false);
    expect(second.invoiceId).toBe(first.invoiceId);
    const row = await arRow(first.invoiceId);
    expect(Number(row.amount_paid)).toBe(650);
    expect(Number(row.balance)).toBe(500);
    expect(row.status).toBe('partially_paid');
  });
});

describe('K-038 adjacent — AP', () => {
  it('a part-settled bill carries amount_paid and still posts one balanced journal for the FULL total', async () => {
    const [m] = mapSageAPInvoices([apSource(`${tag}-AP-PART`, 1150, 500)]);
    expect(m!.amountPaid).toBe(650);
    const { invoiceId } = await commitAPInvoice(companyId, userId, m as never);
    const row = await apRow(invoiceId);
    expect(Number(row.amount_paid)).toBe(650);
    expect(Number(row.balance)).toBe(500);
    expect(row.status).toBe('partially_paid');
    expect(row.payment_matched).toBe(false);

    // The journal is untouched by the fix: still the full invoice, still balanced.
    const { rows: lines } = await pool.query(
      'SELECT COALESCE(SUM(debit),0) AS d, COALESCE(SUM(credit),0) AS c FROM gl_journal_lines WHERE journal_entry_id=$1',
      [row.gl_journal_entry_id]);
    expect(Number(lines[0]!.d)).toBeCloseTo(Number(lines[0]!.c), 2);
    expect(Number(lines[0]!.c)).toBeCloseTo(Number(row.total_amount), 2);
  });

  it('a fully settled bill at a NON-ROUND blended VAT rate still lands paid, never a negative balance', async () => {
    // createSupplierInvoice recomputes total_amount from a 2 dp tax rate, so a
    // bill whose effective rate is not exact stores a total that differs from
    // Sage's by cents. Clamping to the SOURCE total would store -0.01 here.
    const [m] = mapSageAPInvoices([{
      ID: 1, SupplierId: 1, Supplier: { Name: 'K-038 Supplier' },
      DocumentNumber: `${tag}-AP-ODD`, Reference: `${tag}-AP-ODD`,
      Date: '2026-03-01T00:00:00', DueDate: '2026-03-31T00:00:00',
      Exclusive: 700, Tax: 33.33, Total: 733.33, AmountDue: 0, Status: 'x',
    } as never]);
    const { invoiceId, warning } = await commitAPInvoice(companyId, userId, m as never);
    const row = await apRow(invoiceId);
    // The stored total is the recomputed one, not Sage's 733.33.
    expect(Number(row.total_amount)).toBe(733.32);
    expect(Number(row.amount_paid)).toBe(733.32);
    expect(Number(row.balance)).toBe(0);
    expect(Number(row.balance)).toBeGreaterThanOrEqual(0);
    expect(row.status).toBe('paid');
    expect(row.payment_matched).toBe(true);
    // The missing cent is IsaFlow's own recompute, not a discarded credit.
    expect(warning).toBeUndefined();
  });

  it('a fully settled bill whose RECOMPUTED total lands ABOVE Sage\'s leaves no phantom residual', async () => {
    // The mirror of AP-ODD and the case a clamp cannot reach: it only binds
    // when the paid amount exceeds the total. 812.50 / 58.40 gives a 7.19%
    // rate that recomputes to 870.92 against Sage's 870.90, so carrying the
    // source's paid amount across would strand this settled bill at
    // partially_paid with an 0.02 residual in AP aging forever.
    const [m] = mapSageAPInvoices([{
      ID: 1, SupplierId: 1, Supplier: { Name: 'K-038 Supplier' },
      DocumentNumber: `${tag}-AP-ODD2`, Reference: `${tag}-AP-ODD2`,
      Date: '2026-03-01T00:00:00', DueDate: '2026-03-31T00:00:00',
      Exclusive: 812.50, Tax: 58.40, Total: 870.90, AmountDue: 0, Status: 'x',
    } as never]);
    const { invoiceId, warning } = await commitAPInvoice(companyId, userId, m as never);
    const row = await apRow(invoiceId);
    expect(Number(row.total_amount)).toBe(870.92);
    expect(Number(row.amount_paid)).toBe(870.92);
    expect(Number(row.balance)).toBe(0);
    expect(row.status).toBe('paid');
    expect(row.payment_matched).toBe(true);
    // Sub-cent recompute dust is not a customer credit.
    expect(warning).toBeUndefined();
  });

  it('a part-settled bill at a non-round rate keeps exactly the source outstanding amount', async () => {
    const [m] = mapSageAPInvoices([{
      ID: 1, SupplierId: 1, Supplier: { Name: 'K-038 Supplier' },
      DocumentNumber: `${tag}-AP-ODD3`, Reference: `${tag}-AP-ODD3`,
      Date: '2026-03-01T00:00:00', DueDate: '2026-03-31T00:00:00',
      Exclusive: 9999.99, Tax: 1234.56, Total: 11234.55, AmountDue: 200, Status: 'x',
    } as never]);
    const { invoiceId } = await commitAPInvoice(companyId, userId, m as never);
    const row = await apRow(invoiceId);
    // Whatever the recomputed total came to, R200 is what is still owed.
    expect(Number(row.balance)).toBe(200);
    expect(Number(row.amount_paid)).toBeCloseTo(Number(row.total_amount) - 200, 2);
    expect(row.status).toBe('partially_paid');
  });

  it('a genuine AP overpayment is still clamped AND reported', async () => {
    const [m] = mapSageAPInvoices([apSource(`${tag}-AP-OVER`, 1150, -200)]);
    const { invoiceId, warning } = await commitAPInvoice(companyId, userId, m as never);
    const row = await apRow(invoiceId);
    expect(Number(row.amount_paid)).toBe(Number(row.total_amount));
    expect(Number(row.balance)).toBe(0);
    expect(warning).toContain('200');
    expect(warning).toContain(`${tag}-AP-OVER`);
  });

  it('a fully settled bill lands paid, matched, zero balance', async () => {
    const [m] = mapSageAPInvoices([apSource(`${tag}-AP-FULL`, 1150, 0)]);
    const { invoiceId } = await commitAPInvoice(companyId, userId, m as never);
    const row = await apRow(invoiceId);
    expect(Number(row.amount_paid)).toBe(1150);
    expect(Number(row.balance)).toBe(0);
    expect(row.status).toBe('paid');
    expect(row.payment_matched).toBe(true);
    expect(row.paid_at).not.toBeNull();
  });

  it('an unsettled bill is unchanged — approved, nothing paid', async () => {
    const [m] = mapSageAPInvoices([apSource(`${tag}-AP-OPEN`, 1150, 1150)]);
    const { invoiceId } = await commitAPInvoice(companyId, userId, m as never);
    const row = await apRow(invoiceId);
    expect(Number(row.amount_paid)).toBe(0);
    expect(Number(row.balance)).toBe(1150);
    expect(row.status).toBe('approved');
    expect(row.payment_matched).toBe(false);
  });
});
