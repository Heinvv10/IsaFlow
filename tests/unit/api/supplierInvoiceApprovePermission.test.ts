/**
 * #1656: the per-module permissions (company_user_permissions) are enforced on supplier-invoice
 * approval. A manager whose Suppliers & AP "Approve" an owner or admin unticked cannot approve a
 * bill on any person's path (the single route, the bulk route, the MCP approve and bulk-approve
 * tools); nothing of the bill is read or written. A manager with no row keeps the role default
 * (approve), and owner/admin always may. The decision is read from the database (the user's stored
 * role in the request's company, then their row), never from the request's role: a viewer, and a
 * former bookkeeper (manager without approve, Hein 2026-11-19), are refused; and the read names the
 * request's company, so a grant in another company does not count.
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
import { approveSupplierInvoice, cancelSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceService';
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
import { permissionDb, permissionSql } from '../helpers/permissionSqlMock';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const OTHER_COMPANY = '22222222-2222-4222-8222-222222222222';
const USER = '99999999-9999-4999-8999-999999999999';
const BILL = '66666666-6666-4666-8666-666666666666';

let db = permissionDb();
/** USER's stored role in COMPANY, and optionally their Suppliers & AP row there. */
function member(role: string, suppliers?: { can_approve: boolean }, company = COMPANY) {
  db.members.set(`${company}:${USER}`, role);
  if (suppliers) db.rows.set(`${company}:${USER}:suppliers`, { can_read: true, can_write: true, can_delete: false, can_export: true, ...suppliers });
}

function call(handler: unknown, body: unknown, companyRole = 'manager') {
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

const mcpCtx = (companyRole = 'manager'): McpToolContext =>
  ({ companyId: COMPANY, userId: USER, companyRole, scopes: ['write:invoices', 'write:post'], tokenJti: 'jti-1656', oauthAppId: null });

beforeEach(() => {
  vi.clearAllMocks();
  db = permissionDb();
  vi.mocked(sql).mockImplementation(permissionSql(db) as never);
  vi.mocked(approveSupplierInvoice).mockResolvedValue({ id: BILL, status: 'approved' } as never);
  vi.mocked(validateSystemAccounts).mockResolvedValue([] as never);
});

describe('a manager whose Suppliers & AP approve is unticked cannot approve a bill', () => {
  beforeEach(() => { member('manager', { can_approve: false }); });

  it('single route: 403, the bill is never approved', async () => {
    const res = await call(actionRoute, { action: 'approve', invoiceId: BILL });
    expect(res.statusCode).toBe(403);
    expect(JSON.stringify(res.sent)).toMatch(/permission to approve supplier invoices/);
    expect(approveSupplierInvoice).not.toHaveBeenCalled();
    expect(db.reads).toEqual([{ companyId: COMPANY, userId: USER, moduleKey: 'suppliers' }]);
  });

  it('bulk route: 403 for the whole batch, nothing approved', async () => {
    const res = await call(bulkRoute, { action: 'approve', invoiceIds: [BILL] });
    expect(res.statusCode).toBe(403);
    expect(approveSupplierInvoice).not.toHaveBeenCalled();
  });

  it('MCP approve_supplier_invoice: refused before the bill is read', async () => {
    const out = await approveSupplierInvoiceTool.handler({ invoice_id: BILL, idempotency_key: 'k1' }, mcpCtx());
    expect(out.isError).toBe(true);
    expect(out.content[0]!.text).toMatch(/permission to approve supplier invoices/);
    expect(getSupplierInvoiceById).not.toHaveBeenCalled();
    expect(approveViaWorkflow).not.toHaveBeenCalled();
  });

  it('MCP bulk_approve_supplier_invoices: refused before any bill is read', async () => {
    const out = await bulkApproveSupplierInvoicesTool.handler({ invoice_ids: [BILL], idempotency_key: 'k2' }, mcpCtx());
    expect(out.isError).toBe(true);
    expect(out.content[0]!.text).toMatch(/permission to approve supplier invoices/);
    expect(validateSystemAccounts).not.toHaveBeenCalled();
    expect(approveViaWorkflow).not.toHaveBeenCalled();
  });

  // #1656 (Hein: gate everything): cancelling an approved bill reverses its journal, so it asks Approve like approving does.
  it('cancel asks the same Approve: refused, the bill is never cancelled', async () => {
    const res = await call(actionRoute, { action: 'cancel', invoiceId: BILL });
    expect(res.statusCode).toBe(403);
    expect(JSON.stringify(res.sent)).toMatch(/permission to approve supplier invoices/);
    expect(cancelSupplierInvoice).not.toHaveBeenCalled();
  });

  it('cancel goes through for a manager whose Approve is not unticked', async () => {
    db.rows.clear();
    member('manager');
    vi.mocked(cancelSupplierInvoice).mockResolvedValue({ id: BILL, status: 'cancelled' } as never);
    const res = await call(actionRoute, { action: 'cancel', invoiceId: BILL });
    expect(res.statusCode).toBe(200);
    expect(cancelSupplierInvoice).toHaveBeenCalledTimes(1);
  });
});

describe('who may approve, read from the database', () => {
  it('a manager with no permission row keeps the role default and approves', async () => {
    member('manager');
    const res = await call(actionRoute, { action: 'approve', invoiceId: BILL });
    expect(res.statusCode).toBe(200);
    expect(approveSupplierInvoice).toHaveBeenCalledTimes(1);
  });

  it('a manager granted approve approves', async () => {
    member('manager', { can_approve: true });
    expect((await call(actionRoute, { action: 'approve', invoiceId: BILL })).statusCode).toBe(200);
  });

  it.each(['owner', 'admin'])('%s approves even with an unticked row (full access cannot be restricted)', async (role) => {
    member(role, { can_approve: false });
    expect((await call(actionRoute, { action: 'approve', invoiceId: BILL }, role)).statusCode).toBe(200);
    expect(approveSupplierInvoice).toHaveBeenCalledTimes(1);
  });

  it('a viewer is refused (the stored role decides, not the request)', async () => {
    member('viewer');
    expect((await call(actionRoute, { action: 'approve', invoiceId: BILL }, 'manager')).statusCode).toBe(403);
    expect(approveSupplierInvoice).not.toHaveBeenCalled();
  });

  it.each(['bookkeeper', 'accountant'])('a stored %s (manager without approve, #1656) is refused even with no row', async (role) => {
    member(role);
    expect((await call(actionRoute, { action: 'approve', invoiceId: BILL }, 'manager')).statusCode).toBe(403);
    expect(approveSupplierInvoice).not.toHaveBeenCalled();
  });

  it("a grant in another company does not count: the read names the request's company", async () => {
    member('manager', { can_approve: false });
    member('manager', { can_approve: true }, OTHER_COMPANY);
    expect((await call(actionRoute, { action: 'approve', invoiceId: BILL })).statusCode).toBe(403);
    expect(db.reads.map((r) => r.companyId)).toEqual([COMPANY]);
  });

  it('a user who is no member of the company is refused', async () => {
    member('owner', undefined, OTHER_COMPANY);
    expect((await call(actionRoute, { action: 'approve', invoiceId: BILL }, 'owner')).statusCode).toBe(403);
  });
});
