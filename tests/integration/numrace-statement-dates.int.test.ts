/**
 * Ledger-date window, round 6.
 *   S5 (sec-numrace): a statement line whose parser kept a non-canonical date ('0001-06-01T00:00:00') reached the
 *      ::DATE cast at insert unchecked. The import step (bank/bankStatementLedgerDays) now lets Postgres read it: a day
 *      outside the window is a row error, an in-window one is stored as the day Postgres reads.
 *   DateStyle (sec note): the cast is read back as to_char(…, 'YYYY-MM-DD'), so under 'SQL, DMY' or 'German' a
 *      canonical day and an ISO timestamp still pass and the window still refuses.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import { parseStatement } from '@/modules/accounting/services/bank/bankStatementParseService';
import { importParsedTransactions } from '@/modules/accounting/services/bank/bankImportService';
import { ledgerDaysOf, ledgerEntryDay } from '@/modules/accounting/services/gl/journalDateGuard';
import { isJournalDateRefused } from '@/modules/accounting/utils/journalDateWindow';
import { assertLocalFixtureDbUrl } from './fixtureDbGuard';
import { dropFixture, inTx } from './helpers/l1FifoFixture';
import { seedDateFixture, type DateFixture } from './helpers/numraceDateFixture';

const DATABASE_URL = process.env.DATABASE_URL;
let c: DateFixture;

describe.skipIf(!DATABASE_URL)('ledger-date window: statement import and DateStyle', () => {
  beforeAll(async () => {
    assertLocalFixtureDbUrl('DATABASE_URL', DATABASE_URL, ['isaflow_test', 'isaflow_schema_fixture']);
    c = await seedDateFixture('NUMRACE-SD', DATABASE_URL!);
  }, 60000);
  afterAll(async () => {
    await sql`UPDATE bank_transactions SET import_batch_id = NULL WHERE company_id = ${c.fx.companyId}::UUID`;
    await sql`DELETE FROM bank_import_batches WHERE company_id = ${c.fx.companyId}::UUID`;
    await dropFixture(c.fx);
  }, 60000);

  it("S5: sec's CSV — '0001-06-01T00:00:00' is a row error; '2025-03-31T00:00:00' is stored as 2025-03-31", async () => {
    const csv = ['Date,Description,Amount', `0001-06-01T00:00:00,NRSD old ${c.fx.tag},-1.00`,
      `2025-03-31T00:00:00,NRSD stamp ${c.fx.tag},-2.00`, `2025-04-01,NRSD plain ${c.fx.tag},-3.00`].join('\n');
    const parsed = await parseStatement({ fileType: 'csv', csvContent: csv, bankFormat: 'generic' } as never);
    const r = await inTx(c.fx, () => importParsedTransactions(c.fx.companyId, parsed, c.fx.bankAccountId, '2025-04-30',
      { skipPostImportEffects: true }));
    const rows = (await sql`SELECT transaction_date::text AS d FROM bank_transactions
      WHERE company_id = ${c.fx.companyId}::UUID AND description LIKE 'NRSD %' ORDER BY d`) as { d: string }[];
    process.stdout.write(`SD-S5 ${JSON.stringify({ parsed: parsed.transactions.map((t) => t.transactionDate), r, rows })}\n`);
    expect(rows.map((x) => x.d)).toEqual(['2025-03-31', '2025-04-01']);
    expect(r.errors.map((e) => e.error).join(' ')).toMatch(/0001-06-01 is outside 1900-01-01 to 2199-12-31/);
  }, 60000);

  it.each(["SQL, DMY", 'German'])('DateStyle %s: canonical and ISO timestamps pass as YYYY-MM-DD; the window refuses', async (style) => {
    const out = await inTx(c.fx, async () => {
      await sql`SELECT set_config('DateStyle', ${style}, true)`;
      const days = await ledgerDaysOf(['2025-03-31', '2025-03-31T10:00:00', '2199-12-31 24:00', '2025-03-31 BC',
        '100000-01-01', 'infinity']);
      let refused: unknown = null;
      try { await ledgerEntryDay('2200-01-01T00:00:00'); } catch (e) { refused = e; }
      return { days: Object.fromEntries(days), refused: isJournalDateRefused(refused),
        stamp: await ledgerEntryDay('2025-03-31T10:00:00') };
    });
    process.stdout.write(`SD-style ${style} ${JSON.stringify(out)}\n`);
    expect(out.days['2025-03-31']).toBe('2025-03-31');
    expect(out.days['2025-03-31T10:00:00']).toBe('2025-03-31');
    expect(out.days['2199-12-31 24:00']).toBe('2199-12-31');
    expect(out.days['2025-03-31 BC']).toBe('2025-03-31 BC');
    expect(out.days['100000-01-01']).toBe('100000-01-01');
    expect(out.days['infinity']).toBe('infinity');
    expect(out.stamp).toBe('2025-03-31');
    expect(out.refused).toBe(true);
  }, 60000);
});
