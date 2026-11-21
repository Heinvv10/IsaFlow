/**
 * Migration 1018, round 12 (the round-11 breaker's repros, as assertions), as app_user under RLS and claims.
 * M1: late_claim_base is written only on a line of a journal created in the writing transaction. L3: a document's
 * cancel locks its journal's row before the journal's key, the claim's order, so a claim and a cancel wait instead of
 * deadlocking. L4: posting a journal takes no link key and does not need READ COMMITTED.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';
import { sql } from '@/lib/neon';
import { isDisposableDb } from '../helpers/assertDisposableDb';
import {
  asApp, document, dropFreeze, journal, negate, openApp, reverseAsSuperuser, seedFreeze, type Freeze, type Leg, type Row,
} from './helpers/ledgerFreezeFixture';

const describeIfDisposable = isDisposableDb() ? describe : describe.skip;
let z: Freeze;
let legs: Leg[];
const one = async (q: Promise<unknown>) => ((await q) as Row[])[0]!;
const settle = (p: Promise<unknown>) => p.then(() => 'ACCEPTED', (e: { message: string }) => e.message);
const BASE = /late-claim base is written only on a journal created in this transaction/;
const pid = async (c: PoolClient) => Number((await c.query('SELECT pg_backend_pid() AS p')).rows[0].p);
const advisoryHeld = async (p: number) => Number((await one(sql`SELECT count(*)::int AS n FROM pg_locks
  WHERE locktype = 'advisory' AND pid = ${p} AND granted`)).n);

describeIfDisposable('ledger column immutability, round 12 (migration 1018)', () => {
  beforeAll(async () => { z = await seedFreeze(); legs = [[z.ar, 100, 0], [z.revenue, 0, 100]]; }, 240000);
  afterAll(async () => { if (z) await dropFreeze(z); }, 120000);

  it('M1 a posted companion\'s late-claim base is not changed (100 -> 0, NULL -> 5), nor a linked pair\'s on both sides', async () => {
    const vat: Leg[] = [[z.expense, 15, 0], [z.expense, 30, 0], [z.ap, 0, 45]];
    const cm = await journal(z, vat, { source: 'auto_vat_late_claim' });
    await sql`UPDATE gl_journal_lines SET late_claim_base = 100 WHERE journal_entry_id = ${cm}::UUID AND debit = 15`;
    await expect(settle(asApp(z, (c) => c.query('UPDATE gl_journal_lines SET late_claim_base = 0 WHERE journal_entry_id = $1 AND late_claim_base IS NOT NULL', [cm]), { commit: true }))).resolves.toMatch(BASE);
    await expect(settle(asApp(z, (c) => c.query('UPDATE gl_journal_lines SET late_claim_base = 5 WHERE journal_entry_id = $1 AND late_claim_base IS NULL', [cm]), { commit: true }))).resolves.toMatch(BASE);
    const r = await reverseAsSuperuser(z, cm, vat);
    await sql`UPDATE gl_journal_lines SET late_claim_base = -100 WHERE journal_entry_id = ${r}::UUID AND credit = 15`;
    expect(await settle(asApp(z, (c) => c.query('UPDATE gl_journal_lines SET late_claim_base = late_claim_base * 1000 WHERE journal_entry_id = ANY($1::uuid[]) AND late_claim_base IS NOT NULL', [[cm, r]]), { commit: true }))).toMatch(BASE);
    const draft = await journal(z, vat, { status: 'draft', source: 'auto_vat_late_claim' }); // an older draft takes no new based line either
    expect(await settle(asApp(z, (c) => c.query('INSERT INTO gl_journal_lines (journal_entry_id, company_id, gl_account_id, debit, credit, late_claim_base) VALUES ($1, $2, $3, 1, 0, 7)', [draft, z.f.fx.companyId, z.expense])))).toMatch(BASE);
    expect((await one(sql`SELECT array_agg(late_claim_base ORDER BY debit) AS b FROM gl_journal_lines WHERE journal_entry_id = ${cm}::UUID AND debit > 0`)).b.map((v: unknown) => (v == null ? null : Number(v)))).toEqual([100, null]);
  });

  it('M1 over-strict check: a journal created in the transaction takes its bases, on UPDATE and on INSERT', async () => {
    expect(await settle(asApp(z, async (c) => {
      const je = String((await c.query(`INSERT INTO gl_journal_entries (company_id, entry_date, description, source, status, created_by)
        VALUES ($1, '2026-06-12', 'R12 born here', 'auto_vat_late_claim', 'draft', $2) RETURNING id`, [z.f.fx.companyId, z.f.fx.userId])).rows[0].id);
      await c.query('INSERT INTO gl_journal_lines (journal_entry_id, company_id, gl_account_id, debit, credit, late_claim_base) VALUES ($1, $2, $3, 15, 0, 100), ($1, $2, $4, 0, 15, NULL)',
        [je, z.f.fx.companyId, z.expense, z.ap]);
      await c.query('UPDATE gl_journal_lines SET late_claim_base = 110 WHERE journal_entry_id = $1 AND debit = 15', [je]);
    }))).toBe('ACCEPTED');
  });

  it('L3 a cancel does not take the journal\'s key while a claim holds its row: claim (row, then key) and cancel do not deadlock', async () => {
    const o = await journal(z, legs);
    await reverseAsSuperuser(z, o, legs); // a legacy pair: O is out of force and still claimable (reversed_at NULL)
    const doc = await document(z, 'customer_invoices', { link: o });
    const claim = await openApp(z);
    const cancel = await openApp(z);
    try {
      const cancelPid = await pid(cancel);
      await claim.query('SELECT 1 FROM gl_journal_entries WHERE id = $1 FOR NO KEY UPDATE', [o]); // the claim's UPDATE locks the row
      const cancelling = settle(cancel.query("UPDATE customer_invoices SET status = 'cancelled', gl_journal_entry_id = NULL WHERE id = $1", [doc]));
      await new Promise((r) => setTimeout(r, 500));
      expect(await advisoryHeld(cancelPid)).toBe(0); // waiting on the row, holding no key
      const key = settle(claim.query('SELECT pg_advisory_xact_lock(public.ledger_link_key($1))', [o])); // then the trigger's key
      expect(await key).toBe('ACCEPTED');
      await claim.query('COMMIT');
      expect(await cancelling).toBe('ACCEPTED');
      await cancel.query('COMMIT');
    } finally {
      await claim.query('ROLLBACK').catch(() => undefined); await cancel.query('ROLLBACK').catch(() => undefined);
      claim.release(); cancel.release();
    }
    expect((await one(sql`SELECT status FROM customer_invoices WHERE id = ${doc}::UUID`)).status).toBe('cancelled');
  });

  it('L4 posting drafts takes no link key, and is not refused outside READ COMMITTED', async () => {
    const drafts: string[] = [];
    for (let i = 0; i < 5; i += 1) drafts.push(await journal(z, legs, { status: 'draft' }));
    const c = await z.pool.connect();
    try {
      await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      await c.query('SET LOCAL ROLE app_user');
      await c.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: z.f.fx.userId, role: 'authenticated' })]);
      await c.query("SELECT set_config('app.current_company_id', $1, true)", [z.f.fx.companyId]);
      const me = await pid(c);
      const before = await advisoryHeld(me);
      expect(await settle(c.query("UPDATE gl_journal_entries SET status = 'posted', posted_at = now(), posted_by = $2 WHERE id = ANY($1::uuid[])", [drafts, z.f.fx.userId]))).toBe('ACCEPTED');
      expect(await advisoryHeld(me)).toBe(before);
    } finally { await c.query('ROLLBACK').catch(() => undefined); c.release(); }
  });

  it('L4 over-strict check: a claim (reversed_at) still takes the key and still needs READ COMMITTED', async () => {
    const x = await journal(z, legs);
    const c = await openApp(z);
    try {
      const me = await pid(c);
      await c.query('UPDATE gl_journal_entries SET reversed_at = now(), reversed_by = $2 WHERE id = $1', [x, z.f.fx.userId]);
      expect(await advisoryHeld(me)).toBeGreaterThan(0);
    } finally { await c.query('ROLLBACK').catch(() => undefined); c.release(); }
    expect(negate(legs)).toHaveLength(2);
  });
});
