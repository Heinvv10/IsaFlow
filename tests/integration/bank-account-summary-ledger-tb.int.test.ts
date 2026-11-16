/**
 * WP1 PR-B: the bank card's ledger balance IS the Trial Balance bank row at period end, against a real ledger.
 *
 * The ledger figure is `bankGlBalanceAsAt` (posted journals, entry_date <= as at), the reconciliation's own definition
 * (K-020). Fixture (l1FifoFixture: one open FY2026 period), each item there to catch one wrong ledger:
 *   - opening balances posted through postOpeningBalances (dated the period start, 2026-01-01): bank DR R10 000.00;
 *   - a statement line of −R1 234.56 allocated with allocateTransaction (bank CR 1 234.56);
 *   - a R500.00 journal (bank DR) posted, then reversed with reverseJournalEntry (nets to zero);
 *   - a R777.77 journal (bank DR) left a draft;
 *   - a R100.00 journal (bank DR) posted 2026-12-15;
 *   - gl_accounts.bank_opening_balance = R99 999.99 (display metadata, no journal behind it).
 *
 * Expected, in cents: 1 000 000 − 123 456 + 50 000 − 50 000 + 10 000 = 886 544 at 2026-12-31 (= the TB bank row),
 * and 876 544 at 2026-11-15 (the R100.00 journal is after it). The draft, the bank_opening_balance and the statement
 * line's own amount are in neither.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import { allocateTransaction } from '@/modules/accounting/services/bank/bankAllocationService';
import { getBankAccountSummaries } from '@/modules/accounting/services/bank/bankAccountSummaryService';
import { postOpeningBalances } from '@/modules/accounting/services/gl/openingBalancePostingService';
import { createJournalEntry } from '@/modules/accounting/services/gl/journalEntryCrudService';
import { postJournalEntry, reverseJournalEntry } from '@/modules/accounting/services/gl/journalEntryPostingService';
import { getTrialBalance } from '@/modules/accounting/services/gl/trialBalanceService';
import { dropFixture, inTx, seedBankTx, seedFixture, type Fixture } from './helpers/l1FifoFixture';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

let fx: Fixture;
let expense = '';
let equity = '';
let periodId = '';

const one = async <T>(q: Promise<unknown>) => ((await q) as T[])[0]!;

/** A journal DR bank / CR expense of `amount`, dated `date`; posted unless `draft`. Returns its id. */
async function bankJournal(amount: number, date: string, draft = false): Promise<string> {
  return inTx(fx, async () => {
    const entry = await createJournalEntry(fx.companyId, {
      entryDate: date, description: `WP1 ledger ${amount}`, source: 'manual',
      lines: [
        { glAccountId: fx.bankAccountId, debit: amount, credit: 0, description: 'bank' },
        { glAccountId: expense, debit: 0, credit: amount, description: 'contra' },
      ],
    }, fx.userId);
    if (!draft) await postJournalEntry(fx.companyId, entry.id, fx.userId);
    return entry.id;
  });
}

async function ledgerCents(asAt: string): Promise<number> {
  const { accounts } = await getBankAccountSummaries(fx.companyId, { asAt });
  expect(accounts.map((a) => a.id)).toEqual([fx.bankAccountId]);
  expect(accounts[0]!.ledgerAsAt).toBe(asAt);
  return accounts[0]!.ledgerCents;
}

describeIfDb('WP1 PR-B — the bank ledger balance equals the Trial Balance bank row', () => {
  beforeAll(async () => {
    fx = await seedFixture('WP1B-TB', DATABASE_URL!);
    expense = (await one<{ id: string }>(sql`
      SELECT id FROM gl_accounts WHERE company_id = ${fx.companyId}::UUID AND account_code = '6000'`)).id;
    equity = (await one<{ id: string }>(sql`
      INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, normal_balance, is_active, level)
      VALUES (${fx.companyId}::UUID, '3900', ${`Opening Balance Equity ${fx.tag}`}, 'equity', 'credit', true, 3)
      RETURNING id`)).id;
    // postOpeningBalances posts only to level-3 (posting) accounts; the fixture's default level is 1.
    await sql`UPDATE gl_accounts SET level = 3 WHERE company_id = ${fx.companyId}::UUID AND id = ${fx.bankAccountId}::UUID`;
    periodId = (await one<{ id: string }>(sql`
      SELECT id FROM fiscal_periods WHERE company_id = ${fx.companyId}::UUID`)).id;

    await inTx(fx, () => postOpeningBalances(fx.companyId, fx.userId, [
      { accountId: fx.bankAccountId, debit: 10000 },
      { accountId: equity, credit: 10000 },
    ]));
    const line = await seedBankTx(fx, { date: '2026-03-10', amount: -1234.56, description: 'WP1 card spend' });
    await inTx(fx, () => allocateTransaction(fx.companyId, line, expense, fx.userId, undefined, 'account', undefined));
    const reversed = await bankJournal(500, '2026-06-01');
    await inTx(fx, () => reverseJournalEntry(fx.companyId, reversed, fx.userId, { reversalDate: '2026-06-02' }));
    await bankJournal(777.77, '2026-07-01', true);
    await bankJournal(100, '2026-12-15');
    await sql`UPDATE gl_accounts SET bank_opening_balance = 99999.99
              WHERE company_id = ${fx.companyId}::UUID AND id = ${fx.bankAccountId}::UUID`;
  }, 120000);

  afterAll(async () => { if (fx) await dropFixture(fx); });

  it('the fixture is what the expected figures assume', async () => {
    const statuses = (await sql`
      SELECT je.status, COUNT(*)::INT AS n, (je.reversed_at IS NOT NULL) AS reversed
      FROM gl_journal_entries je WHERE je.company_id = ${fx.companyId}::UUID
      GROUP BY 1, 3 ORDER BY 1, 3`) as { status: string; n: number; reversed: boolean }[];
    // opening, allocation, R500, its reversal, R100 posted (the R500 original carries reversed_at); one draft.
    expect(statuses).toEqual([
      { status: 'draft', n: 1, reversed: false },
      { status: 'posted', n: 4, reversed: false },
      { status: 'posted', n: 1, reversed: true },
    ]);
  });

  it('at 2026-12-31 the ledger is 886 544 cents, exactly the Trial Balance bank row (debit − credit)', async () => {
    const tb = await inTx(fx, () => getTrialBalance(fx.companyId, periodId));
    const bankRow = tb.find((r) => r.accountCode === '1000')!;
    const tbCents = Math.round(bankRow.debitBalance * 100) - Math.round(bankRow.creditBalance * 100);
    expect(tbCents).toBe(886544);
    expect(await ledgerCents('2026-12-31')).toBe(tbCents);
  });

  it('at 2026-11-15 the ledger is 876 544 cents: the R100.00 journal of 2026-12-15 is after it', async () => {
    expect(await ledgerCents('2026-11-15')).toBe(876544);
  });
});
