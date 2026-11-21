/**
 * Migration 1018, round 8 (the queue gate's findings, as assertions), as app_user under RLS and claims.
 * F1: an account (or VAT type) change and a reversal link of the same journal serialise on its advisory key, in both
 * orders; F2: the exact negation includes vat_type; F4: a linked journal keeps who reversed and who posted it, each field
 * on its own; F3: the backfill stamps the journals of documents cancelled before 1018, only where state says so without
 * doubt. Not over-strict: a claim and its release before any contra, and moving every line of the pair together, pass.
 */
import { randomUUID } from 'crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, type PoolClient } from 'pg';
import { sql } from '@/lib/neon';
import { isDisposableDb } from '../helpers/assertDisposableDb';
import { provisionAppLogin } from './helpers/appLoginWorld';
import { asApp, document, dropFreeze, journal, negate, openApp, refused, seedFreeze, type Freeze, type Leg, type Row } from './helpers/ledgerFreezeFixture';

const describeIfDisposable = isDisposableDb() ? describe : describe.skip;
let z: Freeze;
let legs: Leg[];
const app = (q: string, v: unknown[] = []) => asApp(z, (c: PoolClient) => c.query(q, v), { commit: true });
const link = (contra: string, original: string) => (c: PoolClient) =>
  c.query('UPDATE gl_journal_entries SET reversal_of_id = $1 WHERE id = $2', [original, contra]);
const moveRevenue = (je: string) => (c: PoolClient) =>
  c.query('UPDATE gl_journal_lines SET gl_account_id = $1 WHERE journal_entry_id = $2 AND gl_account_id = $3', [z.expense, je, z.revenue]);
const settle = (p: Promise<unknown>) => p.then(() => 'ACCEPTED', (e: { message: string }) => e.message);
const firstOf = (p: Promise<string>) => Promise.race([p, new Promise<string>((res) => setTimeout(() => res('BLOCKED'), 1500))]);
const NEGATION = /exact negation/;
const linkOf = async (je: string) => ((await sql`SELECT reversal_of_id::text AS r FROM gl_journal_entries WHERE id = ${je}::UUID`) as Row[])[0]!.r;

/** A journal whose two lines carry a VAT type, written as the superuser. */
async function vatJournal(v: string, flip = false): Promise<string> {
  const je = await journal(z, flip ? negate(legs) : legs);
  await sql`UPDATE gl_journal_lines SET vat_type = ${v} WHERE journal_entry_id = ${je}::UUID`;
  return je;
}

