/**
 * find_double_settlements against a real ledger (step 6). Velocity's cases, generically: a bill settled by a contra
 * AND a card line (SIV0003760); a bill settled by a payment AND a credit note (Build It CN-2026-00562); a bill paid by
 * a "contra" that is an EFT crediting a clearing account (classified by its account, rule 3) and a payment, half
 * each; a bill whose amount_paid no settlement row explains; a payment crediting an account with no subtype
 * ("unclassified"). Not reported: a clean bill, two halves of the same kind, half a credit note + half a payment (bank-fed
 * or not), a cancelled payment. Company isolation both ways.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import { findDoubleSettlements } from '@/modules/accounting/services/ap/doubleSettlementService';
import { findDoubleSettlementsTool } from '@/lib/mcp/tools/findDoubleSettlements';
import type { McpToolContext } from '@/lib/mcp/types';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { dropFixture, inTx, seedFixture, seedSupplier, type Fixture } from './helpers/l1FifoFixture';
import { billWithJournal, dropStepExtras, postedJournal, seedStepAccounts, type StepAccounts } from './helpers/shareUndoFixture';

const DATABASE_URL = process.env.DATABASE_URL;
type Row = Record<string, unknown>;
let fx: Fixture;
let fx2: Fixture;
let a: StepAccounts;
let a2: StepAccounts;

async function pay(f: Fixture, acc: StepAccounts, o: {
  method: string; credit: string; date: string; allocs: { bill: string; amount: number }[];
  status?: string; statementLine?: boolean;
}): Promise<string> {
  const total = o.allocs.reduce((s, x) => s + x.amount, 0);
  const je = await postedJournal(f, o.date, [{ account: acc.ap, debit: total }, { account: o.credit, credit: total }]);
  const [p] = (await sql`
    INSERT INTO supplier_payments (company_id, supplier_id, payment_date, total_amount, payment_method, bank_account_id,
      status, created_by, gl_journal_entry_id)
    VALUES (${f.companyId}::UUID, ${f.supplierId}::UUID, ${o.date}::DATE, ${total}, ${o.method}, ${o.credit}::UUID,
            ${o.status ?? 'processed'}, ${f.userId}::UUID, ${je}::UUID) RETURNING id`) as Row[];
  for (const x of o.allocs) {
    await sql`INSERT INTO payment_allocations (payment_id, invoice_id, amount_allocated) VALUES (${String(p!.id)}::UUID, ${x.bill}::UUID, ${x.amount})`;
  }
  if (o.statementLine) {
    const [line] = (await sql`SELECT id FROM gl_journal_lines WHERE journal_entry_id = ${je}::UUID AND credit > 0`) as Row[];
    await sql`INSERT INTO bank_transactions (company_id, bank_account_id, transaction_date, amount, description, status, matched_journal_line_id)
      VALUES (${f.companyId}::UUID, ${f.bankAccountId}::UUID, ${o.date}::DATE, ${-total}, 'paycard line', 'allocated', ${String(line!.id)}::UUID)`;
  }
  return String(p!.id);
}

async function creditNote(f: Fixture, bill: string, amount: number, legacy = false): Promise<string> {
  const [n] = (await sql`
    INSERT INTO credit_notes (company_id, type, supplier_id, supplier_invoice_id, credit_note_number, credit_date, subtotal,
      total_amount, applied_amount, status, created_by)
    VALUES (${f.companyId}::UUID, 'supplier', ${f.supplierId}::UUID, ${legacy ? bill : null}::UUID,
            ${`CN-${Math.random().toString(36).slice(2, 10)}`}, '2026-06-05', ${amount}, ${amount}, ${amount}, 'applied',
            ${f.userId}::UUID) RETURNING id`) as Row[];
  if (!legacy) {
    await sql`INSERT INTO credit_note_allocations (company_id, credit_note_id, invoice_id, amount_allocated)
      VALUES (${f.companyId}::UUID, ${String(n!.id)}::UUID, ${bill}::UUID, ${amount})`;
  }
  return String(n!.id);
}

const bill = (f: Fixture, acc: StepAccounts, n: string, total: number, date = '2026-05-10', supplier?: string) =>
  billWithJournal(f, acc, n, date, [{ account: acc.expense, debit: total }], supplier).then((b) => b.id);
const all = (f: Fixture) => inTx(f, () => findDoubleSettlements(f.companyId, { supplierId: null, fromDate: null, toDate: null, limit: 200, offset: 0 }));

describe.skipIf(!DATABASE_URL)('find_double_settlements', () => {
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    assertNotProductionDb('This test seeds bills and payments.');
    fx = await seedFixture('DBL', DATABASE_URL!);
    fx2 = await seedFixture('DBL2', DATABASE_URL!);
    a = await seedStepAccounts(fx);
    a2 = await seedStepAccounts(fx2);
    ids.stephan = await bill(fx, a, 'SIV0003760', 150, '2026-05-01');
    ids.contraPay = await pay(fx, a, { method: 'contra', credit: a.clearing, date: '2026-09-17', allocs: [{ bill: ids.stephan, amount: 150 }] });
    ids.cardPay = await pay(fx, a, { method: 'eft', credit: a.bank, date: '2026-09-20', allocs: [{ bill: ids.stephan, amount: 150 }], statementLine: true });
    ids.buildIt = await bill(fx, a, 'BUILDIT', 200, '2026-05-02');
    await pay(fx, a, { method: 'eft', credit: a.bank, date: '2026-06-01', allocs: [{ bill: ids.buildIt, amount: 200 }] });
    ids.cn = await creditNote(fx, ids.buildIt, 200);
    ids.halves = await bill(fx, a, 'HALVES', 100, '2026-05-03');
    ids.clearingEft = await pay(fx, a, { method: 'eft', credit: a.clearing, date: '2026-06-02', allocs: [{ bill: ids.halves, amount: 50 }] });
    await pay(fx, a, { method: 'eft', credit: a.bank, date: '2026-06-03', allocs: [{ bill: ids.halves, amount: 50 }] });
    ids.legacy = await bill(fx, a, 'LEGACY', 80, '2026-05-04');
    await pay(fx, a, { method: 'eft', credit: a.bank, date: '2026-06-04', allocs: [{ bill: ids.legacy, amount: 80 }] });
    await creditNote(fx, ids.legacy, 80, true);
    // Judged per KIND: two contras of 30 are one 60 contra beside a 60 payment on a 120 bill.
    ids.perKind = await bill(fx, a, 'PERKIND', 120, '2026-05-07');
    await pay(fx, a, { method: 'contra', credit: a.clearing, date: '2026-06-09', allocs: [{ bill: ids.perKind, amount: 30 }] });
    await pay(fx, a, { method: 'contra', credit: a.clearing, date: '2026-06-10', allocs: [{ bill: ids.perKind, amount: 30 }] });
    await pay(fx, a, { method: 'eft', credit: a.bank, date: '2026-06-11', allocs: [{ bill: ids.perKind, amount: 60 }] });
    // Not reported.
    const clean = await bill(fx, a, 'CLEAN', 300);
    await pay(fx, a, { method: 'eft', credit: a.bank, date: '2026-06-05', allocs: [{ bill: clean, amount: 300 }] });
    const sameKind = await bill(fx, a, 'SAMEKIND', 300);
    await pay(fx, a, { method: 'eft', credit: a.bank, date: '2026-06-05', allocs: [{ bill: sameKind, amount: 150 }] });
    await pay(fx, a, { method: 'eft', credit: a.bank, date: '2026-06-06', allocs: [{ bill: sameKind, amount: 150 }] });
    // Half a credit note + half a BANK-FED payment (reads card_line): an ordinary settlement, not the contra pattern.
    const cnCard = await bill(fx, a, 'CNCARD', 100);
    await pay(fx, a, { method: 'eft', credit: a.bank, date: '2026-06-05', allocs: [{ bill: cnCard, amount: 50 }], statementLine: true });
    await creditNote(fx, cnCard, 50);
    const cnHalf = await bill(fx, a, 'CNHALF', 100);
    await pay(fx, a, { method: 'eft', credit: a.bank, date: '2026-06-05', allocs: [{ bill: cnHalf, amount: 50 }] });
    await creditNote(fx, cnHalf, 50);
    const voided = await bill(fx, a, 'VOIDED', 100);
    await pay(fx, a, { method: 'eft', credit: a.bank, date: '2026-06-05', allocs: [{ bill: voided, amount: 100 }] });
    await pay(fx, a, { method: 'contra', credit: a.clearing, date: '2026-06-06', allocs: [{ bill: voided, amount: 100 }], status: 'cancelled' });
    // Paid by something that left no settlement row (a bank match / an import): amount_paid with no rows behind it.
    ids.unexplained = await bill(fx, a, 'UNEXPLAINED', 70, '2026-05-05');
    await sql`UPDATE supplier_invoices SET amount_paid = 70, status = 'paid' WHERE id = ${ids.unexplained}::UUID`;
    // An account with no subtype and no statement lines: 'unclassified', never a contra; over-settles with a payment.
    const [bare] = (await sql`INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, normal_balance, is_active)
      VALUES (${fx.companyId}::UUID, '1599', ${`bare ${fx.tag}`}, 'asset', 'debit', true) RETURNING id`) as Row[];
    ids.bareBill = await bill(fx, a, 'BARE', 60, '2026-05-06');
    await pay(fx, a, { method: 'eft', credit: String(bare!.id), date: '2026-06-07', allocs: [{ bill: ids.bareBill, amount: 60 }] });
    await pay(fx, a, { method: 'eft', credit: a.bank, date: '2026-06-08', allocs: [{ bill: ids.bareBill, amount: 60 }] });
    // The other company's own double settlement.
    ids.other = await bill(fx2, a2, 'OTHER', 90);
    await pay(fx2, a2, { method: 'contra', credit: a2.clearing, date: '2026-06-01', allocs: [{ bill: ids.other, amount: 90 }] });
    await pay(fx2, a2, { method: 'eft', credit: a2.bank, date: '2026-06-02', allocs: [{ bill: ids.other, amount: 90 }] });
  }, 120000);

  afterAll(async () => {
    for (const f of [fx, fx2]) { await dropStepExtras(f); await dropFixture(f); }
  }, 120000);

  it('reports a contra + card line, a payment + credit note, a legacy note, two halves of different kinds', async () => {
    const r = await all(fx);
    expect(r.rows.map((b) => b.billId)).toEqual([ids.stephan, ids.buildIt, ids.halves, ids.legacy, ids.unexplained, ids.bareBill, ids.perKind]);
    expect(r.total).toBe(7);
    const [stephan, buildIt, halves, legacy, unexplained, bareBill, perKind] = r.rows;
    expect(stephan).toMatchObject({ total: 150, settledTotal: 300, overSettledBy: 150, reasons: ['over_settled', 'multiple_sources'] });
    expect(stephan!.settlements).toEqual([
      expect.objectContaining({ kind: 'contra', documentId: ids.contraPay, date: '2026-09-17', amount: 150,
        accountId: a.clearing, accountCode: '1560731', paymentMethod: 'contra' }),
      expect.objectContaining({ kind: 'card_line', documentId: ids.cardPay, amount: 150, accountId: a.bank }),
    ]);
    expect(buildIt!.settlements.map((s) => s.kind)).toEqual(['payment', 'credit_note']);
    // A payment and a credit note is not the contra/card-line pattern: over-settled only (review round 1).
    expect(buildIt).toMatchObject({ overSettledBy: 200, reasons: ['over_settled'] });
    expect(halves).toMatchObject({ settledTotal: 100, overSettledBy: 0, reasons: ['multiple_sources'] });
    // Rule 3: an EFT whose journal credits a clearing account, not a bank, is a contra.
    expect(halves!.settlements.find((s) => s.documentId === ids.clearingEft)).toMatchObject({ kind: 'contra', paymentMethod: 'eft' });
    expect(legacy!.settlements.map((s) => s.kind)).toEqual(['payment', 'credit_note']);
    expect(unexplained).toMatchObject({ amountPaid: 70, settledTotal: 0, reasons: ['amount_paid_unexplained'], settlements: [] });
    expect(bareBill!.settlements.map((s) => s.kind)).toEqual(['unclassified', 'payment']);
    expect(bareBill!.reasons).toEqual(['over_settled']);
    expect(perKind).toMatchObject({ settledTotal: 120, reasons: ['multiple_sources'] });
  }, 60000);

  it('filters by supplier and invoice date, and pages with next_offset through the tool', async () => {
    const other = await seedSupplier(fx, 'NOBODY');
    expect((await inTx(fx, () => findDoubleSettlements(fx.companyId, { supplierId: other, fromDate: null, toDate: null, limit: 50, offset: 0 }))).total).toBe(0);
    const may2 = await inTx(fx, () => findDoubleSettlements(fx.companyId, { supplierId: fx.supplierId, fromDate: '2026-05-02', toDate: '2026-05-03', limit: 50, offset: 0 }));
    expect(may2.rows.map((b) => b.billId)).toEqual([ids.buildIt, ids.halves]);
    const ctx = { companyId: fx.companyId, userId: fx.userId } as McpToolContext;
    const page = JSON.parse((await inTx(fx, () => findDoubleSettlementsTool.handler({ limit: 3 }, ctx))).content[0]!.text);
    expect(page.bills).toHaveLength(3);
    expect(page.next_offset).toBe(3);
    const last = JSON.parse((await inTx(fx, () => findDoubleSettlementsTool.handler({ limit: 3, offset: 3 }, ctx))).content[0]!.text);
    expect(last.bills.map((b: { bill_id: string }) => b.bill_id)).toEqual([ids.legacy, ids.unexplained, ids.bareBill]);
    expect(last.next_offset).toBe(6);
  }, 60000);

  it('is company-scoped both ways', async () => {
    expect((await all(fx)).rows.map((b) => b.billId)).not.toContain(ids.other);
    const theirs = await all(fx2);
    expect(theirs.rows.map((b) => b.billId)).toEqual([ids.other]);
    expect(theirs.rows[0]!.settlements.map((s) => s.kind)).toEqual(['contra', 'payment']);
  }, 60000);
});
