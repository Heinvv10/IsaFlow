/**
 * Non-supply VAT exception (findVatNonSupplyLines): a reversed PAIR whose two
 * halves both fall inside the period moves no VAT in that period, so neither
 * half is listed (Hein, 2026-10-05 — Velocity Fibre Jan–Aug 2026 carried 34
 * such rows after every original had been re-coded, blocking the filing on
 * R0,00 of net tax). An unreversed line is still listed, and so is the
 * in-window half of a pair that straddles the period boundary.
 *
 * Journals are inserted directly: the posting-time non-supply guard would
 * (rightly) coerce a salary line's VAT code, and this test is about legacy
 * rows posted before that guard.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import { getVatExceptions } from '@/modules/accounting/services/reports/vatExceptionsService';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { dropFixture, inTx, seedFixture, type Fixture } from './helpers/l1FifoFixture';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;
const PERIOD = { start: '2026-07-01', end: '2026-08-31' };
type Row = Record<string, unknown>;
let fx: Fixture;
let salaries = '';
let vatInput = '';
const je: Record<string, string> = {};

async function salaryJournal(key: string, date: string, sign: 1 | -1, reversalOf?: string): Promise<void> {
  const rows = (await sql`
    INSERT INTO gl_journal_entries (company_id, entry_number, entry_date, description, status, created_by, reversal_of_id)
    VALUES (${fx.companyId}::UUID, ${`NS-${key}-${fx.tag}`}, ${date}::DATE, ${`salary ${key}`}, 'posted',
            ${fx.userId}::UUID, ${reversalOf ?? null}::UUID)
    RETURNING id`) as Row[];
  const id = String(rows[0]!.id);
  const legs: [string, number, number, string | null][] = [
    [salaries, sign > 0 ? 100 : 0, sign > 0 ? 0 : 100, 'standard'],
    [vatInput, sign > 0 ? 15 : 0, sign > 0 ? 0 : 15, 'standard'],
    [fx.bankAccountId, sign > 0 ? 0 : 115, sign > 0 ? 115 : 0, null],
  ];
  for (const [account, debit, credit, vatType] of legs) {
    await sql`INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit, vat_type)
      VALUES (${fx.companyId}::UUID, ${id}::UUID, ${account}::UUID, ${debit}, ${credit}, ${vatType})`;
  }
  je[key] = id;
}

describeIfDb('non-supply VAT exception ignores reversed pairs inside the period', () => {
  beforeAll(async () => {
    assertNotProductionDb('This test inserts journals.');
    fx = await seedFixture('NSR', DATABASE_URL!);
    const acct = (await sql`INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, normal_balance, is_active)
      VALUES (${fx.companyId}::UUID, '49784360', ${`Salaries & Wages ${fx.tag}`}, 'expense', 'debit', true) RETURNING id`) as Row[];
    salaries = String(acct[0]!.id);
    vatInput = String(((await sql`SELECT id FROM gl_accounts WHERE company_id = ${fx.companyId}::UUID AND account_subtype = 'vat_input'`) as Row[])[0]!.id);
    await salaryJournal('pairA', '2026-07-10', 1);
    await salaryJournal('pairB', '2026-07-10', -1, je.pairA);
    await salaryJournal('open', '2026-07-15', 1);
    await salaryJournal('straddleOrig', '2026-06-30', 1);
    await salaryJournal('straddleRev', '2026-07-05', -1, je.straddleOrig);
  }, 240000);

  afterAll(async () => {
    if (!fx) return;
    await sql`UPDATE gl_journal_entries SET reversal_of_id = NULL WHERE company_id = ${fx.companyId}::UUID`;
    await dropFixture(fx);
  }, 120000);

  it('lists the unreversed line and the in-window half of a straddling pair, not the in-window pair', async () => {
    const r = await inTx(fx, () => getVatExceptions(fx.companyId, PERIOD.start, PERIOD.end));
    const ids = r.vatNonSupplyLines.map((l) => l.journalEntryId).sort();
    expect(ids).toEqual([je.open, je.straddleRev].sort());
    expect(r.vatNonSupplyCount).toBe(2);
  });

  it('the straddling original is still listed in its own period', async () => {
    const r = await inTx(fx, () => getVatExceptions(fx.companyId, '2026-05-01', '2026-06-30'));
    expect(r.vatNonSupplyLines.map((l) => l.journalEntryId)).toEqual([je.straddleOrig]);
  });
});
