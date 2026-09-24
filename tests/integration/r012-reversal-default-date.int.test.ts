/**
 * R-012 — the DEFAULT reversal date, on real PostgreSQL.
 *
 * 1. resolveReversalDate's default arm dated the contra TODAY whenever the
 *    original's period was not open — including when the original is dated
 *    AFTER today. A correction dated before what it corrects breaks the as-at
 *    parity the ageing and statements read (softDeleteLedgerPresence). Now
 *    refused pre-write as ReversalBeforeOriginalError (a ClosedFiscalPeriodError).
 * 2. The MCP reverse tool resolved that default read-only but never asked
 *    whether today's period is open, so dry_run promised a reversal the live
 *    call could not post, and the live call failed inside the write path.
 *
 * Periods are built relative to today so the test holds on any date.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { reverseJournalEntry } from '@/modules/accounting/services/gl/journalEntryService';
import { ReversalBeforeOriginalError } from '@/modules/accounting/services/gl/journalEntryReversalDate';
import { ClosedFiscalPeriodError } from '@/modules/accounting/services/gl/journalEntryPostingGuards';
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

const day = (offset: number): string => { const d = new Date(); d.setDate(d.getDate() + offset); return fmtDate(d); };

async function account(subtype: string): Promise<string> {
  return String(((await sql`
    SELECT id FROM gl_accounts WHERE company_id = ${fx.companyId}::UUID AND account_subtype = ${subtype} LIMIT 1`) as Row[])[0]!.id);
}

/** Replace the fixture's periods (before anything posts): [start..end] with a status each. */
async function periods(ranges: Array<[string, string, 'open' | 'closed']>): Promise<void> {
  await sql`DELETE FROM gl_account_balances WHERE fiscal_period_id IN (
    SELECT id FROM fiscal_periods WHERE company_id = ${fx.companyId}::UUID)`;
  await sql`UPDATE gl_journal_entries SET fiscal_period_id = NULL WHERE company_id = ${fx.companyId}::UUID`;
  await sql`DELETE FROM fiscal_periods WHERE company_id = ${fx.companyId}::UUID`;
  let n = 0;
  for (const [start, end, status] of ranges) {
    n++;
    await sql`
      INSERT INTO fiscal_periods (company_id, period_name, period_number, fiscal_year, start_date, end_date, status)
      VALUES (${fx.companyId}::UUID, ${`R012-${n}-${fx.tag}`}, ${n}, ${2100 + n}, ${start}::DATE, ${end}::DATE, ${status})`;
  }
}

async function postedJournal(date: string): Promise<string> {
  const je = String(((await sql`
    INSERT INTO gl_journal_entries
      (company_id, entry_number, entry_date, description, status, created_by, fiscal_period_id, posted_at, source)
    VALUES (${fx.companyId}::UUID, ${`R012-${++seq}-${fx.tag}`}, ${date}::DATE, 'orig', 'posted', ${fx.userId}::UUID,
            (SELECT id FROM fiscal_periods WHERE company_id = ${fx.companyId}::UUID
               AND start_date <= ${date}::DATE AND end_date >= ${date}::DATE LIMIT 1), NOW(), 'manual')
    RETURNING id`) as Row[])[0]!.id);
  await sql`
    INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit, description)
    VALUES (${fx.companyId}::UUID, ${je}::UUID, ${acc.expense!}::UUID, 100, 0, 'exp'),
           (${fx.companyId}::UUID, ${je}::UUID, ${acc.ap!}::UUID, 0, 100, 'ap')`;
  return je;
}

const entryCount = async (): Promise<number> => Number(((await sql`
  SELECT count(*)::int AS n FROM gl_journal_entries WHERE company_id = ${fx.companyId}::UUID`) as Row[])[0]!.n);
const ctx = () => ({ companyId: fx.companyId, userId: fx.userId, tokenJti: 'jti-r012', scopes: [] }) as unknown as McpToolContext;

describeIfDb('R-012: the default reversal date', () => {
  beforeAll(async () => {
    assertNotProductionDb('This test posts and reverses journals.');
    fx = await seedFixture('R012', DATABASE_URL!);
    acc.expense = await account('default_expense');
    acc.ap = await account('payable');
    // One layout for every case: today sits in a CLOSED period; an open window
    // follows it, then a closed one.
    await periods([[day(-400), day(10), 'closed'], [day(11), day(30), 'open'], [day(31), day(100), 'closed']]);
  }, 120000);

  afterAll(async () => {
    await sql`UPDATE gl_journal_entries SET reversal_of_id = NULL WHERE company_id = ${fx.companyId}::UUID`;
    await dropFixture(fx);
  }, 120000);

  it('refuses, writing nothing, to date a reversal today when the future-dated original\'s period is closed', async () => {
    const je = await postedJournal(day(40));
    const before = await entryCount();
    const err = await inTx(fx, () => reverseJournalEntry(fx.companyId, je, fx.userId)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReversalBeforeOriginalError);
    expect(err).toBeInstanceOf(ClosedFiscalPeriodError);
    expect(await entryCount()).toBe(before);
  });

  it('still dates a future-dated original\'s reversal to the original when its period is open', async () => {
    const je = await postedJournal(day(20));
    const r = await inTx(fx, () => reverseJournalEntry(fx.companyId, je, fx.userId));
    expect(fmtDate(r.entryDate)).toBe(day(20));
  });

  it('the MCP tool refuses pre-write, dry run included, when the default date lands in a closed period', async () => {
    const je = await postedJournal(day(-5));
    const before = await entryCount();
    for (const dryRun of [true, false]) {
      const out = await inTx(fx, () => reverseJournalEntryTool.handler(
        { journal_entry_id: je, dry_run: dryRun, idempotency_key: `r012-${dryRun}-${fx.tag}` }, ctx()));
      expect(out.isError, `dry_run=${dryRun}`).toBe(true);
      expect(JSON.stringify(out.content)).toMatch(/not open/);
    }
    expect(await entryCount()).toBe(before);
  });
});
