/**
 * R-035 PR5: the switch, the rules and the request rows around the two payment
 * types.
 *  - The legacy `payment` rule type governs neither type: a NEW one is refused
 *    (400, naming the types that govern payments; the credit-note refusal is
 *    unchanged), and the enforcement GET counts the active ones for a warning.
 *  - Switching either type OFF needs the rank to weaken its strictest rule.
 *  - The preview counts the unpaid payments / batches the switch would hold.
 *  - app_user may insert a request for either type only as requestApproval
 *    writes one (862's insert guard, extended).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import approvalRules from '../../pages/api/accounting/approval-rules';
import approvalEnforcement from '../../pages/api/accounting/approval-enforcement';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, createUser, plantRule, reasonOf } from './r035-approval.helpers';
import { dataOf, messageOf } from './r035-pr2.helpers';
import { asAppUser } from './r035-pr4.helpers';
import { cleanupPr5, enforcePay, payCompany, plantBatch, plantPayment, type PayType } from './r035-pr5.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
const u = { owner: '', manager: '', admin: '' };

beforeAll(async () => {
  for (const k of Object.keys(u) as (keyof typeof u)[]) u[k] = await createUser(pool, tokens);
});
afterAll(() => cleanupPr5(pool, companies, Object.values(u)));

const company = () => payCompany(pool, [[u.owner, 'owner'], [u.manager, 'manager'], [u.admin, 'admin']], companies);
const createRuleVia = (c: string, documentType: string) => callRoute(approvalRules, tokens[u.owner]!, c, 'POST',
  { name: `R035 ${documentType}`, documentType, conditionOperator: 'any', approverRole: 'owner' }, '/api/accounting/approval-rules');
const enforcement = (user: string, c: string, method: 'GET' | 'POST', body?: unknown, query: Record<string, string> = {}) =>
  callRoute(approvalEnforcement, tokens[user]!, c, method, body, '/api/accounting/approval-enforcement', query);

describe('legacy payment rules', () => {
  it('a new one is refused 400, naming the payment types; nothing written', async () => {
    const { company: c } = await company();
    const res = await createRuleVia(c, 'payment');
    expect(res.state.statusCode).toBe(400);
    expect(messageOf(res)).toBe('Approval rules of type payment no longer govern any supplier payment. Create a supplier_payment '
      + 'or payment_batch rule instead.');
    expect((await pool.query('SELECT 1 FROM approval_rules WHERE company_id = $1', [c])).rows).toEqual([]);
  });

  it('the credit-note refusal is unchanged; both payment types are created', async () => {
    const { company: c } = await company();
    expect(messageOf(await createRuleVia(c, 'credit_note'))).toBe('Approval rules of type credit_note no longer govern any '
      + 'credit note. Create a customer_credit_note or supplier_credit_note rule instead.');
    for (const type of ['supplier_payment', 'payment_batch']) expect((await createRuleVia(c, type)).state.statusCode, type).toBe(200);
  });

  it('the GET counts this company\'s ACTIVE legacy payment rules, plain and preview', async () => {
    const { company: c } = await company();
    await plantRule(pool, c, 'owner', { documentType: 'payment' });
    const inactive = await plantRule(pool, c, 'owner', { documentType: 'payment' });
    await pool.query('UPDATE approval_rules SET is_active = false WHERE id = $1', [inactive]);
    const { company: other } = await company();
    await plantRule(pool, other, 'owner', { documentType: 'payment' });
    expect(dataOf<{ legacyPaymentRules: number }>(await enforcement(u.owner, c, 'GET')).legacyPaymentRules).toBe(1);
    expect(dataOf<{ legacyPaymentRules: number }>(await enforcement(u.owner, c, 'GET', undefined, { preview: '1' })).legacyPaymentRules).toBe(1);
  });
});

describe('the switch', () => {
  it.each(['supplier_payment', 'payment_batch'] as PayType[])(
    'switching %s off needs the rank to weaken its strictest rule (403); the owner may', async (type) => {
      const { company: c } = await company();
      await plantRule(pool, c, 'owner', { documentType: type });
      expect((await enforcement(u.owner, c, 'POST', { documentType: type, enabled: true })).state.statusCode).toBe(200);
      const refused = await enforcement(u.manager, c, 'POST', { documentType: type, enabled: false });
      expect(refused.state.statusCode).toBe(403);
      expect(reasonOf(refused)).toBe('RULE_AUTHORITY_REQUIRED');
      expect((await enforcement(u.owner, c, 'POST', { documentType: type, enabled: false })).state.statusCode).toBe(200);
    });

  it('the preview counts unpaid single payments and batches a rule matches, not members, paid ones or cleared ones', async () => {
    const { company: c, bank } = await company();
    for (const type of ['supplier_payment', 'payment_batch']) {
      await plantRule(pool, c, 'owner', { documentType: type, operator: 'greater_than', value: 1000 });
    }
    await plantPayment(pool, c, u.admin, bank); // R1 150: held
    await plantPayment(pool, c, u.admin, bank, { amount: 500 }); // below the rule
    await plantPayment(pool, c, u.admin, bank, { status: 'processed' }); // paid
    await plantBatch(pool, c, u.admin, bank); // held; its two members are not counted as payments
    await plantBatch(pool, c, u.admin, bank, [100]); // below the rule
    const { preview } = dataOf<{ preview: Record<string, number> }>(await enforcement(u.owner, c, 'GET', undefined, { preview: '1' }));
    expect(preview).toMatchObject({ supplier_payment: 1, payment_batch: 1 });
  });
});

describe('the request insert guard', () => {
  const insert = (type: PayType, c: string, id: string, requestedBy: string, status: string) => (cl: import('pg').PoolClient) =>
    cl.query(
      `INSERT INTO approval_requests(company_id, document_type, document_id, requested_by, status, decided_by, decided_at,
         required_role, document_digest)
       VALUES($1,$2,$3,$4::UUID,$5::TEXT, CASE WHEN $5::TEXT = 'pending' THEN NULL ELSE $4::UUID END,
         CASE WHEN $5::TEXT = 'pending' THEN NULL ELSE now() END, 'owner', approval_document_digest($1,$2,$3))`,
      [c, type, id, requestedBy, status]);

  it.each(['supplier_payment', 'payment_batch'] as PayType[])(
    '%s: an approved row, or a pending one naming another requester, is refused; the session user\'s own pending row is not',
    async (type) => {
      const { company: c, bank } = await company();
      const rule = await plantRule(pool, c, 'owner', { documentType: type });
      await enforcePay(pool, c, type, u.owner);
      const id = type === 'supplier_payment'
        ? (await plantPayment(pool, c, u.admin, bank)).id : (await plantBatch(pool, c, u.admin, bank)).id;
      // R-035 N1 (migration 872): app_user holds no INSERT; its own raise goes through approval_request_raise.
      await expect(asAppUser(pool, u.admin, c, insert(type, c, id, u.admin, 'approved'))).rejects.toThrow(/permission denied for table approval_requests/);
      await expect(asAppUser(pool, u.manager, c, insert(type, c, id, u.admin, 'pending'))).rejects.toThrow(/permission denied for table approval_requests/);
      await asAppUser(pool, u.admin, c, (cl) => cl.query('SELECT * FROM approval_request_raise($1, $2, $3, $4, $5)',
        [c, type, id, rule, u.admin]));
      expect((await pool.query('SELECT status FROM approval_requests WHERE document_id = $1', [id])).rows).toEqual([{ status: 'pending' }]);
    });
});
