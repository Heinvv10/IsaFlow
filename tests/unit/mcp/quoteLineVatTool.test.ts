/**
 * create_draft_quote and per-line VAT (migration 1024): it declares and carries each line's `vat_type` and the header
 * `amounts_are` to createQuote (the service holds them to the contract, quoteLineTax), refuses an amounts_are that is not
 * one of the two before the service, and a VAT refusal reaches the agent as its registered code.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/modules/accounting/services/ar/quoteService', () => ({
  createQuote: vi.fn(),
  LineValidationError: class LineValidationError extends Error {},
}));

import { createQuote } from '@/modules/accounting/services/ar/quoteService';
import { InvoiceVatNotRegisteredRefusal } from '@/modules/accounting/services/ar/invoiceLineVatTypes';
import { createDraftQuoteTool } from '@/lib/mcp/tools/writeInvoices';
import { safeErrorText } from '@/lib/mcp/tools/toolHelpers';
import type { McpToolContext } from '@/lib/mcp/types';

const ctx = { companyId: '11111111-1111-4111-8111-111111111111', userId: 'u1', scopes: ['write:invoices'] } as unknown as McpToolContext;
const create = createQuote as unknown as ReturnType<typeof vi.fn>;
const run = (args: Record<string, unknown>) => createDraftQuoteTool.handler({ customer_name: 'Acme', idempotency_key: 'k', ...args }, ctx);

beforeEach(() => { create.mockReset(); create.mockResolvedValue({ id: 'q1' }); });

describe('create_draft_quote: per-line VAT', () => {
  it('declares vat_type (the three document line types) and amounts_are', () => {
    const schema = createDraftQuoteTool.inputSchema as { properties: Record<string, { enum?: string[]; items?: { properties: Record<string, { enum?: string[]; description?: string }> } }> };
    expect(schema.properties.items!.items!.properties.vat_type!.enum).toEqual(['standard', 'zero_rated', 'exempt']);
    expect(schema.properties.items!.items!.properties.vat_type!.description).toMatch(/rate comes from the type and the quote date/);
    expect(schema.properties.amounts_are!.enum).toEqual(['exclusive', 'inclusive']);
    expect(createDraftQuoteTool.description).toMatch(/items\[\]\.vat_type/);
  });

  it('carries each line\'s vat_type as sent (absent stays absent) and amounts_are', async () => {
    await run({ amounts_are: 'inclusive', items: [{ description: 'A', unit_price: 115, vat_type: 'standard' }, { description: 'B', unit_price: 1 }] });
    const input = create.mock.calls[0]![1] as { amountsAre: unknown; lines: Record<string, unknown>[] };
    expect(input.amountsAre).toBe('inclusive');
    expect(input.lines.map((l) => l.vatType)).toEqual(['standard', undefined]);
    expect('vatType' in input.lines[1]!).toBe(false);
  });

  it('refuses an amounts_are that is not exclusive or inclusive, without calling the service', async () => {
    const r = await run({ amounts_are: 'gross', items: [{ description: 'A', unit_price: 1 }] });
    expect(r.isError).toBe(true);
    expect(create).not.toHaveBeenCalled();
  });

  it('a VAT refusal propagates (the registry rolls back) and its wording is shown as a registered code', async () => {
    const err = new InvoiceVatNotRegisteredRefusal('items[0] is standard-rated, but this company is not registered for VAT, so its quotes carry no VAT: leave vatType out.');
    create.mockRejectedValueOnce(err);
    await expect(run({ items: [{ description: 'A', unit_price: 1, vat_type: 'standard' }] })).rejects.toBe(err);
    expect(safeErrorText(err, 'hidden')).toContain('its quotes carry no VAT');
  });
});
