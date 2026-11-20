/**
 * #1656, Hein 2026-11-19 ("gate everything"): every approve path asks the module's Approve, from the database, before
 * the document is read or written. Each path: a manager whose module Approve is unticked is refused and the posting
 * service is never called; a manager with the default (approve) goes through.
 *   payroll: pay-run approve, pay-run reopen, payroll batch post            → Payroll
 *   journal: journal-entries-action post (approving a draft journal)          → Chart of Accounts & GL
 *   customer invoices: MCP finalize_invoice and bulk_finalize_invoices        → Customers & AR
 *     (the route, customer-invoices-detail approve, is breaker1670CustomerInvoice.test.ts)
 *   budgets: budget-version approve                                           → Budgets
 *   MCP settle_by_contra on a payable (it approves a supplier payment)        → Suppliers & AP
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import { permissionDb, permissionSql } from '../helpers/permissionSqlMock';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', async (orig) => ({ ...(await orig<object>()), withAuth: (h: unknown) => h, withWriteAccess: (h: unknown) => h, withCsrf: (h: unknown) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/lib/neon', () => ({ sql: vi.fn(), withSavepoint: (_n: string, fn: () => unknown) => fn() }));
vi.mock('@/lib/auth/impersonationGuard', async (orig) => ({ ...(await orig<object>()), assertNotImpersonating: vi.fn() }));
vi.mock('@/modules/accounting/services/payroll/payrollApprovalService', async (orig) => ({ ...(await orig<object>()), approvePayrollRun: vi.fn(async () => ({ id: 'r' })) }));
vi.mock('@/modules/accounting/services/payroll/payrollRunReopen', async (orig) => ({ ...(await orig<object>()), reopenPayrollRun: vi.fn(async () => ({ previousStatus: 'approved' })) }));
vi.mock('@/modules/accounting/services/payroll/payrollBatchService', async (orig) => ({ ...(await orig<object>()), postBatch: vi.fn(async () => ({ id: 'b' })) }));
vi.mock('@/modules/accounting/services/payroll/payRunApprovalAudit', async (orig) => ({ ...(await orig<object>()), recordPayRunApprovalAudit: vi.fn() }));
vi.mock('@/modules/accounting/services/gl/journalEntryService', async (orig) => ({ ...(await orig<object>()), postJournalEntry: vi.fn(async () => ({ id: 'je' })) }));
vi.mock('@/modules/accounting/services/gl/manualJournalApproval', async (orig) => ({ ...(await orig<object>()), gateManualJournalPost: vi.fn(async () => false), markManualJournal: vi.fn() }));
vi.mock('@/modules/accounting/services/budgets/budgetVersionStatus', async (orig) => ({ ...(await orig<object>()), transitionVersion: vi.fn(async () => ({ id: 'v' })) }));
vi.mock('@/modules/accounting/services/ar/customerInvoiceApprovalService', async (orig) => ({ ...(await orig<object>()), approveCustomerInvoice: vi.fn(async () => ({ id: 'i', status: 'approved' })) }));
vi.mock('@/modules/accounting/services/gl/systemAccountResolver', async (orig) => ({ ...(await orig<object>()), validateSystemAccounts: vi.fn(async () => []) }));

import { sql } from '@/lib/neon';
import { approvePayrollRun } from '@/modules/accounting/services/payroll/payrollApprovalService';
import { reopenPayrollRun } from '@/modules/accounting/services/payroll/payrollRunReopen';
import { postBatch } from '@/modules/accounting/services/payroll/payrollBatchService';
import { postJournalEntry } from '@/modules/accounting/services/gl/journalEntryService';
import { transitionVersion } from '@/modules/accounting/services/budgets/budgetVersionStatus';
import { approveCustomerInvoice } from '@/modules/accounting/services/ar/customerInvoiceApprovalService';
import payRunApprove from '../../../pages/api/payroll/runs/[id]/approve';
import payRunReopen from '../../../pages/api/payroll/runs/[id]/reopen';
import batchPost from '../../../pages/api/payroll/batches/[id]/post';
import journalAction from '../../../pages/api/accounting/journal-entries-action';
import budgetVersionStatus from '../../../pages/api/accounting/budget-versions/[id]/status';
import { finalizeInvoiceTool } from '@/lib/mcp/tools/writeInvoices';
import { bulkFinalizeInvoicesTool } from '@/lib/mcp/tools/writeBulkFinalizeInvoices';
import { settleByContraTool } from '@/lib/mcp/tools/writeSettleByContra';
import type { McpToolContext } from '@/lib/mcp/types';

const C = '11111111-1111-4111-8111-111111111111';
const U = '99999999-9999-4999-8999-999999999999';
const ID = '66666666-6666-4666-8666-666666666666';
let db = permissionDb();

function call(handler: unknown, body: unknown, query: Record<string, string> = {}) {
  const req = { method: 'POST', query, body, companyId: C, companyRole: 'manager', user: { id: U } } as unknown as NextApiRequest;
  const res = {
    statusCode: 200, sent: undefined as unknown,
    setHeader() { return this; }, status(c: number) { this.statusCode = c; return this; },
    json(p: unknown) { this.sent = p; return this; }, end() { return this; },
  };
  return Promise.resolve((handler as (q: NextApiRequest, s: NextApiResponse) => unknown)(req, res as unknown as NextApiResponse)).then(() => res);
}
const ctx = (): McpToolContext => ({ companyId: C, userId: U, companyRole: 'manager', scopes: ['write:invoices', 'write:post'], tokenJti: 'j', oauthAppId: null });
const unticked = (module: string) => { db.members.set(`${C}:${U}`, 'manager'); db.rows.set(`${C}:${U}:${module}`, { can_read: true, can_write: true, can_approve: false }); };
const defaultManager = () => { db.rows.clear(); db.members.set(`${C}:${U}`, 'manager'); };

beforeEach(() => {
  vi.clearAllMocks();
  db = permissionDb();
  vi.mocked(sql).mockImplementation(permissionSql(db) as never);
});

const routes = [
  { name: 'pay-run approve', module: 'payroll', handler: () => payRunApprove, body: { expectedPlanHash: 'h' }, query: { id: ID }, service: () => approvePayrollRun },
  { name: 'pay-run reopen', module: 'payroll', handler: () => payRunReopen, body: { reason: 'wrong rate' }, query: { id: ID }, service: () => reopenPayrollRun },
  { name: 'payroll batch post', module: 'payroll', handler: () => batchPost, body: {}, query: { id: ID }, service: () => postBatch },
  { name: 'journal post', module: 'accounts', handler: () => journalAction, body: { id: ID, action: 'post' }, query: {}, service: () => postJournalEntry },
  { name: 'budget-version approve', module: 'budgets', handler: () => budgetVersionStatus, body: { action: 'approve' }, query: { id: ID }, service: () => transitionVersion },
] as const;

describe.each(routes)('$name asks $module Approve', ({ module, handler, body, query, service }) => {
  it('unticked: 403, the service is never called; the default manager goes through', async () => {
    unticked(module);
    const refused = await call(handler(), body, query);
    expect(refused.statusCode).toBe(403);
    expect(service()).not.toHaveBeenCalled();
    // A payroll route is first behind withPayrollModule (Payroll write), then asks Payroll Approve: two reads, both 'payroll'.
    expect(db.reads.map((r) => r.moduleKey)).toEqual(module === 'payroll' ? [module, module] : [module]);
    defaultManager();
    await call(handler(), body, query);
    expect(service()).toHaveBeenCalledTimes(1);
  });
});

describe('budget-version lock is not an approval', () => {
  it('a manager without Budgets Approve may still lock', async () => {
    unticked('budgets');
    await call(budgetVersionStatus, { action: 'lock' }, { id: ID });
    expect(transitionVersion).toHaveBeenCalledTimes(1);
  });
});

describe('MCP customer-invoice finalize (Customers & AR)', () => {
  it('finalize_invoice: refused before the invoice is read', async () => {
    unticked('customers');
    const out = await finalizeInvoiceTool.handler({ invoice_id: ID, idempotency_key: 'k' }, ctx());
    expect(out.isError).toBe(true);
    expect(out.content[0]!.text).toMatch(/permission to approve customer invoices/);
    expect(approveCustomerInvoice).not.toHaveBeenCalled();
  });

  it('bulk_finalize_invoices: refused before any invoice is read', async () => {
    unticked('customers');
    const out = await bulkFinalizeInvoicesTool.handler({ invoice_ids: [ID], idempotency_key: 'k' }, ctx());
    expect(out.isError).toBe(true);
    expect(out.content[0]!.text).toMatch(/permission to approve customer invoices/);
    expect(db.reads.map((r) => r.moduleKey)).toEqual(['customers']);
  });
});

describe('MCP settle_by_contra (Suppliers & AP on a payable)', () => {
  const args = { subledger: 'ap', document_id: ID, contra_account_id: ID, amount: 10, reason: 'contra', idempotency_key: 'k' };
  it('a payable is refused before anything is read', async () => {
    unticked('suppliers');
    const out = await settleByContraTool.handler(args, ctx());
    expect(out.isError).toBe(true);
    expect(out.content[0]!.text).toMatch(/permission to approve supplier payments/);
    expect(db.reads.map((r) => r.moduleKey)).toEqual(['suppliers']);
  });
  it('a receivable asks Customers & AR (round 4), never Suppliers & AP', async () => {
    unticked('suppliers');
    await settleByContraTool.handler({ ...args, subledger: 'ar' }, ctx());
    expect(db.reads.map((r) => r.moduleKey)).toEqual(['customers']);
  });
});
