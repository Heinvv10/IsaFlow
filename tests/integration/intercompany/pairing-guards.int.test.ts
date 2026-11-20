/**
 * Intercompany P3: only SUGGESTED pairs are recorded (never a mismatch or an unmatched document), the screen touches only its own
 * links (never a P2 mirror link or a credit-note link), and a partner's proposal is shown under Pairings, not as an exception.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { dataOf } from '../r035-pr2.helpers';
import { asAppUser, cleanup, co, party, plantDocument, setup, U } from './intercompany.helpers';
import { LINK, acceptedMessage, low, mirrorArgs, ownerOf, pairing } from './links.helpers';
import { pairingApi as api, pairingConnection, plantCustomerInvoice, plantSupplierInvoice, wipeDocuments } from './pairing.helpers';
import type { PairingView } from '../../../src/modules/accounting/services/intercompany/pairingTypes';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
let id = '';

beforeAll(() => setup(pool), 60000);
afterAll(async () => { await wipeDocuments(pool); await cleanup(pool); });
beforeEach(async () => { id = await pairingConnection(pool); });

const live = () => pool.query("SELECT id, status, origin FROM intercompany_document_links WHERE connection_id = $1 AND status <> 'unlinked' ORDER BY created_at", [id]).then((r) => r.rows);
const view = async (user: string, company: string, direction = 'ar') => dataOf<PairingView>(await api.view(user, company, id, direction));

describe('only suggested pairs are recorded', () => {
  it('a pair with the same number and another total, or two documents with different numbers, is refused whole', async () => {
    const mine = await plantCustomerInvoice(pool, co.A, party.aCustomer, { number: 'G-1', total: 500 });
    const mismatch = await plantSupplierInvoice(pool, co.B, party.bSupplier, { number: 'G-1', total: 550 });
    const lone = await plantCustomerInvoice(pool, co.A, party.aCustomer, { number: 'G-2' });
    const other = await plantSupplierInvoice(pool, co.B, party.bSupplier, { number: 'G-3' });
    const good = { mineId: await plantCustomerInvoice(pool, co.A, party.aCustomer, { number: 'G-4' }), theirsId: await plantSupplierInvoice(pool, co.B, party.bSupplier, { number: 'G-4' }) };
    const v = await view(U.a, co.A);
    expect(v.matches.mismatches).toHaveLength(1);
    for (const bad of [{ mineId: mine, theirsId: mismatch }, { mineId: lone, theirsId: other }, { mineId: lone, theirsId: mismatch }]) {
      expect((await api.pair(U.ab, co.A, id, [good, bad])).state.statusCode).toBe(409);
      expect(await live()).toEqual([]);
    }
    expect((await api.pair(U.ab, co.A, id, [good])).state.statusCode).toBe(201);
  });
});

describe('the screen touches only its own links', () => {
  it('a mirror link (P2) and a credit-note link are neither confirmed nor unlinked here, and are not listed', async () => {
    const { m, src, tgt } = await acceptedMessage(pool, id, co.A, co.B);
    const mirror = await asAppUser(pool, ownerOf(co.B), co.B, async (q) => (await q.query(LINK, mirrorArgs(id, co.A, m, src, tgt))).rows[0].id as string, true);
    const credits = { a: await plantDocument(pool, 'credit_note', co.A, U.ab, 'customer'), b: await plantDocument(pool, 'credit_note', co.B, U.ab, 'supplier') };
    const lowFirst = low() === co.A ? [credits.a, credits.b] : [credits.b, credits.a];
    const credit = await asAppUser(pool, ownerOf(low()), low(), async (q) => (await q.query(LINK, pairing(id, lowFirst[0]!, lowFirst[1]!, 'credit_note', 'credit_note'))).rows[0].id as string, true);

    for (const [user, company] of [[U.a, co.A], [U.b, co.B]] as const) {
      for (const link of [mirror, credit]) {
        expect((await api.confirm(user, company, id, link)).state.statusCode).toBe(404);
        expect((await api.unlink(user, company, id, link)).state.statusCode).toBe(404);
      }
      expect((await view(user, company)).links).toEqual([]);
      expect((await view(user, company, 'ap')).links).toEqual([]);
    }
    expect((await live()).map((r) => r.status).sort()).toEqual(['active', 'pending_confirmation']);
  });
});

describe('a partner\'s proposal', () => {
  it('is shown under Pairings only: its document is not also an exception on this side', async () => {
    const aInvoice = await plantCustomerInvoice(pool, co.A, party.aCustomer, { number: 'P-1' });
    const bBill = await plantSupplierInvoice(pool, co.B, party.bSupplier, { number: 'P-1' });
    const lonely = await plantCustomerInvoice(pool, co.A, party.aCustomer, { number: 'P-2' });
    const args = low() === co.B ? pairing(id, bBill, aInvoice, 'supplier_invoice', 'customer_invoice') : pairing(id, aInvoice, bBill);
    await asAppUser(pool, U.b, co.B, (q) => q.query(LINK, args), true);
    const v = await view(U.a, co.A);
    expect(v.links.map((l) => [l.awaiting, l.mine?.id])).toEqual([['me', aInvoice]]);
    expect(v.matches.unmatchedMine.map((d) => d.id)).toEqual([lonely]);
    expect(v.matches.suggestions).toEqual([]);
  });
});
