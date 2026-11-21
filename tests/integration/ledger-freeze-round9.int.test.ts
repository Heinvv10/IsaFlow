/**
 * Migration 1018, round 9 (the round-8 breaker's probes, as assertions), as app_user under RLS and claims unless said.
 * M2: vat_type '' and NULL stay distinct in a pair (the VAT reports tell them apart). Production blocker: the
 * stamp guard exempts the table's OWNER, so the backfill runs as a non-superuser owner with no trigger switched off,
 * while app_user is still refused. L1: the backfill also ties the journal's amount to the document and skips a '' number.
 */
import { randomUUID } from 'crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';
import { sql } from '@/lib/neon';
import { isDisposableDb } from '../helpers/assertDisposableDb';
import { asApp, document, dropFreeze, journal, negate, refused, seedFreeze, type Freeze, type Leg, type Row } from './helpers/ledgerFreezeFixture';

const describeIfDisposable = isDisposableDb() ? describe : describe.skip;
let z: Freeze;
let legs: Leg[];
const link = (contra: string, original: string) => (c: PoolClient) =>
  c.query('UPDATE gl_journal_entries SET reversal_of_id = $1 WHERE id = $2', [original, contra]);
const settle = (p: Promise<unknown>) => p.then(() => 'ACCEPTED', (e: { message: string }) => e.message);
const setVat = async (je: string, v: string | null) => { await sql`UPDATE gl_journal_lines SET vat_type = ${v} WHERE journal_entry_id = ${je}::UUID`; };
const backfillBlock = () => {
  const file = readFileSync(path.resolve(__dirname, '../../scripts/migrations/sql/1018_ledger_column_immutability.sql'), 'utf8');
  const start = file.indexOf('DO $$\nDECLARE\n  v_held bigint;');
  return file.slice(start, file.indexOf('\n$$;', start) + 4);
};

