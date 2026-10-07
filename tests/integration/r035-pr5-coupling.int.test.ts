/**
 * R-035 PR5 round 1, decision D1 (Hein, 2026-10-06): the two payment switches
 * are COUPLED. Paying a bill as a single payment or as a one-line batch moves
 * the same money, so neither switch may leave the other path open (blind
 * MEDIUM 1, adversarial REPRO 1):
 *  - enabling or disabling either type moves both, atomically, each audited;
 *    disabling needs the rank to weaken the strictest active rule of EITHER;
 *  - a batch clears only on an approval ranked at least the strictest of its
 *    own rule (on the batch amount) and every member's supplier_payment rule
 *    (on the member's amount) — in the TypeScript gate, the 867 backstop and
 *    the bank-file routes alike; a request raised for the batch binds that role.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import approvalEnforcement from '../../pages/api/accounting/approval-enforcement';
import batchPayments from '../../pages/api/accounting/batch-payments';
import eftGenerate from '../../pages/api/accounting/eft-generate';
import { checkApproval } from '@/modules/accounting/services/gl/approvalMatching';
import { requiredRank } from '@/modules/accounting/services/gl/approvalAuthority';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, createUser, plantRule, reasonOf } from './r035-approval.helpers';
import { dataOf } from './r035-pr2.helpers';
import {
  batchState, cleanupPr5, enforcePay, inRequest, payCompany, payRoutes, plantBatch, plantBill, plantSupplier,
} from './r035-pr5.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
const u = { a: '', b: '', m: '' };
const r = payRoutes(tokens);

beforeAll(async () => {
  for (const k of Object.keys(u) as (keyof typeof u)[]) u[k] = await createUser(pool, tokens);
});
afterAll(() => cleanupPr5(pool, companies, Object.values(u)));

const company = () => payCompany(pool, [[u.a, 'admin'], [u.b, 'owner'], [u.m, 'manager']], companies);
const switchTo = (user: string, c: string, documentType: string, enabled: boolean) => callRoute(
  approvalEnforcement, tokens[user]!, c, 'POST', { documentType, enabled }, '/api/accounting/approval-enforcement');
const enforced = async (c: string) => (await pool.query(
  'SELECT document_type FROM approval_enforcement WHERE company_id = $1 ORDER BY document_type', [c])).rows.map((x) => x.document_type);
const audits = async (c: string, action: string) => (await pool.query(
  `SELECT entity_ref FROM audit_log WHERE company_id = $1 AND entity_type = 'approval_enforcement' AND action = $2
   ORDER BY entity_ref`, [c, action])).rows.map((x) => x.entity_ref);

describe('the switches move together', () => {
  it.each(['supplier_payment', 'payment_batch'])('switching %s on switches both on, each audited', async (type) => {
    const { company: c } = await company();
    expect((await switchTo(u.b, c, type, true)).state.statusCode).toBe(200);
    expect(await enforced(c)).toEqual(['payment_batch', 'supplier_payment']);
    expect(await audits(c, 'create')).toEqual(['payment_batch', 'supplier_payment']);
  });

  it('switching either off switches both off — and needs the rank to weaken the strictest rule of EITHER type', async () => {
    const { company: c } = await company();
    await plantRule(pool, c, 'owner', { documentType: 'supplier_payment' });
    await plantRule(pool, c, 'bookkeeper', { documentType: 'payment_batch' });
    expect((await switchTo(u.b, c, 'payment_batch', true)).state.statusCode).toBe(200);
    const refused = await switchTo(u.m, c, 'payment_batch', false);
    expect(refused.state.statusCode).toBe(403);
    expect(reasonOf(refused)).toBe('RULE_AUTHORITY_REQUIRED');
    expect(await enforced(c)).toEqual(['payment_batch', 'supplier_payment']);
    expect((await switchTo(u.b, c, 'payment_batch', false)).state.statusCode).toBe(200);
    expect(await enforced(c)).toEqual([]);
    expect(await audits(c, 'delete')).toEqual(['payment_batch', 'supplier_payment']);
  });
});

describe('a batch is judged by its members\' payment rules too', () => {
  it('REPRO 1: with only a supplier_payment rule, the bill author cannot pay their bill through a one-line batch', async () => {
    const { company: c, bank } = await company();
    await plantRule(pool, c, 'owner', { documentType: 'supplier_payment', name: 'Owner pays' });
    expect((await switchTo(u.b, c, 'supplier_payment', true)).state.statusCode).toBe(200);
    const supplierId = await plantSupplier(pool, c);
    const billId = await plantBill(pool, c, supplierId, u.a, 5000);
    const created = await callRoute(batchPayments, tokens[u.a]!, c, 'POST', {
      bankAccountId: bank, batchDate: '2026-09-01',
      payments: [{ supplierId, invoiceAllocations: [{ invoiceId: billId, amount: 5000 }] }],
    }, '/api/accounting/batch-payments');
    const batchId = dataOf<{ id: string }>(created).id;
    const approve = await r.batch(u.a, c, 'approve', batchId);
    expect(approve.state.statusCode).toBe(409);
    expect(reasonOf(approve)).toBe('APPROVAL_REQUIRED');
    expect(await batchState(pool, batchId)).toMatchObject({ status: 'draft', journals: 0, paid: 0 });
  });

  it('a member rule stricter than the batch rule governs: the request binds it, a lower approval clears nothing', async () => {
    const { company: c, bank } = await company();
    await plantRule(pool, c, 'manager', { documentType: 'payment_batch', name: 'Manager batches' });
    await plantRule(pool, c, 'owner', { documentType: 'supplier_payment', name: 'Owner over 2000', operator: 'greater_than', value: 2000 });
    await enforcePay(pool, c, 'payment_batch', u.b);
    const b = await plantBatch(pool, c, u.a, bank, [1150, 2300]);
    const req = dataOf<{ id: string; requiredRole: string; ruleName: string }>(await r.raise(u.a, c, 'payment_batch', b.id));
    expect(req).toMatchObject({ requiredRole: 'owner' });
    expect((await r.decide(pool, u.m, c, req.id)).state.statusCode).toBe(403);
    expect((await r.decide(pool, u.b, c, req.id)).state.statusCode).toBe(200);
    expect((await r.batch(u.a, c, 'approve', b.id)).state.statusCode).toBe(200);
  });

  it('the backstop and the bank-file route apply the member rule too: a manager-ranked batch approval is refused', async () => {
    const { company: c, bank } = await company();
    await plantRule(pool, c, 'manager', { documentType: 'payment_batch' });
    await enforcePay(pool, c, 'payment_batch', u.b);
    const b = await plantBatch(pool, c, u.a, bank, [1150, 2300]);
    await r.approvedBy(pool, u.a, u.m, c, 'payment_batch', b.id);
    expect((await r.batch(u.a, c, 'approve', b.id)).state.statusCode).toBe(200);
    // A member rule stricter than the approval arrives after it.
    await plantRule(pool, c, 'owner', { documentType: 'supplier_payment', operator: 'greater_than', value: 2000 });
    const eft = await callRoute(eftGenerate, tokens[u.a]!, c, 'POST', { batchId: b.id, bank: 'fnb' }, '/api/accounting/eft-generate');
    expect(eft.state.statusCode).toBe(409);
    expect(reasonOf(eft)).toBe('APPROVAL_REQUIRED');
    const raw = await pool.query("UPDATE supplier_payment_batches SET status = 'processed' WHERE id = $1", [b.id])
      .then(() => 'written', (e: Error) => e.message);
    expect(raw).toMatch(/^R035_APPROVAL_REQUIRED/);
    expect((await r.batch(u.a, c, 'process', b.id)).state.statusCode).toBe(409);
  });

  it('parity: the TypeScript match and approval_payment_batch_strictest_rank agree', async () => {
    const { company: c, bank } = await company();
    const b = await plantBatch(pool, c, u.a, bank, [500, 2300]);
    const cases: [string, string, string, number][][] = [
      [], [['payment_batch', 'manager', 'any', 0]],
      [['supplier_payment', 'owner', 'greater_than', 2000]],
      [['supplier_payment', 'owner', 'greater_than', 3000], ['payment_batch', 'bookkeeper', 'greater_equal', 2800]],
      [['supplier_payment', 'admin', 'greater_equal', 500], ['payment_batch', 'owner', 'greater_than', 9000]],
    ];
    for (const rules of cases) {
      await pool.query('DELETE FROM approval_rules WHERE company_id = $1', [c]);
      for (const [type, role, operator, value] of rules) await plantRule(pool, c, role, { documentType: type, operator, value });
      const ts = await inRequest(pool, u.a, c, () => checkApproval(c, 'payment_batch', b.id, 2800));
      const { rows: [row] } = await pool.query('SELECT approval_payment_batch_strictest_rank($1,$2) AS rank', [c, b.id]);
      expect(row.rank, JSON.stringify(rules)).toBe(ts.matchedRule ? requiredRank(ts.matchedRule.approverRole) : null);
    }
  });
});
