/**
 * void_receipt / void_payment.
 *
 * What is worth pinning:
 *
 *  - both stamp their own tool name. Without it reverseJournalEntry falls back
 *    to defaultHumanMeta(userId), labelling agent work as the token owner's own
 *    and hiding it from list_agent_postings.
 *  - both are `requiresPost`: voiding a posted receipt writes a reversing
 *    journal, which is the authority reverse_bank_allocation asks for.
 *  - a foreign document is refused with the generic miss text, never a distinct
 *    "belongs to another company" that would be an existence oracle.
 *  - the handler does NOT catch. A refusal is audited with a NULL idempotency
 *    key, so a catch-and-return after the journal was reversed would let the
 *    agent's retry on that key void a second time.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/modules/accounting/services/core/paymentVoidService', async () => {
  const actual = await vi.importActual<
    typeof import('@/modules/accounting/services/core/paymentVoidService')
  >('@/modules/accounting/services/core/paymentVoidService');
  return { ...actual, voidPaymentDocument: vi.fn() };
});

import { voidPaymentDocument } from '@/modules/accounting/services/core/paymentVoidService';
import { voidReceiptTool, voidPaymentTool } from '@/lib/mcp/tools/writeVoidPayments';
import type { McpToolContext, McpToolResult } from '@/lib/mcp/types';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const DOC = '77777777-7777-4777-8777-777777777777';
const APPROVAL = '99999999-9999-4999-8999-999999999999';
const KEY = { idempotency_key: 'k1', approval_id: APPROVAL };

function ctx(): McpToolContext {
  return {
    userId: '44444444-4444-4444-8444-444444444444',
    companyId: COMPANY,
    scopes: ['write:invoices', 'write:post'],
    tokenJti: 'jti',
    oauthAppId: null,
  } as McpToolContext;
}

function parseOk(r: McpToolResult): Record<string, unknown> {
  expect(r.isError).toBeFalsy();
  return JSON.parse(r.content[0]!.text) as Record<string, unknown>;
}
function errText(r: McpToolResult): string {
  expect(r.isError).toBe(true);
  return r.content[0]!.text;
}

const VOIDED = {
  paymentId: DOC,
  paymentNumber: 'CP-2025-00024',
  kind: 'customer' as const,
  invoicesReopened: 2,
  amountUnapplied: 1500,
  journalEntryId: '88888888-8888-4888-8888-888888888888',
  bankTransactionId: null,
};

describe('void_receipt / void_payment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(voidPaymentDocument).mockResolvedValue(VOIDED);
  });

  it('declares and forwards approved operation identities to the shared void boundary', async () => {
    for (const [tool, idKey] of [[voidReceiptTool, 'receipt_id'], [voidPaymentTool, 'payment_id']] as const) {
      expect(tool.inputSchema.required).toContain('approval_id');
      await tool.handler({ [idKey]: DOC, ...KEY, intent_id: DOC, reason: 'Correct duplicate payment' }, ctx());
      expect(vi.mocked(voidPaymentDocument).mock.lastCall?.[4]).toMatchObject({
        approvalId: APPROVAL, intentId: DOC, reason: 'Correct duplicate payment',
      });
    }
  });

  it('rejects missing or malformed approval and inverse identities before dispatch', async () => {
    expect(errText(await voidReceiptTool.handler({ receipt_id: DOC, idempotency_key: 'k1' }, ctx())))
      .toBe('approval_id is required');
    expect(errText(await voidReceiptTool.handler({ receipt_id: DOC, ...KEY, approval_id: 'bad' }, ctx())))
      .toBe('invalid approval_id');
    expect(errText(await voidPaymentTool.handler({ payment_id: DOC, ...KEY, intent_id: 'bad' }, ctx())))
      .toBe('invalid intent_id');
    expect(voidPaymentDocument).not.toHaveBeenCalled();
  });

  it('both require write:post — a void writes a reversing journal', () => {
    expect(voidReceiptTool.requiresPost).toBe(true);
    expect(voidPaymentTool.requiresPost).toBe(true);
  });

  it('voids a receipt and reports what moved', async () => {
    const r = await voidReceiptTool.handler({ receipt_id: DOC, ...KEY }, ctx());
    const out = parseOk(r);
    expect(out.voided).toBe(true);
    expect(out.receipt_id).toBe(DOC);
    expect(out.invoices_reopened).toBe(2);
    expect(out.amount_unapplied).toBe(1500);
  });

  it('addresses the customer subledger from void_receipt', async () => {
    await voidReceiptTool.handler({ receipt_id: DOC, ...KEY }, ctx());
    expect(vi.mocked(voidPaymentDocument).mock.calls[0]!.slice(0, 3))
      .toEqual([COMPANY, 'customer', DOC]);
  });

  it('addresses the supplier subledger from void_payment', async () => {
    await voidPaymentTool.handler({ payment_id: DOC, ...KEY }, ctx());
    expect(vi.mocked(voidPaymentDocument).mock.calls[0]!.slice(0, 3))
      .toEqual([COMPANY, 'supplier', DOC]);
  });

  it('stamps the tool name so the void shows in list_agent_postings', async () => {
    await voidReceiptTool.handler({ receipt_id: DOC, ...KEY }, ctx());
    const opts = vi.mocked(voidPaymentDocument).mock.calls[0]![4] as { postingAgent?: string };
    expect(opts.postingAgent).toContain('void_receipt');
  });

  it('forwards an explicit reversal_date, and omits it otherwise', async () => {
    await voidReceiptTool.handler({ receipt_id: DOC, reversal_date: '2026-03-01', ...KEY }, ctx());
    expect((vi.mocked(voidPaymentDocument).mock.calls[0]![4] as Record<string, unknown>).reversalDate)
      .toBe('2026-03-01');

    vi.clearAllMocks();
    vi.mocked(voidPaymentDocument).mockResolvedValue(VOIDED);
    await voidReceiptTool.handler({ receipt_id: DOC, ...KEY }, ctx());
    expect(vi.mocked(voidPaymentDocument).mock.calls[0]![4] as Record<string, unknown>)
      .not.toHaveProperty('reversalDate');
  });

  it('refuses a foreign or missing document with the generic miss text', async () => {
    vi.mocked(voidPaymentDocument).mockResolvedValue({ refusal: 'not_found' });
    expect(errText(await voidReceiptTool.handler({ receipt_id: DOC, ...KEY }, ctx())))
      .toBe('Not found');
  });

  it('refuses an already-cancelled document distinctly', async () => {
    vi.mocked(voidPaymentDocument).mockResolvedValue({ refusal: 'already_cancelled' });
    expect(errText(await voidReceiptTool.handler({ receipt_id: DOC, ...KEY }, ctx())))
      .toBe('This document is already cancelled.');
  });

  it('refuses a malformed id before reaching the service', async () => {
    expect(errText(await voidReceiptTool.handler({ receipt_id: 'nope', ...KEY }, ctx())))
      .toBe('invalid receipt_id');
    expect(errText(await voidReceiptTool.handler({ receipt_id: DOC, reversal_date: '2026-02-31', ...KEY }, ctx())))
      .toBe('invalid reversal_date');
    expect(errText(await voidReceiptTool.handler({ ...KEY }, ctx())))
      .toBe('receipt_id is required');
    expect(voidPaymentDocument).not.toHaveBeenCalled();
  });

  it('does NOT catch a service failure — the savepoint must see it', async () => {
    vi.mocked(voidPaymentDocument).mockRejectedValue(new Error('period is closed'));
    await expect(voidReceiptTool.handler({ receipt_id: DOC, ...KEY }, ctx()))
      .rejects.toThrow('period is closed');
  });
});
