/**
 * #1656 round 3: every route the breaker found ungated (and the ones the transitive census then turned up) answers a person
 * WITHOUT the module's Approve 403, on the module its sibling route or MCP tool uses, before it writes anything. The
 * permission is refused through checkPermission (the one the real gates call); `sql` records every statement, and none
 * of them may be a write. The placement of each gate on EVERY action is what approvePostEntryCensus.test.ts pins.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/lib/auth/permissionService', async (orig) => (await import('../helpers/modulePermissionMock')).permissionServiceAllowing(await orig<object>()));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', async (orig) => ({
  ...(await orig<object>()), withAuth: (h: unknown) => h, withWriteAccess: (h: unknown) => h, withCsrf: (h: unknown) => h,
  withRole: () => (h: unknown) => h, withVatVendor: (h: unknown) => h,
}));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/lib/billing/withFlowMeter', () => ({ withFlowMeter: () => (h: unknown) => h, markFlowNoOp: vi.fn() }));
vi.mock('@/lib/rateLimit', () => ({ checkAiRateLimit: vi.fn().mockResolvedValue(true), checkRateLimit: vi.fn().mockResolvedValue(true) }));
vi.mock('@/lib/als', () => ({ als: { getStore: vi.fn() }, assertTxUsable: vi.fn() }));
const sqlCalls = vi.hoisted(() => [] as string[]);
vi.mock('@/lib/neon', () => {
  const sql = vi.fn(async (strings: TemplateStringsArray) => { sqlCalls.push(strings.join('?')); return []; });
  return { sql, withSavepoint: (_n: string, fn: () => unknown) => fn(), withTransaction: vi.fn() };
});

import { checkPermission } from '@/lib/auth/permissionService';
import journalAction from '../../../pages/api/accounting/journal-entries-action';
import supplierCreditNotes from '../../../pages/api/accounting/supplier-credit-notes';
import closeRunDecide from '../../../pages/api/accounting/close-run/decide';
import glImport from '../../../pages/api/accounting/gl-import';
import bankAutoPost from '../../../pages/api/accounting/bank-auto-post';
import bankRecon from '../../../pages/api/accounting/bank-reconciliations-action';
import loanPayments from '../../../pages/api/accounting/loans/[id]/payments';
import openingBalances from '../../../pages/api/accounting/migration/opening-balances';
import apInvoices from '../../../pages/api/accounting/migration/ap-invoices';
import arInvoices from '../../../pages/api/accounting/migration/ar-invoices';
import drcVat from '../../../pages/api/accounting/drc-vat';
import vatReturns from '../../../pages/api/accounting/vat-returns/index';
import taxDirectiveApply from '../../../pages/api/accounting/tax-directives/[id]/apply';
import provisionalDismiss from '../../../pages/api/accounting/provisional/[jeId]/dismiss';
import smartCategorize from '../../../pages/api/accounting/smart-categorize';
import sageAction from '../../../pages/api/accounting/sage-migration-action';
import recurringJournals from '../../../pages/api/accounting/recurring-journals';
import bankRules from '../../../pages/api/accounting/bank-rules';
import commentaryApprove from '../../../pages/api/accounting/commentary/[id]/approve';
import varianceNotes from '../../../pages/api/accounting/budgets/variance-notes';
import bankRulesAction from '../../../pages/api/accounting/bank-rules-action';

const C = '11111111-1111-4111-8111-111111111111';
const U = '99999999-9999-4999-8999-999999999999';
const ID = '66666666-6666-4666-8666-666666666666';
type Handler = (req: NextApiRequest, res: NextApiResponse) => unknown;

function call(handler: unknown, method: string, body: unknown, query: Record<string, string> = {}) {
  const req = { method, query, body, companyId: C, companyRole: 'manager', user: { id: U }, headers: {}, cookies: {} } as unknown as NextApiRequest;
  const res = {
    statusCode: 0, sent: undefined as unknown, setHeader() { return this; }, getHeader() { return undefined; },
    status(c: number) { this.statusCode = c; return this; }, json(p: unknown) { this.sent = p; return this; },
    send(p: unknown) { this.sent = p; return this; }, end() { return this; },
  };
  return Promise.resolve((handler as Handler)(req, res as unknown as NextApiResponse)).then(() => res);
}

type Case = readonly [name: string, handler: unknown, method: string, body: unknown, query: Record<string, string>, module: string];
const CASES: Case[] = [
  ['journal-entries-action reverse', journalAction, 'POST', { action: 'reverse', id: ID }, {}, 'accounts'],
  ['close-run/decide approve', closeRunDecide, 'POST', { runId: ID, proposalId: ID, decision: 'approve' }, {}, 'accounts'],
  ['gl-import postImmediately', glImport, 'POST', { rows: [{}], postImmediately: true }, {}, 'accounts'],
  ['bank-auto-post undo', bankAutoPost, 'POST', { action: 'undo', runId: ID }, {}, 'banking'],
  ['bank-auto-post undoAnyway', bankAutoPost, 'POST', { action: 'undoAnyway', runId: ID, transactionId: ID, offsetJournalId: ID }, {}, 'banking'],
  ['bank-auto-post confirmHandCorrection', bankAutoPost, 'POST', { action: 'confirmHandCorrection', runId: ID, transactionId: ID, offsetJournalId: ID }, {}, 'banking'],
  ['bank-reconciliations-action reopen', bankRecon, 'POST', { action: 'reopen', reconciliationId: ID, reason: 'x' }, {}, 'banking'],
  ['bank-reconciliations-action adjustment', bankRecon, 'POST', { action: 'adjustment', reconciliationId: ID, bankAccountId: ID, contraAccountId: ID, amount: 10, description: 'x' }, {}, 'banking'],
  ['loans/[id]/payments', loanPayments, 'POST', { paymentDate: '2026-05-01' }, { id: ID }, 'accounts'],
  ['migration/opening-balances', openingBalances, 'POST', { sessionId: 's', effectiveDate: '2026-05-01', balances: [{}] }, {}, 'accounts'],
  ['migration/ap-invoices', apInvoices, 'POST', { sessionId: ID, invoices: [{}] }, {}, 'suppliers'],
  ['migration/ar-invoices', arInvoices, 'POST', { sessionId: ID, invoices: [{}] }, {}, 'customers'],
  ['drc-vat', drcVat, 'POST', { supplierInvoiceId: ID }, {}, 'vat'],
  ['vat-returns submit', vatReturns, 'POST', { periodStart: '2026-01-01', periodEnd: '2026-02-28' }, {}, 'vat'],
  ['provisional/[jeId]/dismiss', provisionalDismiss, 'POST', {}, { jeId: ID }, 'banking'],
  ['smart-categorize', smartCategorize, 'POST', { action: 'categorize', transactionIds: [ID] }, {}, 'banking'],
  ['sage-migration-action import_ledger', sageAction, 'POST', { action: 'import_ledger' }, {}, 'accounts'],
  ['sage-migration-action import_invoices', sageAction, 'POST', { action: 'import_invoices' }, {}, 'suppliers'],
  ['sage-migration-action import_customer_invoices', sageAction, 'POST', { action: 'import_customer_invoices' }, {}, 'customers'],
  ['recurring-journals create with autoPost', recurringJournals, 'POST', { autoPost: true }, {}, 'accounts'],
  ['bank-rules create with autoCreateEntry (round 4)', bankRules, 'POST', { ruleName: 'r', matchField: 'description', matchType: 'contains', matchPattern: 'x', glAccountId: ID, autoCreateEntry: true }, {}, 'banking'],
  ['bank-rules-action update to autoCreateEntry (round 4)', bankRulesAction, 'POST', { action: 'update', id: ID, autoCreateEntry: true }, {}, 'banking'],
  ['commentary/[id]/approve (round 4)', commentaryApprove, 'POST', {}, { id: ID }, 'budgets'],
  ['budgets/variance-notes approve (round 4)', varianceNotes, 'POST', { action: 'approve', id: ID, draft: 'a draft' }, {}, 'budgets'],
  ['bank-rules-action apply', bankRulesAction, 'POST', { action: 'apply', bankAccountId: ID }, {}, 'banking'],
];

beforeEach(() => {
  vi.clearAllMocks();
  sqlCalls.length = 0;
  vi.mocked(checkPermission).mockResolvedValue(false);
});

describe('a person without the module Approve is refused 403 before any write', () => {
  it.each(CASES)('%s', async (_name, handler, method, body, query, module) => {
    const res = await call(handler, method, body, query);
    expect(res.statusCode, JSON.stringify(res.sent)).toBe(403);
    expect(checkPermission).toHaveBeenCalledWith(C, U, module, 'approve');
    expect(sqlCalls.filter((t) => /\b(INSERT|UPDATE|DELETE)\b/i.test(t))).toEqual([]);
  });

  it('supplier-credit-notes reverse (a credit note it finds, then Suppliers Approve)', async () => {
    const { sql } = await import('@/lib/neon');
    vi.mocked(sql).mockImplementation((async (strings: TemplateStringsArray) => {
      sqlCalls.push(strings.join('?'));
      return [{ id: ID, type: 'supplier', status: 'approved', company_id: C }];
    }) as never);
    const res = await call(supplierCreditNotes, 'PATCH', { id: ID, action: 'reverse' });
    expect(res.statusCode, JSON.stringify(res.sent)).toBe(403);
    expect(checkPermission).toHaveBeenCalledWith(C, U, 'suppliers', 'approve');
    expect(sqlCalls.filter((t) => /\b(INSERT|UPDATE|DELETE)\b/i.test(t))).toEqual([]);
  });

  it('tax-directives/[id]/apply: the Payroll module gate AND Payroll Approve, each refused 403', async () => {
    const res = await call(taxDirectiveApply, 'POST', { paymentDate: '2026-05-01' }, { id: ID });
    expect(res.statusCode).toBe(403);
    expect(checkPermission).toHaveBeenCalledWith(C, U, 'payroll', 'write'); // the module wrapper first
    // Write granted, Approve not: the route's own gate.
    vi.mocked(checkPermission).mockImplementation(async (_c, _u, _m, action) => action !== 'approve');
    const res2 = await call(taxDirectiveApply, 'POST', { paymentDate: '2026-05-01' }, { id: ID });
    expect(res2.statusCode, JSON.stringify(res2.sent)).toBe(403);
    expect(checkPermission).toHaveBeenCalledWith(C, U, 'payroll', 'approve');
    expect(sqlCalls.filter((t) => /\b(INSERT|UPDATE|DELETE)\b/i.test(t))).toEqual([]);
  });

  it('close-run/decide: reject and dismiss post nothing and are not gated', async () => {
    vi.mocked(checkPermission).mockResolvedValue(false);
    const res = await call(closeRunDecide, 'POST', { runId: ID, proposalId: ID, decision: 'reject' });
    expect(checkPermission).not.toHaveBeenCalled();
    expect(res.statusCode).not.toBe(403);
  });

  it('gl-import without postImmediately leaves drafts and is not gated', async () => {
    await call(glImport, 'POST', { rows: [{}], postImmediately: false });
    expect(checkPermission).not.toHaveBeenCalled();
  });
});
