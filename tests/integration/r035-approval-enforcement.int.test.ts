/**
 * R-035 PR1: the per-company, per-document-type enforcement switch.
 *
 * Enabling is refused for any type not in ENFORCEABLE_DOCUMENT_TYPES — only
 * supplier_invoice since PR2, the one type whose posting paths consult the gate.
 * Disabling weakens a control, so it demands rank >= the strictest ACTIVE rule
 * of that type (the same ladder as rule edits) and writes an audit row through
 * logAuditOrThrow. Rows are planted directly to test the disable half.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import approvalEnforcement from '../../pages/api/accounting/approval-enforcement';
import { log } from '../../src/lib/logger';
import { ENFORCEABLE_DOCUMENT_TYPES } from '../../src/modules/accounting/services/gl/approvalEnforcement';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, cleanup, createUser, newCompany, plantRule, reasonOf } from './r035-approval.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let owner = '';
let admin = '';

beforeAll(async () => {
  owner = await createUser(pool, tokens);
  admin = await createUser(pool, tokens);
});
afterAll(() => cleanup(pool, companies, [owner, admin]));

const URL = '/api/accounting/approval-enforcement';
const call = (as: string, company: string, method: string, body: unknown = {}) =>
  callRoute(approvalEnforcement, tokens[as]!, company, method, body, URL);

async function plantEnforcement(company: string, documentType: string): Promise<string> {
  const { rows } = await pool.query(
    'INSERT INTO approval_enforcement(company_id, document_type, enabled_by) VALUES($1,$2,$3) RETURNING id',
    [company, documentType, owner]);
  return rows[0].id as string;
}
const enforced = async (company: string) => (await pool.query(
  'SELECT document_type FROM approval_enforcement WHERE company_id = $1 ORDER BY document_type', [company])).rows
  .map((r) => r.document_type as string);
const audits = async (company: string) => (await pool.query(
  `SELECT action, user_id, entity_ref, changes FROM audit_log WHERE company_id = $1 AND entity_type = 'approval_enforcement'`,
  [company])).rows;

const twoMemberCompany = () => newCompany(pool, [[owner, 'owner'], [admin, 'admin']], companies);

describe('only wired types can be enforced', () => {
  it('PR5 makes supplier_invoice, both credit-note types, customer_invoice and both payment types, and only them, enforceable', () => {
    expect(ENFORCEABLE_DOCUMENT_TYPES).toEqual(['supplier_invoice', 'customer_credit_note', 'supplier_credit_note', 'customer_invoice',
      'supplier_payment', 'payment_batch']);
  });

  // `credit_note` is the legacy type: it governs neither credit-note type and is never enforceable.
  it.each(['payment', 'journal_entry', 'credit_note'])('refuses to enable %s — not enforceable yet', async (documentType) => {
    const company = await twoMemberCompany();
    const res = await call(owner, company, 'POST', { documentType, enabled: true });
    expect(res.state.statusCode).toBe(400);
    expect(reasonOf(res)).toBe('NOT_ENFORCEABLE');
    expect(await enforced(company)).toEqual([]);
    expect(await audits(company)).toEqual([]);
  });

  it('rejects an unknown document type', async () => {
    const company = await twoMemberCompany();
    const res = await call(owner, company, 'POST', { documentType: 'purchase_order', enabled: false });
    expect(res.state.statusCode).toBe(400);
  });
});

describe('disabling is a weakening act', () => {
  it('refuses an admin while an owner-only rule of that type is active — 403, row kept, nothing audited', async () => {
    const company = await twoMemberCompany();
    await plantRule(pool, company, 'admin');
    await plantRule(pool, company, 'owner', { operator: 'greater_than', value: 100000 });
    await plantEnforcement(company, 'supplier_invoice');

    const warn = vi.spyOn(log, 'warn');
    const res = await call(admin, company, 'POST', { documentType: 'supplier_invoice', enabled: false });
    expect(res.state.statusCode).toBe(403);
    expect(reasonOf(res)).toBe('RULE_AUTHORITY_REQUIRED');
    expect(await enforced(company)).toEqual(['supplier_invoice']);
    expect(await audits(company)).toEqual([]);
    // Not in audit_log (no action fits a refusal) — but not silent either.
    expect(warn).toHaveBeenCalledWith('Approval enforcement disable refused', expect.objectContaining({
      companyId: company, documentType: 'supplier_invoice', actorId: admin, actorRole: 'admin', strictestRuleRole: 'owner',
    }), 'accounting');
    warn.mockRestore();
  });

  it('lets the owner disable it — 200, row gone, one delete audit row naming the actor', async () => {
    const company = await twoMemberCompany();
    await plantRule(pool, company, 'owner');
    const id = await plantEnforcement(company, 'supplier_invoice');

    const res = await call(owner, company, 'POST', { documentType: 'supplier_invoice', enabled: false });
    expect(res.state.statusCode).toBe(200);
    expect(await enforced(company)).toEqual([]);
    const rows = await audits(company);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'delete', user_id: owner, entity_ref: 'supplier_invoice' });
    expect(rows[0].changes.metadata).toMatchObject({ actorRole: 'owner', strictestRuleRole: 'owner', enforcementId: id });
  });

  it('refuses an admin when the strictest active rule is admin — weakening needs a rank strictly above (R-048)', async () => {
    const company = await twoMemberCompany();
    await plantRule(pool, company, 'admin');
    await plantEnforcement(company, 'supplier_invoice');

    const res = await call(admin, company, 'POST', { documentType: 'supplier_invoice', enabled: false });
    expect(res.state.statusCode).toBe(403);
    expect(reasonOf(res)).toBe('RULE_AUTHORITY_REQUIRED');
    expect(await enforced(company)).toEqual(['supplier_invoice']);
    expect(await audits(company)).toEqual([]);
  });

  it('lets an admin disable when the strictest ACTIVE rule is manager (an inactive owner rule does not count)', async () => {
    const company = await twoMemberCompany();
    await plantRule(pool, company, 'manager');
    const inactive = await plantRule(pool, company, 'owner');
    await pool.query('UPDATE approval_rules SET is_active = false WHERE id = $1', [inactive]);
    await plantEnforcement(company, 'supplier_invoice');

    const res = await call(admin, company, 'POST', { documentType: 'supplier_invoice', enabled: false });
    expect(res.state.statusCode).toBe(200);
    expect(await enforced(company)).toEqual([]);
    expect(await audits(company)).toHaveLength(1);
  });

  it.each([['owner', 'owner'], ['owner', 'admin'], ['admin', 'manager']])(
    'lets an %s disable over an %s-level strictest rule', async (actor, ruleRole) => {
      const company = await twoMemberCompany();
      await plantRule(pool, company, ruleRole);
      await plantEnforcement(company, 'supplier_invoice');
      const res = await call(actor === 'owner' ? owner : admin, company, 'POST', { documentType: 'supplier_invoice', enabled: false });
      expect(res.state.statusCode).toBe(200);
      expect(await enforced(company)).toEqual([]);
    });

  it('ranks only rules of the SAME document type', async () => {
    const company = await twoMemberCompany();
    await plantRule(pool, company, 'owner', { documentType: 'journal_entry' });
    await plantEnforcement(company, 'supplier_invoice');
    const res = await call(admin, company, 'POST', { documentType: 'supplier_invoice', enabled: false });
    expect(res.state.statusCode).toBe(200);
  });

  it("ranks only THIS company's rules, and touches only this company's row", async () => {
    const company = await twoMemberCompany();
    const other = await twoMemberCompany();
    await plantRule(pool, other, 'owner');
    await plantEnforcement(company, 'supplier_invoice');
    await plantEnforcement(other, 'supplier_invoice');

    const res = await call(admin, company, 'POST', { documentType: 'supplier_invoice', enabled: false });
    expect(res.state.statusCode).toBe(200);
    expect(await enforced(company)).toEqual([]);
    expect(await enforced(other)).toEqual(['supplier_invoice']);
    expect(await audits(other)).toEqual([]);
  });
});

describe('listing is tenant-scoped', () => {
  it("GET returns this company's switches only, and what may be enabled", async () => {
    const company = await twoMemberCompany();
    const other = await twoMemberCompany();
    await plantEnforcement(company, 'credit_note');
    await plantEnforcement(other, 'supplier_invoice');
    const res = await call(admin, company, 'GET');
    expect(res.state.statusCode).toBe(200);
    const data = (res.state.body as { data: { items: { documentType: string }[]; enforceable: string[] } }).data;
    expect(data.items.map((i) => i.documentType)).toEqual(['credit_note']);
    expect(data.enforceable).toEqual(['supplier_invoice', 'customer_credit_note', 'supplier_credit_note', 'customer_invoice',
      'supplier_payment', 'payment_batch']);
  });
});
