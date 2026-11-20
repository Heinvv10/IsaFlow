/**
 * Migration 1018, review round 5 (the round-4 breaker's probes, now as assertions), as app_user under RLS and claims.
 * N1: a cancelled or soft-deleted document links no journal (UPDATE, MERGE, insert-cancelled-then-link). N2: an invoice or
 * bill is not soft-deleted while its journal is in force, and a soft-deleted holder counts as cancelled when a link would
 * re-instate its chain. The guards are not over-strict: an open document still links, a soft delete after the reversal
 * passes, a restored document's chain re-instates.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';
import { sql } from '@/lib/neon';
import { isDisposableDb } from '../helpers/assertDisposableDb';
import { asApp, document, dropFreeze, journal, negate, refused, seedFreeze, type Freeze, type Leg, type Row } from './helpers/ledgerFreezeFixture';

const describeIfDisposable = isDisposableDb() ? describe : describe.skip;
type Kind = 'customer_invoices' | 'supplier_invoices' | 'credit_notes';
const KINDS: Kind[] = ['customer_invoices', 'supplier_invoices', 'credit_notes'];
const SOFT: Array<'customer_invoices' | 'supplier_invoices'> = ['customer_invoices', 'supplier_invoices'];
let z: Freeze;
let legs: Leg[];
const app = (q: string, v: unknown[] = []) => asApp(z, (c: PoolClient) => c.query(q, v), { commit: true });
const link = (contra: string, original: string) => app('UPDATE gl_journal_entries SET reversal_of_id = $1 WHERE id = $2', [original, contra]);
const inForce = async (je: string) => ((await sql`SELECT public.gl_journal_in_force(${je}::UUID) AS f`) as Row[])[0]!.f;
const NO_LINK = /a cancelled or deleted document does not link a journal/;
const REINSTATE = /journal of a cancelled document back in force/;

async function approved(kind: Kind): Promise<{ o: string; doc: string }> {
  const o = await journal(z, legs);
  const doc = await document(z, kind, { status: 'draft' });
  await app(`UPDATE ${kind} SET gl_journal_entry_id = $1, status = 'approved' WHERE id = $2`, [o, doc]);
  return { o, doc };
}
async function cancelled(kind: Kind): Promise<{ o: string; r: string; doc: string }> {
  const { o, doc } = await approved(kind);
  const r = await journal(z, negate(legs));
  await link(r, o);
  await app(`UPDATE ${kind} SET status = 'cancelled'${kind === 'credit_notes' ? '' : ', gl_journal_entry_id = NULL'} WHERE id = $1`, [doc]);
  return { o, r, doc };
}

describeIfDisposable('ledger column immutability, round 5 (migration 1018)', () => {
  beforeAll(async () => { z = await seedFreeze(); legs = [[z.ar, 100, 0], [z.revenue, 0, 100]]; }, 240000);
  afterAll(async () => { if (z) await dropFreeze(z); }, 120000);

  it.each(SOFT)('%s: N1 a cancelled (unlinked) document does not link a fresh journal', async (kind) => {
    const { doc } = await cancelled(kind);
    const x = await journal(z, legs);
    await refused(asApp(z, (c) => c.query(`UPDATE ${kind} SET gl_journal_entry_id = $1 WHERE id = $2`, [x, doc])), NO_LINK);
  });

  it('credit_notes: N1 a note cancelled from draft does not link a journal', async () => {
    const doc = await document(z, 'credit_notes', { status: 'draft' });
    await app("UPDATE credit_notes SET status = 'cancelled' WHERE id = $1", [doc]);
    const x = await journal(z, legs);
    await refused(asApp(z, (c) => c.query('UPDATE credit_notes SET gl_journal_entry_id = $1 WHERE id = $2', [x, doc])), NO_LINK);
  });

  it.each(KINDS)('%s: N1b a document inserted cancelled does not link a journal, by UPDATE or by MERGE', async (kind) => {
    const doc = await document(z, kind, { status: 'cancelled' });
    const x = await journal(z, legs);
    await refused(asApp(z, (c) => c.query(`UPDATE ${kind} SET gl_journal_entry_id = $1 WHERE id = $2`, [x, doc])), NO_LINK);
    await refused(asApp(z, (c) => c.query(
      `MERGE INTO ${kind} t USING (SELECT $1::uuid AS id) s ON t.id = s.id WHEN MATCHED THEN UPDATE SET gl_journal_entry_id = $2`, [doc, x])), NO_LINK);
  });

  it.each(SOFT)('%s: N1 a soft-deleted (unlinked) document does not link a journal', async (kind) => {
    const doc = await document(z, kind, { status: 'approved' });
    await app(`UPDATE ${kind} SET deleted_at = now() WHERE id = $1`, [doc]); // unlinked: no guard to meet
    const x = await journal(z, legs);
    await refused(asApp(z, (c) => c.query(`UPDATE ${kind} SET gl_journal_entry_id = $1 WHERE id = $2`, [x, doc])), NO_LINK);
  });

  it.each(KINDS)('%s: over-strict check, an open document still links a fresh journal', async (kind) => {
    const doc = await document(z, kind, { status: 'draft' });
    const x = await journal(z, legs);
    await app(`UPDATE ${kind} SET gl_journal_entry_id = $1, status = 'approved' WHERE id = $2`, [x, doc]);
    expect(await inForce(x)).toBe(true);
  });

  it.each(SOFT)('%s: N2a a soft delete is refused while the journal is in force; after the reversal it passes', async (kind) => {
    const { o, doc } = await approved(kind);
    await refused(asApp(z, (c) => c.query(`UPDATE ${kind} SET deleted_at = now() WHERE id = $1`, [doc])), /journal is in force is not deleted/);
    await link(await journal(z, negate(legs)), o); // what softDeleteService does first: reverse the chain head
    await app(`UPDATE ${kind} SET deleted_at = now() WHERE id = $1`, [doc]);
    expect(await inForce(o)).toBe(false);
  });

  it.each(SOFT)('%s: N2b a soft-deleted holder counts as cancelled: no re-instatement until it is restored', async (kind) => {
    const { o, doc } = await approved(kind);
    const r = await journal(z, negate(legs));
    await link(r, o);
    await app(`UPDATE ${kind} SET deleted_at = now() WHERE id = $1`, [doc]);
    const r2 = await journal(z, legs);
    await refused(asApp(z, (c) => c.query('UPDATE gl_journal_entries SET reversal_of_id = $1 WHERE id = $2', [r, r2])), REINSTATE);
    expect(await inForce(o)).toBe(false);
    await app(`UPDATE ${kind} SET deleted_at = NULL WHERE id = $1`, [doc]); // the undo's order: restore, then re-reverse
    await link(r2, r);
    expect(await inForce(o)).toBe(true);
  });
});
