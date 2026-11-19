/** Intercompany (1000 + 1002) messages: a viewer sends and handles nothing. (Documents: messages-documents.int.test.ts.) */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { asAppUser, cleanup, co, outcome, plantConnection, plantMessage, R, setup, U, wipeConnections } from './intercompany.helpers';

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
             VALUES ($1, $2, $3, 'payment', 'payment', gen_random_uuid(), '{}')`;
const handle = (user: string, company: string, m: string, set: string) =>
  asAppUser(pool, user, company, (q) => outcome(q, `UPDATE intercompany_messages SET ${set} WHERE id = $1`, [m]), true);

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
