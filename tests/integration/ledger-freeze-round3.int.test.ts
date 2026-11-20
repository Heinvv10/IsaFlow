/**
 * Migration 1018, review round 3, as app_user under RLS and claims: a reversal link never puts a cancelled document's
 * journal back in force (M1: the raw link, and both orders of a cancel racing a re-instating link); a chain stays one
 * line of fewer than 64 journals (L1); the deferred account check judges both neighbours (L2); the index guard reads
 * pg_index, not names (L3); a cancelled document that links a journal stays cancelled (L4).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';
import { sql } from '@/lib/neon';
import { isDisposableDb } from '../helpers/assertDisposableDb';
import {
  asApp, document, dropFreeze, journal, negate, openApp, refused, reverseAsSuperuser, seedFreeze, type Freeze, type Leg, type Row,
} from './helpers/ledgerFreezeFixture';

const describeIfDisposable = isDisposableDb() ? describe : describe.skip;
type Kind = 'customer_invoices' | 'supplier_invoices' | 'credit_notes';
let z: Freeze;
let legs: Leg[];
const link = (contra: string, original: string) => (c: PoolClient) =>
  c.query('UPDATE gl_journal_entries SET reversal_of_id = $1 WHERE id = $2', [original, contra]);
/** What each cancel service writes: the invoice and bill cancels clear the link, the credit-note cancel keeps it. */
const cancel = (kind: Kind, doc: string) => (c: PoolClient) => c.query(kind === 'credit_notes'
  ? `UPDATE ${kind} SET status = 'cancelled' WHERE id = $1`
  : `UPDATE ${kind} SET status = 'cancelled', gl_journal_entry_id = NULL WHERE id = $1`, [doc]);
const inForce = async (je: string) => ((await sql`SELECT public.gl_journal_in_force(${je}::UUID) AS f`) as Row[])[0]!.f;
const REINSTATE = /journal of a cancelled document back in force/;
const BLOCKED = 'BLOCKED';
const settle = (p: Promise<unknown>) => p.then(() => 'ACCEPTED', (e: { message: string }) => e.message);
const firstOf = (p: Promise<string>) => Promise.race([p, new Promise<string>((res) => setTimeout(() => res(BLOCKED), 1500))]);

/** An approved document holding O, and O reversed by R (app_user writes both, as approve and the cancel's reversal do). */
async function approvedAndReversed(kind: Kind): Promise<{ o: string; r: string; doc: string }> {
  const o = await journal(z, legs);
  const doc = await document(z, kind, { status: 'draft' });
  await asApp(z, (c) => c.query(`UPDATE ${kind} SET gl_journal_entry_id = $1, status = 'approved' WHERE id = $2`, [o, doc]), { commit: true });
  const r = await journal(z, negate(legs));
  await asApp(z, link(r, o), { commit: true });
  return { o, r, doc };
}

/** A chain O <- ... of `n` journals linked as the superuser; returns its journals top-down and the bottom's legs. */
async function chainOf(n: number): Promise<{ ids: string[]; bottom: Leg[] }> {
  const ids = [await journal(z, legs)];
  let cur = legs;
  for (let i = 1; i < n; i++) { ids.push(await reverseAsSuperuser(z, ids[i - 1]!, cur)); cur = negate(cur); }
  return { ids, bottom: cur };
}

