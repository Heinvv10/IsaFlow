/**
 * Migration 1018, round 13 (the round-12 breaker's repros, as assertions), as app_user under RLS and claims.
 * L1: a claim takes its journal's AND its chain root's keys, sorted, so a re-reversal (claim, then link) and an account
 * merge's sorted sweep wait instead of deadlocking. L2: a based line is not moved into an older journal. I3: a based
 * line of a posted journal keeps its VAT type. I1: the fixture login's password never reaches the server.
 */
import { Client } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { sql } from '@/lib/neon';
import { isDisposableDb } from '../helpers/assertDisposableDb';
import { dropAppLogin, provisionAppLogin } from './helpers/appLoginWorld';
import { asApp, dropFreeze, journal, negate, openApp, seedFreeze, type Freeze, type Leg, type Row } from './helpers/ledgerFreezeFixture';

const describeIfDisposable = isDisposableDb() ? describe : describe.skip;
let z: Freeze;
let legs: Leg[];
const one = async (q: Promise<unknown>) => ((await q) as Row[])[0]!;
const settle = (p: Promise<unknown>) => p.then(() => 'ACCEPTED', (e: { code?: string; message: string }) => `${e.code ?? ''} ${e.message}`);

/** A posted journal written by app_user inside `c`, born in its transaction. */
async function postAsApp(c: PoolClient, l: Leg[], status = 'posted'): Promise<string> {
  const je = String((await c.query(`INSERT INTO gl_journal_entries (company_id, entry_date, description, source, status, created_by)
    VALUES ($1, '2026-06-12', 'R13 born here', 'auto_vat_late_claim', 'draft', $2) RETURNING id`, [z.f.fx.companyId, z.f.fx.userId])).rows[0].id);
  for (const [acct, d, cr] of l) {
    await c.query('INSERT INTO gl_journal_lines (journal_entry_id, company_id, gl_account_id, debit, credit) VALUES ($1, $2, $3, $4, $5)',
      [je, z.f.fx.companyId, acct, d, cr]);
  }
  if (status === 'posted') await c.query("UPDATE gl_journal_entries SET status = 'posted', posted_at = now() WHERE id = $1", [je]);
  return je;
}

/** Y <- X (X the contra of Y), with Y the lower uuid: a link then takes Y's key before X's. */
async function chainRootFirst(): Promise<{ y: string; x: string }> {
  const y = await journal(z, legs);
  let x = await journal(z, negate(legs));
  while (x < y) x = await journal(z, negate(legs));
  await sql`UPDATE gl_journal_entries SET reversal_of_id = ${y}::UUID WHERE id = ${x}::UUID`;
  return { y, x };
}

