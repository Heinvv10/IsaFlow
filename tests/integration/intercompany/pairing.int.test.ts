/**
 * Intercompany P3 (pre-cut-over pairing) through the real routes, as app_user, across three tenants: A and B are connected, C is a
 * stranger. Suggestions and exceptions, pending / active pairings, the anti-squatting rule, the loan difference, and the proof that a
 * pairing writes no ledger row.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { dataOf, messageOf } from '../r035-pr2.helpers';
import { acct, asAppUser, cleanup, co, count, party, setup, U } from './intercompany.helpers';
import {
  dropJournals, pairingApi as api, pairingConnection, plantBalancingAccount, plantCustomerInvoice, plantJournal, plantSupplierInvoice,
} from './pairing.helpers';
import type { PairingResult, PairingView } from '../../../src/modules/accounting/services/intercompany/pairingTypes';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
let id = '';

beforeAll(() => setup(pool), 60000);
afterAll(async () => { await dropJournals(pool); await cleanup(pool); });
beforeEach(async () => { id = await pairingConnection(pool); });

const view = async (user: string, company: string, direction = 'ar') => dataOf<PairingView>(await api.view(user, company, id, direction));
const numbers = (docs: { number: string }[]) => docs.map((d) => d.number).sort();
/** A's invoice and B's bill under one number and total: the common case. */
async function invoicePair(number: string, total = 1150) {
  return {
    mine: await plantCustomerInvoice(pool, co.A, party.aCustomer, { number, total }),
    theirs: await plantSupplierInvoice(pool, co.B, party.bSupplier, { number, total }),
  };
}
const links = (company: string) => pool.query(
  "SELECT id, status, confirmed_by_a, confirmed_by_b FROM intercompany_document_links WHERE company_a_id = $1 OR company_b_id = $1 ORDER BY created_at", [company]).then((r) => r.rows);

describe('suggestions and exceptions', () => {
  it('sorts A\'s open invoices and B\'s open bills into suggestions, amount mismatches and unmatched documents', async () => {
    await invoicePair('INV-1');
    await plantCustomerInvoice(pool, co.A, party.aCustomer, { number: 'INV-2', total: 500 });
    await plantSupplierInvoice(pool, co.B, party.bSupplier, { number: 'INV-2', total: 550 });
    await plantCustomerInvoice(pool, co.A, party.aCustomer, { number: 'INV-3', total: 900 });
    await plantSupplierInvoice(pool, co.B, party.bSupplier, { number: 'INV-9', total: 100 });
    await plantCustomerInvoice(pool, co.A, party.aCustomer, { number: 'AFTER', date: '2026-10-01' });          // on the cut-over: not pre-cut-over
    await plantCustomerInvoice(pool, co.A, party.aCustomer, { number: 'PAID', paid: 1150, status: 'paid' });  // settled: not open

    const v = await view(U.a, co.A);
    expect(v).toMatchObject({ blocked: null, direction: 'ar', cutoverDate: '2026-10-01', confirmsBoth: false });
    expect(numbers(v.matches.suggestions.map((s) => s.mine))).toEqual(['INV-1']);
    expect(v.matches.mismatches.map((m) => [m.mine.number, m.mine.total, m.theirs.total])).toEqual([['INV-2', 500, 550]]);
    expect(numbers(v.matches.unmatchedMine)).toEqual(['INV-3']);
    expect(numbers(v.matches.unmatchedTheirs)).toEqual(['INV-9']);
    expect(v.truncated).toBe(false);
  });

  it('the other direction is B\'s open invoices against A\'s open bills', async () => {
    const bInvoice = await plantCustomerInvoice(pool, co.B, party.bCustomer, { number: 'B-1', total: 200 });
    const aBill = await plantSupplierInvoice(pool, co.A, party.aSupplier, { number: 'B-1', total: 200 });
    const v = await view(U.a, co.A, 'ap');
    expect(v.matches.suggestions.map((s) => [s.mine.id, s.theirs.id])).toEqual([[aBill, bInvoice]]);
  });

  it('lists a foreign-currency document as unsupported and never proposes it', async () => {
    await pool.query('UPDATE companies SET fx_documents_enabled = true WHERE id = ANY($1)', [[co.A, co.B]]);
    try {
      await plantCustomerInvoice(pool, co.A, party.aCustomer, { number: 'F-1', currency: 'USD' });
      await plantSupplierInvoice(pool, co.B, party.bSupplier, { number: 'F-1', currency: 'USD' });
      const v = await view(U.a, co.A);
      expect(v.matches.suggestions).toEqual([]);
      expect(v.matches.unsupported).toHaveLength(2);
    } finally {
      await pool.query('UPDATE companies SET fx_documents_enabled = false WHERE id = ANY($1)', [[co.A, co.B]]);
    }
  });

  it('is blocked, with the reason, when there is no cut-over date, no linked customer, or the user cannot write', async () => {
    await invoicePair('INV-1');
    expect((await view(U.va, co.A)).blocked).toBe('no_write_access');
    expect((await view(U.va, co.A)).matches.suggestions).toEqual([]);
    await asAppUser(pool, U.a, co.A, (q) => q.query('UPDATE intercompany_connection_sides SET customer_id = NULL WHERE connection_id = $1 AND company_id = $2', [id, co.A]), true);
    expect((await view(U.a, co.A)).blocked).toBe('no_party');
    id = await pairingConnection(pool, undefined, null);
    expect((await view(U.a, co.A)).blocked).toBe('no_cutover');
  });
});

