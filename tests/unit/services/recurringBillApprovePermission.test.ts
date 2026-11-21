/**
 * #1656 review of #1670, breaker R1: a person running an autoPost AP recurring template approves the
 * bill it mints (mintRecurringSupplierInvoice, run by POST /api/accounting/recurring-transactions-execute),
 * so it takes their Suppliers & AP Approve. Without it the bill is left a draft and says why; and such
 * a person may not create an autoPost supplier-invoice template or turn autoPost on.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import { permissionDb, permissionSql } from '../helpers/permissionSqlMock';

const C = '11111111-1111-4111-8111-111111111111';
const U = '99999999-9999-4999-8999-999999999999';
const T = '33333333-3333-4333-8333-333333333333';
let db = permissionDb();
let storedTemplate: { entity_type: string; auto_post: boolean } | null = null;
const audits: string[] = [];

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h, withWriteAccess: (h: unknown) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/modules/accounting/services/core/contactDirectoryService', () => ({ assertSupplierInCompany: vi.fn(), assertCustomerInCompany: vi.fn() }));
vi.mock('@/modules/accounting/services/ap/billLineAccountGuard', () => ({ billLineAccountRefusal: vi.fn(async () => null) }));
vi.mock('@/modules/accounting/services/gl/dimensions/supplierDimensionDefaults', () => ({ resolveBillLineDimensions: vi.fn(async (_c: string, _s: string, l: unknown) => l) }));
vi.mock('@/modules/accounting/services/core/recurringTemplateLines', () => ({ normaliseLines: () => [], headerTotals: () => ({ subtotal: 100, taxAmount: 15, totalAmount: 115 }) }));
vi.mock('@/modules/accounting/services/core/paymentTermsResolver', () => ({ dueDateForContact: vi.fn(async () => '2026-12-01') }));
vi.mock('@/modules/accounting/services/core/documentNumberRetry', () => ({ insertWithReservedNumber: vi.fn(async () => 'bill-1') }));
vi.mock('@/modules/accounting/services/gl/approvalGate', () => ({ evaluateApprovalGate: vi.fn(async () => false) }));
vi.mock('@/modules/accounting/services/gl/approvalUnattended', () => ({ raiseUnattendedApproval: vi.fn() }));
vi.mock('@/modules/accounting/services/ap/supplierInvoiceWorkflowService', () => ({ approveSupplierInvoice: vi.fn(async () => ({ id: 'bill-1', status: 'approved' })) }));
vi.mock('@/modules/accounting/services/core/recurringTransactionService', () => ({
  getRecurringTemplates: vi.fn(), createRecurringTemplate: vi.fn(async () => ({ id: T })),
  updateRecurringTemplate: vi.fn(async () => ({ id: T })), deleteRecurringTemplate: vi.fn(),
}));

import { sql } from '@/lib/neon';
import { mintRecurringSupplierInvoice } from '@/modules/accounting/services/core/recurringTransactionInvoices';
import { approveSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import { createRecurringTemplate, updateRecurringTemplate } from '@/modules/accounting/services/core/recurringTransactionService';
import templatesRoute from '../../../pages/api/accounting/recurring-transactions';

const template = { id: T, name: 'Rent', autoPost: true, templateData: { supplierId: '22222222-2222-4222-8222-222222222222' } } as never;

function call(method: string, body: unknown) {
  const req = { method, query: {}, body, companyId: C, companyRole: 'manager', user: { id: U } } as unknown as NextApiRequest;
  const res = {
    statusCode: 200, sent: undefined as unknown,
    setHeader() { return this; }, status(c: number) { this.statusCode = c; return this; },
    json(p: unknown) { this.sent = p; return this; }, end() { return this; },
  };
  return Promise.resolve((templatesRoute as (q: NextApiRequest, s: NextApiResponse) => unknown)(req, res as unknown as NextApiResponse)).then(() => res);
}

beforeEach(() => {
  vi.clearAllMocks();
  db = permissionDb();
  storedTemplate = null;
  audits.length = 0;
  vi.mocked(sql).mockImplementation(permissionSql(db, (text, values) => {
    if (text.includes('INSERT INTO audit_log')) audits.push(JSON.stringify(values));
    if (text.includes('FROM suppliers WHERE id')) return [{ '?column?': 1 }]; // the template's supplier is live (dc34ae0887's pre-write check)
    return text.includes('FROM recurring_transaction_templates') && storedTemplate ? [storedTemplate] : [];
  }) as never);
});

const manager = (canApprove?: boolean) => {
  db.members.set(`${C}:${U}`, 'manager');
  if (canApprove !== undefined) db.rows.set(`${C}:${U}:suppliers`, { can_read: true, can_write: true, can_approve: canApprove });
};

describe('Run now on an autoPost AP template (R1)', () => {
  it('a manager whose Approve is unticked gets a draft, not an approved bill, and is told why', async () => {
    manager(false);
    const r = await mintRecurringSupplierInvoice(C, template, U);
    expect(approveSupplierInvoice).not.toHaveBeenCalled();
    expect(r.posted).toBe(false);
    expect(r.warnings?.[0]).toMatch(/Left as a draft: You do not have permission to approve supplier invoices/);
    // L4 (review of #1670): and audited.
    expect(audits).toHaveLength(1);
    expect(audits[0]).toContain('withheld');
    expect(audits[0]).toContain('recurring_run');
  });

  it('a manager with the default (approve) still gets it posted', async () => {
    manager();
    const r = await mintRecurringSupplierInvoice(C, template, U);
    expect(approveSupplierInvoice).toHaveBeenCalledTimes(1);
    expect(r.posted).toBe(true);
  });
});

describe('creating or switching on an autoPost supplier-invoice template', () => {
  it('is refused (403) for a manager without Approve, and nothing is created', async () => {
    manager(false);
    const res = await call('POST', { name: 'Rent', entityType: 'supplier_invoice', templateData: {}, frequency: 'monthly', autoPost: true });
    expect(res.statusCode).toBe(403);
    expect(createRecurringTemplate).not.toHaveBeenCalled();
  });

  it('turning autoPost on for a stored supplier-invoice template is refused too', async () => {
    manager(false);
    storedTemplate = { entity_type: 'supplier_invoice', auto_post: false };
    const res = await call('PUT', { id: T, autoPost: true });
    expect(res.statusCode).toBe(403);
    expect(updateRecurringTemplate).not.toHaveBeenCalled();
  });

  it('a template that does not approve bills (autoPost off, or a journal) is not asked about', async () => {
    manager(false);
    expect((await call('POST', { name: 'Rent', entityType: 'supplier_invoice', templateData: {}, frequency: 'monthly', autoPost: false })).statusCode).toBe(200);
    expect((await call('POST', { name: 'J', entityType: 'journal_entry', templateData: {}, frequency: 'monthly', autoPost: true })).statusCode).toBe(200);
  });

  // Security review of #1670: auto_post is a boolean column and Postgres casts 'true' / '1' to true, so a value that is
  // not a boolean must not slip past the approve check: it is refused (400) before anything is read or written.
  it.each([['"true"', 'true'], ['1', 1], ['"yes"', 'yes']])('autoPost %s is refused (400) on create and update, nothing written', async (_l, value) => {
    manager(false);
    const created = await call('POST', { name: 'Rent', entityType: 'supplier_invoice', templateData: {}, frequency: 'monthly', autoPost: value });
    expect(created.statusCode).toBe(400);
    storedTemplate = { entity_type: 'supplier_invoice', auto_post: false };
    expect((await call('PUT', { id: T, autoPost: value })).statusCode).toBe(400);
    expect(createRecurringTemplate).not.toHaveBeenCalled();
    expect(updateRecurringTemplate).not.toHaveBeenCalled();
  });

  // Breaker R2-C + security review: an update is judged on the STORED template, never on the body's entityType.
  it('PUT with entityType spoofed to a journal is still judged as the stored supplier-invoice template (403)', async () => {
    manager(false);
    storedTemplate = { entity_type: 'supplier_invoice', auto_post: false };
    expect((await call('PUT', { id: T, entityType: 'journal_entry', autoPost: true })).statusCode).toBe(403);
    expect(updateRecurringTemplate).not.toHaveBeenCalled();
  });

  it('PUT without autoPost on a stored autoPost supplier template is refused too (the stored flag counts)', async () => {
    manager(false);
    storedTemplate = { entity_type: 'supplier_invoice', auto_post: true };
    expect((await call('PUT', { id: T, name: 'Rent 2' })).statusCode).toBe(403);
    expect(updateRecurringTemplate).not.toHaveBeenCalled();
  });

  it('PUT: a non-UUID id, or a template this company does not have, is 404 before the gate', async () => {
    manager(false);
    expect((await call('PUT', { id: 'not-a-uuid', autoPost: true })).statusCode).toBe(404);
    // ...and it never reaches SQL, where the ::UUID cast would be a 500 (22P02).
    expect(vi.mocked(sql).mock.calls.some((c) => c.slice(1).includes('not-a-uuid'))).toBe(false);
    storedTemplate = null;
    expect((await call('PUT', { id: T, autoPost: true })).statusCode).toBe(404);
    expect(updateRecurringTemplate).not.toHaveBeenCalled();
  });

  it('PUT passes the update on without the body entityType (never changed, never trusted)', async () => {
    manager(true);
    storedTemplate = { entity_type: 'supplier_invoice', auto_post: false };
    expect((await call('PUT', { id: T, entityType: 'journal_entry', name: 'x' })).statusCode).toBe(200);
    expect(vi.mocked(updateRecurringTemplate).mock.calls[0]![2]).toEqual({ name: 'x' });
  });

  it('an entity type outside the three is refused (400)', async () => {
    manager(false);
    expect((await call('POST', { name: 'X', entityType: 'Supplier_Invoice', templateData: {}, frequency: 'monthly', autoPost: true })).statusCode).toBe(400);
    expect(createRecurringTemplate).not.toHaveBeenCalled();
  });

  // #1670 Codex: a later run checks only the runner's Approve, so the editor of ANY auto-posting template needs the module's Approve.
  const withheld = (module: string) => db.rows.set(`${C}:${U}:${module}`, { can_read: true, can_write: true, can_approve: false });

  it.each([
    ['journal_entry', 'accounts', /Chart of Accounts/],
    ['customer_invoice', 'customers', /Customers & AR/],
  ])('an autoPost %s template needs %s Approve to create, turn on or edit (403, nothing written)', async (type, module, label) => {
    manager(true); // Suppliers Approve held: the other module decides
    withheld(module);
    const created = await call('POST', { name: 'X', entityType: type, templateData: {}, frequency: 'monthly', autoPost: true });
    expect(created.statusCode).toBe(403);
    expect(JSON.stringify(created.sent)).toMatch(label);
    storedTemplate = { entity_type: type, auto_post: false };
    expect((await call('PUT', { id: T, autoPost: true })).statusCode).toBe(403);
    storedTemplate = { entity_type: type, auto_post: true };
    expect((await call('PUT', { id: T, name: 'edited figures' })).statusCode).toBe(403);
    expect(createRecurringTemplate).not.toHaveBeenCalled();
    expect(updateRecurringTemplate).not.toHaveBeenCalled();
    // autoPost off asks nothing.
    expect((await call('POST', { name: 'X', entityType: type, templateData: {}, frequency: 'monthly', autoPost: false })).statusCode).toBe(200);
  });

  it('a stored auto-posting template of a type with no Approve module is refused (fail closed)', async () => {
    manager(true);
    storedTemplate = { entity_type: 'stock_adjustment', auto_post: true };
    expect((await call('PUT', { id: T, name: 'x' })).statusCode).toBe(403);
    expect(updateRecurringTemplate).not.toHaveBeenCalled();
  });

  it('PUT locks the template row (FOR UPDATE) before the permission check, and the update follows it', async () => {
    manager(true);
    storedTemplate = { entity_type: 'supplier_invoice', auto_post: true };
    expect((await call('PUT', { id: T, name: 'x' })).statusCode).toBe(200);
    const texts = vi.mocked(sql).mock.calls.map((c) => (c[0] as unknown as string[]).join('?'));
    const lock = texts.findIndex((t) => t.includes('FROM recurring_transaction_templates'));
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(texts[lock]).toMatch(/FOR UPDATE/);
    const permission = texts.findIndex((t) => t.includes('LEFT JOIN company_user_permissions p'));
    expect(permission).toBeGreaterThan(lock);
    expect(updateRecurringTemplate).toHaveBeenCalledTimes(1);
  });

  it('a manager with Approve may create one', async () => {
    manager(true);
    expect((await call('POST', { name: 'Rent', entityType: 'supplier_invoice', templateData: {}, frequency: 'monthly', autoPost: true })).statusCode).toBe(200);
  });
});
