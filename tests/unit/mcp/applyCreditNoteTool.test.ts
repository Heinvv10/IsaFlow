/**
 * apply_credit_note — the tool's own contract. The ledger behaviour is pinned
 * against a real database in credit-note-to-document.int.test.ts; this file
 * pins what only the tool decides: which failures become a toolError (a
 * refusal raised before any write) and which are rethrown so the registry
 * unwinds the savepoint, and that dry_run runs the plan and never the write.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/modules/accounting/services/shared/creditNoteDocumentApply', async () => {
  class CreditNoteApplyRefusal extends Error {}
  return {
    CreditNoteApplyRefusal,
    planCreditNoteToDocument: vi.fn(),
    applyCreditNoteToDocument: vi.fn(),
  };
});

import {
  CreditNoteApplyRefusal, applyCreditNoteToDocument, planCreditNoteToDocument,
} from '@/modules/accounting/services/shared/creditNoteDocumentApply';
import { applyCreditNoteTool } from '@/lib/mcp/tools/writeApplyCreditNote';
import type { McpToolContext } from '@/lib/mcp/types';

const COMPANY = 'cccccccc-0000-4000-8000-cccccccccccc';
const NOTE = '0b0b0b0b-0000-4000-8000-000000000001';
const INV = '0c0c0c0c-0000-4000-8000-000000000001';
const ctx = { companyId: COMPANY, userId: 'u-1' } as McpToolContext;
const KEY = { idempotency_key: 'k-1' };

const plan = {
  creditNoteId: NOTE, creditNoteNumber: 'CN-1', side: 'supplier' as const,
  invoiceId: INV, invoiceNumber: 'BILL-1', amount: 50,
  noteTotal: 80, noteAppliedBefore: 0, noteAppliedAfter: 50, noteRemainderAfter: 30,
  noteStatusAfter: 'partially_applied', invoiceOutstandingBefore: 50, invoiceOutstandingAfter: 0,
};

const text = (r: { content: { text: string }[] }) => r.content[0]!.text;

beforeEach(() => vi.clearAllMocks());

describe('apply_credit_note', () => {
  it('refuses a missing or non-uuid id before any read', async () => {
    expect(text(await applyCreditNoteTool.handler({ invoice_id: INV, ...KEY }, ctx))).toBe('credit_note_id is required');
    const r = await applyCreditNoteTool.handler({ credit_note_id: 'x', invoice_id: INV, ...KEY }, ctx);
    expect(r.isError).toBe(true);
    expect(planCreditNoteToDocument).not.toHaveBeenCalled();
    expect(applyCreditNoteToDocument).not.toHaveBeenCalled();
  });

  it('refuses a non-positive or non-numeric amount before any read', async () => {
    for (const amount of [0, -5, '10']) {
      const r = await applyCreditNoteTool.handler({ credit_note_id: NOTE, invoice_id: INV, amount, ...KEY }, ctx);
      expect(text(r)).toBe('amount must be a positive number');
    }
    expect(applyCreditNoteToDocument).not.toHaveBeenCalled();
  });

  it('dry_run runs the plan, never the write, and keeps the idempotency key free', async () => {
    vi.mocked(planCreditNoteToDocument).mockResolvedValue(plan);
    const r = await applyCreditNoteTool.handler({ credit_note_id: NOTE, invoice_id: INV, dry_run: true, ...KEY }, ctx);

    expect(applyCreditNoteToDocument).not.toHaveBeenCalled();
    expect((r as { wroteNothing?: boolean }).wroteNothing).toBe(true);
    const body = JSON.parse(text(r)) as { effects: { field: string; before: number; after: number }[]; journals: unknown[] };
    expect(body.journals).toEqual([]);
    expect(body.effects).toEqual([
      expect.objectContaining({ entityType: 'supplier_invoice', field: 'outstanding', before: 50, after: 0 }),
      expect.objectContaining({ field: 'credit_note_remainder', before: 80, after: 30 }),
    ]);
  });

  it('passes amount through and reports that no journal posted', async () => {
    vi.mocked(applyCreditNoteToDocument).mockResolvedValue(plan);
    const r = await applyCreditNoteTool.handler({ credit_note_id: NOTE, invoice_id: INV, amount: 50, ...KEY }, ctx);

    expect(applyCreditNoteToDocument).toHaveBeenCalledWith(COMPANY, { creditNoteId: NOTE, invoiceId: INV, amount: 50 }, 'u-1');
    expect(JSON.parse(text(r))).toMatchObject({ journal_posted: false, amount_applied: 50, note_remainder_after: 30 });
  });

  it('returns a refusal as a toolError — it is raised before anything is written', async () => {
    vi.mocked(applyCreditNoteToDocument).mockRejectedValue(
      new CreditNoteApplyRefusal('Invoice BILL-1 belongs to a different supplier than credit note CN-1.'),
    );
    const r = await applyCreditNoteTool.handler({ credit_note_id: NOTE, invoice_id: INV, ...KEY }, ctx);
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('different supplier');
  });

  it('answers a missing note or invoice with the shared NOT_FOUND text — no existence oracle', async () => {
    for (const msg of ['Credit note not found.', 'Invoice not found.']) {
      vi.mocked(applyCreditNoteToDocument).mockRejectedValueOnce(new CreditNoteApplyRefusal(msg));
      expect(text(await applyCreditNoteTool.handler({ credit_note_id: NOTE, invoice_id: INV, ...KEY }, ctx))).toBe('Not found');
    }
  });

  it('RETHROWS anything that is not a refusal, so the registry unwinds the savepoint', async () => {
    vi.mocked(applyCreditNoteToDocument).mockRejectedValue(Object.assign(new Error('deadlock'), { code: '40P01' }));
    await expect(applyCreditNoteTool.handler({ credit_note_id: NOTE, invoice_id: INV, ...KEY }, ctx))
      .rejects.toThrow('deadlock');
  });
});
