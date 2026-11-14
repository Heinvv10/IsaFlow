/**
 * party_ledger_check round 2 (ledger-breaker repro, kept verbatim) -- shared-journal attribution across subledgers, and the
 * statement's cancelled-payment change against master's service.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import { assertDisposableDb } from '../helpers/assertDisposableDb';
import { partyLedgerCheck } from '@/modules/accounting/services/reconciliation/partyLedgerCheckService';
import type { PartyLedgerCheck } from '@/modules/accounting/services/reconciliation/partyLedgerTypes';
import { fetchSupplierStatementData } from '@/modules/accounting/services/ap/supplierStatementService';
import { masterFetchSupplierStatementData } from '../helpers/masterSupplierStatement';
import {
  AS_AT, COMPANY, PAY_DATE, TAG, USER, account, bill, cleanup, journal, receipt, supplierPayment,
} from '../helpers/partyLedgerFixture';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;
const flags = (c: PartyLedgerCheck) =>
  c.documents.flatMap((d) => d.flags.map((f) => `${d.number?.replace(TAG, '')}:${f.class}:${f.amount}`));

let mixSup = '';
let mixCus = '';
let parity = '';

describeIfDb('party_ledger_check: mixed-subledger split and statement parity', () => {
  beforeAll(async () => {
    assertDisposableDb('breaker7b r2 seeds a whole company.');
    await sql`INSERT INTO companies (id, name, registration_number) VALUES (${COMPANY}::UUID, ${'BRK2 ' + TAG}, ${TAG})`;
    await sql`INSERT INTO users (id, email, role, is_active) VALUES (${USER}, ${USER + '@test.local'}, 'admin', true)`;
    const payable = await account('2110', 'Trade Creditors', 'liability', 'credit', 'payable');
    const receivable = await account('1120', 'Trade Debtors', 'asset', 'debit', 'receivable');
    const bank = await account('1000', 'Bank', 'asset', 'debit', 'bank');
    const expense = await account('5000', 'Materials', 'expense', 'debit', 'default_expense');

    // (M) ONE money-out bank line split to a supplier (payment 300) and a customer (refund 100),
    // as bankSplitContacts mints them: both documents carry the split journal.
    mixSup = ((await sql`INSERT INTO suppliers (company_id, name) VALUES (${COMPANY}::UUID, ${'mixs ' + TAG}) RETURNING id`) as { id: string }[])[0]!.id;
    mixCus = ((await sql`INSERT INTO customers (company_id, name) VALUES (${COMPANY}::UUID, ${'mixc ' + TAG}) RETURNING id`) as { id: string }[])[0]!.id;
    const bm = await bill(mixSup, 'BM', 300, await journal('JBM', '2026-03-01', [[expense, 300, 0], [payable, 0, 300]]), { paid: 300, status: 'paid' });
    // the customer had paid 100 on account earlier; the refund hands it back
    await receipt(mixCus, 'RC0', 100, await journal('JRC0', '2026-03-01', [[bank, 100, 0], [receivable, 0, 100]]));
    const jMix = await journal('JMIX', PAY_DATE, [[payable, 300, 0], [receivable, 100, 0], [bank, 0, 400]]);
    await supplierPayment(mixSup, 'PM', 300, jMix, [[bm, 300]]);
    await sql`
      INSERT INTO customer_payments (company_id, payment_number, client_id, payment_date, total_amount,
        status, payment_method, gl_journal_entry_id, created_by)
      VALUES (${COMPANY}::UUID, ${TAG + 'RFM'}, ${mixCus}::UUID, ${PAY_DATE}::date, -100, 'confirmed', 'refund',
        ${jMix}::UUID, ${USER}::UUID)`;

    // (S) statement parity with master for cancelled payments with NO reversal after as_at.
    parity = ((await sql`INSERT INTO suppliers (company_id, name) VALUES (${COMPANY}::UUID, ${'par ' + TAG}) RETURNING id`) as { id: string }[])[0]!.id;
    await bill(parity, 'BP', 5000, await journal('JBP', '2026-03-01', [[expense, 5000, 0], [payable, 0, 5000]]));
    const pay = async (n: string, amt: number, jdate: string | null, revDate: string | null, status: string) => {
      const j = jdate ? await journal('J' + n, jdate, [[payable, amt, 0], [bank, 0, amt]]) : null;
      if (j && revDate) await journal('J' + n + 'R', revDate, [[bank, amt, 0], [payable, 0, amt]], 'posted', j);
      const id = await supplierPayment(parity, n, amt, j);
      await sql`UPDATE supplier_payments SET status = ${status} WHERE id = ${id}::UUID`;
    };
    await pay('S1', 11, PAY_DATE, '2026-05-01', 'cancelled'); // reversed before as_at
    await pay('S2', 13, null, null, 'cancelled');             // no journal
    await pay('S3', 17, PAY_DATE, null, 'cancelled');         // never reversed
    await pay('S4', 19, PAY_DATE, '2026-07-15', 'processed'); // reversed later, not cancelled
    await pay('S5', 23, '2026-07-01', '2026-07-20', 'cancelled'); // journal itself after as_at
    await pay('S6', 29, PAY_DATE, AS_AT, 'cancelled');        // reversal ON as_at
  }, 120000);

  afterAll(async () => {
    await cleanup();
  }, 120000);

  it('(M) split shared by a supplier payment and a customer refund: both parties clean', async () => {
    const s = (await partyLedgerCheck(COMPANY, 'supplier', mixSup, AS_AT))!;
    const c = (await partyLedgerCheck(COMPANY, 'customer', mixCus, AS_AT))!;
    // Supplier: 300 billed, 300 paid; AP control +300 -300. Customer: -100 receipt, +100 refund; AR -100 +100.
    expect({ s: s.totals.statementBalance, c: c.totals.statementBalance }).toEqual({ s: 0, c: 0 });
    expect({ s: flags(s), sGap: s.totals.statementMinusGl, c: flags(c), cGap: c.totals.statementMinusGl })
      .toEqual({ s: [], sGap: 0, c: [], cGap: 0 });
  });

  it('(S) cancelled payments without a later reversal: statement identical to master', async () => {
    for (const asAt of ['2026-04-30', AS_AT, '2026-07-10']) {
      const now = (await fetchSupplierStatementData(COMPANY, parity, asAt))!;
      const was = (await masterFetchSupplierStatementData(COMPANY, parity, asAt))!;
      // S4 is processed (master counts it too); only S-rows cancelled with a reversal AFTER asAt may differ.
      // By design: 04-30 -> S1 (rev 05-01) + S6 (rev 06-30) = 40; 06-30 -> 0; 07-10 -> S5 (rev 07-20) = 23.
      const expectedLive = ({ '2026-04-30': 40, [AS_AT]: 0, '2026-07-10': 23 } as Record<string, number>)[asAt];
      expect({ asAt, delta: Math.round((was.summary.balance - now.summary.balance) * 100) / 100 })
        .toEqual({ asAt, delta: expectedLive });
    }
  });
});
