/**
 * The four MCP contact write tools (moved out of cashApplicationTools.test.ts,
 * unchanged, to hold that file under the 300-line cap).
 *
 *  - **The contact update tools check ownership before the write** and answer a
 *    foreign id with the shared NOT_FOUND constant, never a distinct message —
 *    a distinct one is an existence oracle.
 *  - **They sit on write:contacts, not write:invoices**, because a supplier's
 *    bank account number is editable through them.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/modules/accounting/services/core/customerWriteService', async () => {
  const actual = await vi.importActual<
    typeof import('@/modules/accounting/services/core/customerWriteService')
  >('@/modules/accounting/services/core/customerWriteService');
  return {
    ...actual,
    createCustomer: vi.fn(),
    updateCustomer: vi.fn(),
  };
});
vi.mock('@/modules/accounting/services/core/supplierWriteService', () => ({
  createSupplier: vi.fn(),
  updateSupplier: vi.fn(),
}));
vi.mock('@/modules/accounting/services/core/contactDirectoryService', () => ({
  customerBelongsToCompany: vi.fn(),
  supplierBelongsToCompany: vi.fn(),
}));

import {
  createCustomer,
  updateCustomer,
} from '@/modules/accounting/services/core/customerWriteService';
import {
  createSupplier,
  updateSupplier,
} from '@/modules/accounting/services/core/supplierWriteService';
import {
  customerBelongsToCompany,
  supplierBelongsToCompany,
} from '@/modules/accounting/services/core/contactDirectoryService';
import {
  createCustomerTool,
  updateCustomerTool,
  createSupplierTool,
  updateSupplierTool,
} from '@/lib/mcp/tools/writeContacts';
import type { McpToolContext, McpToolResult } from '@/lib/mcp/types';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const SUPPLIER = '22222222-2222-4222-8222-222222222222';
const CUSTOMER = '88888888-8888-4888-8888-888888888888';
const KEY = { idempotency_key: 'k1' };

function ctx(): McpToolContext {
  return {
    userId: '99999999-9999-4999-8999-999999999999',
    companyId: COMPANY,
    scopes: ['write:invoices', 'write:post', 'write:contacts'],
    tokenJti: 'jti',
    oauthAppId: null,
  };
}
function errText(r: McpToolResult): string {
  expect(r.isError).toBe(true);
  return r.content[0]!.text;
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe('contact write tools', () => {
  it('all four sit on write:contacts and post nothing', () => {
    for (const t of [createCustomerTool, updateCustomerTool, createSupplierTool, updateSupplierTool]) {
      expect(t.scope).toBe('write:contacts');
      expect(t.write).toBe(true);
      expect(t.requiresPost).toBeUndefined();
    }
  });

  it('create_customer refuses a blank name before any write', async () => {
    expect(errText(await createCustomerTool.handler({ ...KEY, name: '  ' }, ctx())))
      .toMatch(/name is required/i);
    expect(createCustomer).not.toHaveBeenCalled();
  });

  it('CHECKS OWNERSHIP BEFORE UPDATING and answers a foreign id with the generic miss', async () => {
    vi.mocked(customerBelongsToCompany).mockResolvedValue(false);
    expect(await updateCustomerTool.handler({ ...KEY, customer_id: CUSTOMER, phone: '1' }, ctx()))
      .toMatchObject({ isError: true, content: [{ type: 'text', text: 'Not found' }] });
    expect(updateCustomer).not.toHaveBeenCalled();
  });

  it('update_supplier checks ownership too, and passes registered_name through', async () => {
    vi.mocked(supplierBelongsToCompany).mockResolvedValue(true);
    vi.mocked(updateSupplier).mockResolvedValue({ id: SUPPLIER, name: 'Acme', is_active: true });
    await updateSupplierTool.handler(
      { ...KEY, supplier_id: SUPPLIER, registered_name: 'Acme Holdings (Pty) Ltd' }, ctx(),
    );
    expect(vi.mocked(updateSupplier).mock.calls[0]![0]).toBe(COMPANY);
    expect(vi.mocked(updateSupplier).mock.calls[0]![2].companyName).toBe('Acme Holdings (Pty) Ltd');
  });

  it('no contact tool declares an opening_balance argument', () => {
    // An opening balance is the figure the books were opened with; changing it
    // after documents exist silently restates every period since.
    for (const t of [createCustomerTool, updateCustomerTool, createSupplierTool, updateSupplierTool]) {
      const props = Object.keys(
        (t.inputSchema as { properties?: Record<string, unknown> }).properties ?? {},
      );
      expect(props).not.toContain('opening_balance');
    }
  });

  it('a malformed id refuses before it reaches a ::UUID cast', async () => {
    expect(errText(await updateCustomerTool.handler({ ...KEY, customer_id: 'x' }, ctx())))
      .toBe('invalid customer_id');
    expect(customerBelongsToCompany).not.toHaveBeenCalled();
  });

  it('create_supplier surfaces the service validation error as a refusal, not a failure', async () => {
    vi.mocked(createSupplier).mockRejectedValue(
      Object.assign(new Error('Supplier name must not exceed 255 characters'), {
        name: 'ContactValidationError',
      }),
    );
    // A plain Error is NOT a ContactValidationError, so it must propagate rather
    // than be swallowed into a refusal — that is the write-vs-refuse boundary.
    await expect(createSupplierTool.handler({ ...KEY, name: 'Acme' }, ctx())).rejects.toThrow();
  });
});
