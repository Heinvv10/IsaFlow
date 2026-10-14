/**
 * PR #711 — one bank line split onto SUPPLIERS and CUSTOMERS, against a real
 * ledger: the journal, the documents on it, what the reconciler reads from a
 * journal carrying two documents, what a void of ONE of them may do, the
 * reversal arm, and the reversal.
 *
 * The use case: VF1 7 Oct, one R1,959.48 EFT paying a claimant's own bill
 * (R800) and a merchant slip bill under another supplier (R1,159.48).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from '@/lib/neon';
import {
  reverseReconciledTransaction, splitAllocateTransaction,
} from '@/modules/accounting/services/bank/bankAllocationService';
import { getUnappliedPaymentCash } from '@/modules/accounting/services/reconciliation/unappliedPaymentCash';
import { voidPaymentDocument } from '@/modules/accounting/services/core/paymentVoidService';
import { allocationFacts } from '@/modules/accounting/services/bank/bankLineImporterGate';
import {
  billState, dropFixture, inTx, seedBankTx, seedBill, seedFixture, seedInvoice, seedSupplier, type Fixture,
} from './helpers/l1FifoFixture';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

let fx: Fixture;

async function journalLines(entryId: string): Promise<string[]> {
  const rows = (await sql`
    SELECT a.account_code, jl.debit::float8 AS dr, jl.credit::float8 AS cr
    FROM gl_journal_lines jl JOIN gl_accounts a ON a.id = jl.gl_account_id
    WHERE jl.journal_entry_id = ${entryId}::UUID AND jl.company_id = ${fx.companyId}::UUID`) as Record<string, unknown>[];
  return rows.map((r) => `${String(r.account_code)}:${Number(r.dr).toFixed(2)}/${Number(r.cr).toFixed(2)}`).sort();
}

async function supplierPaymentsOn(entryId: string): Promise<{ id: string; supplier: string; total: number; status: string }[]> {
  const rows = (await sql`
    SELECT id, supplier_id, total_amount::float8 AS total, status FROM supplier_payments
    WHERE company_id = ${fx.companyId}::UUID AND gl_journal_entry_id = ${entryId}::UUID
    ORDER BY total_amount`) as Record<string, unknown>[];
  return rows.map((r) => ({ id: String(r.id), supplier: String(r.supplier_id), total: Number(r.total), status: String(r.status) }));
}

async function accountByCode(code: string): Promise<string> {
  const rows = (await sql`SELECT id FROM gl_accounts WHERE company_id = ${fx.companyId}::UUID AND account_code = ${code}`) as Record<string, unknown>[];
  return String(rows[0]!.id);
}

describeIfDb('PR #711 — a bank line split onto suppliers and customers', () => {
  beforeAll(async () => {
    fx = await seedFixture('SPLIT711', DATABASE_URL!);
  }, 60000);

  afterAll(async () => {
    await dropFixture(fx);
  }, 60000);

  it('two suppliers: one journal, two payments on it, the reconciler foots, a void of one part is refused, the reversal takes all', async () => {
    const frik = await seedSupplier(fx, 'FRIK');
    const southern = await seedSupplier(fx, 'SOUTHERN');
    const bill = await seedBill(fx, { supplierId: frik, number: 'SIV5059', date: '2026-10-01', total: 800 });
    const tx = await seedBankTx(fx, { date: '2026-10-07', amount: -1959.48, description: 'Frik Basson' });

    const result = await inTx(fx, () => splitAllocateTransaction(fx.companyId, tx, [
      { contactType: 'supplier', contactId: frik.toUpperCase(), amount: 800 },
      { contactType: 'supplier', contactId: southern, amount: 1159.48, autoApply: 'none' },
    ], fx.userId));

    // The journal: DR AP per supplier, CR Bank for the line. No VAT.
    expect(await journalLines(result.journalEntryId)).toEqual(['1000:0.00/1959.48', '2100:1159.48/0.00', '2100:800.00/0.00']);
    // Each document on THAT journal, its supplier's own amount; the uppercase id is the same supplier.
    const payments = await supplierPaymentsOn(result.journalEntryId);
    expect(payments.map((p) => [p.supplier, p.total])).toEqual([[frik, 800], [southern, 1159.48]]);
    expect(await billState(fx, bill)).toMatchObject({ status: 'paid', amountPaid: 800 });

    // The reconciler: each payment explains its OWN control movement. Before the
    // fix each read the whole journal's R1,959.48, and the gap showed as offControl.
    const ap = await accountByCode('2100');
    const real = await inTx(fx, () => getUnappliedPaymentCash(fx.companyId, 'ap', '2026-12-31', [ap]));
    const se = payments.find((p) => p.supplier === southern)!;
    expect(real.withPaymentRecord.find((i) => i.id === se.id)).toMatchObject({ amount: 1159.48, documentUnapplied: 1159.48 });
    expect(real.offControl.filter((o) => payments.some((p) => p.id === o.paymentId))).toEqual([]);

    // A void of ONE part would reverse the whole bank line: refused, nothing moved.
    const voided = await inTx(fx, () => voidPaymentDocument(fx.companyId, 'supplier', se.id, fx.userId));
    expect(voided).toMatchObject({ refusal: 'split_part' });
    expect((await supplierPaymentsOn(result.journalEntryId)).every((p) => p.status !== 'cancelled')).toBe(true);

    // The split's own reversal: every document cancelled, the bill reopened, the line free.
    await inTx(fx, () => reverseReconciledTransaction(fx.companyId, tx, fx.userId));
    expect((await supplierPaymentsOn(result.journalEntryId)).map((p) => p.status)).toEqual(['cancelled', 'cancelled']);
    expect(await billState(fx, bill)).toMatchObject({ amountPaid: 0 });
    const [line] = (await sql`SELECT status FROM bank_transactions WHERE id = ${tx}::UUID`) as Record<string, unknown>[];
    expect(line!.status).toBe('imported');
  }, 120000);

  it('money in, a GL line and a customer receipt: the receipt applies, and the reversal arm stays manual_journal', async () => {
    const invoice = await seedInvoice(fx, { number: 'INV711', date: '2026-10-01', total: 400 });
    const tx = await seedBankTx(fx, { date: '2026-10-08', amount: 1000, description: 'Deposit' });
    const expense = await accountByCode('6000');

    const result = await inTx(fx, () => splitAllocateTransaction(fx.companyId, tx, [
      { contraAccountId: expense, amount: 600 },
      { contactType: 'customer', contactId: fx.customerId, amount: 400 },
    ], fx.userId));

    expect(await journalLines(result.journalEntryId)).toEqual(['1000:1000.00/0.00', '1100:0.00/400.00', '6000:0.00/600.00']);
    const [receipt] = (await sql`
      SELECT total_amount::float8 AS total, status FROM customer_payments
      WHERE company_id = ${fx.companyId}::UUID AND gl_journal_entry_id = ${result.journalEntryId}::UUID`) as Record<string, unknown>[];
    expect(receipt).toMatchObject({ total: 400, status: 'reconciled' }); // fully applied
    const [inv] = (await sql`SELECT amount_paid::float8 AS paid FROM customer_invoices WHERE id = ${invoice}::UUID`) as Record<string, unknown>[];
    expect(inv!.paid).toBe(400);

    // Before: the one document read was a receipt (money in → ungated), so the
    // R600 GL part of the split left the manual-journal gate on reversal.
    const facts = await inTx(fx, () => allocationFacts(fx.companyId, { amount: 1000, auto_post_run_id: null }, result.journalEntryId));
    expect(facts?.arm).toBe('manual_journal');
  }, 120000);
});
