/**
 * Migration 1018, round 9, through the real services as the PRODUCTION login (helpers/appLoginWorld).
 * M1: an account merge where a reversal pair straddles a closed period is refused UP FRONT by the merge's own
 * closed-period rule (AccountMergeError 'lines_cannot_be_repointed', nothing moved), never by the deferred 23514.
 * L4: reversing a legacy journal that a contra already links but never stamped answers "already reversed".
 */
import { randomUUID } from 'crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from '@/lib/neon';
import { isDisposableDb } from '../helpers/assertDisposableDb';
import { appLoginWorld, type AppWorld } from './helpers/appLoginWorld';
import { dropFreeze, journal, negate, seedFreeze, type Freeze, type Leg, type Row } from './helpers/ledgerFreezeFixture';

vi.mock('@/modules/accounting/services/ar/invoicePdfSnapshotService', () => ({
  snapshotInvoicePdf: vi.fn(async () => ({ documentId: null, wasExisting: false })),
}));

const describeIfDisposable = isDisposableDb() ? describe : describe.skip;
let z: Freeze;
let world: AppWorld;
let who: { userId: string; companyId: string };
let legs: Leg[];
const one = async (q: Promise<unknown>) => ((await q) as Row[])[0]!;

describeIfDisposable('ledger column immutability, round 9: the real services as the production login (migration 1018)', () => {
  beforeAll(async () => {
    z = await seedFreeze();
    who = { userId: z.f.fx.userId, companyId: z.f.fx.companyId };
    world = await appLoginWorld();
    legs = [[z.ar, 100, 0], [z.revenue, 0, 100]];
  }, 240000);
  afterAll(async () => { if (world) await world.close(); if (z) await dropFreeze(z); }, 120000);

  it('L4 reversing a legacy journal a contra already links (never stamped) answers "already reversed"', async () => {
    const o = await journal(z, legs);
    await sql`UPDATE gl_journal_entries SET reversal_of_id = ${o}::UUID WHERE id = ${await journal(z, negate(legs))}::UUID`;
    const { reverseJournalEntry } = await world.load(() => import('@/modules/accounting/services/gl/journalEntryService'));
    const err = await world.run(who, () => reverseJournalEntry(z.f.fx.companyId, o, z.f.fx.userId)).then(() => null, (e: unknown) => e as Error);
    expect(err?.message).toBe('Journal entry already reversed');
    expect((await one(sql`SELECT count(*)::int AS n FROM gl_journal_entries WHERE reversal_of_id = ${o}::UUID`)).n).toBe(1);
  });

  it('M1 a merge whose reversal pair straddles a closed period is refused by name up front; nothing moves', async () => {
    const { fx } = z.f;
    const acct = async (name: string) => String((await one(sql`INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype, normal_balance, is_active, level)
      VALUES (${fx.companyId}::UUID, ${`49${randomUUID().slice(0, 4)}`}, ${name}, 'revenue', 'operating_revenue', 'credit', true, 3) RETURNING id`)).id);
    const source = await acct('R9 merge source');
    const target = await acct('R9 merge target');
    const pair: Leg[] = [[z.ar, 100, 0], [source, 0, 100]];
    const o = await journal(z, pair, { date: '2026-03-10' });
    await sql`INSERT INTO fiscal_periods (company_id, period_name, period_number, fiscal_year, start_date, end_date, status)
      VALUES (${fx.companyId}::UUID, ${`FY27 r9 ${randomUUID().slice(0, 6)}`}, 1, 2027, '2027-01-01', '2027-12-31', 'open')`;
    const r = await journal(z, negate(pair), { date: '2027-01-10' });
    await sql`UPDATE gl_journal_entries SET reversal_of_id = ${o}::UUID WHERE id = ${r}::UUID`;
    const fp = await one(sql`SELECT id, status FROM fiscal_periods WHERE company_id = ${fx.companyId}::UUID AND '2026-03-10'::date BETWEEN start_date AND end_date`);
    await sql`UPDATE fiscal_periods SET status = 'closed' WHERE id = ${fp.id}::UUID`;
    try {
      const { mergeAccounts } = await world.load(() => import('@/modules/accounting/services/gl/accountMergeService'));
      const err = await world.run(who, () => mergeAccounts(fx.companyId, source, target, fx.userId))
        .then(() => null, (e: unknown) => e as Error & { code?: string });
      expect(err?.name).toBe('AccountMergeError');
      expect(err?.code).toBe('lines_cannot_be_repointed');
      expect((await one(sql`SELECT count(*)::int AS n FROM gl_journal_lines WHERE gl_account_id = ${target}::UUID`)).n).toBe(0);
      expect((await one(sql`SELECT public.gl_lines_are_negation(${r}::UUID, ${o}::UUID) AS n`)).n).toBe(true);
    } finally {
      await sql`UPDATE fiscal_periods SET status = ${String(fp.status)} WHERE id = ${fp.id}::UUID`;
    }
  });
});
