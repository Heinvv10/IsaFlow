/**
 * Intercompany P3 (migration 1012): the two definer functions that give a company the counterparty's side of a pairing, and nothing
 * else: intercompany_pairing_partner_documents (number, date, totals of the partner's OPEN, pre-cut-over documents of the party it
 * linked on the connection) and intercompany_pairing_partner_loan_balance (one number). Run as app_user, across three tenants.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import {
  acct, asAppUser, cleanup, co, party, plantConnection, plantSide, setup, U, wipeConnections,
} from './intercompany.helpers';
import { dropJournals, plantBalancingAccount, plantCustomerInvoice, plantJournal, plantSupplierInvoice, wipeDocuments } from './pairing.helpers';
import { LINK, low, pairing } from './links.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
let id = '';

beforeAll(() => setup(pool), 60000);
afterAll(async () => { await dropJournals(pool); await cleanup(pool); });

async function setCutover(date: string | null, connection = id) {
  await asAppUser(pool, U.ab, co.A, (q) => q.query('UPDATE intercompany_connections SET cutover_date = $2 WHERE id = $1', [connection, date]), true);
}
/** B's own side, edited as B's owner does (the guard runs). */
const setBSide = (column: 'supplier_id' | 'loan_account_id', value: string | null) => asAppUser(pool, U.b, co.B, (q) => q.query(
  `UPDATE intercompany_connection_sides SET ${column} = $3 WHERE connection_id = $1 AND company_id = $2`, [id, co.B, value]), true);
const sides = async (over: { a?: Record<string, unknown>; b?: Record<string, unknown> } = {}) => {
  await plantSide(pool, id, co.A, co.B, { customer_id: party.aCustomer, supplier_id: party.aSupplier, ...over.a });
  await plantSide(pool, id, co.B, co.A, { customer_id: party.bCustomer, supplier_id: party.bSupplier, ...over.b });
};

beforeEach(async () => {
  await wipeConnections(pool);
  await wipeDocuments(pool);
  id = await plantConnection(pool, co.A, co.B);
  await sides();
  await setCutover('2026-10-01');
});

const DOCS = 'SELECT * FROM public.intercompany_pairing_partner_documents($1, $2)';
const docs = (user: string, company: string, type: string, connection = id) =>
  asAppUser(pool, user, company, async (q) => (await q.query(DOCS, [connection, type])).rows);

