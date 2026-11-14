/**
 * delete_draft_credit_note — the tool's own contract. The lock, the status re-read and the dependent-row handling are
 * pinned against a real database in delete-draft-credit-note.int.test.ts; this file pins what only the tool decides:
 * which failures become a toolError (the typed refusal, raised before any write) and which are rethrown so the
 * registry unwinds the savepoint, that the dry run runs the REAL delete inside a rolled-back savepoint and keeps the
 * idempotency key free, and that a foreign id reads exactly like a missing one.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/modules/accounting/services/ar/creditNoteDeleteService', async () => {
  class CreditNoteDeleteRefusal extends Error {
    constructor(readonly code: string, message: string) { super(message); }
  }
  return { CreditNoteDeleteRefusal, deleteDraftCreditNote: vi.fn() };
});
vi.mock('@/modules/accounting/services/core/rolledBackSavepoint', () => ({
  inRolledBackSavepoint: vi.fn(async (_name: string, fn: () => Promise<unknown>) => { await fn(); }),
}));

import {
  CreditNoteDeleteRefusal, deleteDraftCreditNote, type DeletedCreditNote,
} from '@/modules/accounting/services/ar/creditNoteDeleteService';
import { inRolledBackSavepoint } from '@/modules/accounting/services/core/rolledBackSavepoint';
import { deleteDraftCreditNoteTool } from '@/lib/mcp/tools/writeDeleteDraftCreditNote';
import type { McpToolContext } from '@/lib/mcp/types';

const COMPANY = 'cccccccc-0000-4000-8000-cccccccccccc';
const NOTE = '0b0b0b0b-0000-4000-8000-000000000001';
const ctx = { companyId: COMPANY, userId: 'u-1', companyRole: 'owner' } as McpToolContext;
const asRole = (companyRole: string | null | undefined) => ({ ...ctx, companyRole }) as McpToolContext;
const KEY = { idempotency_key: 'k-1' };
const text = (r: { content: { text: string }[] }) => r.content[0]!.text;
const refusal = (code: string, message: string) => new (CreditNoteDeleteRefusal as unknown as new (c: string, m: string) => Error)(code, message);

const deleted: DeletedCreditNote = {
  id: NOTE, creditNoteNumber: 'CN-2026-00007', type: 'supplier', creditDate: '2026-11-01', subtotal: 100, taxRate: 15,
  taxAmount: 15, totalAmount: 115, reason: 'return', clientId: null, supplierId: 's-1', customerInvoiceId: null,
  supplierInvoiceId: 'b-1', glAccountId: null, externalRef: 'X-1', externalDocumentNumber: null, externalSystem: 'sage',
  attachmentsDetached: 2,
};

beforeEach(() => {
  vi.mocked(deleteDraftCreditNote).mockReset();
  vi.mocked(inRolledBackSavepoint).mockClear();
  vi.mocked(deleteDraftCreditNote).mockResolvedValue(deleted);
});

describe('delete_draft_credit_note', () => {
  it('is a write:invoices tool that posts nothing (no write:post)', () => {
    expect(deleteDraftCreditNoteTool.name).toBe('delete_draft_credit_note');
    expect(deleteDraftCreditNoteTool.scope).toBe('write:invoices');
    expect(deleteDraftCreditNoteTool.write).toBe(true);
    expect(deleteDraftCreditNoteTool.requiresPost).toBeUndefined();
    expect(deleteDraftCreditNoteTool.inputSchema.required).toEqual(['credit_note_id', 'idempotency_key']);
  });

  it.each(['manager', 'viewer', 'member', null, undefined])('refuses role %s before any read, dry run alike', async (role) => {
    for (const extra of [{}, { dry_run: true }]) {
      const r = await deleteDraftCreditNoteTool.handler({ credit_note_id: NOTE, ...extra, ...KEY }, asRole(role));
      expect(r.isError).toBe(true);
      expect(text(r)).toBe('Only an owner or admin can delete a draft credit note.');
    }
    // Even a malformed id gets the role answer first: nothing about the call is examined.
    expect(text(await deleteDraftCreditNoteTool.handler({ credit_note_id: 'x', ...KEY }, asRole('manager')))).toContain('Only an owner or admin');
    expect(deleteDraftCreditNote).not.toHaveBeenCalled();
    expect(inRolledBackSavepoint).not.toHaveBeenCalled();
  });

  it.each(['owner', 'admin'])('lets %s through', async (role) => {
    expect((await deleteDraftCreditNoteTool.handler({ credit_note_id: NOTE, ...KEY }, asRole(role))).isError).toBeFalsy();
  });

  it('refuses a missing or non-uuid id before touching the service', async () => {
    expect(text(await deleteDraftCreditNoteTool.handler({ ...KEY }, ctx))).toBe('credit_note_id is required');
    expect((await deleteDraftCreditNoteTool.handler({ credit_note_id: 'x', ...KEY }, ctx)).isError).toBe(true);
    expect(deleteDraftCreditNote).not.toHaveBeenCalled();
  });

  it('deletes through the service for the token company and returns the values to re-create it', async () => {
    const r = await deleteDraftCreditNoteTool.handler({ credit_note_id: NOTE, ...KEY }, ctx);
    expect(r.isError).toBeFalsy();
    expect(r.wroteNothing).toBeUndefined();
    expect(deleteDraftCreditNote).toHaveBeenCalledWith(COMPANY, NOTE, 'u-1');
    expect(inRolledBackSavepoint).not.toHaveBeenCalled();
    const body = JSON.parse(text(r));
    expect(body).toMatchObject({ deleted: true, restorable: false });
    expect(body.note).toContain('cannot be restored');
    expect(body.deleted_note).toMatchObject({
      credit_note_id: NOTE, credit_note_number: 'CN-2026-00007', type: 'supplier', total_amount: 115,
      supplier_id: 's-1', supplier_invoice_id: 'b-1', external_ref: 'X-1', attachments_detached: 2,
    });
  });

  it('dry_run runs the real delete inside a rolled-back savepoint and frees the idempotency key', async () => {
    const r = await deleteDraftCreditNoteTool.handler({ credit_note_id: NOTE, dry_run: true, ...KEY }, ctx);
    expect(inRolledBackSavepoint).toHaveBeenCalledTimes(1);
    expect(deleteDraftCreditNote).toHaveBeenCalledWith(COMPANY, NOTE, 'u-1');
    expect(r.wroteNothing).toBe(true);
    const body = JSON.parse(text(r));
    expect(body).toMatchObject({ dry_run: true, restorable: false });
    expect(body.would_delete.credit_note_number).toBe('CN-2026-00007');
    expect(body.deleted).toBeUndefined();
  });

  it('dry_run answers the same refusal the live call would (parity), with no wroteNothing on an error', async () => {
    vi.mocked(deleteDraftCreditNote).mockRejectedValue(refusal('NOT_DRAFT', 'Credit note CN-1 is approved: only a draft can be deleted. Use cancel_credit_note'));
    const dry = await deleteDraftCreditNoteTool.handler({ credit_note_id: NOTE, dry_run: true, ...KEY }, ctx);
    const live = await deleteDraftCreditNoteTool.handler({ credit_note_id: NOTE, ...KEY }, ctx);
    expect(dry.isError).toBe(true);
    expect(text(dry)).toBe(text(live));
    expect(text(dry)).toContain('cancel_credit_note');
    expect(dry.wroteNothing).toBeUndefined();
  });

  it('the series-number refusal reaches the caller with its text', async () => {
    vi.mocked(deleteDraftCreditNote).mockRejectedValue(refusal('OWN_SEQUENCE', 'Credit note RTN0000001 was numbered from the supplier return sequence'));
    const r = await deleteDraftCreditNoteTool.handler({ credit_note_id: NOTE, ...KEY }, ctx);
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('supplier return sequence');
  });

  it('a missing or foreign id reads as the generic Not found, never the service text', async () => {
    vi.mocked(deleteDraftCreditNote).mockRejectedValue(refusal('NOT_FOUND', 'Credit note belongs to another company'));
    const r = await deleteDraftCreditNoteTool.handler({ credit_note_id: NOTE, ...KEY }, ctx);
    expect(r.isError).toBe(true);
    expect(text(r)).toBe('Not found');
  });

  it('rethrows anything that is not a typed refusal, so the registry savepoint unwinds', async () => {
    vi.mocked(deleteDraftCreditNote).mockRejectedValue(new Error('connection reset'));
    await expect(deleteDraftCreditNoteTool.handler({ credit_note_id: NOTE, ...KEY }, ctx)).rejects.toThrow('connection reset');
    await expect(deleteDraftCreditNoteTool.handler({ credit_note_id: NOTE, dry_run: true, ...KEY }, ctx)).rejects.toThrow('connection reset');
  });
});
