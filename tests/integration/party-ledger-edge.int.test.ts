/**
 * party_ledger_check edges: paging across many same-date documents of every real
 * kind, a foreign-currency bill, a receipt cancelled after the as-at date, credit
 * applied only after it, and the document cap. Every party is clean unless the
 * test says otherwise, so a flag is a false positive.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import { assertDisposableDb } from '../helpers/assertDisposableDb';
import { partyLedgerCheck } from '@/modules/accounting/services/reconciliation/partyLedgerCheckService';
import { assertPartySize, PartyTooLargeError } from '@/modules/accounting/services/reconciliation/partyLedgerSize';
import { fetchStatementData } from '@/modules/accounting/services/ar/statementEmailService';
import { fetchSupplierStatementData } from '@/modules/accounting/services/ap/supplierStatementService';
import { fmtDate } from '@/lib/fmtDate';
import { partyLedgerCheckTool } from '@/lib/mcp/tools/partyLedgerCheck';
import type { McpToolContext } from '@/lib/mcp/types';
import {
  AS_AT, COMPANY, DOC_DATE, PAY_DATE, TAG, USER, account, bill, cleanup, creditNote, invoice, journal, receipt,
  supplierPayment, writeOff,
} from '../helpers/partyLedgerFixture';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;
const ctx = { userId: USER, companyId: COMPANY, scopes: ['read:reports'], tokenJti: 'j', oauthAppId: 'a' } as McpToolContext;
const call = async (args: Record<string, unknown>) =>
  JSON.parse(((await partyLedgerCheckTool.handler(args, ctx)).content[0] as { text: string }).text) as Record<string, any>;

let payable = '';
let expense = '';
let receivable = '';
let bank = '';
let sales = '';
const party = async (table: 'suppliers' | 'customers', n: string) =>
  ((table === 'suppliers'
    ? await sql`INSERT INTO suppliers (company_id, name) VALUES (${COMPANY}::UUID, ${n + TAG}) RETURNING id`
    : await sql`INSERT INTO customers (company_id, name) VALUES (${COMPANY}::UUID, ${n + TAG}) RETURNING id`) as { id: string }[])[0]!.id;
const sjournal = (n: string, amt: number, date = DOC_DATE) => journal(n, date, [[expense, amt, 0], [payable, 0, amt]]);
const cjournal = (n: string, amt: number, date = DOC_DATE) => journal(n, date, [[receivable, amt, 0], [sales, 0, amt]]);

let pager = '';
let fxSupplier = '';
let cancelledCustomer = '';
let creditSupplier = '';
let voidSupplier = '';
let voidCustomer = '';

describeIfDb('party_ledger_check edges', () => {
  beforeAll(async () => {
    assertDisposableDb('party_ledger_check seeds whole companies and journals.');
    await sql`INSERT INTO companies (id, name, registration_number, fx_documents_enabled)
              VALUES (${COMPANY}::UUID, ${'PLE ' + TAG}, ${TAG}, true)`;
    await sql`INSERT INTO users (id, email, role, is_active) VALUES (${USER}, ${USER + '@test.local'}, 'admin', true)`;
    payable = await account('2110', 'Trade Creditors', 'liability', 'credit', 'payable');
    expense = await account('5000', 'Materials', 'expense', 'debit', 'default_expense');
    receivable = await account('1120', 'Trade Debtors', 'asset', 'debit', 'receivable');
    bank = await account('1000', 'Bank', 'asset', 'debit', 'bank');
    sales = await account('4000', 'Sales', 'revenue', 'credit', 'default_revenue');
    const badDebt = await account('5900', 'Bad Debts', 'expense', 'debit', 'default_expense');

    // (1) PAGER: 29 documents of all four real kinds, every one dated PAY_DATE.
    pager = await party('customers', 'pager ');
    for (let i = 0; i < 8; i++) {
      await invoice(pager, `PI${i}`, 100, await cjournal(`KPI${i}`, 100, PAY_DATE), 0, PAY_DATE);
    }
    for (let i = 0; i < 7; i++) await creditNote('customer', pager, `PC${i}`, 10, await journal(`KPC${i}`, PAY_DATE, [[sales, 10, 0], [receivable, 0, 10]]));
    for (let i = 0; i < 7; i++) await receipt(pager, `PR${i}`, 20, await journal(`KPR${i}`, PAY_DATE, [[bank, 20, 0], [receivable, 0, 20]]));
    const wi = await invoice(pager, 'PW', 500, await cjournal('KPW', 500, PAY_DATE), 300, PAY_DATE);
    for (let i = 0; i < 6; i++) {
      await writeOff(pager, wi, `PO${i}`, 50, await journal(`KPO${i}`, PAY_DATE, [[badDebt, 50, 0], [receivable, 0, 50]]));
    }

    // (2) FX: an approved USD bill. Posting books the document figure (total_amount) as rands.
    fxSupplier = await party('suppliers', 'fx ');
    const fxBill = await bill(fxSupplier, 'FX1', 1000, await sjournal('JFX1', 1000));
    await sql`UPDATE supplier_invoices SET currency_code = 'USD', exchange_rate = 18, functional_total = 18000 WHERE id = ${fxBill}::UUID`;

    // (3) A receipt confirmed in March and cancelled 15 July (its journal reversed that day).
    cancelledCustomer = await party('customers', 'cancelled ');
    await invoice(cancelledCustomer, 'CI', 1000, await cjournal('KCI', 1000));
    const jr = await journal('KCR', PAY_DATE, [[bank, 400, 0], [receivable, 0, 400]]);
    await journal('KCRR', '2026-07-15', [[receivable, 400, 0], [bank, 0, 400]], 'posted', jr);
    const rid = await receipt(cancelledCustomer, 'CR', 400, jr, 'confirmed');
    await sql`UPDATE customer_payments SET status = 'cancelled' WHERE id = ${rid}::UUID`;

    // (4) A supplier credit note applied ONLY to a bill dated after as_at.
    creditSupplier = await party('suppliers', 'credit ');
    const cn = await creditNote('supplier', creditSupplier, 'SC', 100, await journal('JSC', PAY_DATE, [[payable, 100, 0], [expense, 0, 100]]));
    const future = ((await sql`
      INSERT INTO supplier_invoices (company_id, supplier_id, invoice_number, invoice_date, due_date, status, subtotal,
        tax_amount, total_amount, amount_paid, gl_journal_entry_id, created_by)
      VALUES (${COMPANY}::UUID, ${creditSupplier}::UUID, ${TAG + 'SF'}, '2026-08-10', '2026-08-10', 'paid', 100, 0, 100, 100,
        ${await sjournal('JSF', 100, '2026-08-10')}::UUID, ${USER}::UUID) RETURNING id`) as { id: string }[])[0]!.id;
    await sql`INSERT INTO credit_note_allocations (company_id, credit_note_id, invoice_id, amount_allocated)
              VALUES (${COMPANY}::UUID, ${cn}::UUID, ${future}::UUID, 100)`;
    await sql`UPDATE credit_notes SET status = 'applied', applied_amount = 100 WHERE id = ${cn}::UUID`;

    // (5) Cancelled payments in four states, for one supplier: PX never reversed (a data defect),
    // PY reversed BEFORE as_at, PZ reversed AFTER it. And a receipt cancelled with its journal never reversed.
    voidSupplier = await party('suppliers', 'void ');
    await bill(voidSupplier, 'VB', 1000, await sjournal('JVB', 1000));
    const cancelled = async (n: string, amount: number, reversedOn: string | null, reversalStatus = 'posted') => {
      const j = await journal('JV' + n, PAY_DATE, [[payable, amount, 0], [bank, 0, amount]]);
      if (reversedOn) await journal('JV' + n + 'R', reversedOn, [[bank, amount, 0], [payable, 0, amount]], reversalStatus, j);
      const id = await supplierPayment(voidSupplier, n, amount, j);
      await sql`UPDATE supplier_payments SET status = 'cancelled' WHERE id = ${id}::UUID`;
    };
    await cancelled('PX', 300, null);
    await cancelled('PY', 200, '2026-05-01');
    await cancelled('PZ', 400, '2026-07-15');
    await cancelled('PW', 150, '2026-07-20', 'draft'); // a reversal that was never posted is no reversal
    voidCustomer = await party('customers', 'void ');
    await invoice(voidCustomer, 'VI', 1000, await cjournal('KVI', 1000));
    const unrev = await receipt(voidCustomer, 'VR', 250, await journal('KVR', PAY_DATE, [[bank, 250, 0], [receivable, 0, 250]]));
    await sql`UPDATE customer_payments SET status = 'cancelled' WHERE id = ${unrev}::UUID`;
  }, 120000);

  afterAll(async () => {
    await sql`DELETE FROM credit_note_allocations WHERE company_id = ${COMPANY}::UUID`;
    await cleanup();
  }, 120000);

  it('paging: 29 documents of four real kinds on one date walk in (date, kind, id) order, once each, at any page size', async () => {
    const base = { party_type: 'customer', party_id: pager, as_at: AS_AT, detail: 'full' };
    const all = await call({ ...base, limit: 500 });
    expect(all.rows).toHaveLength(9 + 7 + 7 + 6);
    const key = (d: { date: string; kind: string; id: string }) => [d.date, { invoice: 0, credit_note: 1, payment: 2, write_off: 3 }[d.kind], d.id];
    const expected = [...all.rows].sort((a, b) => {
      const x = key(a); const y = key(b);
      for (let i = 0; i < 3; i++) if (x[i]! !== y[i]!) return x[i]! < y[i]! ? -1 : 1;
      return 0;
    }).map((r: { id: string }) => r.id);
    expect(all.rows.map((r: { id: string }) => r.id)).toEqual(expected);
    expect(new Set(all.rows.map((r: { kind: string }) => r.kind))).toEqual(new Set(['invoice', 'credit_note', 'payment', 'write_off']));

    for (const limit of [1, 5, 7, 27]) {
      const seen: string[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 40; page++) {
        const res = await call({ ...base, limit, ...(cursor ? { cursor } : {}) });
        seen.push(...res.rows.map((r: { id: string }) => r.id));
        if (!res.next_cursor) break;
        cursor = res.next_cursor as string;
      }
      expect({ limit, seen }).toEqual({ limit, seen: expected });
    }
  });

  it('FX: an approved foreign bill is compared on the figure posting books (total_amount), not functional_total', async () => {
    const c = (await partyLedgerCheck(COMPANY, 'supplier', fxSupplier, AS_AT))!;
    const d = c.documents[0]!;
    expect(d.flags).toEqual([]);
    expect(d.statement.effect).toBe(1000);
    expect(d.gl.controlNet).toBe(1000);
    // functional_total (18000) is an approval-matching figure; nothing posts it yet (FX PR3).
    const [row] = (await sql`SELECT functional_total::float8 AS f FROM supplier_invoices WHERE id = ${d.id}::UUID`) as { f: number }[];
    expect(row!.f).toBe(18000);
  });

  it('a receipt cancelled AFTER as_at stands on the statement and ties to the ledger; once cancelled it leaves both', async () => {
    const st = (await fetchStatementData(COMPANY, cancelledCustomer, AS_AT))!;
    expect(st.summary.balance).toBe(600);
    const at = (await partyLedgerCheck(COMPANY, 'customer', cancelledCustomer, AS_AT))!;
    expect(at.totals).toMatchObject({ statementBalance: 600, glControlNet: 600, statementMinusGl: 0, unexplainedResidual: 0 });
    expect(at.documents.flatMap((d) => d.flags)).toEqual([]);
    const after = (await partyLedgerCheck(COMPANY, 'customer', cancelledCustomer, '2026-07-31'))!;
    expect(after.totals).toMatchObject({ statementBalance: 1000, glControlNet: 1000, statementMinusGl: 0 });
    expect(after.documents.find((d) => d.kind === 'payment')!.statement).toMatchObject({ onStatement: false, excludedReason: 'payment_not_confirmed' });
    expect(after.documents.flatMap((d) => d.flags)).toEqual([]);
  });

  it('credit applied only to a later bill is unapplied credit at as_at: the aged bridge closes and the credit note is clean', async () => {
    const c = (await partyLedgerCheck(COMPANY, 'supplier', creditSupplier, AS_AT))!;
    const cn = c.documents.find((d) => d.kind === 'credit_note')!;
    expect(cn.subledger).toMatchObject({ settled: 100, allocated: 0, unapplied: 100 });
    expect(cn.flags).toEqual([]);
    expect(c.totals.agedBridge).toMatchObject({ unappliedCredit: 100, unexplained: 0 });
    expect(c.totals).toMatchObject({ agedMinusStatement: 100, unexplainedResidual: 0 });
    // And once the bill exists, the allocation counts.
    const later = (await partyLedgerCheck(COMPANY, 'supplier', creditSupplier, '2026-12-31'))!;
    expect(later.documents.find((d) => d.kind === 'credit_note')!.subledger).toMatchObject({ allocated: 100, unapplied: 0 });
    expect(later.totals.agedBridge.unexplained).toBe(0);
  });

  it('refuses a party with more documents than the cap, with the count, before comparing anything', async () => {
    await expect(assertPartySize('ar', COMPANY, pager, AS_AT, 10)).rejects.toBeInstanceOf(PartyTooLargeError);
    await expect(assertPartySize('ar', COMPANY, pager, AS_AT, 10)).rejects.toThrow(/has 29 documents/);
    await expect(assertPartySize('ar', COMPANY, pager, AS_AT, 29)).resolves.toBeUndefined();
  });

  it('statements: only a cancellation reversed AFTER as_at stands at as_at; an unreversed or earlier-reversed one stays off, and TODAY is unchanged', async () => {
    const today = fmtDate(new Date());
    const at = (await fetchSupplierStatementData(COMPANY, voidSupplier, AS_AT))!;
    expect(at.transactions.filter((t) => t.type === 'payment').map((t) => t.reference.replace(TAG, ''))).toEqual(['PZ']);
    expect(at.summary.balance).toBe(600);
    expect(at.excluded.map((e) => e.documentNumber?.replace(TAG, '')).sort()).toEqual(['PW', 'PX', 'PY']);
    // Today: all three cancelled payments are off, exactly as the statement always had them.
    const now = (await fetchSupplierStatementData(COMPANY, voidSupplier, today))!;
    expect(now.transactions.filter((t) => t.type === 'payment')).toEqual([]);
    expect(now.summary.balance).toBe(1000);
    expect(now.excluded.map((e) => e.reason)).toEqual(Array(4).fill('payment_not_processed'));
    // Customer: a cancelled receipt whose journal was never reversed stays off at both dates.
    for (const date of [AS_AT, today]) {
      const c = (await fetchStatementData(COMPANY, voidCustomer, date))!;
      expect({ date, balance: c.summary.balance, receipts: c.transactions.filter((t) => t.type === 'payment').length })
        .toEqual({ date, balance: 1000, receipts: 0 });
    }
  });

  it('party_ledger_check names a cancelled payment whose journal was never reversed, and only that one', async () => {
    const c = (await partyLedgerCheck(COMPANY, 'supplier', voidSupplier, AS_AT))!;
    const byNo = (n: string) => c.documents.find((d) => d.number === TAG + n)!;
    expect(byNo('PX').flags.map((f) => [f.class, f.amount])).toEqual([['cancelled_payment_journal_stands', 300]]);
    expect(byNo('PW').flags.map((f) => [f.class, f.amount])).toEqual([['cancelled_payment_journal_stands', 150]]);
    expect(byNo('PY').flags).toEqual([]); // reversed before as_at: off the statement and off the ledger
    expect(byNo('PZ').flags).toEqual([]); // reversed after as_at: on the statement and on the ledger
    expect(c.totals).toMatchObject({ statementBalance: 600, glControlNet: 150, statementMinusGl: 450, unexplainedResidual: 0 });
    const r = (await partyLedgerCheck(COMPANY, 'customer', voidCustomer, AS_AT))!;
    expect(r.documents.flatMap((d) => d.flags.map((f) => f.class))).toEqual(['cancelled_payment_journal_stands']);
  });
});
