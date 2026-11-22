/**
 * Migration 1018, review round 4 (the round-3 breaker's probes, now as assertions), as app_user under RLS and claims.
 * H1: at REPEATABLE READ or SERIALIZABLE the rules' locks would serialise nothing, so a write they judge is refused there
 * (40001): a re-instating link after a cancel (X1), a cancel after a re-instating link (X2), a second document linking
 * one journal (X3). H2: a linked or non-draft document keeps its company (X5, X6). M1: a document whose journal is in
 * force is not deleted (X9, X10). L1: only a document's cancel stamps document_cancelled_at (X4).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';
import { sql } from '@/lib/neon';
import { isDisposableDb } from '../helpers/assertDisposableDb';
import { asApp, document, dropFreeze, journal, negate, refused, seedFreeze, type Freeze, type Leg, type Row, linkAsApp } from './helpers/ledgerFreezeFixture';

const describeIfDisposable = isDisposableDb() ? describe : describe.skip;
type Kind = 'customer_invoices' | 'supplier_invoices' | 'credit_notes';
const KINDS: Kind[] = ['customer_invoices', 'supplier_invoices', 'credit_notes'];
type Iso = 'REPEATABLE READ' | 'SERIALIZABLE';
let z: Freeze;
let legs: Leg[];
const settle = (p: Promise<unknown>) => p.then(() => 'ACCEPTED', (e: { code?: string; message: string }) => `${e.code}: ${e.message}`);
const link = (contra: string, original: string) => (c: PoolClient) => linkAsApp(c, contra, original);
const inForce = async (je: string) => ((await sql`SELECT public.gl_journal_in_force(${je}::UUID) AS f`) as Row[])[0]!.f;
const stampOf = async (je: string) => ((await sql`SELECT document_cancelled_at AS s FROM gl_journal_entries WHERE id = ${je}::UUID`) as Row[])[0]!.s;
const READ_COMMITTED_ONLY = /^40001: .*READ COMMITTED only/;

/** An app_user transaction at `iso` (current company `company`), left open: the caller commits or rolls back. */
async function openAt(iso: Iso | 'READ COMMITTED', company?: string): Promise<PoolClient> {
  const c = await z.pool.connect();
  await c.query(`BEGIN ISOLATION LEVEL ${iso}`);
  await c.query('SET LOCAL ROLE app_user');
  await c.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: z.f.fx.userId, role: 'authenticated' })]);
  await c.query("SELECT set_config('app.current_company_id', $1, true)", [company ?? z.f.fx.companyId]);
  return c;
}
async function approved(kind: Kind): Promise<{ o: string; doc: string }> {
  const o = await journal(z, legs);
  const doc = await document(z, kind, { status: 'draft' });
  await asApp(z, (c) => c.query(`UPDATE ${kind} SET gl_journal_entry_id = $1, status = 'approved' WHERE id = $2`, [o, doc]), { commit: true });
  return { o, doc };
}
async function approvedAndReversed(kind: Kind): Promise<{ o: string; r: string; doc: string }> {
  const { o, doc } = await approved(kind);
  const r = await journal(z, negate(legs));
  await asApp(z, link(r, o), { commit: true });
  return { o, r, doc };
}

