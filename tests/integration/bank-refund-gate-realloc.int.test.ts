/**
 * Hein, 2026-11-15 (bankLineRefundGate), the reallocation door: a HAND-KEYED line already allocated to an account (and
 * reconciled) cannot be re-pointed to a customer, paying the customer back, without the manual-journal approval.
 * Refused 409 before any write, the old allocation (journal, line, documents, reconciliation) exactly as it was.
 * Removing the gate in allocateTransaction turns this red: the refund would be posted instead.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from '@/lib/neon';
import { als } from '@/lib/als';
import { McpRegistry } from '@/lib/mcp/registry';
import { reallocateBankTransactionTool } from '@/lib/mcp/tools/writeBankReallocate';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { teardown, type Ctx } from './d8-r4-helpers';
import { clearExtras } from './d10-helpers';
import { cleanup } from './d12-helpers';
import { TOOL, entry, reconciledLine, setupCompany, snapshot } from './bank-reallocate-reconciled.helpers';

assertDisposable();
type Row = Record<string, unknown>;
let c: Ctx;
const registry = new McpRegistry();
registry.register(reallocateBankTransactionTool);

/** The tool called as a PERSON in a cookie session (a session id), so the agent-reversal refusal stands aside. */
async function asPerson(args: Record<string, unknown>): Promise<{ isError: boolean; text: string }> {
  const client = await c.fx.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE app_user');
    await client.query("SELECT set_config('app.current_company_id', $1, true)", [c.fx.companyId]);
    const claims = { sub: c.fx.userId, role: 'authenticated', company_id: c.fx.companyId, session_id: randomUUID() };
    await client.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
    const r = await als.run({ client, userId: c.fx.userId, companyId: c.fx.companyId, claims } as never, () => registry.call(TOOL, args, {
      userId: c.fx.userId, companyId: c.fx.companyId, scopes: ['write:bank-tx', 'write:post'], companyRole: 'owner', tokenJti: null, oauthAppId: null }));
    await client.query('ROLLBACK'); // a refusal wrote nothing; a surprise success is undone and fails the assertions below
    return { isError: r.isError === true, text: r.content[0]!.text };
  } finally { client.release(); }
}

describe('reallocate_bank_transaction: a hand-keyed account line re-pointed to a customer', () => {
  beforeAll(async () => { c = await setupCompany('REFUNDRA'); }, 120000);
  afterAll(async () => {
    const co = c.fx.companyId;
    await c.fx.pool.query("DELETE FROM approval_enforcement WHERE document_type <> 'pay_run' AND company_id = $1", [co]);
    await c.fx.pool.query("DELETE FROM approval_rules WHERE document_type <> 'pay_run' AND company_id = $1", [co]);
    await cleanup(c); await clearExtras(c); await teardown(c);
  }, 120000);

  it('is refused 409 (approval required); journal, line, documents and reconciliation are untouched', async () => {
    // Allocated and reconciled BEFORE enforcement is on: a hand-keyed R1 500 spend to an expense account.
    const s = await reconciledLine(c, { amount: -1500, date: '2026-06-10', statementDate: '2026-06-30', alloc: 'account', contra: c.acct.expense });
    // The customer holds R50 000 on account, so only the approval gate stands between the line and a posted refund.
    await sql`INSERT INTO customer_payments (company_id, client_id, payment_number, payment_date, total_amount, status, bank_account_id, created_by)
      VALUES (${c.fx.companyId}::UUID, ${c.fx.customerId}::UUID, 'RA-CREDIT', '2026-01-05', 50000, 'confirmed', ${s.bank}::UUID, ${c.fx.userId}::UUID)`;
    await c.fx.pool.query(
      `INSERT INTO approval_rules(id,company_id,name,document_type,condition_field,condition_operator,condition_value,approver_role,is_active)
       VALUES($1,$2,'Journals sign','manual_journal','amount','greater_than',1000,'admin',true)`, [randomUUID(), c.fx.companyId]);
    await c.fx.pool.query(
      `INSERT INTO approval_enforcement(company_id, document_type, enabled_by) VALUES($1,'manual_journal',$2)`, [c.fx.companyId, c.fx.userId]);

    const before = await snapshot(c, s.bt, s.rec);
    const res = await asPerson({ transaction_id: s.bt, expected_journal_entry_id: s.je, target: { customer_id: c.fx.customerId },
      idempotency_key: randomUUID(), dry_run: false });
    expect(res.isError, res.text).toBe(true);
    expect(res.text).toMatch(/refunding a customer R1500\.00.*manual journal.*needs admin approval/s);
    expect(await snapshot(c, s.bt, s.rec), 'nothing was written').toEqual(before);
    expect((await entry(s.je)).reversed, 'the old journal is not reversed').toBe(false);
    expect(((await sql`SELECT status, allocation_type FROM bank_transactions WHERE id = ${s.bt}::UUID`) as Row[])[0])
      .toMatchObject({ status: 'reconciled', allocation_type: 'account' });
  });
});
