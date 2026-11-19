/**
 * Intercompany P2, the auto-accept worker, against a real database. The worker has no user and no company, so it lists its work
 * through ONE definer (`intercompany_auto_accept_queue`, 1013) and then acts as the RECEIVER: app_user with the claims of a write-role
 * user of the receiving company and that company's GUCs. It accepts only what the receiver's side asked to have accepted on an ACTIVE
 * GROUP connection whose companies still share a group, creates DRAFTS only (nothing approved or posted), writes nothing in the
 * sender's or a third company's books, and leaves a message it cannot accept `failed` with a plain sentence.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { runAutoAccept } from '../../../src/modules/accounting/services/intercompany/autoAcceptWorker';
import { withReceiverTx } from '../../../src/modules/accounting/services/intercompany/receiverTx';
import { sql } from '../../../src/lib/neon';
import { asAppUser, count, plantDocument, plantExternal, withoutTrigger } from './intercompany.helpers';
import {
  acc, approveInvoice, co, connect, inbox, mirrorCleanup, mirrorSetup, party, plantArInvoice, U, wipeConnections,
} from './mirror.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });

beforeAll(() => mirrorSetup(pool), 60000);
afterAll(() => mirrorCleanup(pool), 60000);
beforeEach(async () => {
  await pool.query('DELETE FROM intercompany_transactions WHERE group_id = $1', [co.G]);
  await pool.query('DELETE FROM supplier_invoice_items WHERE supplier_invoice_id IN (SELECT id FROM supplier_invoices WHERE company_id = ANY($1))', [[co.A, co.B, co.C]]);
  await pool.query('DELETE FROM supplier_invoices WHERE company_id = ANY($1)', [[co.A, co.B, co.C]]);
  await wipeConnections(pool);
});

async function sent(over: Parameters<typeof plantArInvoice>[1] = {}) {
  const inv = await plantArInvoice(pool, over);
  expect((await approveInvoice(inv.id)).state.statusCode).toBe(200);
  return { inv, id: (await pool.query('SELECT id FROM intercompany_messages WHERE source_doc_id = $1', [inv.id])).rows[0].id as string };
}
const row = async (id: string) => (await pool.query('SELECT * FROM intercompany_messages WHERE id = $1', [id])).rows[0];
const bills = async (company = co.B) => (await pool.query('SELECT * FROM supplier_invoices WHERE company_id = $1', [company])).rows;
const queue = async () => (await pool.query('SELECT * FROM public.intercompany_auto_accept_queue(50)')).rows;
/** Run `fn` on a connection in a transaction that is always rolled back (to read the queue under a changed world). */
async function rolledBack<T>(fn: (q: import('pg').PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    return await fn(c);
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
}

describe('what the worker does', () => {
  it('accepts as the receiver: a DRAFT bill in B, the message accepted by "auto", the documents linked; nothing is approved or posted', async () => {
    await connect(pool, { autoAccept: true });
    const { inv, id } = await sent();
    const run = await runAutoAccept();
    expect(run).toMatchObject({ considered: 1, accepted: 1, failed: 0, deferred: 0 });
    const [bill] = await bills();
    expect(bill).toMatchObject({ invoice_number: inv.number, supplier_id: party.bSupplier, status: 'draft', gl_journal_entry_id: null });
    expect([Number(bill.subtotal), Number(bill.tax_amount), Number(bill.total_amount)]).toEqual([1000, 150, 1150]);
    const m = await row(id);
    expect(m).toMatchObject({ status: 'accepted', handled_via: 'auto', target_doc_id: bill.id, error: null });
    expect([U.ab, U.b, U.mab]).toContain(m.handled_by); // a write-role user of B, never a viewer
    expect(bill.created_by).toBe(m.handled_by);
    expect(await count(pool, "SELECT count(*) AS n FROM intercompany_document_links WHERE message_id = $1 AND status = 'active'", [id])).toBe(1);
    expect((await pool.query('SELECT match_status FROM intercompany_transactions WHERE group_id = $1', [co.G])).rows[0].match_status).toBe('matched');
    // a draft was made, no journal for it
    expect(await count(pool, 'SELECT count(*) AS n FROM gl_journal_entries WHERE company_id = $1', [co.B])).toBe(0);
  });

  it('writes nothing in the sender\'s or a third company\'s books', async () => {
    await connect(pool, { autoAccept: true });
    await sent();
    const before = await count(pool, 'SELECT count(*) AS n FROM supplier_invoices WHERE company_id = ANY($1)', [[co.A, co.C]]);
    await runAutoAccept();
    expect(await count(pool, 'SELECT count(*) AS n FROM supplier_invoices WHERE company_id = ANY($1)', [[co.A, co.C]])).toBe(before);
    expect(await count(pool, 'SELECT count(*) AS n FROM credit_notes WHERE type = $2 AND company_id = ANY($1)', [[co.A, co.C], 'supplier'])).toBe(0);
  });

  it('a second run, and a run at the same moment as a person\'s accept, make one draft', async () => {
    await connect(pool, { autoAccept: true });
    const { id } = await sent();
    await Promise.all([runAutoAccept(), inbox.accept(U.b, co.B, id), runAutoAccept()]);
    await runAutoAccept();
    expect(await bills()).toHaveLength(1);
    expect(await count(pool, 'SELECT count(*) AS n FROM intercompany_document_links WHERE message_id = $1', [id])).toBe(1);
    expect(await queue()).toHaveLength(0); // an accepted message is not queued again
  });

  it('accepts a credit note as a draft supplier credit note', async () => {
    await connect(pool, { autoAccept: true });
    const connId = (await pool.query('SELECT id FROM intercompany_connections WHERE company_low_id = LEAST($1::uuid, $2::uuid) AND company_high_id = GREATEST($1::uuid, $2::uuid)', [co.A, co.B])).rows[0].id;
    const cn = await plantCreditNote();
    const payload = {
      version: 1, kind: 'credit_note', number: 'CN-AUTO-1', date: '2026-09-05', dueDate: null, currency: 'ZAR', subtotal: 200, taxAmount: 30, total: 230,
      senderName: 'A', senderVatNumber: null, notes: 'Returned router', creditsInvoiceNumber: null, groupTransactionId: null, pdf: null,
      lines: [{ description: 'Returned router', quantity: 1, unitPrice: 200, taxRate: 15, taxAmount: 30, lineTotal: 200 }],
    };
    const m = await asAppUser(pool, U.a, co.A, (q) => q.query(
      `INSERT INTO intercompany_messages(connection_id, from_company_id, to_company_id, kind, source_doc_type, source_doc_id, payload)
       VALUES ($1, $2, $3, 'credit_note', 'credit_note', $4, $5::jsonb) RETURNING id`, [connId, co.A, co.B, cn, JSON.stringify(payload)]), true);
    expect(await runAutoAccept()).toMatchObject({ accepted: 1 });
    const note = (await pool.query("SELECT * FROM credit_notes WHERE company_id = $1 AND type = 'supplier'", [co.B])).rows[0];
    expect(note).toMatchObject({ status: 'draft', supplier_id: party.bSupplier, gl_account_id: acc.bExp1 });
    expect(Number(note.total_amount)).toBe(230);
    expect((await row(m.rows[0].id)).handled_via).toBe('auto');
  });
});

async function plantCreditNote(): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO credit_notes(id, company_id, credit_note_number, type, client_id, credit_date, subtotal, tax_rate, tax_amount, total_amount, status, created_by)
     VALUES ($1, $2, $3, 'customer', $4, DATE '2026-09-05', 200, 15, 30, 230, 'approved', $5)`, [id, co.A, `ICCN-${id.slice(0, 8)}`, party.aCustomer, U.ab]);
  return id;
}

describe('what the worker leaves alone', () => {
  it('a receiver that did not ask for auto-accept: nothing is queued or accepted', async () => {
    await connect(pool, { autoAccept: false });
    const { id } = await sent();
    expect(await queue()).toHaveLength(0);
    expect(await runAutoAccept()).toMatchObject({ considered: 0, accepted: 0 });
    expect((await row(id)).status).toBe('pending');
    expect(await bills()).toHaveLength(0);
  });

  it('a revoked connection is not queued', async () => {
    const conn = await connect(pool, { autoAccept: true });
    const { id } = await sent();
    await asAppUser(pool, U.a, co.A, (q) => q.query("UPDATE intercompany_connections SET status = 'revoked' WHERE id = $1", [conn]), true);
    expect(await queue()).toHaveLength(0);
    expect(await runAutoAccept()).toMatchObject({ considered: 0 });
    expect((await row(id)).status).toBe('pending');
  });

  it('an EXTERNAL connection is never auto-accepted, even with the flag forced on in its side', async () => {
    // A and C share a group here, so the ONLY thing that keeps this connection out of the queue is that it is external.
    await pool.query('INSERT INTO company_group_members(group_id, company_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [co.H, co.A]);
    const ext = await plantExternal(pool, co.A, co.C, 'active');
    await withoutTrigger(pool, 'intercompany_connection_sides', 'trg_intercompany_sides_guard', (q) => q.query(
      'INSERT INTO intercompany_connection_sides(connection_id, company_id, partner_company_id, auto_accept) VALUES ($1, $2, $3, true) ON CONFLICT (connection_id, company_id) DO UPDATE SET auto_accept = true',
      [ext, co.C, co.A]));
    await withoutTrigger(pool, 'intercompany_messages', 'trg_intercompany_messages_guard', (q) => q.query(
      `INSERT INTO intercompany_messages(connection_id, from_company_id, to_company_id, kind, source_doc_type, source_doc_id, payload)
       VALUES ($1, $2, $3, 'invoice', 'customer_invoice', gen_random_uuid(), '{}')`, [ext, co.A, co.C]));
    try {
      expect(await queue()).toHaveLength(0);
      expect(await runAutoAccept()).toMatchObject({ considered: 0 });
      expect(await bills(co.C)).toHaveLength(0);
    } finally {
      await pool.query('DELETE FROM company_group_members WHERE group_id = $1 AND company_id = $2', [co.H, co.A]);
    }
  });

  it('companies that no longer share a group are not queued, even while the connection row still says active', async () => {
    await connect(pool, { autoAccept: true });
    const { id } = await sent();
    await withoutTrigger(pool, 'company_group_members', 'trg_intercompany_group_membership', (q) =>
      q.query('UPDATE company_group_members SET left_date = CURRENT_DATE WHERE group_id = $1 AND company_id = $2', [co.G, co.B]));
    try {
      expect((await pool.query("SELECT status FROM intercompany_connections WHERE company_low_id = LEAST($1::uuid, $2::uuid) AND company_high_id = GREATEST($1::uuid, $2::uuid)", [co.A, co.B])).rows[0].status).toBe('active');
      expect(await queue()).toHaveLength(0);
      expect(await runAutoAccept()).toMatchObject({ considered: 0 });
      expect((await row(id)).status).toBe('pending');
    } finally {
      await pool.query('UPDATE company_group_members SET left_date = NULL WHERE group_id = $1', [co.G]);
    }
  });

  it('a receiver with no write-role user in good standing yields no work; a suspended owner is passed over for the next', async () => {
    await connect(pool, { autoAccept: true });
    await sent();
    expect(await rolledBack(async (q) => {
      await q.query("UPDATE company_users SET role = 'viewer' WHERE company_id = $1", [co.B]);
      return (await q.query('SELECT * FROM public.intercompany_auto_accept_queue(50)')).rows;
    })).toHaveLength(0);
    const actor = await rolledBack(async (q) => {
      await q.query('UPDATE users SET suspended_at = now() WHERE id = ANY($1::text[])', [[U.ab, U.b]]);
      return (await q.query('SELECT * FROM public.intercompany_auto_accept_queue(50)')).rows;
    });
    expect(actor).toHaveLength(1);
    expect(actor[0].actor_user_id).toBe(U.mab);
    expect((await queue())[0].actor_user_id).toBe(U.ab);
  });

  it('a message that cannot be accepted is marked failed with a sentence, once; the next run leaves it; a person can still accept it', async () => {
    await connect(pool, { autoAccept: true, bSupplier: false });
    const { id } = await sent();
    expect(await runAutoAccept()).toMatchObject({ considered: 1, accepted: 0, failed: 1 });
    expect(await row(id)).toMatchObject({ status: 'failed', handled_via: 'auto' });
    expect(String((await row(id)).error)).toMatch(/Link the supplier/);
    expect(await bills()).toHaveLength(0);
    expect(await runAutoAccept()).toMatchObject({ considered: 0 });
    // fix the side, then Accept by hand retries the failed message
    await asAppUser(pool, U.b, co.B, (q) => q.query(
      'UPDATE intercompany_connection_sides SET supplier_id = $2 WHERE company_id = $1', [co.B, party.bSupplier]), true);
    expect((await inbox.accept(U.b, co.B, id)).state.statusCode).toBe(200);
    expect(await row(id)).toMatchObject({ status: 'accepted', handled_via: 'user', error: null });
  });

  it('a duplicate bill number fails the message instead of making a second bill', async () => {
    await connect(pool, { autoAccept: true });
    const { inv, id } = await sent();
    await pool.query(
      `INSERT INTO supplier_invoices(company_id, invoice_number, supplier_id, invoice_date, subtotal, tax_rate, tax_amount, total_amount, currency_code, status, created_by)
       VALUES ($1, $2, $3, DATE '2026-09-01', 5, 15, 0.75, 5.75, 'ZAR', 'draft', $4)`, [co.B, inv.number, party.bSupplier, U.b]);
    expect(await runAutoAccept()).toMatchObject({ failed: 1 });
    expect((await row(id)).status).toBe('failed');
    expect(await bills()).toHaveLength(1);
  });
});

describe('the receiver\'s transaction', () => {
  it('is app_user with the receiver user\'s claims and the receiver\'s company: another company\'s rows are invisible and unwritable', async () => {
    const aBill = await plantDocument(pool, 'supplier_invoice', co.A);
    const seen = await withReceiverTx({ userId: U.b, companyId: co.B }, async () => {
      const who = (await sql`SELECT current_user AS role, auth.uid() AS uid, app.current_company_id()::TEXT AS company`) as Array<Record<string, string>>;
      const aRows = (await sql`SELECT count(*)::int AS n FROM supplier_invoices WHERE company_id = ${co.A}::UUID`) as Array<{ n: number }>;
      const wrote = await sql`UPDATE supplier_invoices SET notes = 'touched' WHERE id = ${aBill}::UUID RETURNING id`;
      return { who: who[0], aRows: aRows[0]!.n, wrote: wrote.length };
    });
    expect(seen.who).toEqual({ role: 'app_user', uid: U.b, company: co.B });
    expect(seen.aRows).toBe(0);
    expect(seen.wrote).toBe(0);
    expect((await pool.query('SELECT notes FROM supplier_invoices WHERE id = $1', [aBill])).rows[0].notes).toBeNull();
  });
});

describe('who may call the queue', () => {
  it('a tenant session (app_user) cannot execute it; a signed-in user of B reads no queue', async () => {
    await connect(pool, { autoAccept: true });
    await sent();
    for (const [user, company] of [[U.b, co.B], [U.a, co.A], [U.c, co.C]] as const) {
      await asAppUser(pool, user, company, async (q) => {
        await expect(q.query('SELECT * FROM public.intercompany_auto_accept_queue(50)')).rejects.toMatchObject({ code: '42501' });
      });
    }
    expect((await pool.query("SELECT has_function_privilege('app_user', 'public.intercompany_auto_accept_queue(integer)', 'EXECUTE') AS a, has_function_privilege('app_service', 'public.intercompany_auto_accept_queue(integer)', 'EXECUTE') AS s, has_function_privilege('public', 'public.intercompany_auto_accept_queue(integer)', 'EXECUTE') AS p")).rows[0])
      .toEqual({ a: false, s: true, p: false });
  });

  it('returns ids only: a receiver company, a message and a user, no payload', async () => {
    await connect(pool, { autoAccept: true });
    await sent();
    const q = await queue();
    expect(Object.keys(q[0]).sort()).toEqual(['actor_user_id', 'message_id', 'to_company_id']);
    expect(q[0].to_company_id).toBe(co.B);
  });
});