describe('recording pairings (no postings)', () => {
  it('a company with a write role only in its own company proposes; the pairing waits for the partner, then the partner confirms', async () => {
    const { mine, theirs } = await invoicePair('INV-1');
    const before = { je: await count(pool, 'SELECT COUNT(*)::int AS n FROM gl_journal_entries WHERE company_id = ANY($1)', [[co.A, co.B]]),
                     jl: await count(pool, 'SELECT COUNT(*)::int AS n FROM gl_journal_lines WHERE company_id = ANY($1)', [[co.A, co.B]]) };

    const res = await api.pair(U.a, co.A, id, [{ mineId: mine, theirsId: theirs }]);
    expect(res.state.statusCode).toBe(201);
    expect(dataOf<PairingResult>(res)).toEqual({ created: 1, active: 0 });
    const rows = await links(co.A);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'pending_confirmation' });

    // A sees it as waiting for the partner; the documents are no longer offered
    const vA = await view(U.a, co.A);
    expect(vA.links.map((l) => [l.status, l.awaiting, l.mine?.number, l.theirs?.number])).toEqual([['pending_confirmation', 'partner', 'INV-1', 'INV-1']]);
    expect(vA.matches.suggestions).toEqual([]);
    expect(vA.matches.unmatchedTheirs).toEqual([]);
    // B sees A's proposal waiting for B, with both documents' numbers (B's own, A's through the definer)
    const vB = await view(U.b, co.B, 'ap');
    expect(vB.links.map((l) => [l.status, l.awaiting, l.mine?.number, l.theirs?.number])).toEqual([['pending_confirmation', 'me', 'INV-1', 'INV-1']]);

    const done = await api.confirm(U.b, co.B, id, vB.links[0]!.id);
    expect(done.state.statusCode).toBe(200);
    expect((await links(co.A))[0]).toMatchObject({ status: 'active' });
    expect((await view(U.a, co.A)).links.map((l) => [l.status, l.awaiting, l.theirs?.number])).toEqual([['active', null, 'INV-1']]);

    expect(await count(pool, 'SELECT COUNT(*)::int AS n FROM gl_journal_entries WHERE company_id = ANY($1)', [[co.A, co.B]])).toBe(before.je);
    expect(await count(pool, 'SELECT COUNT(*)::int AS n FROM gl_journal_lines WHERE company_id = ANY($1)', [[co.A, co.B]])).toBe(before.jl);
  });

  it('a user who can write in BOTH companies of the group confirms both sides at once', async () => {
    const { mine, theirs } = await invoicePair('INV-1');
    expect((await view(U.ab, co.A)).confirmsBoth).toBe(true);
    const res = await api.pair(U.ab, co.A, id, [{ mineId: mine, theirsId: theirs }]);
    expect(dataOf<PairingResult>(res)).toEqual({ created: 1, active: 1 });
    expect((await links(co.A))[0]).toMatchObject({ status: 'active', confirmed_by_a: expect.any(String), confirmed_by_b: expect.any(String) });
  });

  it('all or none: one pair that is not on offer refuses the whole request and records nothing', async () => {
    const { mine, theirs } = await invoicePair('INV-1');
    const res = await api.pair(U.a, co.A, id, [{ mineId: mine, theirsId: theirs }, { mineId: crypto.randomUUID(), theirsId: crypto.randomUUID() }]);
    expect(res.state.statusCode).toBe(409);
    expect(await links(co.A)).toEqual([]);
  });

  it.each([
    ['a bill of a third company', async () => plantSupplierInvoice(pool, co.C, party.bSupplier, { number: 'INV-1' })],
    ['one of A\'s own bills', async () => plantSupplierInvoice(pool, co.A, party.aSupplier, { number: 'INV-1' })],
    ['a made-up id', async () => crypto.randomUUID()],
  ])('refuses %s as the partner\'s document', async (_n, make) => {
    const mine = await plantCustomerInvoice(pool, co.A, party.aCustomer, { number: 'INV-1' });
    const res = await api.pair(U.a, co.A, id, [{ mineId: mine, theirsId: await make() }]);
    expect(res.state.statusCode).toBe(409);
    expect(await links(co.A)).toEqual([]);
  });

  it('refuses a document of the wrong company, the wrong customer, or one that is not open, as this company\'s document', async () => {
    const theirs = await plantSupplierInvoice(pool, co.B, party.bSupplier, { number: 'INV-1' });
    const other = crypto.randomUUID();
    await pool.query('INSERT INTO customers(id, company_id, name) VALUES ($1, $2, $3)', [other, co.A, 'IC A other customer']);
    for (const mine of [
      await plantCustomerInvoice(pool, co.B, party.bCustomer, { number: 'INV-1' }),         // B's invoice
      await plantCustomerInvoice(pool, co.A, other, { number: 'INV-2' }),                   // a customer that is not the linked one
      await plantCustomerInvoice(pool, co.A, party.aCustomer, { number: 'INV-3', status: 'draft' }),
    ]) {
      expect((await api.pair(U.a, co.A, id, [{ mineId: mine, theirsId: theirs }])).state.statusCode).toBe(409);
    }
    expect(await links(co.A)).toEqual([]);
  });

  it('a request that is not well formed is a 400 before anything is looked up', async () => {
    for (const body of [[], [{ mineId: 'x', theirsId: 'y' }]]) {
      expect((await api.pair(U.a, co.A, id, body as never)).state.statusCode).toBe(400);
    }
    expect((await api.view(U.a, co.A, id, 'sideways')).state.statusCode).toBe(400);
  });

  it('two requests for the same documents at once: one wins, the other is refused, one link exists', async () => {
    const { mine, theirs } = await invoicePair('INV-1');
    const body = [{ mineId: mine, theirsId: theirs }];
    const results = await Promise.all([api.pair(U.a, co.A, id, body), api.pair(U.ab, co.A, id, body)]);
    expect(results.map((r) => r.state.statusCode).sort()).toEqual([201, 409]);
    expect(await links(co.A)).toHaveLength(1);
  });
});

