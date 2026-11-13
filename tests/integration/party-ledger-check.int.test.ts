/**
 * party_ledger_check -- one supplier and one customer, each seeded with a clean
 * document and one document per mismatch class, against REAL SQL.
 *
 * Journals are written directly so each document's journal is wrong in exactly
 * one chosen way. The numbers asserted below are worked out by hand in the
 * comments beside each seed, then compared with what the service returns: the
 * statement balance and aged net come from the statement / aging services, the
 * GL net from the documents' own journals, and the three must tie through the
 * named classes.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { sql } from '@/lib/neon';
import { assertDisposableDb } from '../helpers/assertDisposableDb';
import { partyLedgerCheck } from '@/modules/accounting/services/reconciliation/partyLedgerCheckService';
import type { PartyDocument, PartyLedgerCheck } from '@/modules/accounting/services/reconciliation/partyLedgerTypes';
import { partyLedgerCheckTool } from '@/lib/mcp/tools/partyLedgerCheck';
import type { McpToolContext } from '@/lib/mcp/types';
import {
  AS_AT, COMPANY, DOC_DATE, PAY_DATE, TAG, USER, account, bill, cleanup, creditNote, invoice,
  journal, receipt, supplierPayment, writeOff,
} from '../helpers/partyLedgerFixture';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;
const OTHER = randomUUID();

let supplier = '';
let customer = '';
let otherSupplier = '';
let payable = '';
let other = '';
let sup: PartyLedgerCheck;
let cus: PartyLedgerCheck;

const ctx = { userId: USER, companyId: COMPANY, scopes: ['read:reports'], tokenJti: 'j', oauthAppId: 'a' } as McpToolContext;
const doc = (c: PartyLedgerCheck, n: string): PartyDocument => {
  const d = c.documents.find((x) => x.number === TAG + n);
  if (!d) throw new Error(`no document ${n}`);
  return d;
};
const statementFlag = (d: PartyDocument) => d.flags.find((f) => f.bridge === 'statement_vs_gl');
async function call(args: Record<string, unknown>) {
  const res = await partyLedgerCheckTool.handler(args, ctx);
  return JSON.parse((res.content[0] as { text: string }).text) as Record<string, any>;
}

describeIfDb('party_ledger_check', () => {
  beforeAll(async () => {
    assertDisposableDb('party_ledger_check seeds whole companies and journals.');
    await sql`INSERT INTO companies (id, name, registration_number) VALUES (${COMPANY}::UUID, ${'PLC ' + TAG}, ${TAG})`;
    await sql`INSERT INTO companies (id, name, registration_number) VALUES (${OTHER}::UUID, ${'PLC2 ' + TAG}, ${TAG + 'x'})`;
    await sql`INSERT INTO users (id, email, role, is_active) VALUES (${USER}, ${USER + '@test.local'}, 'admin', true)`;
    payable = await account('2110', 'Trade Creditors', 'liability', 'credit', 'payable');
    other = await account('2999', 'Sundry Creditors', 'liability', 'credit', null);
    const bank = await account('1000', 'Bank', 'asset', 'debit', 'bank');
    const expense = await account('5000', 'Materials', 'expense', 'debit', 'default_expense');
    const receivable = await account('1120', 'Trade Debtors', 'asset', 'debit', 'receivable');
    const sundryDebtors = await account('1999', 'Sundry Debtors', 'asset', 'debit', null);
    const sales = await account('4000', 'Sales', 'revenue', 'credit', 'default_revenue');
    const badDebt = await account('5900', 'Bad Debts', 'expense', 'debit', 'default_expense');

    supplier = ((await sql`INSERT INTO suppliers (company_id, name) VALUES (${COMPANY}::UUID, ${'supp ' + TAG}) RETURNING id`) as { id: string }[])[0]!.id;
    customer = ((await sql`INSERT INTO customers (company_id, name) VALUES (${COMPANY}::UUID, ${'cust ' + TAG}) RETURNING id`) as { id: string }[])[0]!.id;
    otherSupplier = ((await sql`INSERT INTO suppliers (company_id, name) VALUES (${OTHER}::UUID, ${'oth ' + TAG}) RETURNING id`) as { id: string }[])[0]!.id;

    // ── SUPPLIER (positive = we owe) ────────────────────────────────────────
    const clean = (n: string, amt: number) => journal(n, DOC_DATE, [[expense, amt, 0], [payable, 0, amt]]);
    const b1 = await bill(supplier, 'B1', 1000, await clean('J1', 1000), { paid: 400 });   // clean, part paid by P0
    await supplierPayment(supplier, 'P0', 400, await journal('JP0', PAY_DATE, [[payable, 400, 0], [bank, 0, 400]]), [[b1, 400]]);
    await bill(supplier, 'B2', 500, null);                                                  // no journal link
    await bill(supplier, 'B3', 300, await journal('J3', DOC_DATE, [[expense, 300, 0], [other, 0, 300]])); // wrong liability account
    await bill(supplier, 'B4', 800, await clean('J4', 600));                                // journal for 600 only
    const j5 = await clean('J5', 700);
    await journal('J5R', DOC_DATE, [[payable, 700, 0], [expense, 0, 700]], 'posted', j5);   // reversed, document live
    await bill(supplier, 'B5', 700, j5);
    await bill(supplier, 'B6', 400, await clean('J6', 400), { status: 'cancelled' });       // cancelled, journal live
    await bill(supplier, 'B7', 250, await journal('J7', '2026-08-01', [[expense, 250, 0], [payable, 0, 250]])); // after as_at
    await bill(supplier, 'B8', 200, await journal('J8', DOC_DATE, [[expense, 200, 0], [payable, 0, 200]], 'draft'));
    await bill(supplier, 'B9', 900, await clean('J9', 900), { paid: 900 });                // paid, no allocation rows
    await bill(supplier, 'B10', 120, await journal('J10', DOC_DATE, [[expense, 120, 0], [expense, 0, 120]])); // nets to nothing anywhere
    await supplierPayment(supplier, 'P1', 300, null);                                       // processed, no journal
    await creditNote('supplier', supplier, 'C1', 150, await journal('JC1', PAY_DATE, [[payable, 150, 0], [expense, 0, 150]]));
    await creditNote('supplier', supplier, 'C2', 100, null);                                // approved, no journal
    await journal('STRAY', DOC_DATE, [[bank, 77, 0], [payable, 0, 77]]);                    // a journal no document claims

    // ── CUSTOMER (positive = they owe us) ───────────────────────────────────
    const cj = (n: string, amt: number) => journal(n, DOC_DATE, [[receivable, amt, 0], [sales, 0, amt]]);
    const i1 = await invoice(customer, 'I1', 1000, await cj('K1', 1000), 400);
    await receipt(customer, 'R1', 400, await journal('KR1', PAY_DATE, [[bank, 400, 0], [receivable, 0, 400]]), 'confirmed', [[i1, 400]]);
    await invoice(customer, 'I2', 500, null);
    const i3 = await invoice(customer, 'I3', 600, await cj('K3', 600), 600);
    await writeOff(customer, i3, 'W3', 600, await journal('KW3', PAY_DATE, [[badDebt, 600, 0], [receivable, 0, 600]]));
    const i4 = await invoice(customer, 'I4', 300, await cj('K4', 300), 300);
    await writeOff(customer, i4, 'W4', 300, null);                                          // approved write-off, no journal
    await receipt(customer, 'R2', 90, null, 'draft');                                       // draft receipt: off the statement
    await receipt(customer, 'R3', 200, await journal('KR3', PAY_DATE, [[bank, 200, 0], [sundryDebtors, 0, 200]]));
    await creditNote('customer', customer, 'CN1', 100, await journal('KCN1', PAY_DATE, [[sales, 100, 0], [receivable, 0, 100]]));

    // ── NOT this party's: a second supplier and customer of the same company, and another
    // company's bill that names OUR supplier (supplier_id is a bare FK). None may appear.
    const rival = ((await sql`INSERT INTO suppliers (company_id, name) VALUES (${COMPANY}::UUID, ${'rival ' + TAG}) RETURNING id`) as { id: string }[])[0]!.id;
    await bill(rival, 'RB', 7777, await clean('JRB', 7777));
    const rivalCust = ((await sql`INSERT INTO customers (company_id, name) VALUES (${COMPANY}::UUID, ${'rival ' + TAG}) RETURNING id`) as { id: string }[])[0]!.id;
    await invoice(rivalCust, 'RI', 8888, await cj('KRI', 8888));
    await sql`
      INSERT INTO supplier_invoices (company_id, supplier_id, invoice_number, invoice_date, due_date, status,
        subtotal, tax_amount, total_amount, amount_paid, created_by)
      VALUES (${OTHER}::UUID, ${supplier}::UUID, ${TAG + 'XB'}, ${DOC_DATE}::date, ${DOC_DATE}::date, 'approved',
        5555, 0, 5555, 0, ${USER}::UUID)`;

    sup = (await partyLedgerCheck(COMPANY, 'supplier', supplier, AS_AT))!;
    cus = (await partyLedgerCheck(COMPANY, 'customer', customer, AS_AT))!;
  }, 120000);

  afterAll(async () => {
    await sql`DELETE FROM supplier_invoices WHERE company_id = ${OTHER}::UUID`;
    await sql`DELETE FROM suppliers WHERE company_id = ${OTHER}::UUID`;
    await sql`DELETE FROM companies WHERE id = ${OTHER}::UUID`;
    await cleanup();
  }, 120000);

  it('supplier: each mismatch class is flagged with its difference, clean documents are not', () => {
    const expected: Array<[string, string, number]> = [
      ['B2', 'document_not_linked_to_journal', 500],
      ['B3', 'posted_to_non_control_account', 300],
      ['B4', 'journal_amount_differs', 200],
      ['B5', 'reversed_journal_live_document', 700],
      ['B6', 'excluded_document_has_live_journal', -400],
      ['B7', 'journal_dated_after_as_at', 250],
      ['B8', 'journal_not_posted', 200],
      ['B10', 'unclassified_difference', 120],
      ['P1', 'settlement_with_no_journal', -300],
      ['C2', 'settlement_with_no_journal', -100],
    ];
    for (const [n, cls, amount] of expected) {
      const f = statementFlag(doc(sup, n));
      expect({ n, cls: f?.class, amount: f?.amount }).toEqual({ n, cls, amount });
    }
    for (const n of ['B1', 'P0', 'C1', 'B9']) expect(statementFlag(doc(sup, n))).toBeUndefined();
    expect(statementFlag(doc(sup, 'B3'))?.postedTo?.map((a) => a.code)).toEqual(['2999']);
    expect(doc(sup, 'B6').statement).toMatchObject({ onStatement: false, excludedReason: 'invoice_cancelled' });
  });

  it('supplier: amount_paid with no allocation rows is a subledger-trail flag, not a statement-vs-GL one', () => {
    const b9 = doc(sup, 'B9');
    expect(b9.flags.map((f) => [f.class, f.bridge, f.amount])).toEqual([['amount_paid_differs_from_allocations', 'subledger_trail', 900]]);
    expect(b9.subledger).toMatchObject({ total: 900, settled: 900, allocated: 0, outstanding: 0 });
    expect(doc(sup, 'B1').subledger).toMatchObject({ settled: 400, allocated: 400, outstanding: 600 });
  });

  it('supplier: statement, aged and GL tie through the named classes', () => {
    // statement = bills 4770 - payments 700 - credits 250 = 3820; GL = 1000-400+600+400+900-150 = 2350
    expect(sup.totals).toMatchObject({
      statementBalance: 3820, glControlNet: 2350, statementMinusGl: 1470,
      classifiedDifference: 1350, unexplainedResidual: 120,
    });
    // aged = 600+500+300+800+700+250+200+120 = 3470; bridge: cash 300 + credit 250 - 900 unallocated = -350
    expect(sup.totals.agedNet).toBe(3470);
    expect(sup.totals.agedMinusStatement).toBe(-350);
    expect(sup.totals.agedBridge).toEqual({
      unappliedCash: 300, unappliedCredit: 250, writeOffs: 0, amountPaidWithoutAllocation: -900, unexplained: 0,
    });
    expect(sup.invariants.filter((i) => !i.holds)).toEqual([]);
    expect(sup.controlAccounts.map((a) => a.accountCode)).toEqual(['2110']);
  });

  it('supplier: company-wide control journals no document claims are counted apart, not in the totals', () => {
    // J5R (reversal, -700 on the balance) and STRAY (+77): a bare journal names no party.
    expect(sup.unattributed).toEqual({ scope: 'company', count: 2, net: -623 });
  });

  it('customer: write-offs, unconfirmed receipts and a receipt posted off-control', () => {
    expect(statementFlag(doc(cus, 'I2'))).toMatchObject({ class: 'document_not_linked_to_journal', amount: 500 });
    expect(statementFlag(doc(cus, 'W3'))).toMatchObject({ class: 'write_off_not_on_statement', amount: 600 });
    expect(statementFlag(doc(cus, 'R3'))).toMatchObject({ class: 'posted_to_non_control_account', amount: -200 });
    expect(statementFlag(doc(cus, 'R3'))?.postedTo?.map((a) => a.code)).toEqual(['1999']);
    expect(doc(cus, 'W4').flags.map((f) => [f.class, f.bridge, f.amount])).toEqual([['settlement_with_no_journal', 'subledger_trail', 300]]);
    expect(doc(cus, 'R2')).toMatchObject({ flags: [], statement: { onStatement: false, excludedReason: 'payment_not_confirmed' } });
    for (const n of ['I1', 'R1', 'I3', 'I4', 'CN1']) expect(statementFlag(doc(cus, n))).toBeUndefined();
  });

  it('customer: totals tie and the aged bridge closes through write-offs', () => {
    // statement = 2400 - 400 - 200 - 100 = 1700; GL = 1000-400+600-600+300-100 = 800
    expect(cus.totals).toMatchObject({
      statementBalance: 1700, glControlNet: 800, statementMinusGl: 900,
      classifiedDifference: 900, unexplainedResidual: 0, agedNet: 1100, agedMinusStatement: -600,
    });
    expect(cus.totals.agedBridge).toEqual({
      unappliedCash: 200, unappliedCredit: 100, writeOffs: -900, amountPaidWithoutAllocation: 0, unexplained: 0,
    });
    expect(cus.invariants.filter((i) => !i.holds)).toEqual([]);
    expect(cus.unattributed.count).toBe(0);
  });

  it('as_at moves every view: before the payments exist only the bills remain, and it still ties', async () => {
    const early = (await partyLedgerCheck(COMPANY, 'supplier', supplier, '2026-03-10'))!;
    expect(early.documents.some((d) => d.kind === 'payment' || d.kind === 'credit_note')).toBe(false);
    expect(early.invariants.filter((i) => !i.holds)).toEqual([]);
    // B1 and B9 were settled after the date: rewound, and allocations dated after it are not counted.
    expect(doc(early, 'B1').subledger).toMatchObject({ settled: 0, allocated: 0 });
    expect(doc(early, 'B1').flags).toEqual([]);
  });

  it('another party\'s documents, and another company\'s bill naming this supplier, are not in the check', () => {
    expect(sup.documents.some((d) => d.number === TAG + 'RB' || d.number === TAG + 'XB')).toBe(false);
    expect(cus.documents.some((d) => d.number === TAG + 'RI')).toBe(false);
  });

  it('a party in another company is indistinguishable from a miss', async () => {
    expect(await partyLedgerCheck(COMPANY, 'supplier', otherSupplier, AS_AT)).toBeNull();
    expect(await partyLedgerCheck(COMPANY, 'supplier', randomUUID(), AS_AT)).toBeNull();
    const res = await partyLedgerCheckTool.handler({ party_type: 'supplier', party_id: otherSupplier, as_at: AS_AT }, ctx);
    expect(res).toMatchObject({ isError: true, content: [{ text: 'Not found' }] });
  });

  it('tool: summary carries no rows, standard only the flagged, full everything, and pages walk without gaps', async () => {
    const base = { party_type: 'supplier', party_id: supplier, as_at: AS_AT };
    const summary = await call({ ...base, detail: 'summary' });
    expect(summary.rows).toEqual([]);
    expect(summary.totals.statementBalance).toBe(3820);
    expect(JSON.stringify(summary).length).toBeLessThan(6000);

    const flagged = sup.documents.filter((d) => d.flags.length > 0).map((d) => d.id);
    const standard = await call({ ...base });
    expect(standard.rows.map((r: PartyDocument) => r.id).sort()).toEqual([...flagged].sort());

    const full = await call({ ...base, detail: 'full' });
    expect(full.rowsTotal).toBe(sup.documents.length);

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const res = await call({ ...base, detail: 'full', limit: 4, ...(cursor ? { cursor } : {}) });
      seen.push(...res.rows.map((r: PartyDocument) => r.id));
      if (!res.next_cursor) break;
      cursor = res.next_cursor as string;
    }
    expect(seen).toEqual(sup.documents.map((d) => d.id));
  });
});
