/**
 * Intercompany P2, the guards ALLOW-LIST the definers' owner (round-4 MED 3). The guard used to test `current_user IN ('app_user', 'app_service')`:
 * the service LOGIN's own name (isaflow_service, which inherits app_service) is neither, so it could insert a forged document message (which a
 * receiver accepted as a R1 035 000 bill) and a pre-matched group row. Every trigger of 1019 that judged a role now refuses unless the role is
 * migration_admin. Probed as the two real logins: isaflow_service (the worker's) and isaflow_app (the request login, SET ROLE app_user).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { asDefiner, outcome } from './intercompany.helpers';
import { clearMirrorRows, co, connect, dataOf, inbox, mirrorCleanup, mirrorSetup, plantArInvoice, sentInvoice, U } from './mirror.helpers';
import { eliminationCleanup, eliminationSetup } from './mirror.helpers';
import { autoGenerateEliminations } from '../../../src/modules/accounting/services/reports/consolidatedReportingService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
beforeAll(async () => { await mirrorSetup(pool); await eliminationSetup(pool); }, 60000);
afterAll(async () => { await eliminationCleanup(pool); await mirrorCleanup(pool); }, 60000);
beforeEach(async () => { await clearMirrorRows(pool); await connect(pool); });

const LOGINS = ['isaflow_service', 'isaflow_app'] as const;
async function as<T>(login: (typeof LOGINS)[number], fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SET LOCAL SESSION AUTHORIZATION ${login}`);
    if (login === 'isaflow_app') await c.query('SET LOCAL ROLE app_user');
    await c.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: U.a })]);
    await c.query("SELECT set_config('app.current_company_id', $1, true)", [co.A]);
    return await fn(c);
  } finally { await c.query('ROLLBACK').catch(() => undefined); c.release(); }
}

describe.each(LOGINS)('as %s', (login) => {
  it('cannot insert a forged document message (a R1 035 000 invoice), so there is nothing for the receiver to accept', async () => {
    const sent = await sentInvoice(pool);
    const inv2 = await plantArInvoice(pool, { status: 'approved' });
    const forged = { ...sent.message.payload, number: 'FORGED-1', subtotal: 900000, taxAmount: 135000, total: 1035000, groupTransactionId: null,
      lines: [{ description: 'forged', quantity: 1, unitPrice: 900000, taxRate: 15, taxAmount: 135000, lineTotal: 900000 }] };
    const out = await as(login, (c) => outcome(c, `INSERT INTO intercompany_messages(connection_id, from_company_id, to_company_id, kind, source_doc_type, source_doc_id, payload)
      VALUES ($1, $2, $3, 'invoice', 'customer_invoice', $4, $5::jsonb)`, [sent.message.connection_id, co.A, co.B, inv2.id, JSON.stringify(forged)]));
    expect(out).toMatch(/^(42501|23514)/);
    expect((await pool.query('SELECT count(*)::int AS n FROM intercompany_messages WHERE source_doc_id = $1', [inv2.id])).rows[0].n).toBe(0);
    expect(dataOf<{ items: unknown[] }>(await inbox.list(U.b, co.B)).items).toHaveLength(1);   // only the honest one
  });

  it('cannot insert a group row that is already matched, signed or carrying a variance (so nothing pre-matched is eliminated)', async () => {
    const out = await as(login, async (c) => ({
      matched: await outcome(c, `INSERT INTO intercompany_transactions(group_id, source_company_id, target_company_id, transaction_type, amount, currency, description, transaction_date, match_status, matched_at)
        VALUES ($1, $2, $3, 'sale', 777, 'ZAR', 'forged', '2026-09-01', 'matched', now())`, [co.G, co.A, co.B]),
      signed: await outcome(c, `INSERT INTO intercompany_transactions(group_id, source_company_id, target_company_id, transaction_type, amount, currency, description, transaction_date, matched_by)
        VALUES ($1, $2, $3, 'sale', 777, 'ZAR', 'forged', '2026-09-01', $4)`, [co.G, co.A, co.B, U.a]),
      first: await outcome(c, `INSERT INTO intercompany_transactions(group_id, source_company_id, target_company_id, transaction_type, amount, currency, description, transaction_date, variance_reason)
        VALUES ($1, $2, $3, 'sale', 777, 'ZAR', 'forged', '2026-09-01', 'looks fine')`, [co.G, co.A, co.B]),
    }));
    for (const v of Object.values(out)) expect(v).toMatch(/^(42501|23514)/);
    expect((await pool.query("SELECT count(*)::int AS n FROM intercompany_transactions WHERE description = 'forged'")).rows[0].n).toBe(0);
    expect(await autoGenerateEliminations(co.G, '2026-01-01', '2026-12-31')).toHaveLength(0);
  });

  it('cannot forge the system-update flags, nor sign another user\'s name on a row it may update', async () => {
    const sent = await sentInvoice(pool);
    // a row no message records (the manual feed): only the matched_by rule judges a write to it
    const plain = (await asDefiner(pool, U.a, co.A, (q) => q.query(
      `INSERT INTO intercompany_transactions(group_id, source_company_id, target_company_id, transaction_type, amount, currency, description, transaction_date)
       VALUES ($1, $2, $3, 'sale', 5, 'ZAR', 'plain', '2026-09-01') RETURNING id`, [co.G, co.A, co.B]), true)).rows[0].id as string;
    const out = await as(login, async (c) => {
      await c.query("SELECT set_config('app.intercompany_system_update', 'withdraw', true)");
      const flag = await outcome(c, "UPDATE intercompany_messages SET status = 'withdrawn', source_cancelled_at = now() WHERE id = $1", [sent.id]);
      const sign = await outcome(c, "UPDATE intercompany_transactions SET matched_by = $2 WHERE id = $1", [plain, crypto.randomUUID()]);
      return { flag, sign };
    });
    expect(out.flag).toMatch(/^(42501|23514)/);
    expect(out.sign).toMatch(/^(42501|23514)/);
    expect((await pool.query('SELECT status FROM intercompany_messages WHERE id = $1', [sent.id])).rows[0].status).toBe('pending');
  });
});
