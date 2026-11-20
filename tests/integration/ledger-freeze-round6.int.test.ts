/**
 * Migration 1018, review round 6 (the round-5 breaker's probes, now as assertions), as app_user under RLS and claims.
 * P1 (rule 9): a linked document never goes back from the approved side to draft / pending approval, in force or not, so
 * reverse -> draft -> re-reverse cannot leave a hidden draft holding a journal in force, nor launder a soft-deleted one.
 * Not over-strict: an unlinked document still goes back (the provisional withdraw), a linked draft is still submitted.
 * P3: the advisory key is tenant-gated (journal id + created_at read under RLS): another tenant cannot stall a link,
 * while a session of the journal's own company still serialises with it.
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
let bUser = '';
const app = (q: string, v: unknown[] = []) => asApp(z, (c: PoolClient) => c.query(q, v), { commit: true });
const link = (contra: string, original: string) => app('UPDATE gl_journal_entries SET reversal_of_id = $1 WHERE id = $2', [original, contra]);
const inForce = async (je: string) => ((await sql`SELECT public.gl_journal_in_force(${je}::UUID) AS f`) as Row[])[0]!.f;
const BACK = /a linked document is not sent back to draft or pending approval/;

async function approvedAndReversed(kind: Kind): Promise<{ o: string; r: string; doc: string }> {
  const o = await journal(z, legs);
  const doc = await document(z, kind, { status: 'draft' });
  await app(`UPDATE ${kind} SET gl_journal_entry_id = $1, status = 'approved' WHERE id = $2`, [o, doc]);
  const r = await journal(z, negate(legs));
  await link(r, o);
  return { o, r, doc };
}
/** An app_user transaction for `user` in `company`, left open: the caller rolls back and releases. */
async function openAs(user: string, company: string): Promise<PoolClient> {
  const c = await z.pool.connect();
  await c.query('BEGIN');
  await c.query("SET LOCAL lock_timeout = '1500ms'");
  await c.query('SET LOCAL ROLE app_user');
  await c.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: user, role: 'authenticated' })]);
  await c.query("SELECT set_config('app.current_company_id', $1, true)", [company]);
  return c;
}

describeIfDisposable('ledger column immutability, round 6 (migration 1018)', () => {
  beforeAll(async () => {
    z = await seedFreeze();
    legs = [[z.ar, 100, 0], [z.revenue, 0, 100]];
    bUser = randomUUID();
    await sql`INSERT INTO users (id, email, role, is_active) VALUES (${bUser}, ${`lcf-b-${bUser}@isaflow.test`}, 'admin', true)`;
    await sql`INSERT INTO company_users (company_id, user_id, role) VALUES (${z.f.other.companyId}::UUID, ${bUser}, 'admin')`;
  }, 240000);
  afterAll(async () => {
    if (!z) return;
    await sql`DELETE FROM company_users WHERE user_id = ${bUser}`;
    await sql`DELETE FROM users WHERE id = ${bUser}`;
    await dropFreeze(z);
  }, 120000);

  it.each(KINDS)('%s: P1 (B6/B7) approved -> reversed -> back to draft or pending is refused; the re-reversal then keeps it in AR/AP', async (kind) => {
    const { o, r, doc } = await approvedAndReversed(kind);
    const back = kind === 'credit_notes' ? ['draft'] : ['draft', 'pending_approval'];
    for (const status of back) await refused(asApp(z, (c) => c.query(`UPDATE ${kind} SET status = $2 WHERE id = $1`, [doc, status])), BACK);
    await link(await journal(z, legs), r); // the document is still approved: the re-instated journal stays in AR/AP
    expect(await inForce(o)).toBe(true);
    expect(((await z.pool.query(`SELECT status FROM ${kind} WHERE id = $1`, [doc])).rows[0] as Row).status).toBe('approved');
  });

  it.each(['customer_invoices', 'supplier_invoices'] as const)('%s: P1 (B3d/B3e) a soft-deleted document is not laundered through draft', async (kind) => {
    const { o, r, doc } = await approvedAndReversed(kind);
    await app(`UPDATE ${kind} SET deleted_at = now() WHERE id = $1`, [doc]);
    await refused(asApp(z, (c) => c.query(`UPDATE ${kind} SET status = 'draft' WHERE id = $1`, [doc])), BACK);
    await refused(asApp(z, (c) => c.query(`UPDATE ${kind} SET status = 'draft', deleted_at = NULL WHERE id = $1`, [doc])), BACK);
    const r2 = await journal(z, legs);
    await refused(asApp(z, (c) => c.query('UPDATE gl_journal_entries SET reversal_of_id = $1 WHERE id = $2', [r, r2])), /journal of a cancelled document back in force/);
    expect(await inForce(o)).toBe(false);
  });

  it.each(KINDS)('%s: P1 over-strict check, an unlinked document goes back to draft and a linked draft is submitted', async (kind) => {
    const unlinked = await document(z, kind, { status: 'approved' });
    await app(`UPDATE ${kind} SET status = 'draft' WHERE id = $1`, [unlinked]); // the provisional withdraw: a NULL link
    if (kind === 'credit_notes') return;
    const drafted = await document(z, kind, { status: 'draft' });
    await app(`UPDATE ${kind} SET gl_journal_entry_id = $1 WHERE id = $2`, [await journal(z, legs), drafted]); // "Post to GL"
    await app(`UPDATE ${kind} SET status = 'pending_approval' WHERE id = $1`, [drafted]);
  });

  it('P3 another tenant cannot hold a journal\'s advisory key; a session of its own company still serialises with it', async () => {
    const oacc = String(((await sql`SELECT id FROM gl_accounts WHERE company_id = ${z.f.other.companyId}::UUID AND account_code = '4100'`) as Row[])[0]!.id);
    const attempt = async (holder: 'tenantA' | 'sameCompany') => {
      const je = await journal(z, [[oacc, 100, 0], [oacc, 0, 100]], { company: z.f.other.companyId });
      const doc = await document(z, 'customer_invoices', { status: 'draft', company: z.f.other.companyId });
      const a = holder === 'tenantA' ? await openAs(z.f.fx.userId, z.f.fx.companyId) : await openAs(bUser, z.f.other.companyId);
      const b = await openAs(bUser, z.f.other.companyId);
      try {
        // Every key the holder can compute: the old formula and ledger_link_key as the holder sees the journal.
        await a.query("SELECT pg_advisory_xact_lock(hashtextextended('doc_journal_link:' || $1, 0))", [je]);
        await a.query('SELECT pg_advisory_xact_lock(public.ledger_link_key($1))', [je]);
        return await b.query('UPDATE customer_invoices SET gl_journal_entry_id = $1 WHERE id = $2', [je, doc])
          .then(() => 'linked', (e: { code?: string }) => String(e.code));
      } finally {
        await b.query('ROLLBACK').catch(() => undefined); b.release();
        await a.query('ROLLBACK').catch(() => undefined); a.release();
      }
    };
    expect(await attempt('tenantA')).toBe('linked');
    expect(await attempt('sameCompany')).toBe('55P03');
  });
});
