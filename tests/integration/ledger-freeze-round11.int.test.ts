/**
 * Migration 1018, round 11 (the round-10 breaker's repros and the merge queue's codex gate, as assertions), as app_user
 * under RLS and claims. M1: a journal is linked as a reversal only in the transaction that claimed the journal it
 * reverses and created the contra, so an independent posting with the same lines never joins a chain. L1: no journal is
 * INSERTed as 'reversed', and a document links only a journal of status 'posted'. G2: a contra carries the late-claim
 * base negated, checked at commit. G3: the deferred line check refuses when it cannot see the journal. G4: a change of
 * the reversal stamp waits for a link of that journal.
 */
import { randomUUID } from 'crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';
import { sql } from '@/lib/neon';
import { isDisposableDb } from '../helpers/assertDisposableDb';
import {
  asApp, document, dropFreeze, journal, linkAsApp, negate, openApp, refused, seedFreeze, type Freeze, type Leg, type Row,
} from './helpers/ledgerFreezeFixture';

const describeIfDisposable = isDisposableDb() ? describe : describe.skip;
let z: Freeze;
let legs: Leg[];
const one = async (q: Promise<unknown>) => ((await q) as Row[])[0]!;
const inForce = async (je: string) => (await one(sql`SELECT public.gl_journal_in_force(${je}::UUID) AS f`)).f;
const settle = (p: Promise<unknown>) => p.then(() => 'ACCEPTED', (e: { message: string }) => e.message);
const rawLink = (contra: string, original: string) => (c: PoolClient) =>
  c.query('UPDATE gl_journal_entries SET reversal_of_id = $1 WHERE id = $2', [original, contra]);
const BORN_HERE = /claimed the journal and created the reversal/;

/** A posted journal written by app_user inside `c` (draft, lines, post), as createJournalEntry + postJournalEntry do. */
async function postAsApp(c: PoolClient, l: Leg[]): Promise<string> {
  const je = String((await c.query(`INSERT INTO gl_journal_entries (company_id, entry_date, description, source, status, created_by)
    VALUES ($1, '2026-06-12', 'R11 born here', 'manual', 'draft', $2) RETURNING id`, [z.f.fx.companyId, z.f.fx.userId])).rows[0].id);
  for (const [acct, d, cr] of l) {
    await c.query('INSERT INTO gl_journal_lines (journal_entry_id, company_id, gl_account_id, debit, credit) VALUES ($1, $2, $3, $4, $5)',
      [je, z.f.fx.companyId, acct, d, cr]);
  }
  await c.query("UPDATE gl_journal_entries SET status = 'posted', posted_at = now() WHERE id = $1", [je]);
  return je;
}

