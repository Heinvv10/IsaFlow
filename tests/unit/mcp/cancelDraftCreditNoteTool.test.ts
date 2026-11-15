/**
 * cancel_credit_note on a DRAFT: cancelled with no journal. The lock, the guards and the "writes nothing" claim are
 * pinned against a real database in cancel-draft-credit-note.int.test.ts; this file pins what only the tool decides:
 * a draft goes to the draft service (never to cancelCreditNote, which would run the posted path), the typed refusal
 * becomes a toolError while anything else is rethrown, the dry run is the same call in a rolled-back savepoint and
 * keeps the idempotency key free, and an approved note's dry run does the same around the unchanged posted cancel.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { COMPANY, NOTE, KEY, ctx, draftNote } from './creditNoteTools.harness';

vi.mock('@/modules/accounting/services/ar/creditNoteDeleteService', async () => {
  class CreditNoteDeleteRefusal extends Error {
    constructor(readonly code: string, message: string) { super(message); }
  }
  return { CreditNoteDeleteRefusal };
});
vi.mock('@/modules/accounting/services/ar/creditNoteDraftCancelService', () => ({ cancelDraftCreditNote: vi.fn() }));
vi.mock('@/modules/accounting/services/core/rolledBackSavepoint', () => ({
  inRolledBackSavepoint: vi.fn(async (_name: string, fn: () => Promise<unknown>) => { await fn(); }),
}));

import { getCreditNoteById, cancelCreditNote } from '@/modules/accounting/services/ar/creditNoteService';
import { CreditNoteDeleteRefusal } from '@/modules/accounting/services/ar/creditNoteDeleteService';
import { cancelDraftCreditNote } from '@/modules/accounting/services/ar/creditNoteDraftCancelService';
import { inRolledBackSavepoint } from '@/modules/accounting/services/core/rolledBackSavepoint';
import { cancelCreditNoteTool } from '@/lib/mcp/tools/writeCreditNotes';

const refusal = (code: string, message: string) => new (CreditNoteDeleteRefusal as unknown as new (c: string, m: string) => Error)(code, message);
const text = (r: { content: { text: string }[] }) => r.content[0]!.text;
const cancelled = { ...draftNote, status: 'cancelled' } as never;
const call = (extra: Record<string, unknown> = {}) => cancelCreditNoteTool.handler({ credit_note_id: NOTE, ...KEY, ...extra }, ctx());

beforeEach(() => {
  vi.mocked(cancelDraftCreditNote).mockReset();
  vi.mocked(inRolledBackSavepoint).mockClear();
  vi.mocked(getCreditNoteById).mockResolvedValue(draftNote as never);
  vi.mocked(cancelDraftCreditNote).mockResolvedValue(cancelled);
});

describe('cancel_credit_note — a draft', () => {
  it('still needs write:invoices + write:post, and advertises dry_run and the no-journal draft cancel', () => {
    expect(cancelCreditNoteTool.scope).toBe('write:invoices');
    expect(cancelCreditNoteTool.requiresPost).toBe(true);
    expect(Object.keys(cancelCreditNoteTool.inputSchema.properties as object)).toEqual(['credit_note_id', 'reason', 'dry_run', 'idempotency_key']);
    expect(cancelCreditNoteTool.description).toContain('DRAFT note is cancelled WITHOUT a journal');
    expect(cancelCreditNoteTool.description).toContain('number stays on the books');
  });

  it('cancels through the draft service, never the posted path, and says nothing was posted', async () => {
    const r = await call({ reason: 'duplicate' });
    expect(r.isError).toBeFalsy();
    expect(r.wroteNothing).toBeUndefined();
    expect(cancelDraftCreditNote).toHaveBeenCalledWith(COMPANY, NOTE, expect.any(String), 'duplicate',
      { postingAgent: 'mcp:cancel_credit_note:v1', actorType: 'agent', actorTokenJti: 'jti' });
    expect(cancelCreditNote).not.toHaveBeenCalled();
    expect(inRolledBackSavepoint).not.toHaveBeenCalled();
    expect(JSON.parse(text(r))).toMatchObject({
      id: NOTE, credit_note_number: 'CN-2026-00001', status: 'cancelled', total_amount: 115, journal_reversed: false, reversal_date_roll: null,
    });
  });

  it('dry_run runs the real draft cancel inside a rolled-back savepoint and frees the idempotency key', async () => {
    const r = await call({ dry_run: true });
    expect(inRolledBackSavepoint).toHaveBeenCalledTimes(1);
    expect(cancelDraftCreditNote).toHaveBeenCalledTimes(1);
    expect(cancelCreditNote).not.toHaveBeenCalled();
    expect(r.wroteNothing).toBe(true);
    expect(JSON.parse(text(r))).toMatchObject({ dry_run: true, would_cancel: { status: 'cancelled', journal_reversed: false } });
  });

  it.each([
    ['HAS_JOURNAL', 'Credit note CN-1 is a draft but carries a ledger journal (je-1).'],
    ['HAS_APPLICATIONS', 'Credit note CN-1 is a draft but already has credit applied or allocated.'],
    ['DISPUTE_NOTE', 'Credit note CN-1 was raised by resolving a dispute'],
    ['APPROVAL_PENDING', 'Credit note CN-1 has a pending approval request.'],
    ['NOT_DRAFT', 'Credit note CN-1 is approved, not a draft: it changed after it was read.'],
  ])('%s: the refusal text reaches the caller, dry run and live alike, with no wroteNothing', async (code, message) => {
    vi.mocked(cancelDraftCreditNote).mockRejectedValue(refusal(code, message));
    const dry = await call({ dry_run: true });
    const live = await call();
    for (const r of [dry, live]) {
      expect(r.isError).toBe(true);
      expect(text(r)).toBe(message);
      expect(r.wroteNothing).toBeUndefined();
    }
  });

  it('a note that vanished under the lock reads as the generic Not found', async () => {
    vi.mocked(cancelDraftCreditNote).mockRejectedValue(refusal('NOT_FOUND', 'Not found'));
    expect(text(await call())).toBe('Not found');
  });

  it('rethrows anything that is not a typed refusal, so the registry savepoint unwinds', async () => {
    vi.mocked(cancelDraftCreditNote).mockRejectedValue(new Error('connection reset'));
    await expect(call()).rejects.toThrow('connection reset');
    await expect(call({ dry_run: true })).rejects.toThrow('connection reset');
  });

  it('a missing note is the generic Not found before any service call', async () => {
    vi.mocked(getCreditNoteById).mockResolvedValue(null as never);
    expect(text(await call())).toBe('Not found');
    expect(cancelDraftCreditNote).not.toHaveBeenCalled();
  });
});

describe('cancel_credit_note — an approved note', () => {
  beforeEach(() => {
    vi.mocked(getCreditNoteById).mockResolvedValue({ ...draftNote, status: 'approved' } as never);
    vi.mocked(cancelCreditNote).mockResolvedValue(cancelled);
  });

  it('live call is unchanged: the posted cancel, its reply shape, no savepoint, no draft service', async () => {
    const r = await call({ reason: 'x' });
    expect(cancelCreditNote).toHaveBeenCalledWith(COMPANY, NOTE, expect.any(String), 'x',
      { postingAgent: 'mcp:cancel_credit_note:v1', actorType: 'agent', actorTokenJti: 'jti' });
    expect(cancelDraftCreditNote).not.toHaveBeenCalled();
    expect(inRolledBackSavepoint).not.toHaveBeenCalled();
    expect(Object.keys(JSON.parse(text(r)))).toEqual(['id', 'credit_note_number', 'status', 'total_amount', 'reversal_date_roll']);
    expect(r.wroteNothing).toBeUndefined();
  });

  it('dry_run wraps that same cancel in a rolled-back savepoint and frees the key', async () => {
    const r = await call({ dry_run: true });
    expect(inRolledBackSavepoint).toHaveBeenCalledTimes(1);
    expect(cancelCreditNote).toHaveBeenCalledTimes(1);
    expect(r.wroteNothing).toBe(true);
    expect(JSON.parse(text(r))).toMatchObject({ dry_run: true, would_cancel: { status: 'cancelled' } });
  });
});
