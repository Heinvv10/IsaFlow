/**
 * A reversal is the one posting a VAT lock does not simply refuse: when the
 * caller names no date, a contra that would land inside a filed period ROLLS
 * FORWARD to the first date that is outside every active lock and inside an
 * open fiscal period, and the result says so. A date the caller names inside
 * a lock is refused — rolling a date somebody chose would be overriding them.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from '@/lib/neon';
import { reverseJournalEntry } from '@/modules/accounting/services/gl/journalEntryService';
import { VatPeriodLockedError } from '@/modules/accounting/services/gl/journalVatLockGuard';
import { reverseJournalEntryTool } from '@/lib/mcp/tools/writeJournalReverse';
import type { McpToolContext } from '@/lib/mcp/types';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { dropFixture, inTx, seedFixture, type Fixture } from './helpers/l1FifoFixture';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

type Row = Record<string, unknown>;
let fx: Fixture;
let seq = 0;
const acc: Record<string, string> = {};

async function accountBySubtype(subtype: string): Promise<string> {
  return String(((await sql`
    SELECT id FROM gl_accounts WHERE company_id = ${fx.companyId}::UUID AND account_subtype = ${subtype}
    LIMIT 1`) as Row[])[0]!.id);
}

/** A posted journal on `date`, with a VAT leg or without one. */
async function postedJournal(date: string, withVat: boolean): Promise<string> {
  const je = String(((await sql`
    INSERT INTO gl_journal_entries
      (company_id, entry_number, entry_date, description, status, created_by, fiscal_period_id, posted_at, source)
    VALUES (${fx.companyId}::UUID, ${`VLR-${++seq}-${fx.tag}`}, ${date}::DATE, 'orig', 'posted', ${fx.userId}::UUID,
            (SELECT id FROM fiscal_periods WHERE company_id = ${fx.companyId}::UUID LIMIT 1), NOW(), 'manual')
    RETURNING id`) as Row[])[0]!.id);
  await sql`
    INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit, description, vat_type)
    VALUES (${fx.companyId}::UUID, ${je}::UUID, ${acc.expense!}::UUID, 100, 0, 'exp', NULL),
           (${fx.companyId}::UUID, ${je}::UUID, ${acc.ap!}::UUID, 0, ${withVat ? 115 : 100}, 'ap', NULL)`;
  if (withVat) {
    await sql`
      INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit, description, vat_type)
      VALUES (${fx.companyId}::UUID, ${je}::UUID, ${acc.vatInput!}::UUID, 15, 0, 'vat', 'standard')`;
  }
  return je;
}

async function lock(start: string, end: string): Promise<void> {
  await sql`
    INSERT INTO vat_period_locks
      (company_id, period_start, period_end, output_tax, input_tax, net_vat, posted_through, locked_by)
    VALUES (${fx.companyId}::UUID, ${start}::DATE, ${end}::DATE, 0, 0, 0, NOW(), ${fx.userId})`;
}

const contraOf = async (je: string) => ((await sql`
  SELECT id, entry_date::TEXT AS d FROM gl_journal_entries
  WHERE company_id = ${fx.companyId}::UUID AND reversal_of_id = ${je}::UUID`) as Row[])[0];

const ctx = () => ({ companyId: fx.companyId, userId: fx.userId, companyRole: 'owner', tokenJti: 'jti-r', scopes: [] }) as unknown as McpToolContext;