describeIfDisposable('ledger column immutability, round 4 (migration 1018)', () => {
  beforeAll(async () => {
    z = await seedFreeze();
    legs = [[z.ar, 100, 0], [z.revenue, 0, 100]];
    await sql`INSERT INTO company_users (company_id, user_id, role) VALUES (${z.f.other.companyId}::UUID, ${z.f.fx.userId}, 'admin') ON CONFLICT DO NOTHING`;
  }, 240000);
  afterAll(async () => {
    if (!z) return;
    await sql`DELETE FROM company_users WHERE company_id = ${z.f.other.companyId}::UUID AND user_id = ${z.f.fx.userId}`;
    await dropFreeze(z);
  }, 120000);

  for (const iso of ['REPEATABLE READ', 'SERIALIZABLE'] as Iso[]) {
    it(`H1 ${iso} X1: a snapshot older than the cancel cannot re-instate the cancelled invoice's chain`, async () => {
      const { o, r, doc } = await approvedAndReversed('customer_invoices');
      const r2 = await journal(z, legs);
      const a = await openAt(iso);
      try {
        await a.query('SELECT count(*) FROM gl_journal_entries'); // the snapshot
        await asApp(z, (c) => c.query("UPDATE customer_invoices SET status = 'cancelled', gl_journal_entry_id = NULL WHERE id = $1", [doc]), { commit: true });
        expect(await settle(link(r2, r)(a))).toMatch(READ_COMMITTED_ONLY);
      } finally { await a.query('ROLLBACK').catch(() => undefined); a.release(); }
      expect(await inForce(o)).toBe(false);
    });

    it(`H1 ${iso} X2: a snapshot older than a re-instating link cannot cancel the invoice`, async () => {
      const { o, r, doc } = await approvedAndReversed('customer_invoices');
      const r2 = await journal(z, legs);
      const a = await openAt(iso);
      try {
        await a.query('SELECT count(*) FROM gl_journal_entries');
        await asApp(z, link(r2, r), { commit: true });
        expect(await settle(a.query("UPDATE customer_invoices SET status = 'cancelled', gl_journal_entry_id = NULL WHERE id = $1", [doc])))
          .toMatch(READ_COMMITTED_ONLY);
      } finally { await a.query('ROLLBACK').catch(() => undefined); a.release(); }
      expect(((await sql`SELECT status FROM customer_invoices WHERE id = ${doc}::UUID`) as Row[])[0]!.status).toBe('approved');
      expect(await inForce(o)).toBe(true);
    });

    it(`H1 ${iso} X2b: a credit-note cancel (it keeps its link) from a snapshot older than a re-instating link is refused`, async () => {
      const { o, r, doc } = await approvedAndReversed('credit_notes');
      const a = await openAt(iso);
      try {
        await a.query('SELECT count(*) FROM gl_journal_entries');
        await asApp(z, link(await journal(z, legs), r), { commit: true });
        expect(await settle(a.query("UPDATE credit_notes SET status = 'cancelled' WHERE id = $1", [doc]))).toMatch(READ_COMMITTED_ONLY);
      } finally { await a.query('ROLLBACK').catch(() => undefined); a.release(); }
      expect(await inForce(o)).toBe(true);
    });

    it(`H1 ${iso} X3: a second document cannot link one journal from an older snapshot`, async () => {
      const x = await journal(z, legs);
      const [d1, d2] = [await document(z, 'customer_invoices', { status: 'draft' }), await document(z, 'credit_notes', { status: 'draft' })];
      const a = await openAt(iso);
      try {
        await a.query('SELECT count(*) FROM customer_invoices');
        await asApp(z, (c) => c.query("UPDATE customer_invoices SET gl_journal_entry_id = $1, status = 'approved' WHERE id = $2", [x, d1]), { commit: true });
        expect(await settle(a.query("UPDATE credit_notes SET gl_journal_entry_id = $1, status = 'approved' WHERE id = $2", [x, d2])))
          .toMatch(READ_COMMITTED_ONLY);
      } finally { await a.query('ROLLBACK').catch(() => undefined); a.release(); }
    });
  }

  it.each(KINDS)('%s: H1 a delete of a linked document is refused outside READ COMMITTED too', async (kind) => {
    const { doc } = await approvedAndReversed(kind);
    const a = await openAt('REPEATABLE READ');
    try {
      expect(await settle(a.query(`DELETE FROM ${kind} WHERE id = $1`, [doc]))).toMatch(READ_COMMITTED_ONLY);
    } finally { await a.query('ROLLBACK').catch(() => undefined); a.release(); }
  });

  it.each(KINDS)('%s: H2 X5 a member of two companies cannot cancel while moving the document to the other company', async (kind) => {
    const { o, r, doc } = await approvedAndReversed(kind);
    const unlink = kind === 'credit_notes' ? '' : ', gl_journal_entry_id = NULL';
    const b = await openAt('READ COMMITTED', z.f.other.companyId);
    try {
      // The company freeze refuses it; for the credit note the cancel trigger fires first (trigger order) and its stamp, by
      // journal id, is refused by RLS's WITH CHECK from company B. Either way nothing moves.
      expect(await settle(b.query(`UPDATE ${kind} SET status = 'cancelled'${unlink}, company_id = $2 WHERE id = $1`, [doc, z.f.other.companyId])))
        .toMatch(kind === 'credit_notes' ? /violates row-level security policy for table "gl_journal_entries"/ : /keeps its company/);
    } finally { await b.query('ROLLBACK').catch(() => undefined); b.release(); }
    expect(((await z.pool.query(`SELECT company_id::text AS co FROM ${kind} WHERE id = $1`, [doc])).rows[0] as Row).co).toBe(z.f.fx.companyId);
    // The cancel done right stamps the journal (by its id), and the chain stays out.
    await asApp(z, (c) => c.query(`UPDATE ${kind} SET status = 'cancelled'${unlink} WHERE id = $1`, [doc]), { commit: true });
    expect(await stampOf(o)).not.toBeNull();
    await refused(asApp(z, link(await journal(z, legs), r)), /journal of a cancelled document back in force/);
  });

  it.each(KINDS)('%s: H2 X6 a linked or approved document keeps its company; a draft unlinked one may move', async (kind) => {
    const { doc } = await approved(kind);
    const move = (id: string) => (c: PoolClient) => c.query(`UPDATE ${kind} SET company_id = $2 WHERE id = $1`, [id, z.f.other.companyId]);
    const b = await openAt('READ COMMITTED', z.f.other.companyId);
    try {
      expect(await settle(move(doc)(b))).toMatch(/keeps its company/);
    } finally { await b.query('ROLLBACK').catch(() => undefined); b.release(); }
    const draft = await document(z, kind, { status: 'draft' });
    const c2 = await openAt('READ COMMITTED', z.f.other.companyId);
    try {
      expect(await settle(move(draft)(c2))).toBe('ACCEPTED');
    } finally { await c2.query('ROLLBACK').catch(() => undefined); c2.release(); }
  });

  it.each(KINDS)('%s: M1 X10 a document whose journal is in force is not deleted; once out of force it may be', async (kind) => {
    const { o, doc } = await approved(kind);
    await refused(asApp(z, (c) => c.query(`DELETE FROM ${kind} WHERE id = $1`, [doc])), /journal is in force is not deleted/);
    expect(await inForce(o)).toBe(true);
    const unlinked = await document(z, kind, { status: 'draft' });
    expect((await asApp(z, (c) => c.query(`DELETE FROM ${kind} WHERE id = $1`, [unlinked]), { commit: true })).rowCount).toBe(1); // the purge's shape
  });

  it.each(KINDS)('%s: M1 a document deleted while its journal is out of force stamps it: the chain is not re-instated after', async (kind) => {
    const { o, r, doc } = await approvedAndReversed(kind);
    expect((await asApp(z, (c) => c.query(`DELETE FROM ${kind} WHERE id = $1`, [doc]), { commit: true })).rowCount).toBe(1);
    expect(await stampOf(o)).not.toBeNull();
    await refused(asApp(z, link(await journal(z, legs), r)), /journal of a cancelled document back in force/);
    expect(await inForce(o)).toBe(false);
  });

  it('M1 X9 a draft that holds its journal ("Post to GL") is not deleted while the journal is in force', async () => {
    const o = await journal(z, legs);
    const doc = await document(z, 'customer_invoices', { status: 'draft' });
    await asApp(z, (c) => c.query('UPDATE customer_invoices SET gl_journal_entry_id = $1 WHERE id = $2', [o, doc]), { commit: true });
    await refused(asApp(z, (c) => c.query('DELETE FROM customer_invoices WHERE id = $1', [doc])), /journal is in force is not deleted/);
  });

  it('L1 X4 app_user cannot pre-stamp document_cancelled_at, by UPDATE, by the stamp helper, or on INSERT; the undo shape re-instates', async () => {
    const { o, r } = await approvedAndReversed('customer_invoices');
    await refused(asApp(z, (c) => c.query('UPDATE gl_journal_entries SET document_cancelled_at = now() WHERE id = $1', [o])), /only by that document's cancel/);
    await refused(asApp(z, (c) => c.query("SELECT public.gl_je_stamp_document_cancel('x', $1)", [o])), /only by that document's cancel/);
    await refused(asApp(z, (c) => c.query(
      "INSERT INTO gl_journal_entries (company_id, entry_date, description, source, status, created_by, document_cancelled_at) VALUES ($1, '2026-06-10', 'x', 'manual', 'draft', $2, now())",
      [z.f.fx.companyId, z.f.fx.userId])), /only by that document's cancel/);
    expect(await stampOf(o)).toBeNull();
    await asApp(z, link(await journal(z, legs), r), { commit: true }); // a soft-delete undo's shape: the document is not cancelled
    expect(await inForce(o)).toBe(true);
  });
});
