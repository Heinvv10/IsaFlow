/**
 * R-035 PR3 review B2: the legacy `credit_note` rule type governs neither
 * credit-note type, so a rule of it is silently inert.
 *
 *  - (a) No NEW rule of that type may be created: 400, naming the two types
 *    that do govern credit notes. Existing rows are left as they are.
 *  - (b) The enforcement GET reports how many ACTIVE legacy rules a company
 *    still has, so the Enforce switch can say they govern nothing.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import approvalRules from '../../pages/api/accounting/approval-rules';
import approvalEnforcement from '../../pages/api/accounting/approval-enforcement';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, cleanup, createUser, newCompany, plantRule } from './r035-approval.helpers';
import { dataOf, messageOf } from './r035-pr2.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let owner = '';

beforeAll(async () => { owner = await createUser(pool, tokens); });
afterAll(() => cleanup(pool, companies, [owner]));

const company = () => newCompany(pool, [[owner, 'owner']], companies);
const createRuleVia = (c: string, documentType: string) => callRoute(approvalRules, tokens[owner]!, c, 'POST',
  { name: `R035 ${documentType}`, documentType, conditionOperator: 'any', approverRole: 'owner' }, '/api/accounting/approval-rules');
const rulesOf = async (c: string) => (await pool.query(
  'SELECT document_type, is_active FROM approval_rules WHERE company_id = $1 ORDER BY document_type', [c])).rows;

describe('(a) a new legacy credit_note rule is refused', () => {
  it('400 naming customer_credit_note and supplier_credit_note; nothing written', async () => {
    const c = await company();
    const res = await createRuleVia(c, 'credit_note');
    expect(res.state.statusCode).toBe(400);
    expect(messageOf(res)).toMatch(/customer_credit_note/);
    expect(messageOf(res)).toMatch(/supplier_credit_note/);
    expect(await rulesOf(c)).toEqual([]);
  });

  it('the two credit-note types, and every other type, are still created', async () => {
    const c = await company();
    for (const documentType of ['customer_credit_note', 'supplier_credit_note', 'supplier_invoice']) {
      expect((await createRuleVia(c, documentType)).state.statusCode, documentType).toBe(200);
    }
  });

  it('an existing legacy rule is left alone and may still be edited', async () => {
    const c = await company();
    const id = await plantRule(pool, c, 'owner', { documentType: 'credit_note' });
    const res = await callRoute(approvalRules, tokens[owner]!, c, 'PUT', { id, isActive: false }, '/api/accounting/approval-rules');
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    expect(await rulesOf(c)).toEqual([{ document_type: 'credit_note', is_active: false }]);
  });
});

describe('(b) the enforcement GET reports active legacy credit_note rules', () => {
  const get = (c: string, query: Record<string, string> = {}) => callRoute(approvalEnforcement, tokens[owner]!, c, 'GET',
    undefined, '/api/accounting/approval-enforcement', query);

  it('counts active legacy rules only, on the plain and the preview GET', async () => {
    const c = await company();
    await plantRule(pool, c, 'owner', { documentType: 'credit_note' });
    await plantRule(pool, c, 'manager', { documentType: 'credit_note' });
    const inactive = await plantRule(pool, c, 'owner', { documentType: 'credit_note' });
    await pool.query('UPDATE approval_rules SET is_active = false WHERE id = $1', [inactive]);
    await plantRule(pool, c, 'owner', { documentType: 'customer_credit_note' });
    const otherCompany = await company();
    await plantRule(pool, otherCompany, 'owner', { documentType: 'credit_note' });
    expect(dataOf<{ legacyCreditNoteRules: number }>(await get(c)).legacyCreditNoteRules).toBe(2);
    expect(dataOf<{ legacyCreditNoteRules: number }>(await get(c, { preview: '1' })).legacyCreditNoteRules).toBe(2);
  });

  it('is 0 for a company with none', async () => {
    const c = await company();
    expect(dataOf<{ legacyCreditNoteRules: number }>(await get(c)).legacyCreditNoteRules).toBe(0);
  });
});
