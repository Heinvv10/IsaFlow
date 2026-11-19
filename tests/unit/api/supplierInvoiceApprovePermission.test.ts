/**
 * #1656: the per-module permissions (company_user_permissions) are enforced on supplier-invoice
 * approval. A manager whose Suppliers & AP "Approve" an owner or admin unticked cannot approve a
 * bill on any person's path (the single route, the bulk route, the MCP approve and bulk-approve
 * tools); nothing of the bill is read or written. A manager with no row keeps the role default
 * (approve), and owner/admin always may.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ withAuth: (h: unknown) => h, withWriteAccess: (h: unknown) => h }));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (h: unknown) => h }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (h: unknown) => h }));
vi.mock('@/lib/neon', () => ({ sql: vi.fn(), withSavepoint: (_n: string, fn: () => unknown) => fn() }));
vi.mock('@/lib/rateLimit', () => ({ checkRateLimit: vi.fn(async () => true) }));
vi.mock('@/modules/accounting/services/ap/supplierInvoiceService', async (orig) => ({
  ...(await orig<object>()), approveSupplierInvoice: vi.fn(), cancelSupplierInvoice: vi.fn(),
  performThreeWayMatch: vi.fn(), getSupplierInvoiceById: vi.fn(),
}));
vi.mock('@/modules/accounting/services/ap/supplierInvoiceWorkflowService', async (orig) => ({
  ...(await orig<object>()), approveSupplierInvoice: vi.fn(),
}));
vi.mock('@/modules/accounting/services/gl/systemAccountResolver', async (orig) => ({
  ...(await orig<object>()), validateSystemAccounts: vi.fn(async () => []),
}));

import { sql } from '@/lib/neon';
import { approveSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceService';
import {
  approveSupplierInvoice as approveViaWorkflow,
} from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import { getSupplierInvoiceById } from '@/modules/accounting/services/ap/supplierInvoiceService';
import { validateSystemAccounts } from '@/modules/accounting/services/gl/systemAccountResolver';
import actionRoute from '../../../pages/api/accounting/supplier-invoices-action';
import bulkRoute from '../../../pages/api/accounting/supplier-invoices-bulk-action';
import { approveSupplierInvoiceTool } from '@/lib/mcp/tools/writeSupplierInvoices';
import { bulkApproveSupplierInvoicesTool } from '@/lib/mcp/tools/writeBulkApproveSupplierInvoices';
import type { McpToolContext } from '@/lib/mcp/types';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const USER = '99999999-9999-4999-8999-999999999999';
const BILL = '66666666-6666-4666-8666-666666666666';

/** The suppliers row company_user_permissions holds for USER (null: none, the role default applies). */
let suppliersRow: { can_approve: boolean } | null = null;
const permissionReads: string[] = [];

function call(handler: unknown, body: unknown, companyRole: string) {
  const req = { method: 'POST', query: {}, body, companyId: COMPANY, companyRole, user: { id: USER } } as unknown as NextApiRequest;
  const res = {
    statusCode: 0, sent: undefined as unknown, headers: {} as Record<string, string>,
    setHeader(k: string, v: string) { this.headers[k] = v; return this; },
    status(code: number) { this.statusCode = code; return this; },
    json(payload: unknown) { this.sent = payload; return this; },
    end() { return this; },
  };
  return Promise.resolve((handler as (q: NextApiRequest, s: NextApiResponse) => unknown)(req, res as unknown as NextApiResponse))
    .then(() => res);
}

const mcpCtx = (companyRole: string): McpToolContext =>
  ({ companyId: COMPANY, userId: USER, companyRole, scopes: ['write:invoices', 'write:post'], tokenJti: 'jti-1656', oauthAppId: null });

beforeEach(() => {
  vi.clearAllMocks();
  suppliersRow = null;
  permissionReads.length = 0;
  vi.mocked(sql).mockImplementation(((strings: TemplateStringsArray) => {
    const text = strings.join('?');
    if (text.includes('company_user_permissions')) {
      permissionReads.push(text);
      return Promise.resolve(suppliersRow ? [{ can_read: true, can_write: true, can_delete: false, can_export: true, ...suppliersRow }] : []);
    }
    return Promise.resolve([]);
  }) as never);
  vi.mocked(approveSupplierInvoice).mockResolvedValue({ id: BILL, status: 'approved' } as never);
  vi.mocked(validateSystemAccounts).mockResolvedValue([] as never);
});

describe('a manager whose Suppliers & AP approve is unticked cannot approve a bill', () => {
  beforeEach(() => { suppliersRow = { can_approve: false }; });

  it('single route: 403, the bill is never approved', async () => {
    const res = await call(actionRoute, { action: 'approve', invoiceId: BILL }, 'manager');
    expect(res.statusCode).toBe(403);
    expect(JSON.stringify(res.sent)).toMatch(/permission to approve supplier invoices/);
    expect(approveSupplierInvoice).not.toHaveBeenCalled();
    expect(permissionReads.join()).toMatch(/module_key/);
  });

  it('bulk route: 403 for the whole batch, nothing approved', async () => {
    const res = await call(bulkRoute, { action: 'approve', invoiceIds: [BILL] }, 'manager');
    expect(res.statusCode).toBe(403);
    expect(approveSupplierInvoice).not.toHaveBeenCalled();
  });

  it('MCP approve_supplier_invoice: refused before the bill is read', async () => {
    const out = await approveSupplierInvoiceTool.handler({ invoice_id: BILL, idempotency_key: 'k1' }, mcpCtx('manager'));
    expect(out.isError).toBe(true);
    expect(out.content[0]!.text).toMatch(/permission to approve supplier invoices/);
    expect(getSupplierInvoiceById).not.toHaveBeenCalled();
    expect(approveViaWorkflow).not.toHaveBeenCalled();
  });

  it('MCP bulk_approve_supplier_invoices: refused before any bill is read', async () => {
    const out = await bulkApproveSupplierInvoicesTool.handler({ invoice_ids: [BILL], idempotency_key: 'k2' }, mcpCtx('manager'));
    expect(out.isError).toBe(true);
    expect(out.content[0]!.text).toMatch(/permission to approve supplier invoices/);
    expect(validateSystemAccounts).not.toHaveBeenCalled();
    expect(approveViaWorkflow).not.toHaveBeenCalled();
  });

  it('cancel is not an approval: the same manager still cancels', async () => {
    const res = await call(actionRoute, { action: 'cancel', invoiceId: BILL }, 'manager');
    expect(res.statusCode).not.toBe(403);
  });
});

describe('who may approve', () => {
  it('a manager with no permission row keeps the role default and approves', async () => {
    const res = await call(actionRoute, { action: 'approve', invoiceId: BILL }, 'manager');
    expect(res.statusCode).toBe(200);
    expect(approveSupplierInvoice).toHaveBeenCalledTimes(1);
  });

  it('a manager granted approve approves', async () => {
    suppliersRow = { can_approve: true };
    const res = await call(actionRoute, { action: 'approve', invoiceId: BILL }, 'manager');
    expect(res.statusCode).toBe(200);
  });

  it.each(['owner', 'admin'])('%s approves even with an unticked row (full access cannot be restricted)', async (role) => {
    suppliersRow = { can_approve: false };
    const res = await call(actionRoute, { action: 'approve', invoiceId: BILL }, role);
    expect(res.statusCode).toBe(200);
    expect(permissionReads).toEqual([]);
  });
});
