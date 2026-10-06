/**
 * R-035 PR5, decision Q6: an agent may neither raise nor decide an approval.
 * MCP settle_by_contra on a PAYABLE creates a supplier payment, approves it and
 * processes it in one call — the gate cannot be read for a payment that does
 * not exist yet, so the call is refused up front, from reads, whenever supplier
 * payments are enforced and an active rule matches the amount. Nothing is
 * created (no half-made payment), nothing posts. A receivable settles as before.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { McpRegistry } from '../../src/lib/mcp/registry';
import { settleByContraTool } from '../../src/lib/mcp/tools/writeSettleByContra';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { createUser, plantRule } from './r035-approval.helpers';
import { cleanupPr5, enforcePay, inRequest, payCompany, plantBill, plantSupplier } from './r035-pr5.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let a = '';

beforeAll(async () => { a = await createUser(pool, tokens); });
afterAll(() => cleanupPr5(pool, companies, [a]));

const registry = new McpRegistry();
registry.register(settleByContraTool);
const settle = (c: string, documentId: string, contra: string, amount: number, extra: Record<string, unknown> = {}) =>
  inRequest(pool, a, c, () => registry.call('settle_by_contra', {
    subledger: 'ap', document_id: documentId, contra_account_id: contra, amount, reason: 'R035 netted',
    settlement_date: '2026-09-01', idempotency_key: crypto.randomUUID(), ...extra,
  }, { userId: a, companyId: c, scopes: ['write:invoices', 'write:post'], tokenJti: 'r035-pr5', oauthAppId: null }));
const text = (res: { content: { text: string }[] }) => res.content[0]!.text;

async function fixture(opts: { enforced?: boolean; over?: number } = {}) {
  const { company: c } = await payCompany(pool, [[a, 'owner']], companies);
  const contra = (await pool.query(
    `INSERT INTO gl_accounts(company_id,account_code,account_name,account_type,normal_balance,is_active,account_subtype)
     VALUES ($1,$2,'R035 Director loan','liability','credit',true,'other_current_liability') RETURNING id`,
    [c, `DL${c.slice(0, 6)}`])).rows[0].id as string;
  await plantRule(pool, c, 'owner', { documentType: 'supplier_payment', operator: 'greater_than', value: opts.over ?? 1000 });
  if (opts.enforced !== false) await enforcePay(pool, c, 'supplier_payment', a);
  const bill = await plantBill(pool, c, await plantSupplier(pool, c), a);
  return { c, contra, bill };
}

const payments = async (c: string) => Number((await pool.query(
  'SELECT count(*)::INT AS n FROM supplier_payments WHERE company_id = $1', [c])).rows[0].n);
const journals = async (c: string) => Number((await pool.query(
  'SELECT count(*)::INT AS n FROM gl_journal_entries WHERE company_id = $1', [c])).rows[0].n);

describe('settle_by_contra on a payable', () => {
  it('refuses a payment a rule governs under enforcement, from a read: no payment, no journal, bill unpaid', async () => {
    const { c, contra, bill } = await fixture();
    const res = await settle(c, bill, contra, 1150);
    expect(res.isError).toBe(true);
    expect(text(res)).toBe('Supplier payments are enforced: a payment of R1150.00 needs owner approval before it can be '
      + 'paid (rule: r035 owner). This connector cannot raise or decide approvals: a person must record the settlement '
      + 'in IsaFlow, submit it for approval, and an eligible approver must approve it.');
    expect({ payments: await payments(c), journals: await journals(c) }).toEqual({ payments: 0, journals: 0 });
    expect((await pool.query('SELECT amount_paid::FLOAT8 AS p FROM supplier_invoices WHERE id = $1', [bill])).rows[0].p).toBe(0);
  });

  it('the dry run says so too', async () => {
    const { c, contra, bill } = await fixture();
    const res = await settle(c, bill, contra, 1150, { dry_run: true });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/^Supplier payments are enforced/);
  });

  it('settles when no rule matches the amount, and when enforcement is off', async () => {
    const below = await fixture({ over: 5000 });
    expect((await settle(below.c, below.bill, below.contra, 1150)).isError).toBeFalsy();
    const off = await fixture({ enforced: false });
    expect((await settle(off.c, off.bill, off.contra, 1150)).isError).toBeFalsy();
    const { rows } = await pool.query(
      "SELECT status FROM supplier_payments WHERE company_id = ANY($1) AND payment_method = 'contra'", [[below.c, off.c]]);
    expect(rows).toEqual([{ status: 'processed' }, { status: 'processed' }]);
  });
});