describeIfDb('reversals into a locked VAT period', () => {
  beforeAll(async () => {
    assertNotProductionDb('This test posts and reverses journals.');
    fx = await seedFixture('VLR', DATABASE_URL!);
    acc.expense = await accountBySubtype('default_expense');
    acc.ap = await accountBySubtype('payable');
    acc.vatInput = await accountBySubtype('vat_input');
  }, 120000);

  afterAll(async () => {
    await sql`DELETE FROM vat_period_locks WHERE company_id = ${fx.companyId}::UUID`;
    await sql`UPDATE gl_journal_entries SET reversal_of_id = NULL WHERE company_id = ${fx.companyId}::UUID`;
    await dropFixture(fx);
  }, 120000);

  it('rolls a defaulted VAT reversal forward past the lock and reports why', async () => {
    const je = await postedJournal('2026-06-10', true);
    await lock('2026-05-01', '2026-06-30');
    try {
      // The MCP dry run previews the rolled date, from the same resolution.
      const dry = await inTx(fx, () => reverseJournalEntryTool.handler(
        { journal_entry_id: je, idempotency_key: `k${++seq}`, dry_run: true }, ctx()));
      const preview = JSON.parse(dry.content[0]!.text) as {
        journals: { date: string }[]; reversal_date_roll: { rolledFrom: string; date: string; reason: string } | null;
      };
      expect(preview.journals[0]!.date).toBe('2026-07-01');
      expect(preview.reversal_date_roll).toMatchObject({ rolledFrom: '2026-06-10', date: '2026-07-01' });

      const out = await inTx(fx, () => reverseJournalEntry(fx.companyId, je, fx.userId));
      expect(out.vatLockRoll).toMatchObject({
        rolledFrom: '2026-06-10', date: '2026-07-01', lockedPeriodStart: '2026-05-01', lockedPeriodEnd: '2026-06-30',
      });
      expect(out.vatLockRoll!.reason).toMatch(/locked VAT period 2026-05-01 to 2026-06-30/);
      expect((await contraOf(je))!.d).toBe('2026-07-01');
    } finally {
      await sql`DELETE FROM vat_period_locks WHERE company_id = ${fx.companyId}::UUID`;
    }
  });

  it('keeps the original date for a reversal that moves no VAT figure', async () => {
    const je = await postedJournal('2026-06-11', false);
    await lock('2026-05-01', '2026-06-30');
    try {
      const out = await inTx(fx, () => reverseJournalEntry(fx.companyId, je, fx.userId));
      expect(out.vatLockRoll ?? null).toBeNull();
      expect((await contraOf(je))!.d).toBe('2026-06-11');
    } finally {
      await sql`DELETE FROM vat_period_locks WHERE company_id = ${fx.companyId}::UUID`;
    }
  });

  it('refuses an EXPLICIT reversal date inside the lock, and posts nothing', async () => {
    const je = await postedJournal('2026-06-12', true);
    await lock('2026-05-01', '2026-06-30');
    try {
      await expect(inTx(fx, () => reverseJournalEntry(fx.companyId, je, fx.userId, { reversalDate: '2026-06-20' })))
        .rejects.toBeInstanceOf(VatPeriodLockedError);
      expect(await contraOf(je)).toBeUndefined();
      // Refused by the date resolution, BEFORE any contra is drafted — and so
      // over MCP as a plain refusal from a read, not a failure mid-write.
      const r = await inTx(fx, () => reverseJournalEntryTool.handler(
        { journal_entry_id: je, reversal_date: '2026-06-20', idempotency_key: `k${++seq}` }, ctx()));
      expect(r.isError).toBe(true);
      expect(r.content[0]!.text).toMatch(/^Cannot reverse on reversal_date 2026-06-20: .*locked/);
    } finally {
      await sql`DELETE FROM vat_period_locks WHERE company_id = ${fx.companyId}::UUID`;
    }
  });

  it('refuses when no date from the default up to today is outside every lock', async () => {
    const je = await postedJournal('2026-06-13', true);
    await lock('2026-05-01', '2099-12-31');
    try {
      await expect(inTx(fx, () => reverseJournalEntry(fx.companyId, je, fx.userId)))
        .rejects.toBeInstanceOf(VatPeriodLockedError);
      expect(await contraOf(je)).toBeUndefined();
    } finally {
      await sql`DELETE FROM vat_period_locks WHERE company_id = ${fx.companyId}::UUID`;
    }
  });

  it('ignores an UNLOCKED (historical) lock row', async () => {
    const je = await postedJournal('2026-06-14', true);
    await lock('2026-05-01', '2026-06-30');
    await sql`
      UPDATE vat_period_locks SET unlocked_at = NOW(), unlocked_by = ${fx.userId}, unlock_reason = 'amend'
      WHERE company_id = ${fx.companyId}::UUID`;
    try {
      const out = await inTx(fx, () => reverseJournalEntry(fx.companyId, je, fx.userId));
      expect(out.vatLockRoll ?? null).toBeNull();
      expect((await contraOf(je))!.d).toBe('2026-06-14');
    } finally {
      await sql`DELETE FROM vat_period_locks WHERE company_id = ${fx.companyId}::UUID`;
    }
  });

  it('a lock ending TODAY leaves nowhere to roll: refused, naming the lock and that an admin can unlock', async () => {
    const je = await postedJournal('2026-06-15', true);
    const t = new Date();
    const today = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
    await lock('2026-05-01', today);
    try {
      const err = await inTx(fx, () => reverseJournalEntry(fx.companyId, je, fx.userId)).then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(VatPeriodLockedError);
      const msg = (err as Error).message;
      expect(msg).toContain(`locked VAT period 2026-05-01 to ${today}`);
      expect(msg).toMatch(/owner or admin can unlock/);
      expect(await contraOf(je)).toBeUndefined();
    } finally {
      await sql`DELETE FROM vat_period_locks WHERE company_id = ${fx.companyId}::UUID`;
    }
  });

  /** L4: createJournalEntry creates an uncovered date's fiscal year on demand
   *  (ensureFiscalPeriodForDate), so the roll must count such a date as open. A
   *  company whose only period is FY2025 rolls a Dec-2025 reversal into
   *  2026-01-01, and the post creates FY2026 to hold it. */
  it('rolls into a date no fiscal period covers yet when that year would be created on demand', async () => {
    const fy = await seedFixture('VLRY', DATABASE_URL!);
    try {
      await sql`UPDATE companies SET financial_year_start = 1 WHERE id = ${fy.companyId}::UUID`;
      // A period lies inside its fiscal year (migration 940): it moves into FY2025, and
      // the FY2026 it leaves empty is removed, so FY2026 does not exist yet.
      const was = String(((await sql`SELECT fiscal_year_id FROM fiscal_periods WHERE company_id = ${fy.companyId}::UUID`) as Row[])[0]!.fiscal_year_id);
      await sql`UPDATE fiscal_periods SET start_date = '2025-01-01', end_date = '2025-12-31', fiscal_year = 2025,
                  fiscal_year_id = public.fiscal_year_ensure(${fy.companyId}::UUID, '2025-01-01')
                WHERE company_id = ${fy.companyId}::UUID`;
      await sql`DELETE FROM fiscal_years WHERE id = ${was}::UUID`;
      const exp = String(((await sql`SELECT id FROM gl_accounts WHERE company_id = ${fy.companyId}::UUID AND account_subtype = 'default_expense'`) as Row[])[0]!.id);
      const vin = String(((await sql`SELECT id FROM gl_accounts WHERE company_id = ${fy.companyId}::UUID AND account_subtype = 'vat_input'`) as Row[])[0]!.id);
      const ap = String(((await sql`SELECT id FROM gl_accounts WHERE company_id = ${fy.companyId}::UUID AND account_subtype = 'payable'`) as Row[])[0]!.id);
      const je = String(((await sql`
        INSERT INTO gl_journal_entries
          (company_id, entry_number, entry_date, description, status, created_by, fiscal_period_id, posted_at, source)
        VALUES (${fy.companyId}::UUID, ${`VLRY-${fy.tag}`}, '2025-12-10', 'orig', 'posted', ${fy.userId}::UUID,
                (SELECT id FROM fiscal_periods WHERE company_id = ${fy.companyId}::UUID LIMIT 1), NOW(), 'manual')
        RETURNING id`) as Row[])[0]!.id);
      await sql`
        INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit, description, vat_type)
        VALUES (${fy.companyId}::UUID, ${je}::UUID, ${exp}::UUID, 100, 0, 'exp', NULL),
               (${fy.companyId}::UUID, ${je}::UUID, ${vin}::UUID, 15, 0, 'vat', 'standard'),
               (${fy.companyId}::UUID, ${je}::UUID, ${ap}::UUID, 0, 115, 'ap', NULL)`;
      await sql`
        INSERT INTO vat_period_locks
          (company_id, period_start, period_end, output_tax, input_tax, net_vat, posted_through, locked_by)
        VALUES (${fy.companyId}::UUID, '2025-11-01', '2025-12-31', 0, 0, 0, NOW(), ${fy.userId})`;

      const out = await inTx(fy, () => reverseJournalEntry(fy.companyId, je, fy.userId));
      expect(out.vatLockRoll).toMatchObject({ rolledFrom: '2025-12-10', date: '2026-01-01' });
      const contra = ((await sql`
        SELECT je.entry_date::TEXT AS d, fp.fiscal_year FROM gl_journal_entries je
        JOIN fiscal_periods fp ON fp.id = je.fiscal_period_id
        WHERE je.company_id = ${fy.companyId}::UUID AND je.reversal_of_id = ${je}::UUID`) as Row[])[0]!;
      expect(contra).toMatchObject({ d: '2026-01-01', fiscal_year: 2026 });
    } finally {
      await sql`DELETE FROM vat_period_locks WHERE company_id = ${fy.companyId}::UUID`;
      await sql`UPDATE gl_journal_entries SET reversal_of_id = NULL WHERE company_id = ${fy.companyId}::UUID`;
      await dropFixture(fy);
    }
  });

  /** FY2026 (January start) with a GAP in July-August: an open period Jan-Jun
   *  holding a posted VAT journal on 2026-06-10, a lock over May-June, and
   *  `after` filling the year from September. */
  async function gapYear(prefix: string, after: Array<[string, string, 'open' | 'closed']>): Promise<{ fy: Fixture; je: string }> {
    const fy = await seedFixture(prefix, DATABASE_URL!);
    await sql`UPDATE companies SET financial_year_start = 1 WHERE id = ${fy.companyId}::UUID`;
    await sql`UPDATE fiscal_periods SET end_date = '2026-06-30' WHERE company_id = ${fy.companyId}::UUID`;
    let n = 1;
    for (const [start, end, status] of after) {
      n++;
      await sql`
        INSERT INTO fiscal_periods (company_id, period_name, period_number, fiscal_year, start_date, end_date, status)
        VALUES (${fy.companyId}::UUID, ${`FY26-${n} ${fy.tag}`}, ${n}, 2026, ${start}::DATE, ${end}::DATE, ${status})`;
    }
    const acct = async (st: string) => String(((await sql`SELECT id FROM gl_accounts WHERE company_id = ${fy.companyId}::UUID AND account_subtype = ${st}`) as Row[])[0]!.id);
    const [exp, vin, ap] = [await acct('default_expense'), await acct('vat_input'), await acct('payable')];
    const je = String(((await sql`
      INSERT INTO gl_journal_entries
        (company_id, entry_number, entry_date, description, status, created_by, fiscal_period_id, posted_at, source)
      VALUES (${fy.companyId}::UUID, ${`${prefix}-${fy.tag}`}, '2026-06-10', 'orig', 'posted', ${fy.userId}::UUID,
              (SELECT id FROM fiscal_periods WHERE company_id = ${fy.companyId}::UUID AND start_date = '2026-01-01'), NOW(), 'manual')
      RETURNING id`) as Row[])[0]!.id);
    await sql`
      INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit, description, vat_type)
      VALUES (${fy.companyId}::UUID, ${je}::UUID, ${exp}::UUID, 100, 0, 'exp', NULL),
             (${fy.companyId}::UUID, ${je}::UUID, ${vin}::UUID, 15, 0, 'vat', 'standard'),
             (${fy.companyId}::UUID, ${je}::UUID, ${ap}::UUID, 0, 115, 'ap', NULL)`;
    await sql`
      INSERT INTO vat_period_locks
        (company_id, period_start, period_end, output_tax, input_tax, net_vat, posted_through, locked_by)
      VALUES (${fy.companyId}::UUID, '2026-05-01', '2026-06-30', 0, 0, 0, NOW(), ${fy.userId})`;
    return { fy, je };
  }
  async function dropGapYear(fy: Fixture): Promise<void> {
    await sql`DELETE FROM vat_period_locks WHERE company_id = ${fy.companyId}::UUID`;
    await sql`UPDATE gl_journal_entries SET reversal_of_id = NULL WHERE company_id = ${fy.companyId}::UUID`;
    await dropFixture(fy);
  }

  /** L3: a date in a GAP of a fiscal year that holds a closed period is not
   *  postable — the generator adds no month beside a closed one (migration 942;
   *  before it, createFiscalYear refused the existing year). The roll must jump
   *  the gap to the next open period instead. */
  it('does not roll into a gap inside a fiscal year that holds a closed period; jumps to the next open period', async () => {
    const { fy, je } = await gapYear('VLRG', [['2026-09-01', '2026-11-30', 'open'], ['2026-12-01', '2026-12-31', 'closed']]);
    try {
      const out = await inTx(fy, () => reverseJournalEntry(fy.companyId, je, fy.userId));
      expect(out.vatLockRoll).toMatchObject({ rolledFrom: '2026-06-10', date: '2026-09-01' });
    } finally {
      await dropGapYear(fy);
    }
  });

  /** Since migration 942 a GAP in an OPEN fiscal year with no closed period is
   *  postable: the post generates the missing month. So the roll lands in the
   *  gap rather than jumping it (it jumped while createFiscalYear refused the
   *  existing year), and the contra sits in the generated period. */
  it('rolls into a gap inside an open fiscal year with no closed period; the post generates its month', async () => {
    const { fy, je } = await gapYear('VLRO', [['2026-09-01', '2026-12-31', 'open']]);
    try {
      const out = await inTx(fy, () => reverseJournalEntry(fy.companyId, je, fy.userId));
      expect(out.vatLockRoll).toMatchObject({ rolledFrom: '2026-06-10', date: '2026-07-01' });
      const contra = ((await sql`
        SELECT je.entry_date::TEXT AS d, fp.start_date::TEXT AS ps, fp.end_date::TEXT AS pe FROM gl_journal_entries je
        JOIN fiscal_periods fp ON fp.id = je.fiscal_period_id
        WHERE je.company_id = ${fy.companyId}::UUID AND je.reversal_of_id = ${je}::UUID`) as Row[])[0]!;
      expect(contra).toMatchObject({ d: '2026-07-01', ps: '2026-07-01', pe: '2026-07-31' });
    } finally {
      await dropGapYear(fy);
    }
  });
});
