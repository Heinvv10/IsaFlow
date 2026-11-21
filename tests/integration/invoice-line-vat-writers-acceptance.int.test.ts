/**
 * ACCEPTANCE of the per-line VAT writers, end to end through the real handlers: an invoice of 1000 standard + 300
 * zero_rated + 200 exempt created over HTTP (customer-invoices-create) stores each line's net, VAT, type and rate and a
 * 1500 / 150 / 1650 header at 15%; approved, it posts DR AR 1650, CR revenue 1000 / 300 / 200 each on its type, CR VAT
 * 150 standard; the PDF model prints those figures; the VAT201 reads fields 1 / 2 / 3 / output VAT = 1000 / 300 / 200 /
 * 150 and the period passes the lock gate unforced (filing rate check ties, no blocking exception). A credit note for
 * 150 created over HTTP (credit-notes POST) with NO VAT given carries 15.00 (the invoice's remaining VAT in proportion,
 * not 22.50 at 15% on its subtotal), approves, and the fields read 900 / 270 / 180 / 135.
 *
 * Disposable databases only.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { sql } from '@/lib/neon';
import customerInvoicesCreate from '../../pages/api/accounting/customer-invoices-create';
import creditNotesRoute from '../../pages/api/accounting/credit-notes';
import { approveCustomerInvoice } from '@/modules/accounting/services/ar/customerInvoiceApprovalService';
import { approveCreditNote } from '@/modules/accounting/services/ar/creditNoteApproveService';
import { loadInvoicePdfModel } from '@/modules/accounting/services/ar/invoicePdfModel';
import { getVat201Return } from '@/modules/accounting/services/reports/vat201Return';
import { computeVatLockFigures } from '@/modules/accounting/services/reports/vatPeriodLockFigures';
import { getNilRatedSupplies } from '@/modules/accounting/services/reports/vat201NilRatedSupplies';
import { rateCheckForFiling } from '@/modules/accounting/services/reports/vat201RateCheck';
import { assertVatGateClear } from '@/modules/accounting/services/reports/vatGateOverrideService';
import { isDisposableDb } from '../helpers/assertDisposableDb';
import { inTx } from './helpers/l1FifoFixture';
import { dropLineRevenue, seedLineRevenue, type LineRevenueFixture } from './helpers/lineRevenueFixture';
import { journalLegs, L } from './helpers/lineVatFixture';
import { callRoute, createUser } from './r035-approval.helpers';

vi.mock('@/modules/accounting/services/ar/invoicePdfSnapshotService', () => ({
  snapshotInvoicePdf: vi.fn(async () => ({ documentId: null, wasExisting: false })),
}));

const describeIfDisposable = isDisposableDb() ? describe : describe.skip;
let f: LineRevenueFixture;
let pool: Pool;
const tokens: Record<string, string> = {};
let user = '';
const SEP: [string, string] = ['2026-09-01', '2026-09-30'];

type Res = Awaited<ReturnType<typeof callRoute>>;
const data = <T>(r: Res) => (r.state.body as { data: T }).data;
const fields = async () => {
  const v = await inTx(f.fx, () => getVat201Return(f.fx.companyId, ...SEP));
  return [v.field1_standardRatedSupplies, v.field2_zeroRatedSupplies, v.field3_exemptSupplies, v.field5_outputVAT];
};
/** The lock route's own checks, unforced: the filing rate check ties and no blocking VAT exception stands. */
const lockGate = () => inTx(f.fx, async () => {
  const { report } = await computeVatLockFigures(f.fx.companyId, ...SEP);
  const filing = rateCheckForFiling(report, await getNilRatedSupplies(f.fx.companyId, ...SEP));
  const gate = await assertVatGateClear(f.fx.companyId, ...SEP, 'vat_period_lock', null, { userId: user, role: 'owner' }, undefined);
  return { ties: filing.ties, overridden: gate.overridden, exceptions: gate.counts.totalExceptions };
});

