/**
 * Migration 1018, round 12, through the real services as the production-shaped login (helpers/appLoginWorld).
 * L1: copyLateClaimBaseToReversal pairs each base by account, VAT type and BOTH amounts, so a re-reversal (whose based
 * lines are credits) pairs every base with its own line, every time. L3: an account merge takes its journals' link keys
 * in sorted order up front, so a merge and a reversal link wait for one another instead of deadlocking. L2: the
 * fixture login is dropped, with its stored password, when the world closes.
 */
import { randomUUID } from 'crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import { isDisposableDb } from '../helpers/assertDisposableDb';
import { appLoginWorld, FIXTURE_LOGIN, type AppWorld } from './helpers/appLoginWorld';
import { dropFreeze, journal, negate, openApp, seedFreeze, type Freeze, type Leg, type Row } from './helpers/ledgerFreezeFixture';

const describeIfDisposable = isDisposableDb() ? describe : describe.skip;
let z: Freeze;
let world: AppWorld;
let who: { userId: string; companyId: string };
const one = async (q: Promise<unknown>) => ((await q) as Row[])[0]!;
const settle = (p: Promise<unknown>) => p.then(() => 'ACCEPTED', (e: { message: string; code?: string }) => `${e.code ?? ''} ${e.message}`);

describeIfDisposable('ledger column immutability, round 12: services as the production login (migration 1018)', () => {
  beforeAll(async () => {
    z = await seedFreeze();
    who = { userId: z.f.fx.userId, companyId: z.f.fx.companyId };
    world = await appLoginWorld();
  }, 240000);
  afterAll(async () => {
    if (world) await world.close();
    if (!z) return;
    await sql`DELETE FROM gl_account_merges WHERE company_id = ${z.f.fx.companyId}::UUID`; // the L3 merge's record
    await dropFreeze(z);
  }, 120000);

  it('L1 re-reversing a late-claim contra carries each base to its own line, ten times out of ten', async () => {
    const vat: Leg[] = [[z.expense, 15, 0], [z.expense, 30, 0], [z.ap, 0, 45]];
    const companion = await journal(z, vat, { source: 'auto_vat_late_claim' });
    const r = await journal(z, negate(vat), { source: 'auto_vat_late_claim' }); // its contra: the based lines are credits
    await sql`UPDATE gl_journal_lines SET late_claim_base = CASE credit WHEN 15 THEN -100 ELSE -200 END
      WHERE journal_entry_id = ${r}::UUID AND gl_account_id = ${z.expense}::UUID`;
    const { copyLateClaimBaseToReversal } = await world.load(() => import('@/modules/accounting/services/gl/vatLateClaimSplit'));
    const neon = await world.load(() => import('@/lib/neon'));
    const pairs: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      const r2 = await world.run(who, async () => {
        const je = String(((await neon.sql`INSERT INTO gl_journal_entries (company_id, entry_date, description, source, status, created_by)
          VALUES (${z.f.fx.companyId}::UUID, '2026-06-12', 'R12 re-reversal', 'auto_vat_late_claim', 'draft', ${z.f.fx.userId}) RETURNING id`) as Row[])[0]!.id);
        for (const [acct, d, c] of negate(negate(vat))) {
          await neon.sql`INSERT INTO gl_journal_lines (journal_entry_id, company_id, gl_account_id, debit, credit)
            VALUES (${je}::UUID, ${z.f.fx.companyId}::UUID, ${acct}::UUID, ${d}, ${c})`;
        }
        await copyLateClaimBaseToReversal(z.f.fx.companyId, r, je);
        return je;
      });
      const got = (await sql`SELECT debit::text || ':' || late_claim_base::text AS p FROM gl_journal_lines
        WHERE journal_entry_id = ${r2}::UUID AND late_claim_base IS NOT NULL ORDER BY debit`) as Row[];
      pairs.push(got.map((g) => String(g.p)).join(','));
    }
    expect(new Set(pairs)).toEqual(new Set(['15.00:100.00,30.00:200.00']));
    expect(companion).toBeTruthy();
  }, 120000);

  it('L3 an account merge and a reversal link that take two journals\' keys in opposite orders wait, they do not deadlock', async () => {
    const acct = async (name: string) => String((await one(sql`INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype, normal_balance, is_active, level)
      VALUES (${z.f.fx.companyId}::UUID, ${`68${randomUUID().slice(0, 4)}`}, ${name}, 'expense', 'operating_expense', 'debit', true, 3) RETURNING id`)).id);
    const source = await acct('R12 merge source');
    const target = await acct('R12 merge target');
    // HIGH's line is written first, so the merge's UPDATE (and, before the fix, its deferred check at COMMIT) visits
    // HIGH, then LOW: the opposite of a link's sorted order. Journals are drawn until the first is the higher uuid.
    const high = await journal(z, [[source, 10, 0], [z.ap, 0, 10]]);
    let low = await journal(z, [[z.expense, 1, 0], [z.ap, 0, 1]]);
    while (low > high) low = await journal(z, [[z.expense, 1, 0], [z.ap, 0, 1]]);
    await sql`UPDATE gl_journal_lines SET gl_account_id = ${source}::UUID WHERE journal_entry_id = ${low}::UUID AND gl_account_id = ${z.expense}::UUID`;
    const link = await openApp(z); // a link takes the keys in sorted order: LOW, then HIGH
    try {
      await link.query('SELECT pg_advisory_xact_lock(public.ledger_link_key($1))', [low]);
      const { mergeAccounts } = await world.load(() => import('@/modules/accounting/services/gl/accountMergeService'));
      const merging = settle(world.run(who, () => mergeAccounts(z.f.fx.companyId, source, target, z.f.fx.userId)));
      await new Promise((r) => setTimeout(r, 1500));
      const second = settle(link.query('SELECT pg_advisory_xact_lock(public.ledger_link_key($1))', [high]));
      expect(await second).toBe('ACCEPTED');
      await link.query('COMMIT');
      expect(await merging).toBe('ACCEPTED');
    } finally { await link.query('ROLLBACK').catch(() => undefined); link.release(); }
    expect((await one(sql`SELECT count(*)::int AS n FROM gl_journal_lines WHERE gl_account_id = ${target}::UUID`)).n).toBe(2);
  }, 60000);

  it('L2 closing the world drops the fixture login and its stored password', async () => {
    await world.close();
    world = undefined as unknown as AppWorld;
    const url = process.env.DATABASE_URL!; // the fixture superuser's again, once the world is closed
    expect((await one(sql`SELECT count(*)::int AS n FROM pg_roles WHERE rolname = ${FIXTURE_LOGIN}`)).n).toBe(0);
    const admin = new URL(url); admin.pathname = '/postgres';
    const { Client } = await import('pg');
    const c = new Client({ connectionString: admin.toString() });
    await c.connect();
    try { expect((await c.query("SELECT to_regclass('public.ci_isaflow_app_login') AS t")).rows[0].t).toBeNull(); } finally { await c.end(); }
  });
});
