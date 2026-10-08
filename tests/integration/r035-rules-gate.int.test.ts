/**
 * R-035 follow-up, PR A (goal §3): a rule created from the starter set is the
 * rule the gate enforces. Created through the starter action, enforcement
 * switched on through the real enforcement route, then the real supplier-invoice
 * approve route: a bill above the rule's amount is refused 409 and stays a
 * draft; a bill below it posts. Also: the rules GET says which role the actor
 * holds, so the form can offer only the roles they may demand.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import approvalRules from '../../pages/api/accounting/approval-rules';
import approvalEnforcement from '../../pages/api/accounting/approval-enforcement';
import { checkApproval } from '../../src/modules/accounting/services/gl/approvalService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, createUser, plantBill, reasonOf } from './r035-approval.helpers';
import { billState, cleanupPr2, postableCompany, routes } from './r035-pr2.helpers';
import { inRequest } from './r035-pr5.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
const u = { owner: '', manager: '' };
const r = routes(tokens);

beforeAll(async () => {
  for (const k of Object.keys(u) as (keyof typeof u)[]) u[k] = await createUser(pool, tokens);
});
afterAll(() => cleanupPr2(pool, companies, Object.values(u)));

const URL = '/api/accounting/approval-rules';
const company = () => postableCompany(pool, [[u.owner, 'owner'], [u.manager, 'manager']], companies);

async function starterSupplierInvoiceRule(c: string): Promise<string> {
  const res = await callRoute(approvalRules, tokens[u.owner]!, c, 'POST',
    { action: 'starter', rules: [{ documentType: 'supplier_invoice' }] }, URL);
  expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
  return (res.state.body as { data: { created: { id: string }[] } }).data.created[0]!.id;
}

async function switchOn(c: string): Promise<void> {
  const res = await callRoute(approvalEnforcement, tokens[u.owner]!, c, 'POST',
    { documentType: 'supplier_invoice', enabled: true }, '/api/accounting/approval-enforcement');
  expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
}

describe('a starter rule gates documents once enforcement is on', () => {
  it('a R57 500 bill is refused 409 APPROVAL_REQUIRED under "Large supplier invoices" (> R50 000) and stays a draft', async () => {
    const c = await company();
    const ruleId = await starterSupplierInvoiceRule(c);
    await switchOn(c);
    const bill = await plantBill(pool, c, u.manager, { total: 57500 });

    const res = await r.approveBill(u.manager, c, bill.id);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(409);
    expect(reasonOf(res)).toBe('APPROVAL_REQUIRED');
    expect(JSON.stringify(res.state.body)).toContain('Large supplier invoices');
    expect(await billState(pool, bill.id)).toEqual({ status: 'draft', gl_journal_entry_id: null, journals: 0 });

    // checkApproval is the matcher the gate uses: it names the created rule.
    const matched = await inRequest(pool, u.manager, c, () => checkApproval(c, 'supplier_invoice', bill.id, 57500));
    expect(matched.matchedRule?.id).toBe(ruleId);
  });

  it('a R1 150 bill under the same rule and switch posts', async () => {
    const c = await company();
    await starterSupplierInvoiceRule(c);
    await switchOn(c);
    const bill = await plantBill(pool, c, u.manager);

    const res = await r.approveBill(u.manager, c, bill.id);
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    expect((await billState(pool, bill.id)).status).toBe('approved');
  });
});

describe('the rules GET names the actor role', () => {
  it.each([['owner'], ['manager']] as const)('as %s', async (role) => {
    const c = await company();
    const res = await callRoute(approvalRules, tokens[u[role]]!, c, 'GET', undefined, URL);
    expect(res.state.statusCode).toBe(200);
    expect((res.state.body as { data: { actorRole: string } }).data.actorRole).toBe(role);
  });
});
