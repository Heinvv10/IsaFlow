/**
 * Intercompany P5, review round 1 (a): the `unsent` and `unlinked_partner_bill` lists are capped like the messages are. Each lists at most
 * MAX_RECON_LIST_ROWS rows, oldest first, and the summary says when one was cut (`truncated`); the page says so. The cap is lowered to 2
 * for this file (the statement reads cap + 1 rows, so the real cap of 500 behaves the same way).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { co, U, wipeConnections } from './intercompany.helpers';
import { mirrorCleanup } from './mirror.helpers';
import { clearPayments } from './allocation.helpers';
import { fixturePaid, pair, reconConnect, reconSetup, reportAs, reportOf } from './loan-recon.helpers';

vi.mock('../../../src/modules/accounting/services/intercompany/loanReconTypes', async (orig) => ({
  ...(await orig<object>()), MAX_RECON_LIST_ROWS: 2,
}));

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
let conn = '';

beforeAll(() => reconSetup(pool), 90000);
afterAll(async () => { await clearPayments(pool); await mirrorCleanup(pool); }, 60000);
beforeEach(async () => {
  await clearPayments(pool);
  await wipeConnections(pool);
  await pool.query('UPDATE supplier_invoices SET deleted_at = now() WHERE company_id = $1 AND deleted_at IS NULL', [co.B]);
  conn = await reconConnect(pool);
});

const attention = async () => reportOf(await reportAs(U.b, co.B, conn, { section: 'attention' }));
const ids = (r: Awaited<ReturnType<typeof attention>>, kind: string) => r.section.items.filter((i) => i.kind === kind).map((i) => i.id);

describe('the capped lists', () => {
  it('at the cap: every row, not truncated; one more: the oldest cap rows and truncated, for unsent and unlinked alike', async () => {
    const unsent = [await fixturePaid(pool, conn, 410, { send: false }), await fixturePaid(pool, conn, 420, { send: false })];
    const bills = [await pair(pool, conn, 330, { link: false, paid: 330 }), await pair(pool, conn, 340, { link: false, paid: 340 })];
    const full = await attention();
    expect(ids(full, 'unsent')).toEqual(unsent.map((u) => u.allocation));
    expect(ids(full, 'unlinked_bill')).toEqual(bills.map((b) => b.bill));
    expect(full.summary.truncated).toEqual({ unsent: false, unlinked: false });

    await fixturePaid(pool, conn, 430, { send: false });
    await pair(pool, conn, 350, { link: false, paid: 350 });
    const cut = await attention();
    expect(ids(cut, 'unsent')).toEqual(unsent.map((u) => u.allocation));
    expect(ids(cut, 'unlinked_bill')).toEqual(bills.map((b) => b.bill));
    expect(cut.summary.truncated).toEqual({ unsent: true, unlinked: true });
    expect(cut.section.total).toBe(4);
  });
});
