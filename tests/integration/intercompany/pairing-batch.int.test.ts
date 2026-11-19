/**
 * Intercompany P3: a pairing request is all or none even when the DATABASE refuses part of it (the screen's own checks passed), and
 * a document that is in a live pairing is in one only.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { asAppUser, cleanup, co, party, plantConnection, plantSide, setup, U } from './intercompany.helpers';
import { dataOf } from '../r035-pr2.helpers';
import type { PairingView } from '../../../src/modules/accounting/services/intercompany/pairingTypes';
import { pairingApi as api, pairingConnection, plantCustomerInvoice, plantSupplierInvoice } from './pairing.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
let id = '';

beforeAll(() => setup(pool), 60000);
afterAll(() => cleanup(pool));
beforeEach(async () => { id = await pairingConnection(pool); });

const live = () => pool.query("SELECT doc_a_id, doc_b_id, status FROM intercompany_document_links WHERE connection_id = $1 AND status <> 'unlinked'", [id]).then((r) => r.rows);

describe('all or none', () => {
  it('a database refusal on the second pair of a batch removes the first pair too', async () => {
    const pairs = [];
    for (const n of ['B-1', 'B-2']) {
      pairs.push({
        mineId: await plantCustomerInvoice(pool, co.A, party.aCustomer, { number: n }),
        theirsId: await plantSupplierInvoice(pool, co.B, party.bSupplier, { number: n }),
      });
    }
    // The screen offers both; a trigger stands in for a race the database loses at the second insert.
    await pool.query(`
      CREATE OR REPLACE FUNCTION public.ic_test_refuse_second() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.doc_a_id::text = '${pairs[1]!.mineId}' OR NEW.doc_b_id::text = '${pairs[1]!.mineId}' THEN
          RAISE EXCEPTION 'a document is in one active or pending link at a time, whatever the connection' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END $$`);
    await pool.query('CREATE TRIGGER ic_test_refuse_second BEFORE INSERT ON intercompany_document_links FOR EACH ROW EXECUTE FUNCTION public.ic_test_refuse_second()');
    try {
      const res = await api.pair(U.a, co.A, id, pairs);
      expect(res.state.statusCode).toBe(409);
      expect(await live()).toEqual([]);
    } finally {
      await pool.query('DROP TRIGGER IF EXISTS ic_test_refuse_second ON intercompany_document_links');
      await pool.query('DROP FUNCTION IF EXISTS public.ic_test_refuse_second()');
    }
    // and with the refusal gone the same request goes through whole
    expect((await api.pair(U.a, co.A, id, pairs)).state.statusCode).toBe(201);
    expect(await live()).toHaveLength(2);
  });
});

describe('a document is in one live pairing', () => {
  it('once paired (even only proposed) neither document is offered again, and a request naming one is refused', async () => {
    const mine = await plantCustomerInvoice(pool, co.A, party.aCustomer, { number: 'U-1' });
    const theirs = await plantSupplierInvoice(pool, co.B, party.bSupplier, { number: 'U-1' });
    const otherBill = await plantSupplierInvoice(pool, co.B, party.bSupplier, { number: 'U-2' });
    const otherInvoice = await plantCustomerInvoice(pool, co.A, party.aCustomer, { number: 'U-2' });
    expect((await api.pair(U.a, co.A, id, [{ mineId: mine, theirsId: theirs }])).state.statusCode).toBe(201);
    expect((await api.pair(U.a, co.A, id, [{ mineId: mine, theirsId: otherBill }])).state.statusCode).toBe(409);
    expect((await api.pair(U.a, co.A, id, [{ mineId: otherInvoice, theirsId: theirs }])).state.statusCode).toBe(409);
    expect(await live()).toHaveLength(1);
  });
});

describe('a document paired on one connection is not offered on its successor', () => {
  it('after the first connection is revoked its active pairing still holds both documents on the new one', async () => {
    const mine = await plantCustomerInvoice(pool, co.A, party.aCustomer, { number: 'S-1' });
    const theirs = await plantSupplierInvoice(pool, co.B, party.bSupplier, { number: 'S-1' });
    expect((await api.pair(U.ab, co.A, id, [{ mineId: mine, theirsId: theirs }])).state.statusCode).toBe(201);
    await asAppUser(pool, U.ab, co.A, (q) => q.query("UPDATE intercompany_connections SET status = 'revoked' WHERE id = $1", [id]), true);

    const second = await plantConnection(pool, co.A, co.B);
    await plantSide(pool, second, co.A, co.B, { customer_id: party.aCustomer, supplier_id: party.aSupplier });
    await plantSide(pool, second, co.B, co.A, { customer_id: party.bCustomer, supplier_id: party.bSupplier });
    await asAppUser(pool, U.ab, co.A, (q) => q.query('UPDATE intercompany_connections SET cutover_date = $2 WHERE id = $1', [second, '2026-10-01']), true);
    const v = dataOf<PairingView>(await api.view(U.a, co.A, second));
    expect(v.blocked).toBeNull();
    expect(v.matches.suggestions).toEqual([]);
    expect(v.matches.unmatchedMine).toEqual([]);
    expect(v.matches.unmatchedTheirs).toEqual([]);
    expect((await api.pair(U.a, co.A, second, [{ mineId: mine, theirsId: theirs }])).state.statusCode).toBe(409);
  });
});
