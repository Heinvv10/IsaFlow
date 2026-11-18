/**
 * Intercompany (999z) manual pairings: pending until the other party confirms, the inserter's document in its own company,
 * either party may unlink. Trigger-level rules are tested as the table owner so the trigger's own refusal is what is asserted.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import {
  asAppUser, asOwner, cleanup, co, count, outcome, plantConnection, plantDocument, plantMessage, R, setup, U, wipeConnections,
} from './intercompany.helpers';
import { LINK, acceptedMessage, high, linkRow, low, mirrorArgs, pairing } from './links.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
let id = '';

beforeAll(() => setup(pool), 60000);
afterAll(() => cleanup(pool));
beforeEach(async () => {
  await wipeConnections(pool);
  id = await plantConnection(pool, co.A, co.B);
});

const lowUser = () => (low() === co.A ? U.a : U.b);
const highUser = () => (high() === co.A ? U.a : U.b);

describe('a manual pairing', () => {
  it('starts pending with the inserter\'s side confirmed, and names no message', async () => {
    const a = await plantDocument(pool, 'customer_invoice', low());
    const b = await plantDocument(pool, 'supplier_invoice', high());
    const lowUser = low() === co.A ? U.a : U.b;
    const link = await asAppUser(pool, lowUser, low(), async (q) => (await q.query(LINK, pairing(id, a, b))).rows[0].id as string, true);
    expect(await linkRow(pool, link)).toMatchObject({ status: 'pending_confirmation', confirmed_by_a: lowUser, confirmed_by_b: null, confirmed_at: null });
    const m = await plantMessage(pool, id, co.A, co.B);
    await asAppUser(pool, lowUser, low(), async (q) => {
      expect(await outcome(q, LINK, [id, m, low(), 'customer_invoice', crypto.randomUUID(), high(), 'supplier_invoice', crypto.randomUUID(), 'manual_pairing'])).toBe(R.manualNoMessage);
    });
  });

  it.each([
    ['customer_invoice', 'supplier_invoice'], ['supplier_invoice', 'customer_invoice'], ['credit_note', 'credit_note'],
  ] as const)('the inserter\'s own %s must exist in its own company (and %s on the other side is not checked by the inserter)', async (aType, bType) => {
    const a = await plantDocument(pool, aType, low());
    const b = await plantDocument(pool, bType, high());
    const lowUser = low() === co.A ? U.a : U.b;
    await asAppUser(pool, lowUser, low(), async (q) => {
      expect(await outcome(q, LINK, pairing(id, a, b, aType, bType))).toBe('ok');
      expect(await outcome(q, LINK, pairing(id, crypto.randomUUID(), crypto.randomUUID(), aType, bType))).toBe(R.docNotOwn);
      // the other company's document is not "own"
      expect(await outcome(q, LINK, pairing(id, b, crypto.randomUUID(), aType, bType))).toBe(R.docNotOwn);
    });
    // ... even for a user who belongs to BOTH companies, so that RLS shows them the other company's document of the same type
    const foreignA = await plantDocument(pool, aType, high());
    const foreignB = await plantDocument(pool, bType, low());
    await asAppUser(pool, U.ab, low(), async (q) => {
      expect(await outcome(q, LINK, pairing(id, foreignA, b, aType, bType))).toBe(R.docNotOwn);
      expect(await outcome(q, LINK, pairing(id, a, b, aType, bType))).toBe('ok');
    });
    await asAppUser(pool, U.ab, high(), async (q) => {
      expect(await outcome(q, LINK, pairing(id, a, foreignB, aType, bType))).toBe(R.docNotOwn);
      expect(await outcome(q, LINK, pairing(id, a, b, aType, bType))).toBe('ok');
    });
  });

  it('whatever status or confirmations an insert carries (a role with the grant) are replaced: pending, the inserter confirmed, nothing else', async () => {
    const a = await plantDocument(pool, 'customer_invoice', low());
    const b = await plantDocument(pool, 'supplier_invoice', high());
    const link = await asOwner(pool, U.ab, low(), async (q) => (await q.query(
      `INSERT INTO intercompany_document_links(connection_id, company_a_id, doc_a_type, doc_a_id, company_b_id, doc_b_type, doc_b_id, origin, status,
         confirmed_by_a, confirmed_by_b, confirmed_at, unlinked_at, unlinked_by, created_by)
       VALUES ($1, $2, 'customer_invoice', $3, $4, 'supplier_invoice', $5, 'manual_pairing', 'active', 'x', 'y', now(), now(), 'z', 'w') RETURNING id`,
      [id, low(), a, high(), b])).rows[0].id as string, true);
    expect(await linkRow(pool, link)).toMatchObject({ status: 'pending_confirmation', confirmed_by_a: U.ab, confirmed_by_b: null, confirmed_at: null, unlinked_at: null, unlinked_by: null, created_by: U.ab });
  });

  it('is confirmed by the OTHER party, then active; a confirmation is made once, by a user with a write role, as the user', async () => {
    const a = await plantDocument(pool, 'customer_invoice', low());
    const b = await plantDocument(pool, 'supplier_invoice', high());
    const lowUser = low() === co.A ? U.a : U.b;
    const highUser = high() === co.A ? U.a : U.b;
    const link = await asAppUser(pool, lowUser, low(), async (q) => (await q.query(LINK, pairing(id, a, b))).rows[0].id as string, true);
    const confirmB = "UPDATE intercompany_document_links SET confirmed_by_b = 'x' WHERE id = $1";
    // the inserting side cannot confirm the other side (it has no write role there)
    await asAppUser(pool, lowUser, low(), async (q) => { expect(await outcome(q, confirmB, [link])).toBe(R.linkConfirmRole); });
    // a viewer of the other company cannot
    const viewerOfHigh = high() === co.A ? U.va : U.avb;
    await asAppUser(pool, viewerOfHigh, high(), async (q) => { expect(await outcome(q, confirmB, [link])).toBe(R.linkWriteRole); });
    await asAppUser(pool, highUser, high(), async (q) => { expect(await outcome(q, confirmB, [link])).toBe('ok'); }, true);
    expect(await linkRow(pool, link)).toMatchObject({ status: 'active', confirmed_by_a: lowUser, confirmed_by_b: highUser });
    expect((await linkRow(pool, link)).confirmed_at).toBeInstanceOf(Date);
    await asAppUser(pool, lowUser, low(), async (q) => {
      expect(await outcome(q, "UPDATE intercompany_document_links SET confirmed_by_a = 'x' WHERE id = $1", [link])).toBe(R.linkConfirmed);
    });
    await asAppUser(pool, highUser, high(), async (q) => {
      expect(await outcome(q, confirmB, [link])).toBe(R.linkConfirmed);
      expect(await outcome(q, "UPDATE intercompany_document_links SET confirmed_by_b = NULL WHERE id = $1", [link])).toBe(R.linkConfirmed);
    });
  });

  it('a user with a write role in BOTH companies of a group may confirm both sides', async () => {
    const a = await plantDocument(pool, 'customer_invoice', low());
    const b = await plantDocument(pool, 'supplier_invoice', high());
    const link = await asAppUser(pool, U.ab, low(), async (q) => (await q.query(LINK, pairing(id, a, b))).rows[0].id as string, true);
    await asAppUser(pool, U.ab, low(), async (q) => {
      expect(await outcome(q, "UPDATE intercompany_document_links SET confirmed_by_b = 'x' WHERE id = $1", [link])).toBe('ok');
    }, true);
    expect(await linkRow(pool, link)).toMatchObject({ status: 'active', confirmed_by_a: U.ab, confirmed_by_b: U.ab });
  });

  it('the status cannot be set to active by the client; the stamps and everything else cannot change (trigger, as owner)', async () => {
    const a = await plantDocument(pool, 'customer_invoice', low());
    const b = await plantDocument(pool, 'supplier_invoice', high());
    const link = await asAppUser(pool, U.ab, low(), async (q) => (await q.query(LINK, pairing(id, a, b))).rows[0].id as string, true);
    await asOwner(pool, U.ab, low(), async (q) => {
      expect(await outcome(q, "UPDATE intercompany_document_links SET status = 'active' WHERE id = $1", [link])).toBe(R.linkActivation);
      expect(await outcome(q, "UPDATE intercompany_document_links SET origin = 'mirror' WHERE id = $1", [link])).toBe(R.linkImmutable);
      expect(await outcome(q, 'UPDATE intercompany_document_links SET doc_a_id = gen_random_uuid() WHERE id = $1', [link])).toBe(R.linkImmutable);
      expect(await outcome(q, 'UPDATE intercompany_document_links SET doc_b_type = $2 WHERE id = $1', [link, 'credit_note'])).toBe(R.linkImmutable);
      expect(await outcome(q, 'UPDATE intercompany_document_links SET connection_id = gen_random_uuid() WHERE id = $1', [link])).toBe(R.linkImmutable);
      expect(await outcome(q, "UPDATE intercompany_document_links SET created_at = '2001-01-01' WHERE id = $1", [link])).toBe(R.linkImmutable);
      expect(await outcome(q, "UPDATE intercompany_document_links SET confirmed_at = now(), unlinked_by = 'x' WHERE id = $1", [link])).toBe('ok');
    }, true);
    const r = await linkRow(pool, link);
    expect(r).toMatchObject({ status: 'pending_confirmation', confirmed_at: null, unlinked_by: null, unlinked_at: null });
  });

  it('a pairing made from the HIGH company checks its own document on the B side, and the LOW company confirms', async () => {
    const a = await plantDocument(pool, 'customer_invoice', low());
    const b = await plantDocument(pool, 'supplier_invoice', high());
    const highUser = high() === co.A ? U.a : U.b;
    const lowUser = low() === co.A ? U.a : U.b;
    await asAppUser(pool, highUser, high(), async (q) => {
      expect(await outcome(q, LINK, pairing(id, a, crypto.randomUUID()))).toBe(R.docNotOwn);
    });
    const link = await asAppUser(pool, highUser, high(), async (q) => (await q.query(LINK, pairing(id, a, b))).rows[0].id as string, true);
    expect(await linkRow(pool, link)).toMatchObject({ status: 'pending_confirmation', confirmed_by_a: null, confirmed_by_b: highUser });
    const viewerOfLow = low() === co.A ? U.va : U.avb;
    await asAppUser(pool, viewerOfLow, low(), async (q) => {
      expect(await outcome(q, "UPDATE intercompany_document_links SET confirmed_by_a = 'x' WHERE id = $1", [link])).toBe(R.linkWriteRole);
    });
    await asAppUser(pool, lowUser, low(), (q) => q.query("UPDATE intercompany_document_links SET confirmed_by_a = 'x' WHERE id = $1", [link]), true);
    expect(await linkRow(pool, link)).toMatchObject({ status: 'active', confirmed_by_a: lowUser, confirmed_by_b: highUser });
  });

  it('the HIGH company\'s writer cannot confirm the LOW side', async () => {
    const a = await plantDocument(pool, 'customer_invoice', low());
    const b = await plantDocument(pool, 'supplier_invoice', high());
    const link = await asAppUser(pool, highUser(), high(), async (q) => (await q.query(LINK, pairing(id, a, b))).rows[0].id as string, true);
    await asAppUser(pool, highUser(), high(), async (q) => {
      expect(await outcome(q, "UPDATE intercompany_document_links SET confirmed_by_a = 'x' WHERE id = $1", [link])).toBe(R.linkConfirmRole);
    });
    expect((await linkRow(pool, link)).status).toBe('pending_confirmation');
  });

  it('either party may unlink; the stamps are server-side; an unlinked link is final; unlinking changes nothing else', async () => {
    const a = await plantDocument(pool, 'customer_invoice', low());
    const b = await plantDocument(pool, 'supplier_invoice', high());
    const link = await asAppUser(pool, U.ab, low(), async (q) => (await q.query(LINK, pairing(id, a, b))).rows[0].id as string, true);
    const highUser = high() === co.A ? U.a : U.b;
    await asAppUser(pool, highUser, high(), async (q) => {
      expect(await outcome(q, "UPDATE intercompany_document_links SET status = 'unlinked', confirmed_by_b = 'x' WHERE id = $1", [link])).toBe(R.linkUnlinkOnly);
      expect(await outcome(q, "UPDATE intercompany_document_links SET status = 'unlinked' WHERE id = $1", [link])).toBe('ok');
    }, true);
    expect(await linkRow(pool, link)).toMatchObject({ status: 'unlinked', unlinked_by: highUser });
    expect((await linkRow(pool, link)).unlinked_at).toBeInstanceOf(Date);
    await asOwner(pool, U.ab, low(), async (q) => {
      expect(await outcome(q, "UPDATE intercompany_document_links SET status = 'pending_confirmation' WHERE id = $1", [link])).toBe(R.linkFinal);
      expect(await outcome(q, "UPDATE intercompany_document_links SET status = 'unlinked' WHERE id = $1", [link])).toBe(R.linkFinal);
    });
  });

  it('a third company neither reads, confirms nor unlinks; no signed-in user, no change; the grant stops other columns', async () => {
    const a = await plantDocument(pool, 'customer_invoice', low());
    const b = await plantDocument(pool, 'supplier_invoice', high());
    const link = await asAppUser(pool, U.ab, low(), async (q) => (await q.query(LINK, pairing(id, a, b))).rows[0].id as string, true);
    await asAppUser(pool, U.c, co.C, async (q) => {
      expect((await q.query("UPDATE intercompany_document_links SET status = 'unlinked' WHERE id = $1", [link])).rowCount).toBe(0);
      expect(await count(q, 'SELECT COUNT(*)::int AS n FROM intercompany_document_links')).toBe(0);
    });
    await asOwner(pool, null, low(), async (q) => {
      expect(await outcome(q, "UPDATE intercompany_document_links SET status = 'unlinked' WHERE id = $1", [link])).toBe(R.linkUser);
    });
    await asOwner(pool, U.ab, co.C, async (q) => {
      expect(await outcome(q, "UPDATE intercompany_document_links SET status = 'unlinked' WHERE id = $1", [link])).toBe(R.linkParty);
    });
    await asAppUser(pool, U.ab, low(), async (q) => {
      expect(await outcome(q, 'UPDATE intercompany_document_links SET doc_a_id = gen_random_uuid() WHERE id = $1', [link])).toBe('42501: permission denied for table intercompany_document_links');
      expect(await outcome(q, "UPDATE intercompany_document_links SET unlinked_by = 'x' WHERE id = $1", [link])).toBe('42501: permission denied for table intercompany_document_links');
      expect(await outcome(q, 'DELETE FROM intercompany_document_links')).toBe('42501: permission denied for table intercompany_document_links');
    });
  });
});