describe('a pending pairing reserves only the side that is verified (no squatting)', () => {
  it('B proposing A\'s invoice does not stop A pairing it with its real bill; B\'s own pending proposal then cannot be confirmed', async () => {
    const aInvoice = await plantCustomerInvoice(pool, co.A, party.aCustomer, { number: 'INV-1' });
    const bSquat = await plantSupplierInvoice(pool, co.B, party.bSupplier, { number: 'WRONG-1' });
    const bReal = await plantSupplierInvoice(pool, co.B, party.bSupplier, { number: 'INV-1' });
    // B proposes (its own bill, A's invoice)
    const proposed = await api.pair(U.b, co.B, id, [{ mineId: bSquat, theirsId: aInvoice }], 'ap');
    expect(proposed.state.statusCode).toBe(201);
    // A's invoice still holds no slot: A sees it, and pairs it with the real bill, confirmed on both sides
    const vA = await view(U.a, co.A);
    expect(vA.matches.suggestions.map((s) => s.mine.id)).toEqual([aInvoice]);
    expect((await api.pair(U.ab, co.A, id, [{ mineId: aInvoice, theirsId: bReal }])).state.statusCode).toBe(201);
    expect((await view(U.a, co.A)).links.map((l) => l.status).sort()).toEqual(['active', 'pending_confirmation']);
    // now A cannot confirm B's proposal: its invoice is paired
    const proposal = (await view(U.a, co.A)).links.find((l) => l.awaiting === 'me');
    expect(proposal).toMatchObject({ conflict: true });   // listed, but it can only be declined
    const pending = (await links(co.A)).find((l) => l.status === 'pending_confirmation')!;
    const res = await api.confirm(U.a, co.A, id, pending.id);
    expect(res.state.statusCode).toBe(409);
    expect((await links(co.A)).find((l) => l.id === pending.id)).toMatchObject({ status: 'pending_confirmation' });
  });
});

