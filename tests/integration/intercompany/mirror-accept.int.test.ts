/**
 * Intercompany P2, the RECEIVER's inbox, through the real routes as app_user across three tenants (A sends, B receives, C is a
 * stranger in another group). Accepting creates a DRAFT supplier invoice in B with the sender's number, VAT and total, marks the
 * message accepted and links the two documents (mirror link). It does NOT match the sender's group row: a draft eliminates nothing
 * (mirror-elimination.int.test.ts). A refusal writes nothing at all (no draft, no half-accepted message). A duplicate (same supplier and number) is
 * refused; a rejection needs a reason and touches only the message; nobody outside the two companies reads or changes anything.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { enableFxDocuments } from '../r035-approval.helpers';
import { asAppUser, count, pairOf, withoutTrigger } from './intercompany.helpers';
import {
  acct, acc, approveInvoice, co, connect, dataOf, errorOf, inbox, mirrorCleanup, mirrorSetup, party, plantArCreditNote, plantArInvoice,
  U, asService, clearMirrorRows, sentInvoice as sentInvoiceIn,
} from './mirror.helpers';
import { acceptMessage } from '../../../src/modules/accounting/services/intercompany/acceptService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
let conn = '';

beforeAll(() => mirrorSetup(pool), 60000);
afterAll(() => mirrorCleanup(pool), 60000);
beforeEach(async () => {
  await clearMirrorRows(pool);
  conn = await connect(pool);
});

const sentInvoice = (over: Parameters<typeof plantArInvoice>[1] = {}) => sentInvoiceIn(pool, over);
const bills = async () => (await pool.query('SELECT * FROM supplier_invoices WHERE company_id = $1 ORDER BY created_at', [co.B])).rows;
const notes = async () => (await pool.query("SELECT * FROM credit_notes WHERE company_id = $1 AND type = 'supplier'", [co.B])).rows;
const messageRow = async (id: string) => (await pool.query('SELECT * FROM intercompany_messages WHERE id = $1', [id])).rows[0];
const links = async () => (await pool.query('SELECT * FROM intercompany_document_links WHERE company_a_id = $1 OR company_b_id = $1', [co.A])).rows;
const accept = (id: string, body?: unknown, user = U.b) => inbox.accept(user, co.B, id, body);

describe('accepting an invoice', () => {
  it('creates a draft bill with the same number, VAT and total, on B\'s supplier and default account; links it; leaves the group row unmatched', async () => {
    const { inv, id } = await sentInvoice();
    const res = await accept(id);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    const result = dataOf<{ targetDocType: string; targetDocId: string }>(res);
    expect(result.targetDocType).toBe('supplier_invoice');

    const [bill] = await bills();
    expect(bill).toMatchObject({ id: result.targetDocId, invoice_number: inv.number, supplier_id: party.bSupplier, status: 'draft', company_id: co.B });
    expect([Number(bill.subtotal), Number(bill.tax_amount), Number(bill.total_amount)]).toEqual([1000, 150, 1150]);
    expect(String(bill.invoice_date).slice(0, 10)).toBe('2026-09-01');
    expect(bill.gl_journal_entry_id).toBeNull();
    const items = (await pool.query('SELECT * FROM supplier_invoice_items WHERE supplier_invoice_id = $1 ORDER BY description', [bill.id])).rows;
    expect(items.map((i) => [i.description, Number(i.line_total), Number(i.tax_amount), i.gl_account_id])).toEqual([
      ['Fibre install', 600, 90, acc.bExp1], ['Router', 400, 60, acc.bExp1],
    ]);

    const m = await messageRow(id);
    expect(m).toMatchObject({ status: 'accepted', target_doc_type: 'supplier_invoice', target_doc_id: bill.id, handled_by: U.b, handled_via: 'user', error: null });
    const [link] = await links();
    expect(link).toMatchObject({ origin: 'mirror', status: 'active', message_id: id, connection_id: conn });
    const [low] = pairOf(co.A, co.B);
    const aIsLow = low === co.A;
    expect(aIsLow ? [link.doc_a_type, link.doc_a_id, link.doc_b_type, link.doc_b_id] : [link.doc_b_type, link.doc_b_id, link.doc_a_type, link.doc_a_id])
      .toEqual(['customer_invoice', inv.id, 'supplier_invoice', bill.id]);
    // a draft eliminates nothing: the sender's group row stays unmatched until the receiver approves the bill
    const g = (await pool.query('SELECT * FROM intercompany_transactions WHERE group_id = $1', [co.G])).rows[0];
    expect(g).toMatchObject({ match_status: 'unmatched', matched_by: null, target_journal_entry_id: null });
    // A's own books are untouched
    expect(await count(pool, 'SELECT count(*) AS n FROM supplier_invoices WHERE company_id = $1', [co.A])).toBe(0);
    expect((await pool.query('SELECT status FROM customer_invoices WHERE id = $1', [inv.id])).rows[0].status).toBe('approved');
  });

  it('a second accept (a double click) is refused and creates no second draft', async () => {
    const { id } = await sentInvoice();
    expect((await accept(id)).state.statusCode).toBe(200);
    const again = await accept(id);
    expect(again.state.statusCode).toBe(409);
    expect(errorOf(again)).toMatch(/already accepted/);
    expect(await bills()).toHaveLength(1);
    expect(await links()).toHaveLength(1);
  });

  it('two accepts at the same moment make one draft', async () => {
    const { id } = await sentInvoice();
    const results = await Promise.all([accept(id), accept(id), accept(id)]);
    expect(results.map((r) => r.state.statusCode).sort()).toEqual([200, 409, 409]);
    expect(await bills()).toHaveLength(1);
    expect(await links()).toHaveLength(1);
  });

  it('a bill with the same supplier and number is a duplicate: refused, and nothing is written', async () => {
    const { inv, id } = await sentInvoice();
    await pool.query(
      `INSERT INTO supplier_invoices(company_id, invoice_number, supplier_id, invoice_date, subtotal, tax_rate, tax_amount, total_amount, currency_code, status, created_by)
       VALUES ($1, $2, $3, DATE '2026-09-01', 5, 15, 0.75, 5.75, 'ZAR', 'draft', $4)`, [co.B, inv.number, party.bSupplier, U.b]);
    const res = await accept(id);
    expect(res.state.statusCode).toBe(409);
    expect(errorOf(res)).toMatch(/already exists/);
    expect(await bills()).toHaveLength(1);
    expect((await messageRow(id)).status).toBe('pending');
    expect(await links()).toHaveLength(0);
    // the preview says so before anyone clicks
    const preview = dataOf<{ duplicateOf: { number: string } | null; blockers: string[] }>(await inbox.get(U.b, co.B, id));
    expect(preview.duplicateOf?.number).toBe(inv.number);
    expect(preview.blockers.join(' ')).toMatch(/already exists/);
  });

  it('with no supplier linked on B\'s side: refused with the reason, nothing written', async () => {
    await clearMirrorRows(pool);
    conn = await connect(pool, { bSupplier: false });
    const { id } = await sentInvoice();
    const res = await accept(id);
    expect(res.state.statusCode).toBe(409);
    expect(errorOf(res)).toMatch(/Link the supplier/);
    expect(await bills()).toHaveLength(0);
    expect((await messageRow(id)).status).toBe('pending');
  });

  it('with no default account and no earlier account for a line, the person must choose; the choice is used', async () => {
    await clearMirrorRows(pool);
    conn = await connect(pool, { bDefault: false });
    const { id } = await sentInvoice();
    const refused = await accept(id);
    expect(refused.state.statusCode).toBe(400);
    expect(errorOf(refused)).toMatch(/Choose an expense account for line 1/);
    expect(await bills()).toHaveLength(0);
    const ok = await accept(id, { lineAccounts: { 0: acc.bExp1, 1: acc.bExp2 } });
    expect(ok.state.statusCode, JSON.stringify(ok.state.body)).toBe(200);
    const items = (await pool.query('SELECT description, gl_account_id FROM supplier_invoice_items ORDER BY description')).rows
      .filter((r) => ['Fibre install', 'Router'].includes(r.description));
    expect(items.some((i) => i.gl_account_id === acc.bExp2)).toBe(true);
  });

  it('the account last used for a sender description is suggested next time; a new description gets the side default', async () => {
    const first = await sentInvoice();
    expect((await accept(first.id, { lineAccounts: { 0: acc.bExp2, 1: acc.bExp2 } })).state.statusCode).toBe(200);
    const second = await sentInvoice({ lines: [['  fibre INSTALL ', 1, 100], ['Brand new thing', 1, 50]] });
    const preview = dataOf<{ lines: Array<{ description: string; accountId: string; accountSource: string }> }>(await inbox.get(U.b, co.B, second.id));
    expect(preview.lines.map((l) => [l.accountId, l.accountSource])).toEqual([[acc.bExp2, 'last_used'], [acc.bExp1, 'default']]);
    expect((await accept(second.id)).state.statusCode).toBe(200);
    const accounts = (await pool.query(
      `SELECT sii.description, sii.gl_account_id FROM supplier_invoice_items sii JOIN supplier_invoices si ON si.id = sii.supplier_invoice_id
        WHERE si.company_id = $1 AND si.invoice_number = $2`, [co.B, second.inv.number])).rows;
    expect(Object.fromEntries(accounts.map((r) => [String(r.description).trim().toLowerCase(), r.gl_account_id]))).toEqual({ 'fibre install': acc.bExp2, 'brand new thing': acc.bExp1 });
  });

  it('an account that is not B\'s, a header account, and an inactive account are refused, and nothing is written', async () => {
    const { id } = await sentInvoice();
    for (const bad of [acct.aExpense, acc.bExpHeader]) {
      const res = await accept(id, { lineAccounts: { 0: bad } });
      expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(400);
      expect(await bills()).toHaveLength(0);
      expect((await messageRow(id)).status).toBe('pending');
      expect(await links()).toHaveLength(0);
    }
    await pool.query('UPDATE gl_accounts SET is_active = false WHERE id = $1', [acc.bExp2]);
    try {
      expect((await accept(id, { lineAccounts: { 0: acc.bExp2 } })).state.statusCode).toBe(400);
      expect(await bills()).toHaveLength(0);
    } finally {
      await pool.query('UPDATE gl_accounts SET is_active = true WHERE id = $1', [acc.bExp2]);
    }
  });

  it('a request body with an unknown field, a non-UUID account or a bad line key is a 400', async () => {
    const { id } = await sentInvoice();
    for (const body of [{ x: 1 }, { accountId: 'nope' }, { lineAccounts: { a: acc.bExp1 } }, { lineAccounts: { 0: 'nope' } }, 'text']) {
      expect((await accept(id, body)).state.statusCode).toBe(400);
    }
    expect(await bills()).toHaveLength(0);
  });
});

describe('the dialog\'s account list', () => {
  it('holds every suggested account, even one of a type the list leaves out (a default that is not an expense or asset account)', async () => {
    // B's loan account is a LIABILITY account: usable for a bill line, but not in the expense / asset pick-list
    await asAppUser(pool, U.b, co.B, (q) => q.query('UPDATE intercompany_connection_sides SET default_expense_account_id = $2 WHERE company_id = $1', [co.B, acct.bLoan]), true);
    const { id } = await sentInvoice();
    const preview = dataOf<{ accounts: Array<{ id: string }>; lines: Array<{ accountId: string }> }>(await inbox.get(U.b, co.B, id));
    expect(preview.lines.map((l) => l.accountId)).toEqual([acct.bLoan, acct.bLoan]);
    expect(preview.accounts.map((a) => a.id)).toContain(acct.bLoan);
    expect(new Set(preview.accounts.map((a) => a.id)).size).toBe(preview.accounts.length); // listed once
  });
});

describe('atomicity and the group re-check', () => {
  it('a sender document that is already in another link: the accept is refused AFTER the draft was built, and the draft goes with it', async () => {
    const { inv, id } = await sentInvoice();
    const [low] = pairOf(co.A, co.B);
    const aIsLow = low === co.A;
    // A manual pairing, already confirmed, that holds the sender's invoice: planted with the links guard off (the slots trigger still runs).
    await withoutTrigger(pool, 'intercompany_document_links', 'trg_intercompany_links_guard', (q) => q.query(
      `INSERT INTO intercompany_document_links(connection_id, company_a_id, doc_a_type, doc_a_id, company_b_id, doc_b_type, doc_b_id, origin, status, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'manual_pairing', 'active', $8)`,
      aIsLow ? [conn, co.A, 'customer_invoice', inv.id, co.B, 'supplier_invoice', crypto.randomUUID(), U.ab]
             : [conn, co.B, 'supplier_invoice', crypto.randomUUID(), co.A, 'customer_invoice', inv.id, U.ab]));
    const res = await accept(id);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(409);
    expect(errorOf(res)).toMatch(/already linked/);
    expect(await bills()).toHaveLength(0);
    expect(await count(pool, 'SELECT count(*) AS n FROM supplier_invoice_items WHERE supplier_invoice_id NOT IN (SELECT id FROM supplier_invoices)')).toBe(0);
    expect((await messageRow(id)).status).toBe('pending');
  });

  it('after a refusal that came AFTER the draft was built, the same transaction is still usable and holds no draft (the accept is one savepoint)', async () => {
    const { inv, id } = await sentInvoice();
    const [low] = pairOf(co.A, co.B);
    await withoutTrigger(pool, 'intercompany_document_links', 'trg_intercompany_links_guard', (q) => q.query(
      `INSERT INTO intercompany_document_links(connection_id, company_a_id, doc_a_type, doc_a_id, company_b_id, doc_b_type, doc_b_id, origin, status, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'manual_pairing', 'active', $8)`,
      low === co.A ? [conn, co.A, 'customer_invoice', inv.id, co.B, 'supplier_invoice', crypto.randomUUID(), U.ab]
                   : [conn, co.B, 'supplier_invoice', crypto.randomUUID(), co.A, 'customer_invoice', inv.id, U.ab]));
    const inside = await asService(pool, U.b, co.B, async (q) => {
      await expect(acceptMessage(U.b, co.B, id)).rejects.toMatchObject({ status: 409 });
      return (await q.query('SELECT count(*)::int AS n FROM supplier_invoices WHERE company_id = $1', [co.B])).rows[0].n as number;
    });
    expect(inside).toBe(0);
  });

  it('companies that no longer share a group (the connection row still says active): accept is refused and writes nothing', async () => {
    const { id } = await sentInvoice();
    await withoutTrigger(pool, 'company_group_members', 'trg_intercompany_group_membership', (q) =>
      q.query('UPDATE company_group_members SET left_date = CURRENT_DATE WHERE group_id = $1 AND company_id = $2', [co.G, co.B]));
    try {
      const res = await accept(id);
      expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(409);
      expect(errorOf(res)).toMatch(/no longer in one group/);
      expect(await bills()).toHaveLength(0);
      expect((await messageRow(id)).status).toBe('pending');
    } finally {
      await pool.query('UPDATE company_group_members SET left_date = NULL WHERE group_id = $1', [co.G]);
    }
  });
});

