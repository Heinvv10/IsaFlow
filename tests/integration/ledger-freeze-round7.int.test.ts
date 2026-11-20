/**
 * Migration 1018, review round 7 (the round-6 breaker's probes, now as assertions), as app_user under RLS and claims.
 * Q1 (rule 10): a linked document's status is never NULL: approved -> NULL (-> draft / pending), with or without a
 * reversal, is refused on all three kinds; a NULL-status document links nothing. A LEGACY NULL-status row (written by
 * the superuser: NULL stays a legal shape, shared/documentPopulation reads it as issued) counts as the approved side
 * (no NULL -> draft). Not over-strict: an unlinked document may still hold NULL, a NULL-status holder's chain still
 * re-instates (it is in the AR/AP population), and the ordinary status moves still pass.
 */
import { randomUUID } from 'crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';
import { sql } from '@/lib/neon';
import { isDisposableDb } from '../helpers/assertDisposableDb';
import { asApp, document, dropFreeze, journal, negate, refused, seedFreeze, type Freeze, type Leg, type Row } from './helpers/ledgerFreezeFixture';

const describeIfDisposable = isDisposableDb() ? describe : describe.skip;
type Kind = 'customer_invoices' | 'supplier_invoices' | 'credit_notes';
const KINDS: Kind[] = ['customer_invoices', 'supplier_invoices', 'credit_notes'];
let z: Freeze;
let legs: Leg[];
const app = (q: string, v: unknown[] = []) => asApp(z, (c: PoolClient) => c.query(q, v), { commit: true });
const link = (contra: string, original: string) => app('UPDATE gl_journal_entries SET reversal_of_id = $1 WHERE id = $2', [original, contra]);
const inForce = async (je: string) => ((await sql`SELECT public.gl_journal_in_force(${je}::UUID) AS f`) as Row[])[0]!.f;
const NULL_STATUS = /a linked document keeps a status/;

async function approved(kind: Kind): Promise<{ o: string; doc: string }> {
  const o = await journal(z, legs);
  const doc = await document(z, kind, { status: 'draft' });
  await app(`UPDATE ${kind} SET gl_journal_entry_id = $1, status = 'approved' WHERE id = $2`, [o, doc]);
  return { o, doc };
}

/** One superuser transaction that writes a legacy NULL status, then continues as app_user; rolled back. */
async function withLegacyNull(kind: Kind, fn: (c: PoolClient, ids: { o: string; r: string; doc: string }) => Promise<void>): Promise<void> {
  const { o, doc } = await approved(kind);
  const r = await journal(z, negate(legs));
  const c = await z.pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(`UPDATE ${kind} SET status = NULL WHERE id = $1`, [doc]); // as the superuser: the legacy shape
    await c.query('SET LOCAL ROLE app_user');
    await c.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: z.f.fx.userId, role: 'authenticated' })]);
    await c.query("SELECT set_config('app.current_company_id', $1, true)", [z.f.fx.companyId]);
    await fn(c, { o, r, doc });
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    c.release();
  }
}
const settle = (p: Promise<unknown>) => p.then(() => 'ACCEPTED', (e: { message: string }) => e.message);

