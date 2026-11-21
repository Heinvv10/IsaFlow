/**
 * Migration 1018, round 3 security review, as app_user under RLS and claims. S1: a cancelled document never leaves
 * 'cancelled', whether it unlinks and un-cancels in one UPDATE, one after the other, or never had a link; a document's
 * journal is unlinked only by its cancel. S2: the cancel stamps its journal (document_cancelled_at), the credit note's
 * too, so deleting the cancelled document afterwards does not let its chain be re-instated.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';
import { sql } from '@/lib/neon';
import { isDisposableDb } from '../helpers/assertDisposableDb';
import { asApp, document, dropFreeze, journal, negate, refused, seedFreeze, type Freeze, type Leg, type Row, linkAsApp } from './helpers/ledgerFreezeFixture';

const describeIfDisposable = isDisposableDb() ? describe : describe.skip;
type Kind = 'customer_invoices' | 'supplier_invoices' | 'credit_notes';
const KINDS: Kind[] = ['customer_invoices', 'supplier_invoices', 'credit_notes'];
let z: Freeze;
let legs: Leg[];
const link = (contra: string, original: string) => (c: PoolClient) => linkAsApp(c, contra, original);
const write = (q: string, params: unknown[]) => (c: PoolClient) => c.query(q, params);

/** An approved document holding O, and O reversed by R, both written as app_user. */
async function approvedAndReversed(kind: Kind): Promise<{ o: string; r: string; doc: string }> {
  const o = await journal(z, legs);
  const doc = await document(z, kind, { status: 'draft' });
  await asApp(z, write(`UPDATE ${kind} SET gl_journal_entry_id = $1, status = 'approved' WHERE id = $2`, [o, doc]), { commit: true });
  const r = await journal(z, negate(legs));
  await asApp(z, link(r, o), { commit: true });
  return { o, r, doc };
}

describeIfDisposable('ledger column immutability, round 3 security review (migration 1018)', () => {
  beforeAll(async () => { z = await seedFreeze(); legs = [[z.ar, 100, 0], [z.revenue, 0, 100]]; }, 240000);
  afterAll(async () => { if (z) await dropFreeze(z); }, 120000);

  it.each(KINDS)('%s: S1 a journal out of force is unlinked only by the cancel itself', async (kind) => {
    const { doc } = await approvedAndReversed(kind);
    await refused(asApp(z, write(`UPDATE ${kind} SET gl_journal_entry_id = NULL WHERE id = $1`, [doc])), /unlinked only by its cancel/);
    await refused(asApp(z, write(`UPDATE ${kind} SET gl_journal_entry_id = NULL, status = 'draft' WHERE id = $1`, [doc])), /unlinked only by its cancel/);
    await asApp(z, write(`UPDATE ${kind} SET gl_journal_entry_id = NULL, status = 'cancelled' WHERE id = $1`, [doc]), { commit: true });
  });

  it('S1 a cancelled credit note (linked) neither unlinks and un-cancels in one UPDATE nor unlinks first', async () => {
    const { doc } = await approvedAndReversed('credit_notes');
    await asApp(z, write("UPDATE credit_notes SET status = 'cancelled' WHERE id = $1", [doc]), { commit: true });
    await refused(asApp(z, write("UPDATE credit_notes SET gl_journal_entry_id = NULL, status = 'approved' WHERE id = $1", [doc])), /stays cancelled/);
    await refused(asApp(z, write('UPDATE credit_notes SET gl_journal_entry_id = NULL WHERE id = $1', [doc])), /unlinked only by its cancel/);
  });

  it.each(KINDS)('%s: S1 a cancelled document with no link stays cancelled too', async (kind) => {
    const doc = await document(z, kind, { status: 'cancelled' });
    for (const status of ['approved', 'draft', 'pending_approval']) {
      await refused(asApp(z, write(`UPDATE ${kind} SET status = $2 WHERE id = $1`, [doc, status])), /stays cancelled/);
    }
  });

  it('S2 a cancelled credit note deleted afterwards: its chain still cannot be re-instated', async () => {
    const { o, r, doc } = await approvedAndReversed('credit_notes');
    await asApp(z, write("UPDATE credit_notes SET status = 'cancelled' WHERE id = $1", [doc]), { commit: true });
    expect(((await sql`SELECT document_cancelled_at AS t FROM gl_journal_entries WHERE id = ${o}::UUID`) as Row[])[0]!.t).not.toBeNull();
    const deleted = await asApp(z, write('DELETE FROM credit_notes WHERE id = $1', [doc]), { commit: true });
    expect(deleted.rowCount).toBe(1);
    await refused(asApp(z, link(await journal(z, legs), r)), /journal of a cancelled document back in force/);
  });
});
