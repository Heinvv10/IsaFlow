/**
 * create_credit_note with external_ref (brief step 3): a re-sent source note returns the existing
 * one, ahead of the identical-draft refusal; a new one is stamped after it is created.
 */
import { describe, it, expect, vi } from 'vitest';
import { CUSTOMER, SUPPLIER, NOTE, KEY, COMPANY, ctx, parseOk, errText, draftNote } from './creditNoteTools.harness';

vi.mock('@/modules/accounting/services/core/externalRefService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/accounting/services/core/externalRefService')>()),
  findByExternalRef: vi.fn(async () => []),
  lockExternalRef: vi.fn(async () => undefined),
  stampExternalRef: vi.fn(async () => undefined),
}));

import { createCreditNote } from '@/modules/accounting/services/ar/creditNoteService';
import { findOpenDuplicateDraft } from '@/modules/accounting/services/ar/creditNoteLinkService';
import { findByExternalRef, stampExternalRef } from '@/modules/accounting/services/core/externalRefService';
import { createCreditNoteTool } from '@/lib/mcp/tools/writeCreditNotes';

const XREF = { external_system: 'sage', external_ref: '3629825983', external_document_number: 'RTN0000080' };
const supplierArgs = { type: 'supplier', supplier_id: SUPPLIER, credit_date: '2026-11-11', subtotal: 100, ...KEY, ...XREF };

describe('create_credit_note — external_ref', () => {
  it('returns the live note with the reference before the duplicate-draft check, and creates nothing', async () => {
    vi.mocked(findByExternalRef).mockResolvedValueOnce([{
      entityType: 'credit_note', id: 'cn-existing', number: 'CN-2026-00557', status: 'applied', date: '2026-11-11',
      totalAmount: 115, live: true, externalDocumentNumber: 'RTN0000080', creditNoteType: 'supplier',
    }]);
    vi.mocked(findOpenDuplicateDraft).mockResolvedValue('would-refuse');
    const r = await createCreditNoteTool.handler(supplierArgs, ctx());
    expect(r.wroteNothing).toBe(true);
    expect(parseOk(r)).toMatchObject({ already_existed: true, id: 'cn-existing', credit_note_type: 'supplier' });
    expect(findByExternalRef).toHaveBeenCalledWith(COMPANY, 'credit_note', 'sage', '3629825983', { creditNoteType: 'supplier' });
    expect(findOpenDuplicateDraft).not.toHaveBeenCalled();
    expect(createCreditNote).not.toHaveBeenCalled();
  });

  it('a replay compares the total as the service rounds it (no cent-edge false difference)', async () => {
    // subtotal 0.50 at 15%: the service rounds tax first (0.075 -> 0.08), total 0.58;
    // a single round of 0.50 * 1.15 gives 0.57.
    vi.mocked(findByExternalRef).mockResolvedValueOnce([{
      entityType: 'credit_note', id: 'cn-existing', number: 'CN-1', status: 'draft', date: '2026-11-11',
      totalAmount: 0.58, live: true, externalDocumentNumber: null, creditNoteType: 'supplier',
    }]);
    const out = parseOk(await createCreditNoteTool.handler({ ...supplierArgs, subtotal: 0.5 }, ctx()));
    expect(out.payload_differs).toBe(false);
  });

  it('creates and stamps a new note', async () => {
    vi.mocked(createCreditNote).mockResolvedValue({ ...draftNote, type: 'supplier' } as never);
    const out = parseOk(await createCreditNoteTool.handler(supplierArgs, ctx()));
    expect(stampExternalRef).toHaveBeenCalledWith(COMPANY, 'credit_note', NOTE, { system: 'sage', ref: '3629825983', documentNumber: 'RTN0000080' });
    expect(out).toMatchObject({ id: NOTE, external_ref: '3629825983' });
  });

  it('refuses a half-given reference before anything is read', async () => {
    const r = await createCreditNoteTool.handler(
      { type: 'customer', client_id: CUSTOMER, credit_date: '2026-11-11', subtotal: 100, external_ref: '1', ...KEY }, ctx(),
    );
    expect(errText(r)).toMatch(/external_system/);
    expect(findByExternalRef).not.toHaveBeenCalled();
  });
});
