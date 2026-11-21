/**
 * Migration 1018, review round 2: the chain's parity decides "in force" (M1); a document is not sent back to draft or
 * pending approval while its journal is in force (M2); a linked journal's line set is closed and its accounts stay
 * negations (M3); a document linking X and a contra being linked to X wait for one another (L1); a second contra is
 * refused by the trigger itself, with the unique index dropped (L3). As app_user under RLS and claims.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';
import { sql } from '@/lib/neon';
import { isDisposableDb } from '../helpers/assertDisposableDb';
import {
  asApp, asRole, document, dropFreeze, journal, negate, openApp, refused, reverseAsSuperuser, seedFreeze, type Freeze, type Leg, type Row, linkAsApp,
} from './helpers/ledgerFreezeFixture';

const describeIfDisposable = isDisposableDb() ? describe : describe.skip;
type Kind = 'customer_invoices' | 'supplier_invoices' | 'credit_notes';
const KINDS: Kind[] = ['customer_invoices', 'supplier_invoices', 'credit_notes'];
let z: Freeze;
let legs: Leg[];
/** A link, or (null) the unlink as only a cancel writes it (migration 1018 round 3: status 'cancelled' in the same UPDATE). */
const setLink = (kind: Kind, id: string, je: string | null) => (c: PoolClient) => (je === null
  ? c.query(`UPDATE ${kind} SET gl_journal_entry_id = NULL, status = 'cancelled' WHERE id = $1`, [id])
  : c.query(`UPDATE ${kind} SET gl_journal_entry_id = $1 WHERE id = $2`, [je, id]));
const setStatus = (kind: Kind, id: string, status: string) => (c: PoolClient) =>
  c.query(`UPDATE ${kind} SET status = $2 WHERE id = $1`, [id, status]);
const link = (contra: string, original: string) => (c: PoolClient) => linkAsApp(c, contra, original);
const accountsOf = async (je: string) => ((await sql`SELECT gl_account_id FROM gl_journal_lines WHERE journal_entry_id = ${je}::UUID ORDER BY debit DESC`) as Row[]).map((r) => String(r.gl_account_id));