describeIfDisposable('ledger column immutability, round 11 (migration 1018)', () => {
  beforeAll(async () => { z = await seedFreeze(); legs = [[z.ar, 250, 0], [z.revenue, 0, 250]]; }, 240000);
  afterAll(async () => { if (z) await dropFreeze(z); }, 120000);

  it('M1 an independent posted journal with the same lines is not linked as a reversal: J1 stays out of force', async () => {
    const j1 = await journal(z, legs);
    const r1 = await journal(z, negate(legs));
    await asApp(z, (c) => linkAsApp(c, r1, j1), { commit: true });
    const j2 = await journal(z, legs); // a later, independent posting (a repeated debit order, a re-approval)
    expect([await inForce(j1), await inForce(j2)]).toEqual([false, true]);
    await refused(asApp(z, rawLink(j2, r1)), BORN_HERE);
    // Claiming R1 in the linking transaction is not enough: J2 was created in another one, and cannot be re-stamped.
    await refused(asApp(z, async (c) => {
      await c.query('UPDATE gl_journal_entries SET reversed_at = now(), reversed_by = $2 WHERE id = $1', [r1, z.f.fx.userId]);
      return rawLink(j2, r1)(c);
    }), BORN_HERE);
    await refused(asApp(z, (c) => c.query('UPDATE gl_journal_entries SET created_at = now() WHERE id = $1', [j2])), /created_at is frozen|created_at is never changed/);
    const draft = await journal(z, legs, { status: 'draft' });
    await refused(asApp(z, (c) => c.query('UPDATE gl_journal_entries SET created_at = now() WHERE id = $1', [draft])), /created_at is never changed/);
    expect([await inForce(j1), await inForce(j2)]).toEqual([false, true]);
  });

  it('M1 over-strict check: a contra born, posted and linked in the transaction that claims the original links', async () => {
    const o = await journal(z, legs);
    const r = await asApp(z, async (c) => {
      await c.query('UPDATE gl_journal_entries SET reversed_at = now(), reversed_by = $2 WHERE id = $1', [o, z.f.fx.userId]);
      const contra = await postAsApp(c, negate(legs));
      await rawLink(contra, o)(c);
      return contra;
    }, { commit: true });
    expect((await one(sql`SELECT reversal_of_id AS r FROM gl_journal_entries WHERE id = ${r}::UUID`)).r).toBe(o);
    expect(await inForce(o)).toBe(false);
  });

  it("L1 no journal is INSERTed as 'reversed'; 'draft' and 'posted' inserts pass", async () => {
    const ins = (status: string) => (c: PoolClient) => c.query(`INSERT INTO gl_journal_entries (company_id, entry_date, description, source, status, created_by)
      VALUES ($1, '2026-06-10', 'R11 insert', 'auto_invoice', $2, $3)`, [z.f.fx.companyId, status, z.f.fx.userId]);
    await refused(asApp(z, ins('reversed')), /never marked status reversed/);
    await asApp(z, ins('draft'));
    await asApp(z, ins('posted'));
  });

  it.each(['customer_invoices', 'supplier_invoices', 'credit_notes'] as const)(
    "L1 %s: a document links only a journal of status 'posted', never a legacy 'reversed' one", async (kind) => {
      const legacy = await journal(z, legs, { status: 'reversed' }); // superuser: the legacy shape
      const doc = await document(z, kind, { status: 'approved' });
      await refused(asApp(z, (c) => c.query(`UPDATE ${kind} SET gl_journal_entry_id = $1 WHERE id = $2`, [legacy, doc])),
        /links only a posted, unreversed journal/);
      const fresh = await journal(z, legs);
      await asApp(z, (c) => c.query(`UPDATE ${kind} SET gl_journal_entry_id = $1 WHERE id = $2`, [fresh, doc])); // over-strict check
    });

  it('G2 a contra that does not carry the late-claim base negated is refused at commit; with it, the link commits', async () => {
    const vatLegs: Leg[] = [[z.expense, 0, 15], [z.ap, 15, 0]];
    const o = await journal(z, vatLegs, { source: 'auto_vat_late_claim' });
    await sql`UPDATE gl_journal_lines SET late_claim_base = 100 WHERE journal_entry_id = ${o}::UUID AND gl_account_id = ${z.expense}::UUID`;
    const bare = await journal(z, negate(vatLegs), { source: 'auto_vat_late_claim' });
    expect(await settle(asApp(z, (c) => linkAsApp(c, bare, o), { commit: true }))).toMatch(/carries the late-claim base of the journal it reverses/);
    const copied = await journal(z, negate(vatLegs), { source: 'auto_vat_late_claim' });
    await asApp(z, async (c) => {
      await linkAsApp(c, copied, o);
      await c.query('UPDATE gl_journal_lines SET late_claim_base = -100 WHERE journal_entry_id = $1 AND gl_account_id = $2', [copied, z.expense]);
    }, { commit: true });
    expect((await one(sql`SELECT reversal_of_id AS r FROM gl_journal_entries WHERE id = ${copied}::UUID`)).r).toBe(o);
    // Once linked, the base does not move on one side, nor (round 12 M1) on both: it is written only on a journal
    // created in the writing transaction.
    expect(await settle(asApp(z, (c) => c.query('UPDATE gl_journal_lines SET late_claim_base = -90 WHERE journal_entry_id = $1 AND late_claim_base IS NOT NULL', [copied]), { commit: true })))
      .toMatch(/stay the exact negation|late-claim base is written only on a journal created in this transaction/);
    expect(await settle(asApp(z, async (c) => {
      await c.query('UPDATE gl_journal_lines SET late_claim_base = 90 WHERE journal_entry_id = $1 AND late_claim_base IS NOT NULL', [o]);
      await c.query('UPDATE gl_journal_lines SET late_claim_base = -90 WHERE journal_entry_id = $1 AND late_claim_base IS NOT NULL', [copied]);
    }, { commit: true }))).toMatch(/late-claim base is written only on a journal created in this transaction/);
  });

  it('G3 the deferred line check refuses a change it cannot judge: a legacy line whose journal the caller cannot see', async () => {
    const bUser = randomUUID();
    await sql`INSERT INTO users (id, email, role, is_active) VALUES (${bUser}, ${`r11-${bUser}@isaflow.test`}, 'admin', true)`;
    await sql`INSERT INTO company_users (company_id, user_id, role) VALUES (${z.f.other.companyId}::UUID, ${bUser}, 'admin')`;
    try {
      const acct = async (code: string) => String((await one(sql`INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype, normal_balance, is_active, level)
        VALUES (${z.f.other.companyId}::UUID, ${code}, ${`R11 ${code}`}, 'revenue', 'operating_revenue', 'credit', true, 3) RETURNING id`)).id);
      const bFrom = await acct(`57${randomUUID().slice(0, 4)}`);
      const bTo = await acct(`58${randomUUID().slice(0, 4)}`);
      const o = await journal(z, legs);
      const r = await journal(z, negate(legs));
      await sql`INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit) VALUES
        (${z.f.other.companyId}::UUID, ${o}::UUID, ${bFrom}::UUID, 0, 50), (${z.f.other.companyId}::UUID, ${o}::UUID, ${z.f.acct.foreign}::UUID, 50, 0),
        (${z.f.other.companyId}::UUID, ${r}::UUID, ${bFrom}::UUID, 50, 0), (${z.f.other.companyId}::UUID, ${r}::UUID, ${z.f.acct.foreign}::UUID, 0, 50)`;
      await sql`UPDATE gl_journal_entries SET reversal_of_id = ${o}::UUID WHERE id = ${r}::UUID`;
      const line = String((await one(sql`SELECT id FROM gl_journal_lines WHERE journal_entry_id = ${o}::UUID AND gl_account_id = ${bFrom}::UUID`)).id);
      const c = await z.pool.connect();
      try {
        await c.query('BEGIN');
        await c.query('SET LOCAL ROLE app_user');
        await c.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: bUser, role: 'authenticated' })]);
        await c.query("SELECT set_config('app.current_company_id', $1, true)", [z.f.other.companyId]);
        expect((await c.query('SELECT count(*)::int AS n FROM gl_journal_entries WHERE id = $1', [o])).rows[0].n).toBe(0); // hidden
        const moved = await c.query('UPDATE gl_journal_lines SET gl_account_id = $1 WHERE id = $2', [bTo, line]);
        expect(moved.rowCount).toBe(1); // the line is visible to company B
        expect(await settle(c.query('COMMIT'))).toMatch(/a line of a journal the caller cannot see is not changed/);
      } finally { await c.query('ROLLBACK').catch(() => undefined); c.release(); }
      expect((await one(sql`SELECT gl_account_id AS a FROM gl_journal_lines WHERE id = ${line}::UUID`)).a).toBe(bFrom);
    } finally {
      await sql`DELETE FROM gl_account_balances WHERE gl_account_id IN (SELECT id FROM gl_accounts WHERE company_id = ${z.f.other.companyId}::UUID)`;
      await sql`DELETE FROM company_users WHERE user_id = ${bUser}`;
      await sql`DELETE FROM users WHERE id = ${bUser}`;
    }
  });

  it('G4 a change of the reversal stamp waits for a session holding that journal\'s link key, and is refused outside READ COMMITTED', async () => {
    const x = await journal(z, legs);
    const doc = await document(z, 'customer_invoices', { status: 'approved' });
    const first = await openApp(z);
    const second = await openApp(z);
    try {
      await first.query('UPDATE customer_invoices SET gl_journal_entry_id = $1 WHERE id = $2', [x, doc]); // takes x's link key
      let done = false;
      const stamp = second.query('UPDATE gl_journal_entries SET reversed_at = now(), reversed_by = $2 WHERE id = $1', [x, z.f.fx.userId])
        .then(() => { done = true; });
      await new Promise((r) => setTimeout(r, 400));
      expect(done).toBe(false);
      await first.query('COMMIT');
      await stamp;
      expect(done).toBe(true);
    } finally {
      await first.query('ROLLBACK').catch(() => undefined); await second.query('ROLLBACK').catch(() => undefined);
      first.release(); second.release();
    }
    const rr = await z.pool.connect();
    try {
      await rr.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      await rr.query('SET LOCAL ROLE app_user');
      await rr.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: z.f.fx.userId, role: 'authenticated' })]);
      await rr.query("SELECT set_config('app.current_company_id', $1, true)", [z.f.fx.companyId]);
      expect(await settle(rr.query('UPDATE gl_journal_entries SET reversed_at = now(), reversed_by = $2 WHERE id = $1', [x, z.f.fx.userId])))
        .toMatch(/READ COMMITTED/);
    } finally { await rr.query('ROLLBACK').catch(() => undefined); rr.release(); }
  });
});