describeIfDisposable('ledger column immutability, round 7 (migration 1018)', () => {
  beforeAll(async () => { z = await seedFreeze(); legs = [[z.ar, 100, 0], [z.revenue, 0, 100]]; }, 240000);
  afterAll(async () => { if (z) await dropFreeze(z); }, 120000);

  it.each(KINDS)('%s: Q1 (R6-1a/b) approved -> NULL is refused while the journal is in force', async (kind) => {
    const { o, doc } = await approved(kind);
    await refused(asApp(z, (c) => c.query(`UPDATE ${kind} SET status = NULL WHERE id = $1`, [doc])), NULL_STATUS);
    expect(await inForce(o)).toBe(true);
  });

  it.each(KINDS)('%s: Q1 (R6-1c) after a reversal, approved -> NULL is refused too', async (kind) => {
    const { o, doc } = await approved(kind);
    await link(await journal(z, negate(legs)), o);
    await refused(asApp(z, (c) => c.query(`UPDATE ${kind} SET status = NULL WHERE id = $1`, [doc])), NULL_STATUS);
  });

  it.each(KINDS)('%s: over-strict check, an unlinked document may still be given a NULL status (a legal legacy shape)', async (kind) => {
    const doc = await document(z, kind, { status: 'approved' });
    expect((await asApp(z, (c) => c.query(`UPDATE ${kind} SET status = NULL WHERE id = $1`, [doc]))).rowCount).toBe(1);
  });

  it.each(KINDS)('%s: Q1 a legacy NULL-status document counts as the approved side: NULL -> draft / pending is refused', async (kind) => {
    await withLegacyNull(kind, async (c, { doc }) => {
      await c.query('SAVEPOINT s');
      expect(await settle(c.query(`UPDATE ${kind} SET status = 'draft' WHERE id = $1`, [doc]))).toMatch(/not sent back to draft or pending approval/);
      await c.query('ROLLBACK TO SAVEPOINT s');
      if (kind !== 'credit_notes') {
        expect(await settle(c.query(`UPDATE ${kind} SET status = 'pending_approval' WHERE id = $1`, [doc]))).toMatch(/not sent back to draft/);
      }
    });
  });

  it.each(KINDS)('%s: over-strict check, a legacy NULL-status holder is issued, so its chain still re-instates', async (kind) => {
    await withLegacyNull(kind, async (c, { o, r }) => {
      await c.query('UPDATE gl_journal_entries SET reversal_of_id = $1 WHERE id = $2', [o, r]); // out: allowed
      const r2 = await journal(z, legs);
      expect(await settle(c.query('UPDATE gl_journal_entries SET reversal_of_id = $1 WHERE id = $2', [r, r2]))).toBe('ACCEPTED');
    });
  });

  it.each(KINDS)('%s: Q1 a legacy NULL-status unlinked document does not link a journal', async (kind) => {
    const doc = await document(z, kind, { status: 'approved' });
    const x = await journal(z, legs);
    const c = await z.pool.connect();
    try {
      await c.query('BEGIN');
        await c.query(`UPDATE ${kind} SET status = NULL WHERE id = $1`, [doc]);
      await c.query('SET LOCAL ROLE app_user');
      await c.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: z.f.fx.userId, role: 'authenticated' })]);
      await c.query("SELECT set_config('app.current_company_id', $1, true)", [z.f.fx.companyId]);
      expect(await settle(c.query(`UPDATE ${kind} SET gl_journal_entry_id = $1 WHERE id = $2`, [x, doc]))).toMatch(/without a status does not link/);
    } finally { await c.query('ROLLBACK').catch(() => undefined); c.release(); }
  });

  // Q2, the stated BOUNDARY (not a guarantee): pg_locks is readable by PUBLIC, so another tenant can read a key that a
  // session holds and hold it; the victim waits until lock_timeout (55P03) and nothing is written. If pg_locks is ever
  // revoked from PUBLIC on the test cluster, this flips: then invert it into the guarantee.
  it('Q2 (R6-2) boundary: a key read from pg_locks lets another tenant stall a journal until lock_timeout, writing nothing', async () => {
    const oacc = String(((await sql`SELECT id FROM gl_accounts WHERE company_id = ${z.f.other.companyId}::UUID AND account_code = '4100'`) as Row[])[0]!.id);
    const bUser = randomUUID();
    await sql`INSERT INTO users (id, email, role, is_active) VALUES (${bUser}, ${`lcf-b-${bUser}@isaflow.test`}, 'admin', true)`;
    await sql`INSERT INTO company_users (company_id, user_id, role) VALUES (${z.f.other.companyId}::UUID, ${bUser}, 'admin')`;
    const open = async (user: string, company: string) => {
      const c = await z.pool.connect();
      await c.query('BEGIN');
      await c.query("SET LOCAL lock_timeout = '1500ms'");
      await c.query('SET LOCAL ROLE app_user');
      await c.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: user, role: 'authenticated' })]);
      await c.query("SELECT set_config('app.current_company_id', $1, true)", [company]);
      return c;
    };
    const je = await journal(z, [[oacc, 100, 0], [oacc, 0, 100]], { company: z.f.other.companyId });
    const [d1, d2] = [await document(z, 'customer_invoices', { status: 'draft', company: z.f.other.companyId }),
      await document(z, 'customer_invoices', { status: 'draft', company: z.f.other.companyId })];
    const keysOf = async (c: PoolClient) => new Set(((await c.query(
      "SELECT ((classid::bigint << 32) | objid::bigint)::text AS k FROM pg_locks WHERE locktype = 'advisory' AND granted")).rows as Row[]).map((r) => String(r.k)));
    const a = await open(z.f.fx.userId, z.f.fx.companyId);
    const b = await open(bUser, z.f.other.companyId);
    try {
      expect((await a.query('SELECT 1 FROM gl_journal_entries WHERE id = $1', [je])).rowCount).toBe(0); // A cannot see the journal
      const before = await keysOf(a);
      await b.query('UPDATE customer_invoices SET gl_journal_entry_id = $1 WHERE id = $2', [je, d1]); // B holds the key
      const seen = [...await keysOf(a)].filter((k) => !before.has(k));
      await b.query('ROLLBACK');
      for (const k of seen) await a.query('SELECT pg_advisory_xact_lock($1::bigint)', [k]);
      await b.query('BEGIN');
      await b.query("SET LOCAL lock_timeout = '1500ms'");
      await b.query('SET LOCAL ROLE app_user');
      await b.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: bUser, role: 'authenticated' })]);
      await b.query("SELECT set_config('app.current_company_id', $1, true)", [z.f.other.companyId]);
      const res = await b.query('UPDATE customer_invoices SET gl_journal_entry_id = $1 WHERE id = $2', [je, d2]).then(() => 'linked', (e: { code?: string }) => String(e.code));
      expect(res).toBe('55P03');
    } finally {
      await b.query('ROLLBACK').catch(() => undefined); b.release();
      await a.query('ROLLBACK').catch(() => undefined); a.release();
      await sql`DELETE FROM company_users WHERE user_id = ${bUser}`;
      await sql`DELETE FROM users WHERE id = ${bUser}`;
    }
    expect(((await sql`SELECT count(*)::int AS n FROM customer_invoices WHERE gl_journal_entry_id = ${je}::UUID`) as Row[])[0]!.n).toBe(0);
  });

  it.each(KINDS)('%s: over-strict check, the ordinary moves of a linked document still pass (approve, cancel after reversal)', async (kind) => {
    const { o, doc } = await approved(kind);
    if (kind === 'customer_invoices') await app(`UPDATE ${kind} SET status = 'sent' WHERE id = $1`, [doc]);
    await link(await journal(z, negate(legs)), o);
    await app(`UPDATE ${kind} SET status = 'cancelled'${kind === 'credit_notes' ? '' : ', gl_journal_entry_id = NULL'} WHERE id = $1`, [doc]);
  });
});