describe('intercompany_pairing_partner_documents', () => {
  it('gives A the open, pre-cut-over bills B holds from the supplier it linked, with number, date, total and open amount only', async () => {
    const bill = await plantSupplierInvoice(pool, co.B, party.bSupplier, { number: 'INV-100', date: '2026-09-30', total: 1150, paid: 150 });
    const rows = await docs(U.a, co.A, 'supplier_invoice');
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0]).sort()).toEqual(['currency_code', 'doc_date', 'doc_id', 'doc_number', 'doc_type', 'link_id', 'open_amount', 'total_amount']);
    expect(rows[0]).toMatchObject({ doc_type: 'supplier_invoice', doc_id: bill, doc_number: 'INV-100', link_id: null, currency_code: 'ZAR' });
    expect(Number(rows[0].total_amount)).toBe(1150);
    expect(Number(rows[0].open_amount)).toBe(1000);
  });

  it('is the same for the other direction: B reads A\'s open customer invoices for the customer A linked', async () => {
    const inv = await plantCustomerInvoice(pool, co.A, party.aCustomer, { number: 'INV-7', date: '2026-08-01' });
    const rows = await docs(U.b, co.B, 'customer_invoice');
    expect(rows.map((r) => r.doc_id)).toEqual([inv]);
  });

  it.each([
    ['a draft', { status: 'draft' }], ['pending approval', { status: 'pending_approval' }], ['a cancelled one', { status: 'cancelled' }],
    ['a fully paid one', { paid: 1150, status: 'paid' }], ['one dated ON the cut-over date', { date: '2026-10-01' }],
    ['one dated after it', { date: '2026-11-01' }], ['a deleted one', { deleted: true }],
  ])('leaves out %s', async (_n, over) => {
    await plantSupplierInvoice(pool, co.B, party.bSupplier, over);
    expect(await docs(U.a, co.A, 'supplier_invoice')).toEqual([]);
  });

  it('carries a foreign-currency document with its currency, so the caller can refuse it', async () => {
    await pool.query('UPDATE companies SET fx_documents_enabled = true WHERE id = $1', [co.B]);
    try {
      await plantSupplierInvoice(pool, co.B, party.bSupplier, { currency: 'USD' });
      expect((await docs(U.a, co.A, 'supplier_invoice')).map((r) => r.currency_code)).toEqual(['USD']);
    } finally {
      await pool.query('UPDATE companies SET fx_documents_enabled = false WHERE id = $1', [co.B]);
    }
  });

  it('reads only the party the partner linked on THIS connection, in the partner\'s own company', async () => {
    const other = crypto.randomUUID();
    await pool.query('INSERT INTO suppliers(id, company_id, name) VALUES ($1, $2, $3)', [other, co.B, 'IC B other supplier']);
    await plantSupplierInvoice(pool, co.B, other);
    await plantSupplierInvoice(pool, co.A, party.aSupplier);      // A's own bill is not B's
    await plantSupplierInvoice(pool, co.C, party.bSupplier);      // a third company's bill, even naming B's supplier id
    expect(await docs(U.a, co.A, 'supplier_invoice')).toEqual([]);
    // the partner has linked nobody: nothing at all
    await setBSide('supplier_id', null);
    await plantSupplierInvoice(pool, co.B, party.bSupplier);
    expect(await docs(U.a, co.A, 'supplier_invoice')).toEqual([]);
  });

  it('answers nothing without a cut-over date, on a revoked connection, or for an unknown type', async () => {
    await plantSupplierInvoice(pool, co.B, party.bSupplier);
    expect(await docs(U.a, co.A, 'credit_note')).toEqual([]);
    expect(await docs(U.a, co.A, 'supplier_invoice')).toHaveLength(1);
    await setCutover(null);
    expect(await docs(U.a, co.A, 'supplier_invoice')).toEqual([]);
    await setCutover('2026-10-01');
    await asAppUser(pool, U.a, co.A, (q) => q.query("UPDATE intercompany_connections SET status = 'revoked' WHERE id = $1", [id]), true);
    expect(await docs(U.a, co.A, 'supplier_invoice')).toEqual([]);
  });

  it.each([
    ['the third company', () => [U.c, co.C]], ['a user of nothing, company forged to A', () => [U.x, co.A]],
    ['a user of nothing, company forged to B', () => [U.x, co.B]], ['a member of A forging B', () => [U.a, co.B]],
    ['a viewer of A', () => [U.va, co.A]], ['the owner of A who only views B, acting as B', () => [U.avb, co.B]],
  ])('answers nothing to %s', async (_n, who) => {
    await plantSupplierInvoice(pool, co.B, party.bSupplier);
    const [user, company] = who();
    expect(await docs(user, company, 'supplier_invoice')).toEqual([]);
    expect(await docs(user, company, 'customer_invoice')).toEqual([]);
  });

  it('shows a document held by a link of this connection with that link, and hides one held by a link of another connection', async () => {
    const mine = await plantCustomerInvoice(pool, co.A, party.aCustomer, { number: 'X-1' });
    const bill = await plantSupplierInvoice(pool, co.B, party.bSupplier, { number: 'X-1' });
    const args = low() === co.A ? pairing(id, mine, bill) : pairing(id, bill, mine, 'supplier_invoice', 'customer_invoice');
    const link = await asAppUser(pool, U.a, co.A, async (q) => (await q.query(LINK, args)).rows[0].id as string, true);
    // the proposer's side is held; B's bill (the unverified side of a pending pairing) holds nothing and is still offered, with no link
    expect((await docs(U.a, co.A, 'supplier_invoice')).map((r) => [r.doc_id, r.link_id])).toEqual([[bill, null]]);
    const bColumn = low() === co.B ? 'confirmed_by_a' : 'confirmed_by_b';
    await asAppUser(pool, U.b, co.B, (q) => q.query(`UPDATE intercompany_document_links SET ${bColumn} = $2 WHERE id = $1`, [link, U.b]), true);
    expect((await docs(U.a, co.A, 'supplier_invoice')).map((r) => [r.doc_id, r.link_id])).toEqual([[bill, link]]);
    // the connection ends, a new one begins: the old link still holds the bill, so the new connection no longer offers it
    await asAppUser(pool, U.ab, co.A, (q) => q.query("UPDATE intercompany_connections SET status = 'revoked' WHERE id = $1", [id]), true);
    const second = await plantConnection(pool, co.A, co.B);
    await asAppUser(pool, U.ab, co.A, (q) => q.query('UPDATE intercompany_connections SET cutover_date = $2 WHERE id = $1', [second, '2026-10-01']), true);
    await plantSide(pool, second, co.A, co.B, { customer_id: party.aCustomer, supplier_id: party.aSupplier });
    await plantSide(pool, second, co.B, co.A, { customer_id: party.bCustomer, supplier_id: party.bSupplier });
    expect(await docs(U.a, co.A, 'supplier_invoice', second)).toEqual([]);
  });
});