describe('unlinking', () => {
  it('either party can unlink; both documents are offered again; a stranger and a viewer cannot', async () => {
    const { mine, theirs } = await invoicePair('INV-1');
    await api.pair(U.ab, co.A, id, [{ mineId: mine, theirsId: theirs }]);
    const link = (await links(co.A))[0]!.id;
    expect((await api.unlink(U.c, co.C, id, link)).state.statusCode).toBe(404);
    expect((await api.unlink(U.va, co.A, id, link)).state.statusCode).toBe(403);
    expect((await links(co.A))[0]).toMatchObject({ status: 'active' });
    expect((await api.unlink(U.b, co.B, id, link)).state.statusCode).toBe(200);
    expect((await links(co.A))[0]).toMatchObject({ status: 'unlinked' });
    expect((await view(U.a, co.A)).matches.suggestions).toHaveLength(1);
  });

  it('works after the connection is revoked (and no new pairing does)', async () => {
    const { mine, theirs } = await invoicePair('INV-1');
    await api.pair(U.ab, co.A, id, [{ mineId: mine, theirsId: theirs }]);
    const link = (await links(co.A))[0]!.id;
    await pool.query("SELECT set_config('request.jwt.claims', $1, false)", [JSON.stringify({ sub: U.ab })]);
    const { asAppUser } = await import('./intercompany.helpers');
    await asAppUser(pool, U.ab, co.A, (q) => q.query("UPDATE intercompany_connections SET status = 'revoked' WHERE id = $1", [id]), true);
    const v = await view(U.a, co.A);
    expect(v.blocked).toBe('revoked');
    expect(v.links.map((l) => l.status)).toEqual(['active']);
    expect((await api.pair(U.a, co.A, id, [{ mineId: mine, theirsId: theirs }])).state.statusCode).toBe(409);
    expect((await api.unlink(U.a, co.A, id, link)).state.statusCode).toBe(200);
  });
});

