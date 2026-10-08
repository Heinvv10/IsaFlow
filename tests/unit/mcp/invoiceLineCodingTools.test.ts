/**
 * The MCP customer-invoice create tools and line coding (migration 873),
 * through their HANDLERS: the header project_id reaches the service, a coding
 * refusal is the registered INVOICE_LINE_CODING_REFUSED (bulk: named by
 * element), and an unknown line key — camelCase glAccountId — is refused
 * instead of silently dropped.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => []), withSavepoint: vi.fn(async (_n: string, fn: () => unknown) => fn()) }));
vi.mock('@/modules/accounting/services/ar/customerInvoiceCreateService', () => ({
  createDraftCustomerInvoice: vi.fn(),
  InvoiceLineValidationError: class InvoiceLineValidationError extends Error {},
}));
vi.mock('@/modules/accounting/services/core/contactDirectoryService', () => ({ customerBelongsToCompany: vi.fn(async () => true) }));

import { createDraftCustomerInvoice } from '@/modules/accounting/services/ar/customerInvoiceCreateService';
import { createDraftInvoiceTool } from '@/lib/mcp/tools/writeInvoices';
import { bulkCreateCustomerInvoicesTool } from '@/lib/mcp/tools/writeBulkCustomerInvoices';
import { InvoiceLineCodingRefusal } from '@/modules/accounting/services/ar/invoiceLineCoding';
import { isRefusalCoded } from '@/lib/mcp/tools/toolHelpers';
import type { McpToolContext } from '@/lib/mcp/types';

const create = vi.mocked(createDraftCustomerInvoice);
const ctx = { userId: 'u', companyId: 'c', scopes: ['write:invoices'], tokenJti: 'j', oauthAppId: null } as McpToolContext;
const CUSTOMER = '21d12090-6fd3-44b1-8c7a-5ea3e84254bb';
const PROJECT = 'bbbbbbbb-0000-4000-8000-bbbbbbbbbbbb';
const ACCOUNT = 'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa';
const one = (extra: Record<string, unknown> = {}, line: Record<string, unknown> = {}) =>
  ({ customer_id: CUSTOMER, items: [{ description: 'Spot', unit_price: 100, ...line }], ...extra });
type Res = { content: { text: string }[]; isError?: boolean };

beforeEach(() => {
  vi.clearAllMocks();
  create.mockResolvedValue({ id: 'inv-1', invoiceNumber: 'INV-1' });
});

describe('create_draft_invoice', () => {
  it('passes the header project_id and each line\'s coding to the service', async () => {
    await createDraftInvoiceTool.handler({ ...one({ project_id: PROJECT }, { gl_account_id: ACCOUNT }), idempotency_key: 'k' }, ctx);
    expect(create.mock.calls[0]![2]).toMatchObject({
      projectId: PROJECT,
      items: [{ glAccountId: ACCOUNT, projectId: null }],
    });
  });

  it('lets a coding refusal through as the registered INVOICE_LINE_CODING_REFUSED', async () => {
    create.mockRejectedValueOnce(new InvoiceLineCodingRefusal('An invoice line cannot be coded to 6100 Crew.'));
    const err = await createDraftInvoiceTool.handler({ ...one(), idempotency_key: 'k' }, ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvoiceLineCodingRefusal);
    expect(isRefusalCoded(err)).toBe(true);
  });

  it.each([
    ['glAccountId', 'gl_account_id'], ['projectId', 'project_id'], ['costCenterId', 'cc1, cc2 or bu'],
  ])('refuses the unknown line key %s, naming %s, before anything is written', async (camel, snake) => {
    const res = await createDraftInvoiceTool.handler({ ...one({}, { [camel]: ACCOUNT }), idempotency_key: 'k' }, ctx) as Res;
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain(`items[0] has "${camel}", which is not a line field — did you mean ${snake}?`);
    expect(create).not.toHaveBeenCalled();
  });
});

describe('an unknown line key is echoed safely', () => {
  it('bounded to 64 characters and JSON-quoted, whatever the caller sent', async () => {
    const key = `x"${'y'.repeat(200)}`;
    const res = await createDraftInvoiceTool.handler({ ...one({}, { [key]: 1 }), idempotency_key: 'k' }, ctx) as Res;
    expect(res.content[0]!.text).toContain(`items[0] has ${JSON.stringify(`${key.slice(0, 64)}…`)}, which is not a line field;`);
    expect(res.content[0]!.text).not.toContain('y'.repeat(70));
  });

  it.each(['constructor', '__proto__', 'toString'])('%s gets no "did you mean" from the prototype', async (key) => {
    const res = await createDraftInvoiceTool.handler(
      { ...one(), items: [JSON.parse(`{"description":"x","unit_price":1,${JSON.stringify(key)}:1}`)], idempotency_key: 'k' }, ctx) as Res;
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain(`items[0] has ${JSON.stringify(key)}, which is not a line field;`);
  });
});

describe('bulk_create_customer_invoices', () => {
  it('passes each element\'s header project_id to the service', async () => {
    await bulkCreateCustomerInvoicesTool.handler({ invoices: [one({ project_id: PROJECT }), one()], idempotency_key: 'k' }, ctx);
    expect(create.mock.calls.map((c) => (c[2] as { projectId: unknown }).projectId)).toEqual([PROJECT, null]);
  });

  it('a coding refusal is the registered code, named by element', async () => {
    create.mockResolvedValueOnce({ id: 'a', invoiceNumber: 'A' })
      .mockRejectedValueOnce(new InvoiceLineCodingRefusal('An invoice line cannot be coded to 6100 Crew.'));
    const err = await bulkCreateCustomerInvoicesTool.handler({ invoices: [one(), one()], idempotency_key: 'k' }, ctx)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvoiceLineCodingRefusal);
    expect((err as Error).message).toBe('invoices[1]: An invoice line cannot be coded to 6100 Crew.');
  });

  it('refuses an unknown line key in any element, before anything is written', async () => {
    const res = await bulkCreateCustomerInvoicesTool.handler({ invoices: [one(), one({}, { glAccountId: ACCOUNT })], idempotency_key: 'k' }, ctx) as Res;
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain('invoices[1].items[0] has "glAccountId", which is not a line field');
    expect(create).not.toHaveBeenCalled();
  });
});
