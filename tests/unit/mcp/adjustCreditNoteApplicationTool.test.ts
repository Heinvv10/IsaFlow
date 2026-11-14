/**
 * adjust_credit_note_application — the tool's own contract. The ledger
 * behaviour is pinned against a real database in
 * credit-note-application-adjust.int.test.ts; this file pins what only the tool
 * decides: argument refusals before any read, which failures become a toolError
 * (a refusal raised before any write) and which are rethrown so the registry
 * unwinds the savepoint, and that dry_run runs the plan, never the write, and
 * keeps the idempotency key free.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/modules/accounting/services/shared/creditNoteApplicationAdjust', async () => {
  class CreditNoteAdjustRefusal extends Error {}
  return {
    CreditNoteAdjustRefusal,
    planCreditNoteApplicationAdjust: vi.fn(),
    adjustCreditNoteApplication: vi.fn(),
  };
});

import {
  CreditNoteAdjustRefusal, adjustCreditNoteApplication, planCreditNoteApplicationAdjust,
} from '@/modules/accounting/services/shared/creditNoteApplicationAdjust';
import { adjustCreditNoteApplicationTool as tool } from '@/lib/mcp/tools/writeAdjustCreditNoteApplication';
import type { McpToolContext } from '@/lib/mcp/types';

const COMPANY = 'cccccccc-0000-4000-8000-cccccccccccc';
const NOTE = '0b0b0b0b-0000-4000-8000-000000000001';
const DOC = '0c0c0c0c-0000-4000-8000-000000000001';
const JE = '0d0d0d0d-0000-4000-8000-000000000001';
const ctx = { companyId: COMPANY, userId: 'u-1' } as McpToolContext;
const KEY = { idempotency_key: 'k-1' };
const ARGS = { credit_note_id: NOTE, document_id: DOC, ...KEY };

const plan = {
  creditNoteId: NOTE, creditNoteNumber: 'CN-1', side: 'customer' as const, creditNoteJournalId: JE,
  documentId: DOC, documentNumber: 'INV-1', appliedBefore: 60, appliedAfter: 25, change: -35,
  documentOutstandingBefore: 40, documentOutstandingAfter: 75, noteTotal: 100, notePosted: 100,
  noteAppliedBefore: 60, noteAppliedAfter: 25, noteRemainderAfter: 75, noteStatusAfter: 'partially_applied',
};

const text = (r: { content: { text: string }[] }) => r.content[0]!.text;

beforeEach(() => vi.clearAllMocks());

describe('adjust_credit_note_application', () => {
  it('is a write needing write:invoices and write:post, with every argument required', () => {
    expect(tool).toMatchObject({ write: true, requiresPost: true, scope: 'write:invoices' });
    expect((tool.inputSchema as { required: string[] }).required)
      .toEqual(['credit_note_id', 'document_id', 'new_amount', 'idempotency_key']);
  });

  it('refuses a missing or non-uuid id before any read', async () => {
    expect(text(await tool.handler({ document_id: DOC, new_amount: 1, ...KEY }, ctx))).toBe('credit_note_id is required');
    expect(text(await tool.handler({ credit_note_id: NOTE, new_amount: 1, ...KEY }, ctx))).toBe('document_id is required');
    expect((await tool.handler({ ...ARGS, credit_note_id: 'x', new_amount: 1 }, ctx)).isError).toBe(true);
    expect(planCreditNoteApplicationAdjust).not.toHaveBeenCalled();
    expect(adjustCreditNoteApplication).not.toHaveBeenCalled();
  });

  it('refuses a missing, negative, non-numeric or sub-cent new_amount before any read', async () => {
    for (const newAmount of [undefined, -1, '10', 10.005, Number.NaN, 1e20]) {
      const r = await tool.handler({ ...ARGS, new_amount: newAmount }, ctx);
      expect(text(r)).toBe('new_amount must be zero or a positive amount in whole cents');
    }
    expect(adjustCreditNoteApplication).not.toHaveBeenCalled();
  });

  it('accepts 0 — take the whole application back', async () => {
    vi.mocked(adjustCreditNoteApplication).mockResolvedValue({ ...plan, appliedAfter: 0, change: -60 });
    await tool.handler({ ...ARGS, new_amount: 0 }, ctx);
    expect(adjustCreditNoteApplication).toHaveBeenCalledWith(
      COMPANY, { creditNoteId: NOTE, documentId: DOC, newAmount: 0 }, 'u-1');
  });

  it('dry_run runs the plan, never the write, and keeps the idempotency key free', async () => {
    vi.mocked(planCreditNoteApplicationAdjust).mockResolvedValue(plan);
    const r = await tool.handler({ ...ARGS, new_amount: 25, dry_run: true }, ctx);

    expect(adjustCreditNoteApplication).not.toHaveBeenCalled();
    expect((r as { wroteNothing?: boolean }).wroteNothing).toBe(true);
    const body = JSON.parse(text(r)) as { journals: unknown[]; effects: unknown[] };
    expect(body.journals).toEqual([]);
    expect(body.effects).toEqual([
      expect.objectContaining({ entityType: 'customer_invoice', field: 'outstanding', before: 40, after: 75 }),
      expect.objectContaining({ field: 'credit_note_applied', before: 60, after: 25 }),
      expect.objectContaining({ entityId: NOTE, field: 'credit_note_applied_amount', before: 60, after: 25 }),
    ]);
  });

  it('reports no journal, the note\'s own journal and the call that undoes it', async () => {
    vi.mocked(adjustCreditNoteApplication).mockResolvedValue(plan);
    const r = await tool.handler({ ...ARGS, new_amount: 25 }, ctx);

    expect((r as { wroteNothing?: boolean }).wroteNothing).toBeUndefined();
    expect(JSON.parse(text(r))).toMatchObject({
      journal_posted: false, reversal_journal_id: null, new_journal_id: null, credit_note_journal_id: JE,
      applied_before: 60, applied_after: 25, change: -35, note_status_after: 'partially_applied',
      undo: { credit_note_id: NOTE, document_id: DOC, new_amount: 60 },
    });
  });

  it('returns a refusal as a toolError, and a missing note or document as the shared NOT_FOUND', async () => {
    vi.mocked(adjustCreditNoteApplication).mockRejectedValueOnce(
      new CreditNoteAdjustRefusal('Document INV-1 belongs to a different customer than credit note CN-1.'));
    const r = await tool.handler({ ...ARGS, new_amount: 25 }, ctx);
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('different customer');

    for (const msg of ['Credit note not found.', 'Document not found.']) {
      vi.mocked(planCreditNoteApplicationAdjust).mockRejectedValueOnce(new CreditNoteAdjustRefusal(msg));
      expect(text(await tool.handler({ ...ARGS, new_amount: 25, dry_run: true }, ctx))).toBe('Not found');
    }
  });

  it('RETHROWS anything that is not a refusal, so the registry unwinds the savepoint', async () => {
    vi.mocked(adjustCreditNoteApplication).mockRejectedValue(new Error('would have R100.00 applied'));
    await expect(tool.handler({ ...ARGS, new_amount: 100 }, ctx)).rejects.toThrow('would have R100.00 applied');
  });
});