describe('tenant isolation', () => {
  it('the third company cannot read, pair, confirm or unlink on the connection, and the connection id leaks nothing', async () => {
    const { mine, theirs } = await invoicePair('INV-1');
    expect((await api.view(U.c, co.C, id)).state.statusCode).toBe(404);
    const res = await api.pair(U.c, co.C, id, [{ mineId: mine, theirsId: theirs }]);
    expect(res.state.statusCode).toBe(404);
    expect(await links(co.A)).toEqual([]);
    await api.pair(U.a, co.A, id, [{ mineId: mine, theirsId: theirs }]);
    const link = (await links(co.A))[0]!.id;
    expect((await api.confirm(U.c, co.C, id, link)).state.statusCode).toBe(404);
    expect((await api.unlink(U.c, co.C, id, link)).state.statusCode).toBe(404);
  });

  it('a user of nothing who forges A or B as the active company reads and writes nothing', async () => {
    const { mine, theirs } = await invoicePair('INV-1');
    for (const company of [co.A, co.B]) {
      const read = await api.view(U.x, company, id);
      expect(read.state.statusCode).toBeGreaterThanOrEqual(400);
      expect(JSON.stringify(read.state.body)).not.toContain('INV-1');
      const write = await api.pair(U.x, company, id, [{ mineId: mine, theirsId: theirs }]);
      expect(write.state.statusCode).toBeGreaterThanOrEqual(400);
    }
    expect(await links(co.A)).toEqual([]);
  });

  it('a member of A acting as A cannot pair by naming B\'s company: the partner is the connection\'s other company only', async () => {
    const aInvoice = await plantCustomerInvoice(pool, co.A, party.aCustomer, { number: 'INV-1' });
    const cBill = await plantSupplierInvoice(pool, co.C, party.bSupplier, { number: 'INV-1' });
    expect((await api.pair(U.a, co.A, id, [{ mineId: aInvoice, theirsId: cBill }])).state.statusCode).toBe(409);
    expect(messageOf(await api.pair(U.a, co.A, id, [{ mineId: aInvoice, theirsId: cBill }]))).toMatch(/no longer available/);
  });
});

describe('the loan-balance difference', () => {
  let aOther = '';
  let bOther = '';
  beforeEach(async () => {
    aOther ||= await plantBalancingAccount(pool, co.A);
    bOther ||= await plantBalancingAccount(pool, co.B);
    id = await pairingConnection(pool, { a: acct.aLoan, b: acct.bLoan });
  });

  it('is each company\'s loan account before the cut-over, net debit, and their sum: nil when one is the other\'s mirror', async () => {
    await plantJournal(pool, co.A, '2026-09-10', acct.aLoan, aOther, 5000, 0);
    await plantJournal(pool, co.B, '2026-09-10', acct.bLoan, bOther, 0, 5000);
    await plantJournal(pool, co.A, '2026-10-01', acct.aLoan, aOther, 777, 0);     // on the cut-over: not counted
    await plantJournal(pool, co.A, '2026-09-30', acct.aLoan, aOther, 999, 0, 'posted', 'year_end');   // the year-end close: not counted
    expect((await view(U.a, co.A)).loan).toEqual({ mine: 5000, theirs: -5000, difference: 0, asAt: '2026-09-30' });
    expect((await view(U.b, co.B)).loan).toEqual({ mine: -5000, theirs: 5000, difference: 0, asAt: '2026-09-30' });
    await plantJournal(pool, co.A, '2026-09-11', acct.aLoan, aOther, 250, 0);
    expect((await view(U.a, co.A)).loan?.difference).toBe(250);
  });

  it('shows only this company\'s figure while the partner has set no loan account, and nothing while this company has set none', async () => {
    await plantJournal(pool, co.A, '2026-09-10', acct.aLoan, aOther, 300, 0);
    await pool.query('UPDATE intercompany_connection_sides SET loan_account_id = NULL WHERE connection_id = $1 AND company_id = $2', [id, co.B]);
    expect((await view(U.a, co.A)).loan).toEqual({ mine: 300, theirs: null, difference: null, asAt: '2026-09-30' });
    expect((await view(U.b, co.B)).loan).toBeNull();
  });

  it('the partner\'s figure is withheld from a viewer', async () => {
    await plantJournal(pool, co.B, '2026-09-10', acct.bLoan, bOther, 0, 5000);
    expect((await view(U.va, co.A)).loan?.theirs ?? null).toBeNull();
  });
});
