/**
 * Intercompany (999z) messages: a viewer sends and handles nothing, and an accepted message that creates a document
 * names that document in the receiving company.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { asAppUser, cleanup, co, outcome, plantConnection, plantDocument, plantMessage, R, setup, U, wipeConnections } from './intercompany.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
let id = '';

beforeAll(() => setup(pool), 60000);
afterAll(() => cleanup(pool));
beforeEach(async () => {
  await wipeConnections(pool);
  id = await plantConnection(pool, co.A, co.B);
});

const MSG = `INSERT INTO intercompany_messages(connection_id, from_company_id, to_company_id, kind, source_doc_type, source_doc_id, payload)
             VALUES ($1, $2, $3, 'invoice', 'customer_invoice', gen_random_uuid(), '{}')`;
const handle = (user: string, company: string, m: string, set: string) =>
  asAppUser(pool, user, company, (q) => outcome(q, `UPDATE intercompany_messages SET ${set} WHERE id = $1`, [m]), true);
const accepting = (type: string | null, doc: string | null) =>
  `status = 'accepted', target_doc_type = ${type ? `'${type}'` : 'NULL'}, target_doc_id = ${doc ? `'${doc}'` : 'NULL'}`;

describe('a viewer sends and handles nothing', () => {
  it('a viewer of the sending company cannot send; a writer can', async () => {
    await asAppUser(pool, U.va, co.A, async (q) => {
      expect(await outcome(q, MSG, [id, co.A, co.B])).toBe(R.msgSendRole);
    });
    await asAppUser(pool, U.a, co.A, async (q) => {
      expect(await outcome(q, MSG, [id, co.A, co.B])).toBe('ok');
    });
  });

  it('a viewer of the receiving company cannot dismiss, reject, accept or restore; a writer can', async () => {
    const m = await plantMessage(pool, id, co.A, co.B);
    // avb owns A but only views B
    expect(await handle(U.avb, co.B, m, "status = 'dismissed'")).toBe(R.msgHandleRole);
    expect(await handle(U.avb, co.B, m, "status = 'rejected', reason = 'r'")).toBe(R.msgHandleRole);
    expect(await handle(U.avb, co.B, m, "status = 'failed', error = 'x'")).toBe(R.msgHandleRole);
    expect(await handle(U.b, co.B, m, "status = 'dismissed'")).toBe('ok');
    expect(await handle(U.avb, co.B, m, "status = 'pending'")).toBe(R.msgHandleRole);
    expect(await handle(U.b, co.B, m, "status = 'pending'")).toBe('ok');
  });
});

describe('an accepted message that creates a document names it', () => {
  it.each([['invoice'], ['credit_note'], ['interest_invoice']])('%s: no target, a target of the wrong type or one in the SENDER\'s company is refused', async (kind) => {
    const m = await plantMessage(pool, id, co.A, co.B, { kind });
    const own = await plantDocument(pool, 'supplier_invoice', co.B);
    const senders = await plantDocument(pool, 'supplier_invoice', co.A);
    expect(await handle(U.b, co.B, m, accepting(null, null))).toBe(R.msgTarget);
    expect(await handle(U.b, co.B, m, accepting('supplier_invoice', null))).toBe(R.msgTarget);
    expect(await handle(U.b, co.B, m, accepting(null, own))).toBe(R.msgTarget);
    expect(await handle(U.b, co.B, m, accepting('supplier_invoice', crypto.randomUUID()))).toBe(R.msgTarget);
    expect(await handle(U.b, co.B, m, accepting('supplier_invoice', senders))).toBe(R.msgTarget);
    expect(await handle(U.b, co.B, m, accepting('customer_invoice', own))).toBe(R.msgTarget);   // the id exists, but not as that type
    expect(await handle(U.b, co.B, m, accepting('journal_entry', own))).toBe(R.msgTarget);
    // even for a user who belongs to BOTH companies (so the sender's document is visible to them) as the receiver
    expect(await handle(U.ab, co.B, m, accepting('supplier_invoice', senders))).toBe(R.msgTarget);
    expect(await handle(U.b, co.B, m, accepting('supplier_invoice', own))).toBe('ok');
  });

  it('a kind that creates no document (a payment) is accepted without one', async () => {
    const m = await plantMessage(pool, id, co.A, co.B, { kind: 'payment' });
    expect(await handle(U.b, co.B, m, "status = 'accepted'")).toBe('ok');
  });

  it('a rejection or a dismissal needs no target', async () => {
    const m = await plantMessage(pool, id, co.A, co.B);
    expect(await handle(U.b, co.B, m, "status = 'rejected', reason = 'wrong amount'")).toBe('ok');
  });
});
