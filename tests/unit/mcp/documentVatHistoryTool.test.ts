/**
 * document_vat_history (brief step 5a): handler wiring and the registry's scope fence. The figures are
 * proven against a real schema in tests/integration/document-vat-history.int.test.ts.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@/modules/accounting/services/reports/documentVatHistory', () => ({
  DOCUMENT_VAT_ENTITY_TYPES: ['supplier_invoice', 'customer_invoice', 'credit_note'],
  getDocumentVatHistory: vi.fn(),
}));
vi.mock('@/lib/mcp/audit', () => ({
  recordToolCall: vi.fn(async () => undefined), findIdempotentReplay: vi.fn(async () => null), hashArgs: vi.fn(() => 'h'),
}));

import { getDocumentVatHistory } from '@/modules/accounting/services/reports/documentVatHistory';
import { documentVatHistoryTool } from '@/lib/mcp/tools/documentVatHistory';
import { McpRegistry } from '@/lib/mcp/registry';
import { flowOperationFor } from '@/lib/mcp/flowMetering';
import type { McpToolContext, McpToolResult } from '@/lib/mcp/types';

const COMPANY = 'cccccccc-0000-4000-8000-cccccccccccc';
const BILL = 'b1b1b1b1-0000-4000-8000-000000000001';
const ctx = (scopes = ['read:vat', 'read:invoices']) =>
  ({ companyId: COMPANY, userId: 'u', scopes, tokenJti: 'j', oauthAppId: null, companyRole: 'viewer' }) as unknown as McpToolContext;
const text = (r: McpToolResult) => r.content[0]!.text;
const HISTORY = { entity_type: 'supplier_invoice', entity_id: BILL, document_number: 'SIV3762', lines: [], totals: { vat_net_now: 0 } };

beforeEach(() => {
  vi.mocked(getDocumentVatHistory).mockReset();
  vi.mocked(getDocumentVatHistory).mockResolvedValue(HISTORY as never);
});

describe('document_vat_history', () => {
  it('is a free read needing read:vat AND read:invoices', () => {
    expect(documentVatHistoryTool.write).toBe(false);
    expect(documentVatHistoryTool.scope).toBe('read:vat');
    expect(documentVatHistoryTool.requiresScope).toBe('read:invoices');
    expect(flowOperationFor('document_vat_history', {})).toBeNull();
    expect(documentVatHistoryTool.description).toMatch(/HEURISTIC/);
  });

  it.each([[['read:invoices']], [['read:vat']]])('the registry refuses a token holding only %j, before the handler', async (scopes) => {
    const registry = new McpRegistry();
    registry.register(documentVatHistoryTool);
    const r = await registry.call('document_vat_history', { entity_type: 'supplier_invoice', entity_id: BILL }, ctx(scopes));
    expect(r.isError).toBe(true);
    expect(text(r)).toContain(scopes[0] === 'read:vat' ? 'read:invoices' : 'read:vat');
    expect(getDocumentVatHistory).not.toHaveBeenCalled();
  });

  it('the registry runs it for a viewer holding both scopes', async () => {
    const registry = new McpRegistry();
    registry.register(documentVatHistoryTool);
    const r = await registry.call('document_vat_history', { entity_type: 'supplier_invoice', entity_id: BILL }, ctx());
    expect(r.isError).toBeFalsy();
    expect(getDocumentVatHistory).toHaveBeenCalledTimes(1);
  });

  it('reads with the TOKEN company and returns the service\'s history', async () => {
    const r = await documentVatHistoryTool.handler({ entity_type: 'supplier_invoice', entity_id: BILL }, ctx());
    expect(getDocumentVatHistory).toHaveBeenCalledWith(COMPANY, 'supplier_invoice', BILL);
    expect(JSON.parse(text(r))).toEqual(HISTORY);
  });

  it('refuses a bad entity_type, a missing or non-uuid entity_id, before any read', async () => {
    expect(text(await documentVatHistoryTool.handler({ entity_type: 'bank_transaction', entity_id: BILL }, ctx())))
      .toMatch(/entity_type must be one of: supplier_invoice, customer_invoice, credit_note/);
    expect(text(await documentVatHistoryTool.handler({ entity_type: 'credit_note' }, ctx()))).toBe('entity_id is required');
    expect((await documentVatHistoryTool.handler({ entity_type: 'credit_note', entity_id: 'x' }, ctx())).isError).toBe(true);
    expect(getDocumentVatHistory).not.toHaveBeenCalled();
  });

  it('answers a missing or foreign document as the generic Not found', async () => {
    vi.mocked(getDocumentVatHistory).mockResolvedValue(null);
    const r = await documentVatHistoryTool.handler({ entity_type: 'customer_invoice', entity_id: BILL }, ctx());
    expect(r.isError).toBe(true);
    expect(text(r)).toBe('Not found');
  });
});
