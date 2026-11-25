/**
 * Migration 1018, round 10 (the round-9 breaker's repros, as assertions), as app_user under RLS and claims.
 * H1: no session but a superuser moves a journal to status 'reversed', even with a posted contra linked, so the
 * posted-only figures of the pair stay at zero. M2/L3: a line belongs to its journal's company (insert and update), and
 * the deferred account check finds the contra by the JOURNAL's company even on a legacy line of another company.
 */
import { randomUUID } from 'crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';
import { sql } from '@/lib/neon';
import { isDisposableDb } from '../helpers/assertDisposableDb';
import { asApp, dropFreeze, journal, negate, refused, seedFreeze, type Freeze, type Leg, type Row, linkAsApp } from './helpers/ledgerFreezeFixture';

const describeIfDisposable = isDisposableDb() ? describe : describe.skip;
let z: Freeze;
let legs: Leg[];
const link = (contra: string, original: string) => (c: PoolClient) => linkAsApp(c, contra, original);
const settle = (p: Promise<unknown>) => p.then(() => 'ACCEPTED', (e: { message: string }) => e.message);
const LINE_COMPANY = /a journal line belongs to its journal's company/;

/** An app_user transaction with `company` as the current company, for a user who is a member of both companies. */
async function asIn<T>(company: string, fn: (c: PoolClient) => Promise<T>, commit = false): Promise<T> {
  const c = await z.pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE app_user');
    await c.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: z.f.fx.userId, role: 'authenticated' })]);
    await c.query("SELECT set_config('app.current_company_id', $1, true)", [company]);
    const out = await fn(c);
    await c.query(commit ? 'COMMIT' : 'ROLLBACK');
    return out;
  } catch (err) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally { c.release(); }
}

describeIfDisposable('ledger column immutability, round 10 (migration 1018)', () => {
  beforeAll(async () => {
    z = await seedFreeze();
    legs = [[z.ar, 100, 0], [z.revenue, 0, 100]];
    await sql`INSERT INTO company_users (company_id, user_id, role) VALUES (${z.f.other.companyId}::UUID, ${z.f.fx.userId}, 'admin') ON CONFLICT DO NOTHING`;
  }, 240000);
  afterAll(async () => {
    if (!z) return;
    await sql`DELETE FROM company_users WHERE company_id = ${z.f.other.companyId}::UUID AND user_id = ${z.f.fx.userId}`;
    // The legacy shape's company-B lines left balance-cache rows on A's fiscal period: remove them before the periods.
    await sql`DELETE FROM gl_account_balances WHERE gl_account_id IN (SELECT id FROM gl_accounts WHERE company_id = ${z.f.other.companyId}::UUID)`;
    await dropFreeze(z);
  }, 120000);

  it('H1 a reversed journal is not flipped to status reversed: the posted-only balance of the pair stays zero', async () => {
    const o = await journal(z, legs);
    const r = await journal(z, negate(legs));
    await asApp(z, (c) => c.query('UPDATE gl_journal_entries SET reversed_at = now(), reversed_by = $2 WHERE id = $1', [o, z.f.fx.userId]), { commit: true });
    await asApp(z, link(r, o), { commit: true });
    await refused(asApp(z, (c) => c.query("UPDATE gl_journal_entries SET status = 'reversed' WHERE id = $1", [o])), /never marked status reversed/);
    await refused(asApp(z, (c) => c.query("UPDATE gl_journal_entries SET status = 'reversed' WHERE id = $1", [r])), /never marked status reversed/);
    const tb = (await sql`SELECT a.account_code, SUM(l.debit - l.credit)::numeric AS net FROM gl_journal_lines l
      JOIN gl_journal_entries e ON e.id = l.journal_entry_id JOIN gl_accounts a ON a.id = l.gl_account_id
      WHERE e.id IN (${o}::UUID, ${r}::UUID) AND e.status = 'posted' GROUP BY 1`) as Row[];
    expect(tb.map((t) => Number(t.net))).toEqual([0, 0]);
  });

  it('M2 a line of another company is refused in a journal, on INSERT and on UPDATE; a line of its own passes', async () => {
    const draft = await journal(z, legs, { status: 'draft' });
    const insert = (company: string, account: string) => (c: PoolClient) => c.query(
      'INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit) VALUES ($1, $2, $3, 5, 0)', [company, draft, account]);
    await refused(asIn(z.f.other.companyId, insert(z.f.other.companyId, z.f.acct.foreign)), LINE_COMPANY);
    await asIn(z.f.fx.companyId, insert(z.f.fx.companyId, z.expense)); // over-strict check: its own company passes
    const lineId = String(((await sql`SELECT id FROM gl_journal_lines WHERE journal_entry_id = ${draft}::UUID LIMIT 1`) as Row[])[0]!.id);
    await refused(asIn(z.f.other.companyId, (c) => c.query('UPDATE gl_journal_lines SET company_id = $1 WHERE id = $2', [z.f.other.companyId, lineId])),
      /journal line belongs to its journal's company|row-level security/);
  });

  it("M2 the deferred account check finds the contra by the journal's company: a legacy line of company B in A's pair cannot move alone", async () => {
    const otherAcct = async (code: string) => String(((await sql`INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype, normal_balance, is_active, level)
      VALUES (${z.f.other.companyId}::UUID, ${code}, ${`R10 ${code}`}, 'revenue', 'operating_revenue', 'credit', true, 3) RETURNING id`) as Row[])[0]!.id);
    const bFrom = await otherAcct(`47${randomUUID().slice(0, 4)}`);
    const bTo = await otherAcct(`48${randomUUID().slice(0, 4)}`);
    // The legacy shape, as the superuser (no 1018 rule binds it): A's O and R each carry a balanced half in company B.
    const both: Leg[] = [[z.ar, 100, 0], [z.revenue, 0, 100]];
    const o = await journal(z, both);
    const r = await journal(z, negate(both));
    await sql`INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit) VALUES
      (${z.f.other.companyId}::UUID, ${o}::UUID, ${bFrom}::UUID, 0, 50), (${z.f.other.companyId}::UUID, ${o}::UUID, ${z.f.acct.foreign}::UUID, 50, 0),
      (${z.f.other.companyId}::UUID, ${r}::UUID, ${bFrom}::UUID, 50, 0), (${z.f.other.companyId}::UUID, ${r}::UUID, ${z.f.acct.foreign}::UUID, 0, 50)`;
    await sql`UPDATE gl_journal_entries SET reversal_of_id = ${o}::UUID WHERE id = ${r}::UUID`;
    const bLine = String(((await sql`SELECT id FROM gl_journal_lines WHERE journal_entry_id = ${o}::UUID AND gl_account_id = ${bFrom}::UUID`) as Row[])[0]!.id);
    expect(await settle(asIn(z.f.other.companyId, (c) => c.query('UPDATE gl_journal_lines SET gl_account_id = $1 WHERE id = $2', [bTo, bLine]), true)))
      .toMatch(/stay the exact negation/);
    expect(((await sql`SELECT public.gl_lines_are_negation(${r}::UUID, ${o}::UUID) AS n`) as Row[])[0]!.n).toBe(true);
  });
});
