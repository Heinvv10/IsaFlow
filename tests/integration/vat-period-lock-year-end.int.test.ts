/**
 * The year-end close INSERTs its journal straight at status='posted', so it
 * never meets postJournalEntry and carries the VAT-lock guard of its own.
 *
 * What counts as moving a VAT figure is what the lock RECORDED: the VAT201
 * snapshot (vatBoxBasis) reads only the vat_input / vat_output tax legs plus
 * vat_type-tagged lines. So zeroing an UNTAGGED 'tax'-subtype P&L account —
 * Brightsphere's PAYE and Income Tax expense accounts are exactly that — changes
 * nothing a filed return recorded, and the close must NOT be refused for it;
 * refusing would strand every such company's year end behind its VAT filing.
 * A P&L account carrying the vat_input subtype IS a tax leg, and is refused.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sql } from '@/lib/neon';
import { closeFiscalYear } from '@/modules/accounting/services/gl/yearEndCloseService';
import { VatPeriodLockedError } from '@/modules/accounting/services/gl/journalVatLockGuard';
import { clearSystemAccountCache } from '@/modules/accounting/services/gl/systemAccountResolver';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { dropFixture, inTx, seedFixture, type Fixture } from './helpers/l1FifoFixture';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

type Row = Record<string, unknown>;
let fx: Fixture;
let paye = '';
let misfiledVat = '';
let je = '';

describeIfDb('year-end close into a locked VAT period', () => {
  // Per test, not per file: a successful close commits (journal + locked periods) and is idempotent,
  // so a shared company made the second test see the first one's close and get no refusal at all.
  beforeEach(async () => {
    assertNotProductionDb('This test closes a fiscal year.');
    fx = await seedFixture('VLY', DATABASE_URL!);
    const c = fx.companyId;
    await sql`UPDATE companies SET financial_year_start = 1 WHERE id = ${c}::UUID`;
    await sql`UPDATE fiscal_periods SET status = 'closed' WHERE company_id = ${c}::UUID`;
    await sql`
      INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype,
                               normal_balance, is_active, is_system_account)
      VALUES (${c}::UUID, '3200', ${`RE ${fx.tag}`}, 'equity', 'retained_earnings', 'credit', true, true)`;
    const acct = async (code: string, subtype: string) => String(((await sql`
      INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype,
                               normal_balance, is_active)
      VALUES (${c}::UUID, ${code}, ${`${code} ${fx.tag}`}, 'expense', ${subtype}, 'debit', true)
      RETURNING id`) as Row[])[0]!.id);
    paye = await acct('7100', 'tax');
    misfiledVat = await acct('7200', 'vat_input');
    je = String(((await sql`
      INSERT INTO gl_journal_entries
        (company_id, entry_number, entry_date, description, status, created_by, fiscal_period_id, posted_at, source)
      VALUES (${c}::UUID, ${`VLY-1-${fx.tag}`}, '2026-03-31', 'PAYE', 'posted', ${fx.userId}::UUID,
              (SELECT id FROM fiscal_periods WHERE company_id = ${c}::UUID LIMIT 1), NOW(), 'manual')
      RETURNING id`) as Row[])[0]!.id);
    await sql`
      INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit, description)
      VALUES (${c}::UUID, ${je}::UUID, ${paye}::UUID, 250, 0, 'PAYE'),
             (${c}::UUID, ${je}::UUID, ${fx.bankAccountId}::UUID, 0, 250, 'paid')`;
    await sql`
      INSERT INTO vat_period_locks
        (company_id, period_start, period_end, output_tax, input_tax, net_vat, posted_through, locked_by)
      VALUES (${c}::UUID, '2026-11-01', '2026-12-31', 0, 0, 0, NOW(), ${fx.userId})`;
    clearSystemAccountCache(c);
  }, 120000);

  afterEach(async () => {
    clearSystemAccountCache(fx.companyId);
    await sql`DELETE FROM vat_period_locks WHERE company_id = ${fx.companyId}::UUID`;
    await dropFixture(fx);
  }, 120000);

  /** Whether the dev schema admits source='year_end' (migration 627). */
  async function yearEndSourceAdmitted(): Promise<boolean> {
    const rows = (await sql`
      SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conname = 'gl_journal_entries_source_check'`) as Row[];
    return rows.some((r) => String(r.def).includes('year_end'));
  }

  const counts = async () => ((await sql`
    SELECT (SELECT COUNT(*)::INT FROM gl_journal_entries WHERE company_id = ${fx.companyId}::UUID AND source = 'year_end') AS je,
           (SELECT COUNT(*)::INT FROM fiscal_periods WHERE company_id = ${fx.companyId}::UUID AND status = 'locked') AS locked`) as Row[])[0];

  it('ALLOWS closing an untagged tax-subtype (PAYE) account inside the lock — the return never recorded it', async () => {
    const err = await inTx(fx, () => closeFiscalYear(fx.companyId, '2026', fx.userId)).then(() => null, (e: unknown) => e);
    expect(err).not.toBeInstanceOf(VatPeriodLockedError);
    if (await yearEndSourceAdmitted()) {
      expect(err).toBeNull();
      return;
    }
    // isaflow_dev lacks migration 627, so its source CHECK rejects 'year_end' at
    // the INSERT — which runs only AFTER the guard has let the journal through.
    expect(err).toMatchObject({ code: '23514', constraint: 'gl_journal_entries_source_check' });
    expect(await counts()).toEqual({ je: 0, locked: 0 });
  });

  it('refuses the close when a P&L account carries the vat_input subtype, writing nothing', async () => {
    await sql`
      INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit, description)
      VALUES (${fx.companyId}::UUID, ${je}::UUID, ${misfiledVat}::UUID, 15, 0, 'misfiled VAT'),
             (${fx.companyId}::UUID, ${je}::UUID, ${fx.bankAccountId}::UUID, 0, 15, 'paid')`;
    const err = await inTx(fx, () => closeFiscalYear(fx.companyId, '2026', fx.userId)).then(() => null, (e: unknown) => e);
    // Only the VAT-lock guard raises this class, so this names the refusal's source.
    expect(err).toBeInstanceOf(VatPeriodLockedError);
    expect(err).toMatchObject({ date: '2026-12-31', periodStart: '2026-11-01', periodEnd: '2026-12-31' });
    expect(await counts()).toEqual({ je: 0, locked: 0 });
  });
});
