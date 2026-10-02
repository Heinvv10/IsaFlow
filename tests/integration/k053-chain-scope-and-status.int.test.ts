/**
 * D7 round 3 (blind review rev-d7, LOW 4) — the chain walks read ONE tenant's
 * POSTED entries, and a test fails when either half of that is dropped.
 *
 * Three mutations survived the review: the `company_id` scope of the walk, the
 * `company_id` scope of the deleted-document set it is checked against, and
 * the walk's `status = 'posted'`. Natural data never links two tenants (UUID
 * ids, one UNIQUE per company), so these cases forge the links a bug, an
 * import or a hand edit would have to make:
 *
 *   T1  tenant B's DELETED invoice is forged to point at tenant A's journal O,
 *       which A has reversed by hand (M). A's figures must not move — M is not
 *       "a link of a deleted document's chain" because the document is B's —
 *       and B's sub-ledger must not adopt A's O as its own standing journal.
 *   T2  a DRAFT reversal never counts: not as the reversal of a live
 *       invoice's journal (VAT201), not as a link of a deleted one (parity).
 *   T3  a deleted invoice linked to a DRAFT journal has nothing standing.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { sql } from '@/lib/neon';
import { getVatReconciliation } from '@/modules/accounting/services/reports/vatReconciliationService';
import { findUnpostedInvoiceVat } from '@/modules/accounting/services/reports/vatUnpostedInvoices';
import { reconcileSubledger } from '@/modules/accounting/services/reconciliation/subledgerReconciliationService';
import { getARAging } from '@/modules/accounting/services/ar/arAgingService';
import { softDelete } from '@/modules/accounting/services/core/softDeleteService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { type Co, makeCompany, cleanup, inTx, arInvoice, journalOf, reverseTip } from './k053-chain.helpers';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;
const JULY_END = '2026-07-31';

async function agedAR(co: Co): Promise<number> {
  return (await getARAging(co.id, JULY_END)).find((b) => b.entityId === co.customer)?.total ?? 0;
}

/** A DRAFT entry dated in July, optionally forged to reverse `reverses`. */
async function draftEntry(co: Co, reverses: string | null): Promise<string> {
  const id = randomUUID();
  await sql`
    INSERT INTO gl_journal_entries (id, company_id, entry_number, entry_date, description,
      status, source, created_by, reversal_of_id)
    VALUES (${id}::UUID, ${co.id}::UUID, ${'DRAFT-' + id.slice(0, 8)}, '2026-07-20'::date,
      ${'D7 draft ' + co.tag}, 'draft', 'manual', ${co.user}::UUID, ${reverses}::UUID)`;
  return id;
}

/** An approved July invoice of `gross`, soft-deleted by setting deleted_at, linked to `journal`. */
async function deletedInvoiceLinkedTo(co: Co, suffix: string, journal: string, sub: number, vat: number): Promise<void> {
  await sql`
    INSERT INTO customer_invoices (company_id, client_id, customer_id, invoice_number, invoice_date,
      due_date, status, subtotal, tax_rate, tax_amount, total_amount, amount_paid, created_by,
      gl_journal_entry_id, deleted_at)
    VALUES (${co.id}::UUID, ${co.customer}::UUID, ${co.customer}::UUID, ${co.tag + suffix}, '2026-07-12'::date,
      '2026-07-12'::date, 'approved', ${sub}, 15, ${vat}, ${sub + vat}, 0, ${co.user}::UUID,
      ${journal}::UUID, NOW())`;
}

describeIfDb('D7 chain walks: one tenant, posted entries only', () => {
  const cos: Co[] = [];
  beforeAll(() => { assertDisposable(); });
  afterAll(async () => { for (const c of cos) await cleanup(c); }, 120000);

  it('T1: a deleted invoice in another tenant pointing at this tenant\'s journal moves neither side', async () => {
    const a = await makeCompany('D7T1A'); cos.push(a);
    const b = await makeCompany('D7T1B'); cos.push(b);
    const oA = await journalOf(a, await arInvoice(a, '-live', '2026-07-10', 1000, 150));
    const mA = await reverseTip(a, oA, '2026-07-20');
    const snapshot = async () => JSON.stringify([
      (await reconcileSubledger(a.id, 'ar', JULY_END)).reconcilingItems,
      (await getVatReconciliation(a.id, '2026-07-01', JULY_END)).months,
    ]);
    const before = await snapshot();
    // The premise: A's hand reversal is a reconciling item and a revenue variance.
    expect(before).toContain(mA);
    expect(before).toContain('"revenueVariance":-1000');

    await deletedInvoiceLinkedTo(b, '-forged', oA, 400, 60);
    expect(await snapshot()).toBe(before);
    // B's chain walk must not start from A's entry: nothing of B's stands.
    expect(await agedAR(b)).toBe(0);
  }, 120000);

  it('T2: a draft reversal counts neither as reversing a live journal nor as a link of a deleted one', async () => {
    const co = await makeCompany('D7T2'); cos.push(co);
    const live = await journalOf(co, await arInvoice(co, '-live', '2026-07-10', 1000, 150));
    await draftEntry(co, live);
    expect(await findUnpostedInvoiceVat(co.id, '2026-07-01', JULY_END)).toEqual([]);

    const del = await arInvoice(co, '-del', '2026-07-12', 400, 60);
    const o = await journalOf(co, del);
    await inTx(co, () => softDelete(co.id, 'customer_invoice', del, co.user));
    const r = ((await sql`SELECT id FROM gl_journal_entries
      WHERE company_id = ${co.id}::UUID AND reversal_of_id = ${o}::UUID`) as { id: string }[])[0]!.id;
    await draftEntry(co, r);
    // O and R stand, the draft does not: the deleted invoice is out, the live one in.
    expect(await agedAR(co)).toBe(1150);
  }, 120000);

  it('T3: a deleted invoice whose journal is only a draft has nothing standing', async () => {
    const co = await makeCompany('D7T3'); cos.push(co);
    await deletedInvoiceLinkedTo(co, '-draftjournal', await draftEntry(co, null), 400, 60);
    expect(await agedAR(co)).toBe(0);
  }, 60000);
});
