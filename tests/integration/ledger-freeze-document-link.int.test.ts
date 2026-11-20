/**
 * Migration 1018, rules 4 and 5: a customer invoice, supplier bill or credit note links a journal only when that journal
 * is a posted, unreversed, unclaimed journal of its own company; never on INSERT; never swapped; unlinked only once the
 * journal is out of force; and is not cancelled while its journal is in force. One table at a time, as app_user.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import { isDisposableDb } from '../helpers/assertDisposableDb';
import { asApp, asRole, document, dropFreeze, journal, negate, refused, seedFreeze, type Freeze, type Leg, type Row } from './helpers/ledgerFreezeFixture';

const describeIfDisposable = isDisposableDb() ? describe : describe.skip;
type Kind = 'customer_invoices' | 'supplier_invoices' | 'credit_notes';
const KINDS: Kind[] = ['customer_invoices', 'supplier_invoices', 'credit_notes'];
let z: Freeze;
let legs: Leg[];
const setLink = (kind: Kind, id: string, je: string | null) => (c: import('pg').PoolClient) =>
  c.query(`UPDATE ${kind} SET gl_journal_entry_id = $1 WHERE id = $2`, [je, id]);
const linkOf = async (kind: Kind, id: string) => String((await z.pool.query(`SELECT gl_journal_entry_id AS j FROM ${kind} WHERE id = $1`, [id])).rows[0]?.j ?? null);

describeIfDisposable('ledger column immutability: a document\'s journal link and cancel (migration 1018)', () => {
  beforeAll(async () => {
    z = await seedFreeze();
    legs = [[z.ar, 100, 0], [z.revenue, 0, 100]];
  }, 240000);
  afterAll(async () => { if (z) await dropFreeze(z); }, 120000);

  it.each(KINDS)('%s: a document is never inserted already linked', async (kind) => {
    const je = await journal(z, legs);
    const insert = {
      customer_invoices: `INSERT INTO customer_invoices (company_id, customer_id, invoice_number, invoice_date, due_date, subtotal, total_amount, status, gl_journal_entry_id)
        VALUES ($1, $2, 'LCI-INS', '2026-06-10', '2026-06-10', 1, 1, 'draft', $3)`,
      supplier_invoices: `INSERT INTO supplier_invoices (company_id, supplier_id, invoice_number, invoice_date, due_date, subtotal, total_amount, status, gl_journal_entry_id)
        VALUES ($1, $2, 'LCI-INS', '2026-06-10', '2026-06-10', 1, 1, 'draft', $3)`,
      credit_notes: `INSERT INTO credit_notes (company_id, type, credit_note_number, client_id, credit_date, subtotal, total_amount, status, gl_journal_entry_id)
        VALUES ($1, 'customer', 'LCI-INS', $2, '2026-06-10', 1, 1, 'draft', $3)`,
    }[kind];
    const owner = kind === 'supplier_invoices' ? z.f.fx.supplierId : z.f.fx.customerId;
    await refused(asApp(z, (c) => c.query(insert, [z.f.fx.companyId, owner, je])), /created unlinked/);
  });

  it.each(KINDS)('%s: NULL -> a journal is accepted only for a posted, unreversed, own-company journal no other document holds', async (kind) => {
    const doc = await document(z, kind, { status: 'draft' });
    const reversed = await journal(z, legs, { claimed: true });
    const contra = await journal(z, negate(legs));
    await sql`UPDATE gl_journal_entries SET reversal_of_id = ${reversed}::UUID WHERE id = ${contra}::UUID`;
    const held = await Promise.all(KINDS.map(async (k) => { const je = await journal(z, legs); await document(z, k, { link: je }); return je; }));
    const foreign = await journal(z, [[z.f.acct.foreign, 100, 0], [z.f.acct.foreign, 0, 100]], { company: z.f.other.companyId });
    const bad: Array<[string, string]> = [
      ['a draft journal', await journal(z, legs, { status: 'draft' })], ['a reversed journal', reversed],
      ['a reversal contra', contra], ...held.map((je, i): [string, string] => [`a journal held by ${KINDS[i]}`, je]),
      ['another company\'s journal', foreign], ['a journal that does not exist', crypto.randomUUID()],
    ];
    for (const [name, je] of bad) {
      await refused(asApp(z, setLink(kind, doc, je)), /links only a posted|belongs to another document/);
      expect(await linkOf(kind, doc), name).toBe('null');
    }
    const good = await journal(z, legs);
    await asApp(z, setLink(kind, doc, good), { commit: true });
    expect(await linkOf(kind, doc)).toBe(good);
  });

  it.each(KINDS)('%s: two sessions cannot both link one journal (the check holds a per-journal lock)', async (kind) => {
    const je = await journal(z, legs);
    const [a, b] = [await document(z, kind, { status: 'draft' }), await document(z, kind, { status: 'draft' })];
    const open = async () => {
      const c = await z.pool.connect();
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE app_user');
      await c.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: z.f.fx.userId, role: 'authenticated' })]);
      await c.query("SELECT set_config('app.current_company_id', $1, true)", [z.f.fx.companyId]);
      return c;
    };
    const [first, second] = [await open(), await open()];
    try {
      await setLink(kind, a, je)(first);
      const racing = setLink(kind, b, je)(second).then(() => 'linked', (e: { message: string }) => e.message);
      await new Promise((r) => setTimeout(r, 400)); // the second waits on the first's lock
      await first.query('COMMIT');
      expect(await racing).toMatch(/belongs to another document/);
    } finally {
      await first.query('ROLLBACK').catch(() => undefined);
      await second.query('ROLLBACK').catch(() => undefined);
      first.release(); second.release();
    }
    expect(await linkOf(kind, a)).toBe(je);
    expect(await linkOf(kind, b)).toBe('null');
  });

  it.each(KINDS)('%s: a journal a posted contra links to is out of force even when never stamped; another company\'s journal is refused to a role that sees it', async (kind) => {
    const legacy = await journal(z, legs);
    const contra = await journal(z, negate(legs));
    await sql`UPDATE gl_journal_entries SET reversal_of_id = ${legacy}::UUID WHERE id = ${contra}::UUID`;
    const doc = await document(z, kind, { status: 'draft' });
    await refused(asApp(z, setLink(kind, doc, legacy)), /links only a posted/);
    const linked = await document(z, kind, { link: legacy });
    await asApp(z, setLink(kind, linked, null), { commit: true });
    expect(await linkOf(kind, linked)).toBe('null');
    const foreign = await journal(z, [[z.f.acct.foreign, 100, 0], [z.f.acct.foreign, 0, 100]], { company: z.f.other.companyId });
    await refused(asRole(z, 'platform_admin', setLink(kind, doc, foreign)), /links only a posted/);
  });

  it.each(KINDS)('%s: a linked document\'s journal is not swapped, nor unlinked while in force; unlinked once reversed', async (kind) => {
    const original = await journal(z, legs);
    const doc = await document(z, kind, { link: original });
    await refused(asApp(z, setLink(kind, doc, await journal(z, legs))), /cannot be swapped/);
    await refused(asApp(z, setLink(kind, doc, null)), /in force cannot be unlinked/);
    await refused(asRole(z, 'migration_admin', setLink(kind, doc, null)), /in force cannot be unlinked/);
    await sql`UPDATE gl_journal_entries SET reversed_at = now() WHERE id = ${original}::UUID`;
    await asApp(z, setLink(kind, doc, null), { commit: true });
    expect(await linkOf(kind, doc)).toBe('null');
  });

  it.each(KINDS)('%s: cancelled only once its journal is out of force', async (kind) => {
    const original = await journal(z, legs);
    const doc = await document(z, kind, { link: original });
    const cancel = (c: import('pg').PoolClient) => c.query(`UPDATE ${kind} SET status = 'cancelled' WHERE id = $1`, [doc]);
    await refused(asApp(z, cancel), /journal is in force/);
    await refused(asRole(z, 'platform_admin', cancel), /journal is in force/);
    await sql`UPDATE gl_journal_entries SET reversed_at = now() WHERE id = ${original}::UUID`;
    await asApp(z, cancel, { commit: true });
    const unlinked = await document(z, kind, { status: 'approved' });
    await asApp(z, (c) => c.query(`UPDATE ${kind} SET status = 'cancelled' WHERE id = $1`, [unlinked]));
  });
});
