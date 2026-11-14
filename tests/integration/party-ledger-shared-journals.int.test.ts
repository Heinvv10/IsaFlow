/**
 * (Reproduction from the ledger breaker, kept verbatim as cases A-D; cases E-F added.)
 * party_ledger_check against journals the real posting paths SHARE
 * between documents, and an as_at cutoff the aged bridge ignores. Every party
 * here is CLEAN (statement == aged == GL for it); any flag or residual is a
 * false positive.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import { assertDisposableDb } from '../helpers/assertDisposableDb';
import { partyLedgerCheck } from '@/modules/accounting/services/reconciliation/partyLedgerCheckService';
import type { PartyLedgerCheck } from '@/modules/accounting/services/reconciliation/partyLedgerTypes';
import { fetchSupplierStatementData } from '@/modules/accounting/services/ap/supplierStatementService';
import {
  AS_AT, COMPANY, PAY_DATE, TAG, USER, account, bill, cleanup, journal, supplierPayment,
} from '../helpers/partyLedgerFixture';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

let payable = '';
let bank = '';
let expense = '';
const sup = async (n: string) =>
  ((await sql`INSERT INTO suppliers (company_id, name) VALUES (${COMPANY}::UUID, ${n + TAG}) RETURNING id`) as { id: string }[])[0]!.id;
const statementFlags = (c: PartyLedgerCheck) =>
  c.documents.flatMap((d) => d.flags.map((f) => `${d.number?.replace(TAG, '')}:${f.class}:${f.amount}`));

let batchSup = '';
let splitA = '';
let splitB = '';
let prepay = '';
let voided = '';
let ambigA = '';
let ambigB = '';
let revA = '';
let revB = '';

describeIfDb('party_ledger_check: shared journals and cutoffs', () => {
  beforeAll(async () => {
    assertDisposableDb('breaker7b seeds a whole company.');
    await sql`INSERT INTO companies (id, name, registration_number) VALUES (${COMPANY}::UUID, ${'BRK ' + TAG}, ${TAG})`;
    await sql`INSERT INTO users (id, email, role, is_active) VALUES (${USER}, ${USER + '@test.local'}, 'admin', true)`;
    payable = await account('2110', 'Trade Creditors', 'liability', 'credit', 'payable');
    bank = await account('1000', 'Bank', 'asset', 'debit', 'bank');
    expense = await account('5000', 'Materials', 'expense', 'debit', 'default_expense');
    const clean = (n: string, amt: number, date = '2026-03-01') =>
      journal(n, date, [[expense, amt, 0], [payable, 0, amt]]);

    // (A) BATCH PAYMENT, exactly as batchPaymentService.processBatch leaves it: ONE journal
    // (DR AP / CR Bank) on supplier_payment_batches.gl_journal_entry_id, members 'processed'
    // with NO journal of their own, allocations applied, bill paid.
    batchSup = await sup('batch ');
    const ba = await bill(batchSup, 'BA', 1000, await clean('JBA', 1000), { paid: 1000, status: 'paid' });
    const jBatch = await journal('JBATCH', PAY_DATE, [[payable, 1000, 0], [bank, 0, 1000]]);
    const batchId = ((await sql`
      INSERT INTO supplier_payment_batches (company_id, batch_number, batch_date, total_amount, payment_count,
        status, gl_journal_entry_id, created_by)
      VALUES (${COMPANY}::UUID, ${TAG + 'BATCH'}, ${PAY_DATE}::date, 1000, 1, 'processed', ${jBatch}::UUID, ${USER}::UUID)
      RETURNING id`) as { id: string }[])[0]!.id;
    const pa = ((await sql`
      INSERT INTO supplier_payments (company_id, payment_number, supplier_id, payment_date, total_amount,
        status, payment_method, batch_id, created_by)
      VALUES (${COMPANY}::UUID, ${TAG + 'PA'}, ${batchSup}::UUID, ${PAY_DATE}::date, 1000, 'processed', 'eft',
        ${batchId}::UUID, ${USER}::UUID)
      RETURNING id`) as { id: string }[])[0]!.id;
    await sql`INSERT INTO payment_allocations (payment_id, invoice_id, amount_allocated) VALUES (${pa}::UUID, ${ba}::UUID, 1000)`;

    // (B) SPLIT BANK ALLOCATION naming two suppliers (bankSplitContacts): ONE journal
    // (DR AP 300, DR AP 200, CR Bank 500) carried by BOTH payment documents.
    splitA = await sup('splitA ');
    splitB = await sup('splitB ');
    const bsa = await bill(splitA, 'BSA', 300, await clean('JBSA', 300), { paid: 300, status: 'paid' });
    const bsb = await bill(splitB, 'BSB', 200, await clean('JBSB', 200), { paid: 200, status: 'paid' });
    const jSplit = await journal('JSPLIT', PAY_DATE, [[payable, 300, 0], [payable, 200, 0], [bank, 0, 500]]);
    await supplierPayment(splitA, 'PSA', 300, jSplit, [[bsa, 300]]);
    await supplierPayment(splitB, 'PSB', 200, jSplit, [[bsb, 200]]);

    // (C) PREPAYMENT applied to a bill dated AFTER as_at. At as_at the cash is unapplied.
    prepay = await sup('prepay ');
    const pp = await supplierPayment(prepay, 'PP', 500, await journal('JPP', PAY_DATE, [[payable, 500, 0], [bank, 0, 500]]));
    const futureBill = ((await sql`
      INSERT INTO supplier_invoices (company_id, supplier_id, invoice_number, invoice_date, due_date,
        status, subtotal, tax_amount, total_amount, amount_paid, gl_journal_entry_id, created_by)
      VALUES (${COMPANY}::UUID, ${prepay}::UUID, ${TAG + 'BF'}, '2026-07-10', '2026-07-10', 'paid', 500, 0, 500, 500,
        ${await clean('JBF', 500, '2026-07-10')}::UUID, ${USER}::UUID)
      RETURNING id`) as { id: string }[])[0]!.id;
    await sql`INSERT INTO payment_allocations (payment_id, invoice_id, amount_allocated) VALUES (${pp}::UUID, ${futureBill}::UUID, 500)`;

    // (D) Payment live at as_at, voided AFTER it (reversal dated 2026-07-15).
    voided = await sup('voided ');
    await bill(voided, 'BV', 1000, await clean('JBV', 1000));
    const jpv = await journal('JPV', PAY_DATE, [[payable, 400, 0], [bank, 0, 400]]);
    await journal('JPVR', '2026-07-15', [[bank, 400, 0], [payable, 0, 400]], 'posted', jpv);
    const pv = await supplierPayment(voided, 'PV', 400, jpv);
    await sql`UPDATE supplier_payments SET status = 'cancelled' WHERE id = ${pv}::UUID`;

    // (E) A shared journal whose control lines do NOT match its documents: {500, 300} against 500 and 200.
    ambigA = await sup('ambigA ');
    ambigB = await sup('ambigB ');
    await bill(ambigA, 'BU1', 500, await clean('JBU1', 500), { paid: 500, status: 'paid' });
    await bill(ambigB, 'BU2', 200, await clean('JBU2', 200), { paid: 200, status: 'paid' });
    const jAmbig = await journal('JAMBIG', PAY_DATE, [[payable, 500, 0], [payable, 300, 0], [bank, 0, 800]]);
    await supplierPayment(ambigA, 'PU1', 500, jAmbig);
    await supplierPayment(ambigB, 'PU2', 200, jAmbig);

    // (F) A shared journal that was fully REVERSED while both payments are still live on the statement.
    revA = await sup('revA ');
    revB = await sup('revB ');
    await bill(revA, 'BR1', 300, await clean('JBR1', 300));
    await bill(revB, 'BR2', 200, await clean('JBR2', 200));
    const jRev = await journal('JREV', PAY_DATE, [[payable, 300, 0], [payable, 200, 0], [bank, 0, 500]]);
    await journal('JREVR', PAY_DATE, [[bank, 500, 0], [payable, 0, 300], [payable, 0, 200]], 'posted', jRev);
    await supplierPayment(revA, 'PR1', 300, jRev);
    await supplierPayment(revB, 'PR2', 200, jRev);
  }, 120000);

  afterAll(async () => {
    await sql`DELETE FROM payment_allocations WHERE payment_id IN (SELECT id FROM supplier_payments WHERE company_id = ${COMPANY}::UUID)`;
    await sql`DELETE FROM supplier_payments WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM supplier_payment_batches WHERE company_id = ${COMPANY}::UUID`;
    await cleanup();
  }, 120000);

  it('(A) a supplier paid through a processed BATCH is clean: no flag, statement ties to GL', async () => {
    const c = (await partyLedgerCheck(COMPANY, 'supplier', batchSup, AS_AT))!;
    // Truth: owed 1000 - paid 1000 = 0 on the statement, 0 aged, and AP control moved +1000 -1000.
    expect({ stmt: c.totals.statementBalance, aged: c.totals.agedNet }).toEqual({ stmt: 0, aged: 0 });
    expect({ flags: statementFlags(c), statementMinusGl: c.totals.statementMinusGl })
      .toEqual({ flags: [], statementMinusGl: 0 });
  });

  it('(B) a payment that shares a SPLIT journal with another supplier counts only its own leg', async () => {
    const a = (await partyLedgerCheck(COMPANY, 'supplier', splitA, AS_AT))!;
    const b = (await partyLedgerCheck(COMPANY, 'supplier', splitB, AS_AT))!;
    expect({ a: a.totals.glControlNet, b: b.totals.glControlNet }).toEqual({ a: 0, b: 0 });
    expect({ a: statementFlags(a), b: statementFlags(b) }).toEqual({ a: [], b: [] });
  });

  it('(C) cash applied only AFTER as_at is unapplied at as_at: the aged bridge closes', async () => {
    const c = (await partyLedgerCheck(COMPANY, 'supplier', prepay, AS_AT))!;
    // statement -500 (payment only; the bill is after as_at), aged 0 -> agedMinusStatement 500,
    // all of it unapplied cash at as_at.
    expect(c.totals.agedMinusStatement).toBe(500);
    expect({ unappliedCash: c.totals.agedBridge.unappliedCash, unexplained: c.totals.agedBridge.unexplained })
      .toEqual({ unappliedCash: 500, unexplained: 0 });
  });

  it('(D) a payment voided after as_at: statement as at as_at, and the tool, agree with GL', async () => {
    const st = (await fetchSupplierStatementData(COMPANY, voided, AS_AT))!;
    const c = (await partyLedgerCheck(COMPANY, 'supplier', voided, AS_AT))!;
    // At 2026-06-30 the payment stood: owed 1000 - 400 = 600, and AP control says 600.
    expect({ statement: st.summary.balance, gl: c.totals.glControlNet, flags: statementFlags(c) })
      .toEqual({ statement: 600, gl: 600, flags: [] });
  });

  it('(E) a shared journal whose lines cannot be matched is named, and left out of the gap on both sides', async () => {
    const a = (await partyLedgerCheck(COMPANY, 'supplier', ambigA, AS_AT))!;
    const pay = a.documents.find((d) => d.kind === 'payment')!;
    expect(pay.gl.attribution).toBe('unattributable');
    expect(pay.difference).toBeNull();
    expect(pay.flags.map((f) => [f.class, f.bridge])).toEqual([['shared_journal_unattributable', 'shared_journal']]);
    expect(pay.flags[0]!.detail).toContain(pay.gl.sharedWith[0]!);
    // statement 500 - 500 = 0; the payment's -500 leaves the comparison, the bill's +500 GL stays
    // -> (0 - (-500)) - 500 = 0, and the unattributed amount is counted apart.
    expect(a.totals).toMatchObject({
      statementBalance: 0, glControlNet: 500, statementMinusGl: 0, classifiedDifference: 0, unexplainedResidual: 0,
      sharedJournalUnattributable: { documents: 1, statementEffect: -500 },
    });
    expect(a.totals.byClass.find((c) => c.class === 'shared_journal_unattributable')).toMatchObject({ count: 1, amount: -500 });
    expect(a.invariants.filter((i) => !i.holds)).toEqual([]);
  });

  it('(F) a reversed shared journal scales each leg to zero: both live payments are flagged, neither leaks into the other', async () => {
    for (const [supplier, amount] of [[revA, 300], [revB, 200]] as const) {
      const c = (await partyLedgerCheck(COMPANY, 'supplier', supplier, AS_AT))!;
      const pay = c.documents.find((d) => d.kind === 'payment')!;
      expect(pay.gl).toMatchObject({ attribution: 'line_match', controlNet: 0, reversalsInForce: 1 });
      expect(pay.flags.map((f) => [f.class, f.amount])).toEqual([['reversed_journal_live_document', -amount]]);
      expect(c.totals.unexplainedResidual).toBe(0);
    }
  });
});
