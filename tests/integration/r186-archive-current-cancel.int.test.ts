/**
 * R-186 review round 2: the CURRENT cancel shape, built by the real services. An approved invoice
 * is posted to the GL (`postCustomerInvoiceToGL`), a Paystack checkout is opened on it, and it is
 * cancelled (`cancelCustomerInvoice`). The cancel reverses the journal (the original stays
 * 'posted' with `reversed_at`, the reversal is 'posted' with `reversal_of_id`, both on the invoice
 * date) and NULLs `gl_journal_entry_id`. The archive skips the invoice (the request references
 * it). Nothing links the invoice to either journal any more, so there is nothing to refuse: the
 * run completes, both journals move, and the live invoice has no dangling pointer.
 * The 'reversed'-status shapes in r186-archive-skipped-closure are the LEGACY cancel.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { sql } from '@/lib/neon';
import { postCustomerInvoiceToGL } from '@/modules/accounting/services/ar/customerPaymentAllocationService';
import { cancelCustomerInvoice } from '@/modules/accounting/services/ar/customerInvoiceCancelService';
import { executeArchive } from '@/modules/accounting/services/core/archiveExecutionService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { dropFixture, inTx, seedFixture, type Fixture } from './helpers/l1FifoFixture';

assertDisposable();
type Row = Record<string, unknown>;
let fx: Fixture;
const CUTOFF = '2027-01-01';

async function approvedInvoice(): Promise<string> {
  const [i] = (await sql`
    INSERT INTO customer_invoices (company_id, customer_id, client_id, invoice_number, invoice_date, due_date,
      status, subtotal, tax_rate, tax_amount, total_amount, amount_paid, created_by)
    VALUES (${fx.companyId}::UUID, ${fx.customerId}::UUID, ${fx.customerId}::UUID, ${`R186C-${randomUUID().slice(0, 8)}`},
      '2026-05-10', '2026-06-10', 'approved', 1000, 15, 150, 1150, 0, ${fx.userId}::UUID)
    RETURNING id`) as Row[];
  return String(i!.id);
}

beforeAll(async () => {
  fx = await seedFixture('R186C', process.env.DATABASE_URL!);
  // archive_runs.run_by references users; the fixture has no users row.
  await sql`INSERT INTO users (id, email, role, is_active) VALUES (${fx.userId}, ${`${fx.userId}@r186.test`}, 'admin', true)`;
  await sql`
    INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype, normal_balance, is_active, is_system_account)
    VALUES (${fx.companyId}::UUID, '4000', ${`Sales ${fx.tag}`}, 'revenue', 'default_revenue', 'credit', true, true)`;
}, 120000);

afterAll(async () => {
  if (!fx) return;
  const c = fx.companyId;
  await sql`DELETE FROM archive_gl_journal_lines WHERE journal_entry_id IN (SELECT id FROM archive_gl_journal_entries WHERE company_id = ${c}::UUID)`;
  for (const t of ['archive_gl_journal_entries', 'archive_customer_invoices', 'archive_runs', 'audit_log', 'paystack_payment_requests']) {
    await sql.query(`DELETE FROM ${t} WHERE company_id = $1::uuid`, [c]);
  }
  await sql`UPDATE gl_journal_entries SET reversal_of_id = NULL WHERE company_id = ${c}::UUID`;
  await dropFixture(fx);
  await sql`DELETE FROM users WHERE id = ${fx.userId}`;
}, 120000);

describe('R-186: a skipped invoice cancelled by the current cancel service', () => {
  it('completes: both journals move, the live invoice points at nothing', async () => {
    const skipped = await approvedInvoice();
    await inTx(fx, () => postCustomerInvoiceToGL(fx.companyId, skipped, fx.userId));
    const original = String(((await sql`SELECT gl_journal_entry_id FROM customer_invoices WHERE id = ${skipped}::UUID`) as Row[])[0]!.gl_journal_entry_id);
    await sql`
      INSERT INTO paystack_payment_requests (company_id, purpose, customer_invoice_id, paystack_reference, amount_cents, status)
      VALUES (${fx.companyId}::UUID, 'customer_invoice', ${skipped}::UUID, ${`r186c-${randomUUID()}`}, 115000, 'abandoned')`;
    const { reversedJournalEntryId: reversal } = await inTx(fx, () => cancelCustomerInvoice(fx.companyId, skipped, fx.userId));
    const free = await approvedInvoice();
    await inTx(fx, () => cancelCustomerInvoice(fx.companyId, free, fx.userId));

    // The shape the cancel leaves, so the archive assertions below are about it.
    expect((await sql`SELECT status, gl_journal_entry_id FROM customer_invoices WHERE id = ${skipped}::UUID`) as Row[])
      .toEqual([{ status: 'cancelled', gl_journal_entry_id: null }]);
    const chain = (await sql`
      SELECT id, status, reversal_of_id, reversed_at IS NOT NULL AS stamped, entry_date::text AS d
      FROM gl_journal_entries WHERE company_id = ${fx.companyId}::UUID ORDER BY reversal_of_id NULLS FIRST`) as Row[];
    expect(chain).toEqual([
      { id: original, status: 'posted', reversal_of_id: null, stamped: true, d: '2026-05-10' },
      { id: reversal, status: 'posted', reversal_of_id: original, stamped: false, d: '2026-05-10' },
    ]);

    const result = await inTx(fx, () => executeArchive(fx.companyId, CUTOFF, fx.userId));

    expect(result.invoicesSkipped).toBe(1);
    expect(result.invoicesArchived).toBe(1);
    expect(result.entriesArchived).toBe(2);
    expect((await sql`SELECT id FROM gl_journal_entries WHERE company_id = ${fx.companyId}::UUID`) as Row[]).toEqual([]);
    const moved = ((await sql`SELECT id FROM archive_gl_journal_entries WHERE company_id = ${fx.companyId}::UUID`) as Row[])
      .map((r) => r.id).sort();
    expect(moved).toEqual([original, reversal].sort());
    expect((await sql`SELECT id, gl_journal_entry_id FROM customer_invoices WHERE company_id = ${fx.companyId}::UUID`) as Row[])
      .toEqual([{ id: skipped, gl_journal_entry_id: null }]);
  }, 120000);
});