describeIfDisposable('ledger column immutability, round 3 (migration 1018)', () => {
  beforeAll(async () => { z = await seedFreeze(); legs = [[z.ar, 100, 0], [z.revenue, 0, 100]]; }, 240000);
  afterAll(async () => { if (z) await dropFreeze(z); }, 120000);

  it.each<Kind>(['customer_invoices', 'supplier_invoices', 'credit_notes'])(
    '%s: M1 approve -> cancel -> a raw link R2 -> R is refused; the journal stays out of force', async (kind) => {
      const { o, r, doc } = await approvedAndReversed(kind);
      await asApp(z, cancel(kind, doc), { commit: true });
      const r2 = await journal(z, legs);
      const err = await asApp(z, link(r2, r)).then(() => null, (e: { constraint?: string; code?: string; message: string }) => e);
      expect(err?.message).toMatch(REINSTATE);
      expect(err?.code).toBe('23514');
      expect(err?.constraint).toBe('gl_je_reinstates_cancelled_document');
      expect(await inForce(o)).toBe(false);
      const released = ((await sql`SELECT document_released_at AS t FROM gl_journal_entries WHERE id = ${o}::UUID`) as Row[])[0]!.t;
      expect(released !== null).toBe(kind !== 'credit_notes'); // the note keeps its link: its status is what the rule reads
    });

  it('M1 the release stamp is kept: app_user cannot clear or move it', async () => {
    const { o, doc } = await approvedAndReversed('customer_invoices');
    await asApp(z, cancel('customer_invoices', doc), { commit: true });
    await refused(asApp(z, (c) => c.query('UPDATE gl_journal_entries SET document_released_at = NULL WHERE id = $1', [o])), /stays released/);
    await refused(asApp(z, (c) => c.query("UPDATE gl_journal_entries SET document_released_at = now() - interval '1 day' WHERE id = $1", [o])), /stays released/);
  });

  it('M1 a chain held by a document that is NOT cancelled is still re-instated (the soft-delete undo shape)', async () => {
    const { o, r } = await approvedAndReversed('customer_invoices');
    await asApp(z, link(await journal(z, legs), r), { commit: true });
    expect(await inForce(o)).toBe(true);
  });

  it('M1 race, link first: a cancel waits for an uncommitted R2 -> R, then is refused (the chain is back in force)', async () => {
    const { o, r, doc } = await approvedAndReversed('customer_invoices');
    const r2 = await journal(z, legs);
    const [a, b] = [await openApp(z), await openApp(z)];
    try {
      await link(r2, r)(b);
      const pa = settle(cancel('customer_invoices', doc)(a));
      expect(await firstOf(pa)).toBe(BLOCKED);
      await b.query('COMMIT');
      expect(await pa).toMatch(/in force cannot be unlinked/);
      await a.query('ROLLBACK');
      expect(await inForce(o)).toBe(true);
    } finally { a.release(); b.release(); }
  });

  it.each<Kind>(['customer_invoices', 'credit_notes'])(
    '%s: M1 race, cancel first: R2 -> R waits for the uncommitted cancel, then is refused', async (kind) => {
      const { o, r, doc } = await approvedAndReversed(kind);
      const r2 = await journal(z, legs);
      const [a, b] = [await openApp(z), await openApp(z)];
      try {
        await cancel(kind, doc)(a);
        const pb = settle(link(r2, r)(b));
        expect(await firstOf(pb)).toBe(BLOCKED);
        await a.query('COMMIT');
        expect(await pb).toMatch(REINSTATE);
        await b.query('ROLLBACK');
        expect(await inForce(o)).toBe(false);
      } finally { a.release(); b.release(); }
    });

  it('L1 a chain takes its 63rd journal and refuses a 64th; a document does not link a full chain', async () => {
    const { ids, bottom } = await chainOf(62);
    const j63 = await journal(z, negate(bottom));
    await asApp(z, link(j63, ids[61]!), { commit: true });
    await refused(asApp(z, link(await journal(z, bottom), j63)), /fewer than 64 journals/);
    await reverseAsSuperuser(z, j63, negate(bottom)); // a legacy 64-long chain: gl_journal_in_force counts it in force
    expect(await inForce(ids[0]!)).toBe(true);
    const doc = await document(z, 'customer_invoices', { status: 'draft' });
    await refused(asApp(z, (c) => c.query('UPDATE customer_invoices SET gl_journal_entry_id = $1 WHERE id = $2', [ids[0], doc])),
      /links only a posted, unreversed journal/);
  }, 120000);

  it('L1 a link onto a branched chain (two contras, the unique index dropped) is refused, and so is a document link', async () => {
    const o = await journal(z, legs);
    const [a1, a2, c3] = [await journal(z, negate(legs)), await journal(z, negate(legs)), await journal(z, legs)];
    const doc = await document(z, 'customer_invoices', { status: 'draft' });
    const c = await z.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('DROP INDEX IF EXISTS public.ux_gl_je_reversal_of');
      await c.query('UPDATE gl_journal_entries SET reversal_of_id = $1 WHERE id = ANY($2::uuid[])', [o, [a1, a2]]);
      await c.query('SET LOCAL ROLE app_user');
      await c.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: z.f.fx.userId, role: 'authenticated' })]);
      await c.query("SELECT set_config('app.current_company_id', $1, true)", [z.f.fx.companyId]);
      await c.query('SAVEPOINT s');
      const e1 = await link(c3, a1)(c).then(() => null, (e: { message: string }) => e);
      expect(e1?.message).toMatch(/branched or full/);
      await c.query('ROLLBACK TO SAVEPOINT s');
      const e2 = await c.query('UPDATE customer_invoices SET gl_journal_entry_id = $1 WHERE id = $2', [o, doc]).then(() => null, (e: { message: string }) => e);
      expect(e2?.message).toMatch(/links only a posted, unreversed journal/);
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      c.release();
    }
  });

  it('L2 moving an account on O and R together leaves R2 un-negated: refused at commit; all three together pass', async () => {
    const o = await journal(z, legs);
    const r = await journal(z, negate(legs));
    await asApp(z, link(r, o), { commit: true });
    const r2 = await journal(z, legs);
    await asApp(z, link(r2, r), { commit: true });
    const move = (ids: string[]) => (c: PoolClient) => c.query(
      'UPDATE gl_journal_lines SET gl_account_id = $1 WHERE journal_entry_id = ANY($2::uuid[]) AND gl_account_id = $3', [z.expense, ids, z.revenue]);
    await refused(asApp(z, move([o, r]), { commit: true }), /stay the exact negation/);
    await asApp(z, move([o, r, r2]), { commit: true });
    const left = (await sql`SELECT count(*)::int AS n FROM gl_journal_lines WHERE journal_entry_id IN (${o}::UUID, ${r}::UUID, ${r2}::UUID)
      AND gl_account_id = ${z.revenue}::UUID`) as Row[];
    expect(left[0]!.n).toBe(0);
  });

  it('L3 the lookup index is made only when no index leads with reversal_of_id (any name), read from pg_index', async () => {
    const file = readFileSync(path.resolve(__dirname, '../../scripts/migrations/sql/1018_ledger_column_immutability.sql'), 'utf8');
    const start = file.indexOf('DO $$\nDECLARE\n  v_rev smallint;');
    const block = file.slice(start, file.indexOf('\n$$;', start) + 4);
    expect(block).toMatch(/CREATE INDEX IF NOT EXISTS ix_gl_je_reversal_of_lookup/);
    const c = await z.pool.connect();
    const has = async (name: string) => (await c.query('SELECT 1 FROM pg_indexes WHERE indexname = $1', [name])).rowCount === 1;
    try {
      await c.query('BEGIN');
      // Every index on reversal_of_id goes (the baseline has idx_gl_je_reversal_of and ux_gl_je_reversal_of), then one
      // under a name no list would know.
      const onColumn = await c.query(`SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'gl_journal_entries'
        AND indexdef ~ '\\(.*reversal_of_id'`);
      for (const r of onColumn.rows as Array<{ indexname: string }>) await c.query(`DROP INDEX public."${r.indexname}"`);
      expect(await has('ix_gl_je_reversal_of_lookup')).toBe(false);
      await c.query('CREATE INDEX zz_round3_some_name ON public.gl_journal_entries (reversal_of_id)');
      await c.query(block);
      expect(await has('ix_gl_je_reversal_of_lookup')).toBe(false);
      await c.query('DROP INDEX public.zz_round3_some_name');
      await c.query(block);
      expect(await has('ix_gl_je_reversal_of_lookup')).toBe(true);
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      c.release();
    }
  });

  it('L4 a cancelled credit note that links its journal stays cancelled (not approved, not draft)', async () => {
    const { doc } = await approvedAndReversed('credit_notes');
    await asApp(z, cancel('credit_notes', doc), { commit: true });
    for (const status of ['approved', 'draft']) {
      await refused(asApp(z, (c) => c.query('UPDATE credit_notes SET status = $2 WHERE id = $1', [doc, status])), /stays cancelled/);
    }
  });
});
