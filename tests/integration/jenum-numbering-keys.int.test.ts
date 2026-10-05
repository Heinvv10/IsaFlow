/**
 * JENUM round 2: the numbering lock's KEY and the number's WIDTH.
 *
 * Key: round 1 locked `(857, hashtext('<company>:<year>'))` — 32 bits. brk-jenum found two company ids whose
 * `'<id>:2026'` share a hashtext (1899535412), so two unrelated tenants waited on each other. Migration 857 now
 * locks `hashtextextended('<company>:<year>', 857)` (64 bits); that pair no longer shares a key.
 *
 * Width: `LPAD(next_seq, 5)` truncated past 99999 — JE-<y>-99999 was followed by JE-<y>-10000 and then 23505 on
 * every insert. The pad is now at least 5, never shorter than the number.
 *
 * Every journal goes through the real `createJournalEntry`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import { createJournalEntry } from '@/modules/accounting/services/gl/journalEntryCrudService';
import { assertLocalFixtureDbUrl } from './fixtureDbGuard';
import { dropFixture, seedFixture, type Fixture } from './helpers/l1FifoFixture';
import {
  errText, expenseAccountOf, holdJournal, journalInput, openYear, release, seedCompanyWithId, settle, settledWithin,
} from './helpers/jenumFixture';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

/** brk-jenum's pair: hashtext('<id>:2026') = 1899535412 for both. */
const COLLIDING = ['fcadac57-2c4c-46d9-853b-061d0bf125f0', 'cae8d83f-42ec-4e02-a42d-fd4d972637e2'] as const;

let c1: Fixture, c2: Fixture, wide: Fixture;

describeIfDb('JENUM: numbering lock key and number width', () => {
  beforeAll(async () => {
    assertLocalFixtureDbUrl('DATABASE_URL', DATABASE_URL, ['isaflow_test', 'isaflow_schema_fixture']);
    c1 = await seedCompanyWithId(COLLIDING[0], 'JENUM-K1', DATABASE_URL!);
    c2 = await seedCompanyWithId(COLLIDING[1], 'JENUM-K2', DATABASE_URL!);
    wide = await seedFixture('JENUM-W', DATABASE_URL!);
    await openYear(wide, 2028);
  }, 60000);

  afterAll(async () => {
    for (const f of [c1, c2, wide]) if (f) await dropFixture(f);
  }, 60000);

  it('two companies whose "<id>:<year>" hashtext collides never wait on each other', async () => {
    const pair = (await sql`
      SELECT hashtext(${`${COLLIDING[0]}:2026`}) = hashtext(${`${COLLIDING[1]}:2026`}) AS collides`) as { collides: boolean }[];
    expect(pair[0]!.collides, 'the pair must still collide under the 32-bit hash, or this test proves nothing').toBe(true);

    const a = await holdJournal(c1, journalInput(await expenseAccountOf(c1), c1.bankAccountId, '2026-08-01'));
    try {
      const pB = settle(createJournalEntry(c2.companyId,
        journalInput(await expenseAccountOf(c2), c2.bankAccountId, '2026-08-01'), c2.userId));
      expect(await settledWithin(pB, 5000), "a colliding tenant's journal must not wait on another's").toBe(true);
      const out = await pB;
      expect(out.ok, out.ok ? '' : errText(out.error)).toBe(true);
      expect(out.ok && out.value.entryNumber).toBe('JE-2026-00001');
    } finally {
      await release(a, 'ROLLBACK');
    }
  }, 60000);

  it('past 99999 the number keeps all its digits: JE-<y>-100000, then 100001', async () => {
    await sql`
      INSERT INTO gl_journal_entries (company_id, entry_date, description, source, status, created_by, entry_number)
      VALUES (${wide.companyId}::UUID, '2028-01-05', 'jenum width seed', 'manual', 'draft', ${wide.userId}::UUID,
              'JE-2028-99999')`;
    const expense = await expenseAccountOf(wide);
    const first = await settle(createJournalEntry(wide.companyId,
      journalInput(expense, wide.bankAccountId, '2028-01-06', 41), wide.userId));
    expect(first.ok, first.ok ? '' : errText(first.error)).toBe(true);
    expect(first.ok && first.value.entryNumber).toBe('JE-2028-100000');
    // The MAX must read 100000 (6 digits) above 99999 (5), or this mints 100000 again and dies 23505.
    const second = await settle(createJournalEntry(wide.companyId,
      journalInput(expense, wide.bankAccountId, '2028-01-07', 42), wide.userId));
    expect(second.ok, second.ok ? '' : errText(second.error)).toBe(true);
    expect(second.ok && second.value.entryNumber).toBe('JE-2028-100001');
  }, 60000);
});