describeIfDisposable('ledger column immutability, round 13 (migration 1018)', () => {
  beforeAll(async () => { z = await seedFreeze(); legs = [[z.ar, 100, 0], [z.revenue, 0, 100]]; }, 240000);
  afterAll(async () => { if (z) await dropFreeze(z); }, 120000);
  afterEach(() => { vi.restoreAllMocks(); });

  it('L1 a re-reversal (claim X, then link R2 -> X) and a sorted key sweep over {Y, X} do not deadlock', async () => {
    const { y, x } = await chainRootFirst();
    const reversal = await openApp(z);
    const sweep = await openApp(z);
    try {
      await reversal.query('UPDATE gl_journal_entries SET reversed_at = now(), reversed_by = $2 WHERE id = $1', [x, z.f.fx.userId]);
      const swept = settle(sweep.query('SELECT public.ledger_lock_key(j.id) FROM (SELECT unnest($1::uuid[]) AS id ORDER BY 1 OFFSET 0) j', [[y, x]]));
      await new Promise((r) => setTimeout(r, 500));
      const r2 = await postAsApp(reversal, legs); // the negation of X
      expect(await settle(reversal.query('UPDATE gl_journal_entries SET reversal_of_id = $1 WHERE id = $2', [x, r2]))).toBe('ACCEPTED');
      await reversal.query('COMMIT');
      expect(await swept).toBe('ACCEPTED');
      await sweep.query('COMMIT');
    } finally {
      await reversal.query('ROLLBACK').catch(() => undefined); await sweep.query('ROLLBACK').catch(() => undefined);
      reversal.release(); sweep.release();
    }
  }, 30000);

  it('L2 a line carrying a late-claim base is not moved into an older draft (then posted)', async () => {
    const older = await journal(z, legs, { status: 'draft' });
    expect(await settle(asApp(z, async (c) => {
      const fresh = await postAsApp(c, [], 'draft');
      const line = String((await c.query('INSERT INTO gl_journal_lines (journal_entry_id, company_id, gl_account_id, debit, credit, late_claim_base) VALUES ($1, $2, $3, 1, 0, 9999) RETURNING id',
        [fresh, z.f.fx.companyId, z.expense])).rows[0].id);
      await c.query('UPDATE gl_journal_lines SET journal_entry_id = $1 WHERE id = $2', [older, line]);
    }, { commit: true }))).toMatch(/late-claim base is written only on a journal created in this transaction/);
    // Over-strict check: between two journals born in the transaction, the move passes.
    expect(await settle(asApp(z, async (c) => {
      const a = await postAsApp(c, [], 'draft');
      const b = await postAsApp(c, [], 'draft');
      const line = String((await c.query('INSERT INTO gl_journal_lines (journal_entry_id, company_id, gl_account_id, debit, credit, late_claim_base) VALUES ($1, $2, $3, 1, 0, 5) RETURNING id',
        [a, z.f.fx.companyId, z.expense])).rows[0].id);
      await c.query('UPDATE gl_journal_lines SET journal_entry_id = $1 WHERE id = $2', [b, line]);
    }))).toBe('ACCEPTED');
  });

  it('I3 a based line of a posted journal keeps its VAT type; an unbased one, or a draft\'s, still moves', async () => {
    const vat: Leg[] = [[z.expense, 15, 0], [z.ap, 0, 15]];
    const posted = await journal(z, vat, { source: 'auto_vat_late_claim' });
    await sql`UPDATE gl_journal_lines SET late_claim_base = 100, vat_type = 'standard' WHERE journal_entry_id = ${posted}::UUID AND debit = 15`;
    expect(await settle(asApp(z, (c) => c.query("UPDATE gl_journal_lines SET vat_type = 'zero_rated' WHERE journal_entry_id = $1 AND late_claim_base IS NOT NULL", [posted]))))
      .toMatch(/keeps its VAT type once its journal is posted/);
    expect(await settle(asApp(z, (c) => c.query("UPDATE gl_journal_lines SET vat_type = 'zero_rated' WHERE journal_entry_id = $1 AND late_claim_base IS NULL", [posted])))).toBe('ACCEPTED');
    expect(await settle(asApp(z, async (c) => {
      const d = await postAsApp(c, [], 'draft');
      await c.query("INSERT INTO gl_journal_lines (journal_entry_id, company_id, gl_account_id, debit, credit, late_claim_base, vat_type) VALUES ($1, $2, $3, 15, 0, 100, 'standard')", [d, z.f.fx.companyId, z.expense]);
      await c.query("UPDATE gl_journal_lines SET vat_type = 'zero_rated' WHERE journal_entry_id = $1", [d]);
    }))).toBe('ACCEPTED');
  });

  it('I1 the fixture login is created from a SCRAM verifier: no statement sent to the server carries its password', async () => {
    const sent: string[] = [];
    const real = Client.prototype.query;
    vi.spyOn(Client.prototype, 'query').mockImplementation(function (this: Client, ...args: unknown[]) {
      sent.push(typeof args[0] === 'string' ? args[0] : JSON.stringify(args[0]));
      return (real as (...a: unknown[]) => unknown).apply(this, args) as never;
    } as never);
    const url = process.env.DATABASE_URL!;
    const { role, password } = await provisionAppLogin(url);
    vi.restoreAllMocks();
    try {
      expect(sent.some((t) => /CREATE ROLE/.test(t))).toBe(true);
      expect(sent.filter((t) => t.includes(password))).toEqual([]);
      expect(String((await one(sql`SELECT rolpassword AS p FROM pg_authid WHERE rolname = ${role}`)).p)).toMatch(/^SCRAM-SHA-256\$4096:/);
      const login = new URL(url); login.username = role; login.password = password;
      const c = new Client({ connectionString: login.toString() });
      await c.connect(); // the verifier is right: the password logs in
      try { expect((await c.query('SELECT session_user AS u')).rows[0].u).toBe(role); } finally { await c.end(); }
    } finally { await dropAppLogin(url, role); }
  });
});
