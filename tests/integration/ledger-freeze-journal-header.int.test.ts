/**
 * Migration 1018, rules 2 and 3: a posted journal keeps its source, description and date, and a reversal claim is not
 * cleared once a journal reverses it. Forgeries run as app_user under RLS; the controls show drafts, unchanged values
 * and the failed-claim release still write.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import { releaseJournalReversalClaim } from '@/modules/accounting/services/gl/journalEntryReversalClaim';
import { isDisposableDb } from '../helpers/assertDisposableDb';
import { asApp, asRole, dropFreeze, journal, negate, refused, seedFreeze, type Freeze, type Leg, type Row } from './helpers/ledgerFreezeFixture';
import { inAppUserTx } from './helpers/appUserTx';

const describeIfDisposable = isDisposableDb() ? describe : describe.skip;
let z: Freeze;
let legs: Leg[];
const row = async (id: string) => ((await sql`SELECT source, description, entry_date::TEXT AS d, reversed_at FROM gl_journal_entries WHERE id = ${id}::UUID`) as Row[])[0]!;

describeIfDisposable('ledger column immutability: a posted journal\'s header and its claim (migration 1018)', () => {
  beforeAll(async () => {
    z = await seedFreeze();
    legs = [[z.expense, 100, 0], [z.ap, 0, 100]];
  }, 240000);
  afterAll(async () => { if (z) await dropFreeze(z); }, 120000);

  it.each([
    ['source', "source = 'auto_payroll'"],
    ['description', "description = 'Reversal of JE-2026-00001'"],
    ['entry_date', "entry_date = '2026-07-01'"],
  ])('a posted journal\'s %s is refused to app_user, migration_admin and platform_admin', async (_name, set) => {
    const id = await journal(z, legs);
    const before = await row(id);
    await refused(asApp(z, (c) => c.query(`UPDATE gl_journal_entries SET ${set} WHERE id = $1`, [id])), /keeps its source, description and date/);
    for (const role of ['migration_admin', 'platform_admin']) {
      await refused(asRole(z, role, (c) => c.query(`UPDATE gl_journal_entries SET ${set} WHERE id = $1`, [id])), /keeps its source/);
    }
    expect(await row(id)).toEqual(before);
  });

  it('a legacy status = reversed journal is frozen too, and all three columns at once', async () => {
    const id = await journal(z, legs, { status: 'reversed' });
    await refused(asApp(z, (c) => c.query("UPDATE gl_journal_entries SET source = 'x', description = 'y', entry_date = '2026-01-01' WHERE id = $1", [id])), /keeps its source/);
  });

  it('a draft journal and an unchanged value still write', async () => {
    const draft = await journal(z, legs, { status: 'draft' });
    await asApp(z, (c) => c.query("UPDATE gl_journal_entries SET description = 'edited draft', source = 'manual' WHERE id = $1", [draft]), { commit: true });
    expect((await row(draft)).description).toBe('edited draft');
    const posted = await journal(z, legs);
    await asApp(z, (c) => c.query('UPDATE gl_journal_entries SET description = description, entry_date = entry_date WHERE id = $1', [posted]));
  });

  it('reversed_at stays set once a journal links to it, and clears when none does (the failed-claim release)', async () => {
    const original = await journal(z, legs, { claimed: true });
    const contra = await journal(z, negate(legs));
    await sql`UPDATE gl_journal_entries SET reversal_of_id = ${original}::UUID WHERE id = ${contra}::UUID`;
    await refused(asApp(z, (c) => c.query('UPDATE gl_journal_entries SET reversed_at = NULL, reversed_by = NULL WHERE id = $1', [original])), /stays reversed/);
    expect((await row(original)).reversed_at).not.toBeNull();
    const claimed = await journal(z, legs, { claimed: true });
    await inAppUserTx(z.f.fx, () => releaseJournalReversalClaim(z.f.fx.companyId, claimed));
    expect((await row(claimed)).reversed_at).toBeNull();
  });
});
