/**
 * Migration 1018, review round 7 (the round-6 breaker's probes, now as assertions), as app_user under RLS and claims.
 * Q1 (rule 10): a linked document's status is never NULL: approved -> NULL (-> draft / pending), with or without a
 * reversal, is refused on all three kinds; a NULL-status document links nothing; the new CHECK refuses a NULL status on
 * any document. A LEGACY NULL-status row (the CHECK is NOT VALID) counts as the approved side (no NULL -> draft) and,
 * as a holder, as cancelled (no re-instatement). Not over-strict: the ordinary status moves still pass.
 */
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

/** One superuser transaction with the NOT VALID CHECK dropped (a legacy NULL-status row), then app_user; rolled back. */
async function withLegacyNull(kind: Kind, fn: (c: PoolClient, ids: { o: string; r: string; doc: string }) => Promise<void>): Promise<void> {
  const { o, doc } = await approved(kind);
  const r = await journal(z, negate(legs));
  const c = await z.pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(`ALTER TABLE public.${kind} DROP CONSTRAINT ck_${kind}_status_not_null`);
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

  it.each(KINDS)('%s: Q1 the CHECK refuses a NULL status on an unlinked document', async (kind) => {
    const doc = await document(z, kind, { status: 'approved' });
    const err = await asApp(z, (c) => c.query(`UPDATE ${kind} SET status = NULL WHERE id = $1`, [doc])).then(() => null, (e: { constraint?: string }) => e);
    expect(err?.constraint).toBe(`ck_${kind}_status_not_null`);
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

  it.each(KINDS)('%s: Q1 a legacy NULL-status holder counts as cancelled: its chain is not re-instated', async (kind) => {
    await withLegacyNull(kind, async (c, { o, r }) => {
      await c.query('UPDATE gl_journal_entries SET reversal_of_id = $1 WHERE id = $2', [o, r]); // out: allowed
      const r2 = await journal(z, legs);
      expect(await settle(c.query('UPDATE gl_journal_entries SET reversal_of_id = $1 WHERE id = $2', [r, r2])))
        .toMatch(/journal of a cancelled document back in force/);
    });
  });

  it.each(KINDS)('%s: Q1 a legacy NULL-status unlinked document does not link a journal', async (kind) => {
    const doc = await document(z, kind, { status: 'approved' });
    const x = await journal(z, legs);
    const c = await z.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`ALTER TABLE public.${kind} DROP CONSTRAINT ck_${kind}_status_not_null`);
      await c.query(`UPDATE ${kind} SET status = NULL WHERE id = $1`, [doc]);
      await c.query('SET LOCAL ROLE app_user');
      await c.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: z.f.fx.userId, role: 'authenticated' })]);
      await c.query("SELECT set_config('app.current_company_id', $1, true)", [z.f.fx.companyId]);
      expect(await settle(c.query(`UPDATE ${kind} SET gl_journal_entry_id = $1 WHERE id = $2`, [x, doc]))).toMatch(/without a status does not link/);
    } finally { await c.query('ROLLBACK').catch(() => undefined); c.release(); }
  });

  it.each(KINDS)('%s: over-strict check, the ordinary moves of a linked document still pass (approve, cancel after reversal)', async (kind) => {
    const { o, doc } = await approved(kind);
    if (kind === 'customer_invoices') await app(`UPDATE ${kind} SET status = 'sent' WHERE id = $1`, [doc]);
    await link(await journal(z, negate(legs)), o);
    await app(`UPDATE ${kind} SET status = 'cancelled'${kind === 'credit_notes' ? '' : ', gl_journal_entry_id = NULL'} WHERE id = $1`, [doc]);
  });
});