describeIfDisposable('ledger column immutability, round 9 (migration 1018)', () => {
  beforeAll(async () => { z = await seedFreeze(); legs = [[z.ar, 100, 0], [z.revenue, 0, 100]]; }, 240000);
  afterAll(async () => { if (z) await dropFreeze(z); }, 120000);

  it("M2 '' and NULL are different VAT types (the reports tell them apart): no pair across them, no switch on a linked line", async () => {
    const o = await journal(z, legs);
    await setVat(o, '');
    await refused(asApp(z, link(await journal(z, negate(legs)), o)), /exact negation/); // NULL contra: refused
    const r = await journal(z, negate(legs));
    await setVat(r, '');
    await asApp(z, link(r, o), { commit: true }); // over-strict check: '' with '' is a pair
    await refused(asApp(z, (c) => c.query('UPDATE gl_journal_lines SET vat_type = NULL WHERE journal_entry_id = $1', [o]), { commit: true }), /exact negation/);
  });

  it('the stamp guard exempts the table owner (a non-superuser member of it), and still refuses app_user', async () => {
    const o = await journal(z, legs);
    const role = `r9_owner_${randomUUID().slice(0, 8)}`;
    const c = await z.pool.connect();
    try {
      await c.query('BEGIN');
      const owner = String((await c.query("SELECT relowner::regrole::text AS o FROM pg_class WHERE oid = 'public.gl_journal_entries'::regclass")).rows[0].o);
      await c.query(`CREATE ROLE ${role} NOSUPERUSER INHERIT BYPASSRLS`);
      await c.query(`GRANT ${owner} TO ${role}`);
      await c.query(`SET LOCAL ROLE ${role}`);
      expect((await c.query("SELECT current_setting('is_superuser') AS s")).rows[0].s).toBe('off');
      await c.query('UPDATE gl_journal_entries SET document_cancelled_at = now() WHERE id = $1', [o]);
      await c.query('RESET ROLE');
      await c.query('UPDATE gl_journal_entries SET document_cancelled_at = NULL WHERE id = $1', [o]); // superuser: undo for the next check
      await c.query('SET LOCAL ROLE app_user');
      await c.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: z.f.fx.userId, role: 'authenticated' })]);
      await c.query("SELECT set_config('app.current_company_id', $1, true)", [z.f.fx.companyId]);
      expect(await settle(c.query('UPDATE gl_journal_entries SET document_cancelled_at = now() WHERE id = $1', [o]))).toMatch(/only by that document's cancel/);
    } finally { await c.query('ROLLBACK').catch(() => undefined); c.release(); }
  });

  it("L1 the backfill runs as a non-superuser owner, ties the journal's amount to the document, and skips a '' number", async () => {
    const { fx } = z.f;
    const cancelledBill = async (num: string, amount: number) => {
      const doc = await document(z, 'supplier_invoices', { status: 'approved' });
      await sql`UPDATE supplier_invoices SET invoice_number = ${num}, total_amount = ${amount}, status = 'cancelled' WHERE id = ${doc}::UUID`;
      return doc;
    };
    const reversedJournal = async (description: string, amount: number) => {
      const l: Leg[] = [[z.ap, 0, amount], [z.expense, amount, 0]];
      const je = await journal(z, l, { source: 'auto_supplier_invoice', description });
      await sql`UPDATE gl_journal_entries SET reversal_of_id = ${je}::UUID WHERE id = ${await journal(z, negate(l))}::UUID`;
      return je;
    };
    const tied = `R9-${randomUUID().slice(0, 8)}`;
    await cancelledBill(tied, 250);
    const tiedJe = await reversedJournal(`Supplier invoice ${tied}`, 250);
    // A cancelled draft (never approved) and an orphan journal of another bill with the same number but another amount.
    const draftNum = `R9-${randomUUID().slice(0, 8)}`;
    await cancelledBill(draftNum, 80);
    const orphanJe = await reversedJournal(`Supplier invoice ${draftNum}`, 999);
    // A cancelled bill numbered '' and a journal 'Supplier invoice ' of its amount.
    await cancelledBill('', 60);
    const blankJe = await reversedJournal('Supplier invoice ', 60);
    // The same for a customer invoice numbered ''.
    const blankInv = await document(z, 'customer_invoices', { status: 'approved' });
    await sql`UPDATE customer_invoices SET invoice_number = '', total_amount = 70, status = 'cancelled' WHERE id = ${blankInv}::UUID`;
    const arLegs: Leg[] = [[z.ar, 70, 0], [z.revenue, 0, 70]];
    const blankArJe = await journal(z, arLegs, { source: 'auto_invoice', description: 'Customer invoice ' });
    await sql`UPDATE gl_journal_entries SET reversal_of_id = ${blankArJe}::UUID WHERE id = ${await journal(z, negate(arLegs))}::UUID`;
    const role = `r9_owner_${randomUUID().slice(0, 8)}`;
    const c = await z.pool.connect();
    const notices: string[] = [];
    c.on('notice', (n) => notices.push(String(n.message)));
    try {
      await c.query('BEGIN');
      const owner = String((await c.query("SELECT relowner::regrole::text AS o FROM pg_class WHERE oid = 'public.gl_journal_entries'::regclass")).rows[0].o);
      await c.query(`CREATE ROLE ${role} NOSUPERUSER INHERIT BYPASSRLS`);
      await c.query(`GRANT ${owner} TO ${role}`);
      await c.query(`SET LOCAL ROLE ${role}`);
      expect((await c.query("SELECT current_setting('is_superuser') AS s")).rows[0].s).toBe('off');
      await c.query(backfillBlock());
      const stamped = async (je: string) => (await c.query('SELECT document_cancelled_at IS NOT NULL AS s FROM gl_journal_entries WHERE id = $1', [je])).rows[0].s;
      expect(await stamped(tiedJe)).toBe(true);
      expect(await stamped(orphanJe)).toBe(false);
      expect(await stamped(blankJe)).toBe(false);
      expect(await stamped(blankArJe)).toBe(false);
      expect(notices.join('\n')).toMatch(/1018 backfill: \d+ journal\(s\)/);
    } finally { await c.query('ROLLBACK').catch(() => undefined); c.release(); }
    void fx;
  });
});