describeIfDisposable('per-line VAT writers: acceptance', () => {
  beforeAll(async () => {
    f = await seedLineRevenue(process.env.DATABASE_URL!);
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    user = await createUser(pool, tokens);
    await pool.query('INSERT INTO company_users(company_id, user_id, role) VALUES($1, $2, $3)', [f.fx.companyId, user, 'owner']);
  }, 60_000);
  afterAll(async () => {
    if (!f) return;
    await sql`DELETE FROM credit_note_revenue_allocations WHERE company_id = ${f.fx.companyId}::UUID`;
    await sql`DELETE FROM audit_log WHERE company_id = ${f.fx.companyId}::UUID`;
    await pool.query('DELETE FROM company_users WHERE user_id = $1', [user]);
    await dropLineRevenue(f);
    await pool.query('DELETE FROM users WHERE id = $1', [user]);
    await pool.end();
  });

  it('1000 standard + 300 zero_rated + 200 exempt, through create, approve, the PDF, the VAT201 and a credit note with no VAT given', async () => {
    const made = await callRoute(customerInvoicesCreate, tokens[user]!, f.fx.companyId, 'POST', {
      clientId: f.fx.customerId, invoiceDate: '2026-09-10', items: [
        { description: 'Standard', quantity: 1, unitPrice: 1000, vatType: 'standard' },
        { description: 'Zero', quantity: 1, unitPrice: 300, vatType: 'zero_rated' },
        { description: 'Exempt', quantity: 1, unitPrice: 200, vatType: 'exempt' },
      ] }, '/api/accounting/customer-invoices-create');
    expect(made.state.statusCode, JSON.stringify(made.state.body)).toBe(201);
    const id = data<{ id: string }>(made).id;

    expect(await sql`SELECT description, amount::FLOAT8 AS amount, tax_amount::FLOAT8 AS tax, vat_type, tax_rate::FLOAT8 AS rate
                     FROM customer_invoice_items WHERE invoice_id = ${id}::UUID ORDER BY line_position`).toEqual([
      { description: 'Standard', amount: 1000, tax: 150, vat_type: 'standard', rate: 15 },
      { description: 'Zero', amount: 300, tax: 0, vat_type: 'zero_rated', rate: 0 },
      { description: 'Exempt', amount: 200, tax: 0, vat_type: 'exempt', rate: 0 },
    ]);
    expect(await sql`SELECT subtotal::FLOAT8 AS subtotal, tax_amount::FLOAT8 AS tax, total_amount::FLOAT8 AS total, tax_rate::FLOAT8 AS rate
                     FROM customer_invoices WHERE id = ${id}::UUID`).toEqual([{ subtotal: 1500, tax: 150, total: 1650, rate: 15 }]);

    const { glJournalEntryId } = await inTx(f.fx, () => approveCustomerInvoice(f.fx.companyId, id, f.fx.userId));
    expect(await journalLegs(f, glJournalEntryId!)).toEqual([
      L('1100', 1650, 0), L('2120', 0, 150, { vat: 'standard' }),
      L('4000', 0, 200, { vat: 'exempt' }), L('4000', 0, 300, { vat: 'zero_rated' }), L('4000', 0, 1000, { vat: 'standard' }),
    ]);

    const pdf = (await inTx(f.fx, () => loadInvoicePdfModel(f.fx.companyId, id)))!;
    expect([Number(pdf.invoice.subtotal), Number(pdf.invoice.tax_amount), Number(pdf.invoice.total_amount)]).toEqual([1500, 150, 1650]);
    expect(pdf.items.map((i) => [i.description, Number(i.amount), Number(i.tax_amount), i.vat_type]))
      .toEqual([['Standard', 1000, 150, 'standard'], ['Zero', 300, 0, 'zero_rated'], ['Exempt', 200, 0, 'exempt']]);

    expect(await fields()).toEqual([1000, 300, 200, 150]);
    expect(await lockGate()).toEqual({ ties: true, overridden: false, exceptions: 0 });

    const noted = await callRoute(creditNotesRoute, tokens[user]!, f.fx.companyId, 'POST', {
      type: 'customer', clientId: f.fx.customerId, customerInvoiceId: id, creditDate: '2026-09-20', subtotal: 150,
    }, '/api/accounting/credit-notes');
    expect(noted.state.statusCode, JSON.stringify(noted.state.body)).toBe(201);
    const note = data<{ id: string; taxAmount: number; totalAmount: number }>(noted);
    expect([note.taxAmount, note.totalAmount]).toEqual([15, 165]);

    const approved = await inTx(f.fx, () => approveCreditNote(f.fx.companyId, note.id, f.fx.userId));
    expect(await journalLegs(f, approved.glJournalEntryId!)).toEqual([
      L('1100', 0, 165), L('2120', 15, 0, { vat: 'standard' }),
      L('4000', 20, 0, { vat: 'exempt' }), L('4000', 30, 0, { vat: 'zero_rated' }), L('4000', 100, 0, { vat: 'standard' }),
    ]);
    expect(await fields()).toEqual([900, 270, 180, 135]);
    expect(await lockGate()).toEqual({ ties: true, overridden: false, exceptions: 0 });
  });
});