describeIfDisposable('ledger column immutability, round 8 (migration 1018)', () => {
  beforeAll(async () => { z = await seedFreeze(); legs = [[z.ar, 100, 0], [z.revenue, 0, 100]]; }, 240000);
  afterAll(async () => { if (z) await dropFreeze(z); }, 120000);

  it('F1 race, change first: an open account change commits only after a link of its journal commits, then is refused', async () => {
    const o = await journal(z, legs);
    const r = await journal(z, negate(legs));
    const [a, b] = [await openApp(z), await openApp(z)];
    try {
      await moveRevenue(o)(a);                   // deferred: no link committed yet
      await link(r, o)(b);                       // sees O's committed (old) lines: passes, holds O's key
      const commitA = settle(a.query('COMMIT'));
      expect(await firstOf(commitA)).toBe('BLOCKED');
      await b.query('COMMIT');
      expect(await commitA).toMatch(NEGATION);
    } finally { await a.query('ROLLBACK').catch(() => undefined); a.release(); await b.query('ROLLBACK').catch(() => undefined); b.release(); }
    expect(await linkOf(r)).toBe(o);
    expect(((await sql`SELECT public.gl_lines_are_negation(${r}::UUID, ${o}::UUID) AS n`) as Row[])[0]!.n).toBe(true);
  });

  it('F1 race, link first: a link waiting on nothing, then a change that commits after it, is refused at commit', async () => {
    const o = await journal(z, legs);
    const r = await journal(z, negate(legs));
    const [a, b] = [await openApp(z), await openApp(z)];
    try {
      await link(r, o)(b);
      await moveRevenue(o)(a);
      const commitA = settle(a.query('COMMIT'));
      expect(await firstOf(commitA)).toBe('BLOCKED');
      await b.query('COMMIT');
      expect(await commitA).toMatch(NEGATION);
    } finally { await a.query('ROLLBACK').catch(() => undefined); a.release(); await b.query('ROLLBACK').catch(() => undefined); b.release(); }
  });

  it('F1 change committed first: the later link reads the changed lines and is refused', async () => {
    const o = await journal(z, legs);
    const r = await journal(z, negate(legs));
    await app('UPDATE gl_journal_lines SET gl_account_id = $1 WHERE journal_entry_id = $2 AND gl_account_id = $3', [z.expense, o, z.revenue]);
    await refused(asApp(z, link(r, o)), NEGATION);
  });

  it('F1 the deferred check reads at READ COMMITTED only: an account change at REPEATABLE READ is refused at commit (40001)', async () => {
    const o = await journal(z, legs);
    const c = await z.pool.connect();
    try {
      await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      await c.query('SET LOCAL ROLE app_user');
      await c.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: z.f.fx.userId, role: 'authenticated' })]);
      await c.query("SELECT set_config('app.current_company_id', $1, true)", [z.f.fx.companyId]);
      await moveRevenue(o)(c);
      expect(await settle(c.query('COMMIT'))).toMatch(/READ COMMITTED only/);
    } finally { await c.query('ROLLBACK').catch(() => undefined); c.release(); }
  });

  it('F2 a contra whose VAT type differs is not an exact negation; the same VAT type is', async () => {
    const o = await vatJournal('standard');
    await refused(asApp(z, link(await vatJournal('zero_rated', true), o)), NEGATION);
    await asApp(z, link(await vatJournal('standard', true), o), { commit: true });
  });

  it('F2 the VAT type of a linked pair moves only on both sides together (deferred check)', async () => {
    const o = await vatJournal('standard');
    const r = await vatJournal('standard', true);
    await asApp(z, link(r, o), { commit: true });
    const setVat = (ids: string[]) => (c: PoolClient) => c.query("UPDATE gl_journal_lines SET vat_type = 'exempt' WHERE journal_entry_id = ANY($1::uuid[])", [ids]);
    await refused(asApp(z, setVat([o]), { commit: true }), NEGATION);
    await asApp(z, setVat([o, r]), { commit: true }); // over-strict check: both sides together pass
  });

  it('F4 a linked journal keeps reversed_at and reversed_by (each alone) and posted_at / posted_by', async () => {
    const o = await journal(z, legs);
    const r = await journal(z, negate(legs));
    await app('UPDATE gl_journal_entries SET reversed_at = now(), reversed_by = $2 WHERE id = $1', [o, z.f.fx.userId]); // the claim
    await asApp(z, link(r, o), { commit: true });
    const KEEPS = /keeps who reversed it and when/;
    await refused(asApp(z, (c) => c.query('UPDATE gl_journal_entries SET reversed_by = NULL WHERE id = $1', [o])), KEEPS);
    await refused(asApp(z, (c) => c.query("UPDATE gl_journal_entries SET reversed_at = now() - interval '1 day' WHERE id = $1", [o])), KEEPS);
    await refused(asApp(z, (c) => c.query('UPDATE gl_journal_entries SET reversed_at = NULL WHERE id = $1', [o])), KEEPS);
    for (const je of [o, r]) {
      await refused(asApp(z, (c) => c.query('UPDATE gl_journal_entries SET posted_by = $2 WHERE id = $1', [je, randomUUID()])), /keeps who posted it/);
      await refused(asApp(z, (c) => c.query("UPDATE gl_journal_entries SET posted_at = now() - interval '1 day' WHERE id = $1", [je])), /keeps who posted it/);
    }
  });

  it('F4 over-strict check: before any contra, the claim and its release (both fields) pass', async () => {
    const o = await journal(z, legs);
    await app('UPDATE gl_journal_entries SET reversed_at = now(), reversed_by = $2 WHERE id = $1', [o, z.f.fx.userId]);
    await app('UPDATE gl_journal_entries SET reversed_at = NULL, reversed_by = NULL WHERE id = $1', [o]);
  });

  it('F5 the isaflow_app login is provisioned once per cluster: concurrent and later callers get the same working password', async () => {
    const url = process.env.DATABASE_URL!;
    const [p1, p2, p3] = await Promise.all([provisionAppLogin(url), provisionAppLogin(url), provisionAppLogin(url)]);
    expect(new Set([p1, p2, p3]).size).toBe(1);
    const login = new URL(url);
    login.username = 'isaflow_app';
    login.password = p1;
    const held = new Client({ connectionString: login.toString() }); // a connection opened before a later caller
    await held.connect();
    try {
      expect(await provisionAppLogin(url)).toBe(p1); // a later suite does not rotate it
      const fresh = new Client({ connectionString: login.toString() }); // so a NEW connection still logs in
      await fresh.connect();
      expect((await fresh.query('SELECT session_user AS u')).rows[0].u).toBe('isaflow_app');
      await fresh.end();
    } finally { await held.end(); }
  });

  it('F3 the backfill stamps a legacy cancelled document\'s journal only where state identifies it, and counts the rest', async () => {
    const file = readFileSync(path.resolve(__dirname, '../../scripts/migrations/sql/1018_ledger_column_immutability.sql'), 'utf8');
    const start = file.indexOf('DO $$\nDECLARE\n  v_held bigint;');
    const block = file.slice(start, file.indexOf('\n$$;', start) + 4);
    expect(block).toMatch(/ledger_1018_cancel_candidates/);
    const { fx } = z.f;
    // A legacy shape, written as the superuser (no 1018 rule binds it): approved, reversed, cancelled, link cleared.
    const legacy = async (kind: 'customer_invoices' | 'supplier_invoices', source: string, label: string, o: { number?: string; supplier?: string; reverse?: boolean } = {}) => {
      const doc = await document(z, kind, { status: 'approved' });
      if (o.number) await sql`UPDATE supplier_invoices SET invoice_number = ${o.number} WHERE id = ${doc}::UUID`;
      if (o.supplier) await sql`UPDATE supplier_invoices SET supplier_id = ${o.supplier}::UUID WHERE id = ${doc}::UUID`;
      const n = String(((kind === 'customer_invoices'
        ? await sql`SELECT invoice_number AS n FROM customer_invoices WHERE id = ${doc}::UUID`
        : await sql`SELECT invoice_number AS n FROM supplier_invoices WHERE id = ${doc}::UUID`) as Row[])[0]!.n);
      const je = await journal(z, legs, { source, description: `${label} ${n}` });
      if (o.reverse !== false) {
        const r = await journal(z, negate(legs));
        await sql`UPDATE gl_journal_entries SET reversal_of_id = ${je}::UUID WHERE id = ${r}::UUID`;
      }
      if (kind === 'customer_invoices') await sql`UPDATE customer_invoices SET status = 'cancelled' WHERE id = ${doc}::UUID`;
      else await sql`UPDATE supplier_invoices SET status = 'cancelled' WHERE id = ${doc}::UUID`;
      return { doc, je, n };
    };
    const ar = await legacy('customer_invoices', 'auto_invoice', 'Customer invoice');
    const takeOn = await legacy('customer_invoices', 'auto_migration', 'Take-on AR invoice');
    const ap = await legacy('supplier_invoices', 'auto_supplier_invoice', 'Supplier invoice');
    const inForce = await legacy('customer_invoices', 'auto_invoice', 'Customer invoice', { reverse: false });
    // Ambiguous: two cancelled bills of one number from two suppliers, one journal naming that number.
    const other = String(((await sql`INSERT INTO suppliers (company_id, name) VALUES (${fx.companyId}::UUID, ${`R8 ${randomUUID().slice(0, 6)}`}) RETURNING id`) as Row[])[0]!.id);
    const num = `R8-${randomUUID().slice(0, 8)}`;
    const amb1 = await legacy('supplier_invoices', 'auto_supplier_invoice', 'Supplier invoice', { number: num });
    const amb2doc = await document(z, 'supplier_invoices', { status: 'approved' });
    await sql`UPDATE supplier_invoices SET invoice_number = ${num}, supplier_id = ${other}::UUID, status = 'cancelled' WHERE id = ${amb2doc}::UUID`;
    // Exact: a cancelled credit note that still links its (reversed) journal.
    const cnJe = await journal(z, legs);
    await sql`UPDATE gl_journal_entries SET reversal_of_id = ${cnJe}::UUID WHERE id = ${await journal(z, negate(legs))}::UUID`;
    await document(z, 'credit_notes', { status: 'cancelled', link: cnJe });

    const r2 = await journal(z, legs); // made before the block: its ALTER TABLE locks gl_journal_entries until ROLLBACK
    const c = await z.pool.connect();
    const notices: string[] = [];
    c.on('notice', (n) => notices.push(String(n.message)));
    try {
      await c.query('BEGIN');
      await c.query(block);
      const stamped = async (je: string) => (await c.query('SELECT document_cancelled_at IS NOT NULL AS s FROM gl_journal_entries WHERE id = $1', [je])).rows[0].s;
      expect(await stamped(ar.je)).toBe(true);
      expect(await stamped(takeOn.je)).toBe(true);
      expect(await stamped(ap.je)).toBe(true);
      expect(await stamped(cnJe)).toBe(true);
      expect(await stamped(inForce.je)).toBe(false); // still in force: not the cancel's journal
      expect(await stamped(amb1.je)).toBe(false);    // matched by two bills: left alone
      expect(notices.join('\n')).toMatch(/1018 backfill: \d+ journal\(s\) of a cancelled document that still links them, \d+ found by approval identity, [1-9]\d* ambiguous left unstamped/);
      await c.query('SAVEPOINT again');
      notices.length = 0;
      await c.query(block); // idempotent: a second run stamps nothing new
      expect(notices.join('\n')).toMatch(/: 0 journal\(s\) .* 0 found by approval identity/);
      await c.query('ROLLBACK TO SAVEPOINT again');
      // As app_user in the same transaction: the legacy invoice's chain is not re-instated now.
      await c.query('SET LOCAL ROLE app_user');
      await c.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: fx.userId, role: 'authenticated' })]);
      await c.query("SELECT set_config('app.current_company_id', $1, true)", [fx.companyId]);
      const r = String((await c.query('SELECT id FROM gl_journal_entries WHERE reversal_of_id = $1', [ar.je])).rows[0].id);
      expect(await settle(c.query('UPDATE gl_journal_entries SET reversal_of_id = $1 WHERE id = $2', [r, r2]))).toMatch(/cancelled document back in force/);
    } finally { await c.query('ROLLBACK').catch(() => undefined); c.release(); }
  }, 60000);
});