describeIfDisposable('ledger column immutability, round 2 (migration 1018)', () => {
  beforeAll(async () => { z = await seedFreeze(); legs = [[z.ar, 100, 0], [z.revenue, 0, 100]]; }, 240000);
  afterAll(async () => { if (z) await dropFreeze(z); }, 120000);

  it.each(KINDS)('%s: M1 a re-instated chain (O <- R <- R2) still holds its document; out again at R3', async (kind) => {
    const original = await journal(z, legs);
    const doc = await document(z, kind, { link: original });
    const r1 = await reverseAsSuperuser(z, original, legs);
    const r2 = await reverseAsSuperuser(z, r1, negate(legs));
    await refused(asApp(z, setLink(kind, doc, null)), /in force cannot be unlinked/);
    await refused(asApp(z, setStatus(kind, doc, 'cancelled')), /journal is in force/);
    await reverseAsSuperuser(z, r2, legs);
    await asApp(z, setLink(kind, doc, null), { commit: true });
  });

  it.each(KINDS)('%s: M2 not sent back to draft or pending approval while its journal is in force', async (kind) => {
    const original = await journal(z, legs);
    const doc = await document(z, kind, { link: original });
    const back = kind === 'credit_notes' ? ['draft'] : ['draft', 'pending_approval'];
    for (const status of back) await refused(asApp(z, setStatus(kind, doc, status)), /not sent back to draft or pending approval/);
    await reverseAsSuperuser(z, original, legs);
    // Round 6 (rule 9): out of force does not open the way back either; a linked document is cancelled instead.
    for (const status of back) await refused(asApp(z, setStatus(kind, doc, status)), /not sent back to draft or pending approval/);
    const unlinked = await document(z, kind, { status: 'approved' });
    await asApp(z, setStatus(kind, unlinked, 'draft')); // the provisional withdraw: a NULL link
    if (kind !== 'credit_notes') {
      const drafted = await document(z, kind, { status: 'draft', link: await journal(z, legs) });
      await asApp(z, setStatus(kind, drafted, 'pending_approval')); // a draft that was Post-to-GL'd may be submitted
    }
  });

  it('M3 a linked journal\'s line set is closed, and an account moves only on both sides', async () => {
    const original = await journal(z, legs);
    const contra = await journal(z, negate(legs));
    await asApp(z, link(contra, original), { commit: true });
    const add = (je: string) => (c: PoolClient) => c.query('INSERT INTO gl_journal_lines (journal_entry_id, company_id, gl_account_id, debit, credit) VALUES ($1, $2, $3, 0, 0)', [je, z.f.fx.companyId, z.ap]);
    await refused(asApp(z, add(contra)), /are closed/);
    await refused(asApp(z, add(original)), /are closed/);
    await refused(asApp(z, (c) => c.query('DELETE FROM gl_journal_lines WHERE journal_entry_id = $1', [contra])), /are closed/);
    await refused(asApp(z, (c) => c.query('UPDATE gl_journal_lines SET gl_account_id = $2 WHERE journal_entry_id = $1 AND credit > 0', [original, z.ap]), { commit: true }), /stay the exact negation/);
    expect((await accountsOf(original)).sort()).toEqual([z.ar, z.revenue].sort());
    // An account merge: one statement per journal, in one transaction; the pair is a negation again at COMMIT.
    await asApp(z, async (c) => {
      for (const je of [original, contra]) await c.query('UPDATE gl_journal_lines SET gl_account_id = $2 WHERE journal_entry_id = $1 AND gl_account_id = $3', [je, z.expense, z.revenue]);
    }, { commit: true });
    expect((await accountsOf(contra)).sort()).toEqual([z.ar, z.expense].sort());
  });

  it('M3 lines added to a contra in the transaction that created and linked it are refused', async () => {
    const original = await journal(z, legs);
    await refused(asApp(z, async (c) => {
      const je = (await c.query(`INSERT INTO gl_journal_entries (company_id, entry_date, description, source, status, created_by)
        VALUES ($1, '2026-06-11', 'born contra', 'manual', 'draft', $2) RETURNING id`, [z.f.fx.companyId, z.f.fx.userId])).rows[0].id;
      for (const [acct, d, cr] of negate(legs)) {
        await c.query('INSERT INTO gl_journal_lines (journal_entry_id, company_id, gl_account_id, debit, credit) VALUES ($1, $2, $3, $4, $5)', [je, z.f.fx.companyId, acct, d, cr]);
      }
      await c.query("UPDATE gl_journal_entries SET status = 'posted', posted_at = now() WHERE id = $1", [je]);
      await linkAsApp(c, je, original);
      await c.query('INSERT INTO gl_journal_lines (journal_entry_id, company_id, gl_account_id, debit, credit) VALUES ($1, $2, $3, 0, 0)', [je, z.f.fx.companyId, z.ap]);
    }), /are closed/);
  });

  it('the Demo company\'s wipe may still delete the lines of its linked journals (as the reseed does)', async () => {
    const demo = '00000000-0000-0000-0000-000000000001';
    await sql`INSERT INTO companies (id, name) VALUES (${demo}::UUID, 'LCF demo stand-in') ON CONFLICT (id) DO NOTHING`;
    try {
      const acct = async (code: string) => String(((await sql`INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, normal_balance, is_active)
        VALUES (${demo}::UUID, ${code}, ${`LCF demo ${code}`}, 'asset', 'debit', true) RETURNING id`) as Row[])[0]!.id);
      const [a, b] = [await acct('LCF1'), await acct('LCF2')];
      const dl: Leg[] = [[a, 10, 0], [b, 0, 10]];
      const original = await journal(z, dl, { company: demo });
      const contra = await journal(z, negate(dl), { company: demo });
      await sql`UPDATE gl_journal_entries SET reversal_of_id = ${original}::UUID WHERE id = ${contra}::UUID`;
      await asRole(z, 'migration_admin', (c) => c.query('DELETE FROM gl_journal_lines WHERE journal_entry_id = $1', [contra]));
      const other = await journal(z, negate(legs));
      const og = await journal(z, legs);
      await sql`UPDATE gl_journal_entries SET reversal_of_id = ${og}::UUID WHERE id = ${other}::UUID`;
      await refused(asRole(z, 'migration_admin', (c) => c.query('DELETE FROM gl_journal_lines WHERE journal_entry_id = $1', [other])), /are closed/);
    } finally {
      await sql`UPDATE gl_journal_entries SET reversal_of_id = NULL WHERE company_id = ${demo}::UUID`;
      await sql`DELETE FROM gl_journal_lines WHERE company_id = ${demo}::UUID`;
      await sql`DELETE FROM gl_journal_entries WHERE company_id = ${demo}::UUID`;
      await sql`DELETE FROM gl_accounts WHERE company_id = ${demo}::UUID`;
      await sql`DELETE FROM companies WHERE id = ${demo}::UUID`;
    }
  });

  it('L1 a document linking X waits for a contra being linked to X, and is then refused; the other order is the cancel', async () => {
    const original = await journal(z, legs);
    const contra = await journal(z, negate(legs));
    const doc = await document(z, 'customer_invoices', { status: 'draft' });
    const [s1, s2] = [await openApp(z), await openApp(z)];
    try {
      await link(contra, original)(s1); // uncommitted: holds X's lock
      const racing = setLink('customer_invoices', doc, original)(s2).then(() => 'linked', (e: { message: string }) => e.message);
      await new Promise((r) => setTimeout(r, 400));
      await s1.query('COMMIT');
      expect(await racing).toMatch(/links only a posted/);
    } finally {
      for (const c of [s1, s2]) { await c.query('ROLLBACK').catch(() => undefined); c.release(); }
    }
    const o2 = await journal(z, legs);
    const c2 = await journal(z, negate(legs));
    const d2 = await document(z, 'customer_invoices', { status: 'draft' });
    const [t1, t2] = [await openApp(z), await openApp(z)];
    try {
      await setLink('customer_invoices', d2, o2)(t1);
      const racing = link(c2, o2)(t2).then(() => 'linked', (e: { message: string }) => e.message);
      await new Promise((r) => setTimeout(r, 400));
      await t1.query('COMMIT');
      expect(await racing).toBe('linked');
    } finally {
      for (const c of [t1, t2]) { await c.query('COMMIT').catch(() => undefined); c.release(); }
    }
  });

  it('L3 a second contra of one journal is refused by the trigger, with the unique index dropped', async () => {
    const original = await journal(z, legs);
    const [a, b] = [await journal(z, negate(legs)), await journal(z, negate(legs))];
    const c = await z.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('DROP INDEX IF EXISTS public.ux_gl_je_reversal_of');
      await c.query('SET LOCAL ROLE app_user');
      await c.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: z.f.fx.userId, role: 'authenticated' })]);
      await c.query("SELECT set_config('app.current_company_id', $1, true)", [z.f.fx.companyId]);
      await link(a, original)(c);
      const err = await link(b, original)(c).then(() => null, (e: { code?: string; constraint?: string; message: string }) => e);
      expect(err?.message).toMatch(/already has a reversal/);
      expect(err?.code).toBe('23505');
      expect(err?.constraint).toBe('ux_gl_je_reversal_of');
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      c.release();
    }
  });
});