const LOAN = 'SELECT public.intercompany_pairing_partner_loan_balance($1) AS bal';
const loan = (user: string, company: string, connection = id) =>
  asAppUser(pool, user, company, async (q) => (await q.query(LOAN, [connection])).rows[0].bal as string | null);

describe('intercompany_pairing_partner_loan_balance', () => {
  let bOther = '';
  let aOther = '';
  beforeEach(async () => {
    bOther ||= await plantBalancingAccount(pool, co.B);
    aOther ||= await plantBalancingAccount(pool, co.A);
    await setBSide('loan_account_id', acct.bLoan);
  });

  it('is the partner\'s loan account as net debit over posted journals dated before the cut-over', async () => {
    expect(Number(await loan(U.a, co.A))).toBe(0);
    await plantJournal(pool, co.B, '2026-09-01', acct.bLoan, bOther, 0, 5000);
    await plantJournal(pool, co.B, '2026-09-20', acct.bLoan, bOther, 1200, 0);
    await plantJournal(pool, co.B, '2026-10-01', acct.bLoan, bOther, 0, 9999);               // on the cut-over date: not yet
    await plantJournal(pool, co.B, '2026-09-02', acct.bLoan, bOther, 0, 7777, 'draft');       // not posted
    await plantJournal(pool, co.B, '2026-09-30', acct.bLoan, bOther, 0, 8888, 'posted', 'year_end');   // the year-end close is left out, as in every report
    await plantJournal(pool, co.A, '2026-09-02', acct.aLoan, aOther, 0, 4444);               // A's own books are not B's
    expect(Number(await loan(U.a, co.A))).toBe(-3800);
  });

  it('is null (not zero) when the partner set no loan account, there is no cut-over, or the caller is no writing party', async () => {
    await plantJournal(pool, co.B, '2026-09-01', acct.bLoan, bOther, 0, 5000);
    expect(Number(await loan(U.a, co.A))).toBe(-5000);
    for (const [user, company] of [[U.c, co.C], [U.x, co.A], [U.a, co.B], [U.va, co.A]] as const) expect(await loan(user, company)).toBeNull();
    await setCutover(null);
    expect(await loan(U.a, co.A)).toBeNull();
    await setCutover('2026-10-01');
    await setBSide('loan_account_id', null);
    expect(await loan(U.a, co.A)).toBeNull();
  });

  it('is null once the connection is revoked, although a revoke keeps the loan accounts', async () => {
    await plantJournal(pool, co.B, '2026-09-01', acct.bLoan, bOther, 0, 5000);
    expect(Number(await loan(U.a, co.A))).toBe(-5000);
    await asAppUser(pool, U.a, co.A, (q) => q.query("UPDATE intercompany_connections SET status = 'revoked' WHERE id = $1", [id]), true);
    expect(await loan(U.a, co.A)).toBeNull();
  });
});

describe('the registry and the grants', () => {
  const FNS = ['intercompany_pairing_partner_documents(uuid,text)', 'intercompany_pairing_partner_loan_balance(uuid)'];
  it('lists both definers in app_definer_reviews with their current hash, and no PUBLIC execute', async () => {
    const rows = (await pool.query(
      `SELECT r.signature, r.body_md5 = public.app_definer_hash(p.oid) AS fresh, p.prosecdef,
              has_function_privilege('public', p.oid, 'EXECUTE') AS pub, has_function_privilege('app_user', p.oid, 'EXECUTE') AS app,
              pg_get_userbyid(p.proowner) AS owner
         FROM public.app_definer_reviews r JOIN pg_proc p ON p.oid = ('public.' || r.signature)::regprocedure
        WHERE r.signature = ANY($1) ORDER BY r.signature`, [FNS])).rows;
    expect(rows).toEqual(FNS.map((s) => ({ signature: s, fresh: true, prosecdef: true, pub: false, app: true, owner: 'migration_admin' })).sort((a, b) => a.signature.localeCompare(b.signature)));
  });
});
