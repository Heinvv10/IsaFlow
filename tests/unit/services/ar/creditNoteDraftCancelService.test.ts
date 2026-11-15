/**
 * cancelDraftCreditNote / cancelLockedDraftCreditNote — order of effects against a scripted sql: the lock comes
 * first, every refusal is raised before any write, the one UPDATE sets cancelled + the actor stamps and nothing else
 * (no journal, no allocation, no invoice), and the number is not touched. Real-database behaviour is in
 * cancel-draft-credit-note.int.test.ts. Also pins that cancelCreditNote hands a draft here and leaves the
 * approved path alone.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/modules/accounting/services/core/auditTrailService', () => ({ logAuditOrThrow: vi.fn() }));
vi.mock('@/modules/accounting/services/core/companySettingsService', () => ({ getDocumentNumbers: vi.fn() }));
vi.mock('@/modules/accounting/services/ar/creditNoteLock', () => ({ lockCreditNoteForUpdate: vi.fn() }));
vi.mock('@/modules/accounting/services/core/rowLockBudget', () => ({
  underFlowLockBudget: vi.fn(async (_n: string, fn: () => Promise<unknown>) => fn()),
}));
vi.mock('@/modules/accounting/services/gl/journalEntryService', () => ({
  createJournalEntry: vi.fn(), postJournalEntry: vi.fn(), reverseJournalEntry: vi.fn(),
}));
vi.mock('@/modules/accounting/services/shared/creditNoteFifo', () => ({ listCreditNoteAllocations: vi.fn(async () => []) }));
vi.mock('@/modules/accounting/services/shared/creditNoteApplicationWrites', () => ({ lockInvoicesForUpdate: vi.fn() }));
vi.mock('@/modules/accounting/services/shared/journalChainHead', () => ({ lockStandingChainHead: vi.fn(async () => 'head-1') }));
vi.mock('@/modules/accounting/services/shared/creditNoteReverseApplications', () => ({
  reverseCreditNoteApplications: vi.fn(async () => ({ lines: [], paidMoved: 0 })),
}));

import { sql } from '@/lib/neon';
import { lockCreditNoteForUpdate } from '@/modules/accounting/services/ar/creditNoteLock';
import { reverseJournalEntry } from '@/modules/accounting/services/gl/journalEntryService';
import { CreditNoteDeleteRefusal } from '@/modules/accounting/services/ar/creditNoteDeleteService';
import { cancelDraftCreditNote, cancelLockedDraftCreditNote } from '@/modules/accounting/services/ar/creditNoteDraftCancelService';
import { cancelCreditNote } from '@/modules/accounting/services/ar/creditNoteCancelService';

const COMPANY = 'cccccccc-0000-4000-8000-cccccccccccc';
const USER = 'dddddddd-0000-4000-8000-dddddddddddd';
const ID = '0b0b0b0b-0000-4000-8000-000000000001';

function note(over: Record<string, unknown> = {}) {
  return {
    id: ID, credit_note_number: 'RTN0000001', type: 'supplier', status: 'draft', applied_amount: '0.00',
    gl_journal_entry_id: null, ...over,
  };
}
const statements = () => vi.mocked(sql).mock.calls.map((c) => (c[0] as unknown as string[]).join('?').replace(/\s+/g, ' ').trim());
const writes = () => statements().filter((s) => /^(UPDATE|DELETE|INSERT)/.test(s));

function db(over: { alloc?: number; dispute?: boolean; pending?: boolean; updated?: number } = {}) {
  vi.mocked(sql).mockImplementation((async (strings: TemplateStringsArray) => {
    const s = strings.join('?');
    if (/credit_note_allocations/.test(s)) return [{ n: over.alloc ?? 0 }];
    if (/customer_invoice_disputes/.test(s)) return over.dispute ? [{ id: 'd-1' }] : [];
    if (/approval_requests/.test(s)) return over.pending ? [{ id: 'r-1' }] : [];
    if (/UPDATE credit_notes/.test(s)) {
      return (over.updated ?? 1) === 0 ? [] : [{ id: ID, credit_note_number: 'RTN0000001', type: 'supplier', status: 'cancelled', total_amount: '115.00' }];
    }
    return [];
  }) as never);
}
async function refusalOf(p: Promise<unknown>): Promise<CreditNoteDeleteRefusal> {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(CreditNoteDeleteRefusal);
  return err as CreditNoteDeleteRefusal;
}

beforeEach(() => {
  vi.mocked(sql).mockReset();
  vi.mocked(lockCreditNoteForUpdate).mockReset();
  vi.mocked(reverseJournalEntry).mockReset();
  vi.mocked(lockCreditNoteForUpdate).mockResolvedValue(note() as never);
  db();
});

describe('cancelDraftCreditNote', () => {
  it('locks first, then runs one company-scoped UPDATE that sets cancelled with the actor stamps, and nothing else', async () => {
    const r = await cancelDraftCreditNote(COMPANY, ID, USER, 'duplicate');
    expect(lockCreditNoteForUpdate).toHaveBeenCalledWith(COMPANY, ID);
    const w = writes();
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/^UPDATE credit_notes SET status = 'cancelled', cancelled_by = \?::UUID, cancelled_at = NOW\(\), cancel_reason = \?/);
    expect(w[0]).toMatch(/company_id = \?::UUID AND status = 'draft'/);
    // The stamps and reason are bound, the number and amounts are not in the SET.
    expect(vi.mocked(sql).mock.calls.find((c) => /UPDATE credit_notes/.test((c[0] as unknown as string[]).join('?')))!.slice(1))
      .toEqual([USER, 'duplicate', ID, COMPANY]);
    expect(w[0]).not.toMatch(/credit_note_number|applied_amount|total_amount|gl_journal_entry_id/);
    expect(r).toMatchObject({ id: ID, status: 'cancelled' });
    expect(reverseJournalEntry).not.toHaveBeenCalled();
  });

  it('records a blank reason as NULL', async () => {
    await cancelDraftCreditNote(COMPANY, ID, USER);
    expect(vi.mocked(sql).mock.calls.find((c) => /UPDATE credit_notes/.test((c[0] as unknown as string[]).join('?')))!.slice(1))
      .toEqual([USER, null, ID, COMPANY]);
  });

  it('keeps a supplier-return-sequence number: there is no OWN_SEQUENCE refusal on a cancel', async () => {
    expect((await cancelDraftCreditNote(COMPANY, ID, USER)).status).toBe('cancelled');
  });

  it('a missing (or another company\'s) note is NOT_FOUND and nothing is written', async () => {
    vi.mocked(lockCreditNoteForUpdate).mockResolvedValue(null);
    expect((await refusalOf(cancelDraftCreditNote(COMPANY, ID, USER))).code).toBe('NOT_FOUND');
    expect(vi.mocked(sql)).not.toHaveBeenCalled();
  });

  it.each(['approved', 'partially_applied', 'applied', 'cancelled'])('%s (seen under the lock) is refused, not cancelled as a draft', async (status) => {
    vi.mocked(lockCreditNoteForUpdate).mockResolvedValue(note({ status }) as never);
    const e = await refusalOf(cancelDraftCreditNote(COMPANY, ID, USER));
    expect(e.code).toBe('NOT_DRAFT');
    expect(e.message).toContain(status);
    expect(writes()).toEqual([]);
  });

  it('a "draft" that carries a GL journal is corrupt state: refused with the delete\'s text', async () => {
    vi.mocked(lockCreditNoteForUpdate).mockResolvedValue(note({ gl_journal_entry_id: 'je-1' }) as never);
    const e = await refusalOf(cancelDraftCreditNote(COMPANY, ID, USER));
    expect(e.code).toBe('HAS_JOURNAL');
    expect(e.message).toContain('is a draft but carries a ledger journal (je-1)');
    expect(writes()).toEqual([]);
  });

  it('a "draft" with allocation rows or applied_amount is corrupt state: refused', async () => {
    db({ alloc: 1 });
    expect((await refusalOf(cancelDraftCreditNote(COMPANY, ID, USER))).code).toBe('HAS_APPLICATIONS');
    db();
    vi.mocked(lockCreditNoteForUpdate).mockResolvedValue(note({ applied_amount: '10.00' }) as never);
    const e = await refusalOf(cancelDraftCreditNote(COMPANY, ID, USER));
    expect(e.code).toBe('HAS_APPLICATIONS');
    expect(e.message).toContain('already has credit applied or allocated');
    expect(writes()).toEqual([]);
  });

  it('a note a dispute points at is refused, worded for a cancel', async () => {
    db({ dispute: true });
    const e = await refusalOf(cancelDraftCreditNote(COMPANY, ID, USER));
    expect(e.code).toBe('DISPUTE_NOTE');
    expect(e.message).toContain('cannot be cancelled here');
    expect(writes()).toEqual([]);
  });

  it('a pending approval request refuses the cancel', async () => {
    db({ pending: true });
    const e = await refusalOf(cancelDraftCreditNote(COMPANY, ID, USER));
    expect(e.code).toBe('APPROVAL_PENDING');
    expect(e.message).toContain('then cancel the draft');
    expect(writes()).toEqual([]);
  });

  it('an UPDATE that matches no row is a plain throw (the caller\'s savepoint unwinds), not a refusal', async () => {
    db({ updated: 0 });
    const err = await cancelDraftCreditNote(COMPANY, ID, USER).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(CreditNoteDeleteRefusal);
    expect((err as Error).message).toContain('vanished');
  });
});

describe('cancelLockedDraftCreditNote', () => {
  it('refuses a row that is not a draft without any read or write', async () => {
    const e = await refusalOf(cancelLockedDraftCreditNote(COMPANY, note({ status: 'approved' }) as never, USER));
    expect(e.code).toBe('NOT_DRAFT');
    expect(vi.mocked(sql)).not.toHaveBeenCalled();
  });
});

describe('cancelCreditNote dispatch', () => {
  it('a draft goes to the draft path: no journal reversed, no chain-head lock', async () => {
    const r = await cancelCreditNote(COMPANY, ID, USER, 'dup');
    expect(r.status).toBe('cancelled');
    expect(reverseJournalEntry).not.toHaveBeenCalled();
    expect(writes()).toHaveLength(1);
  });

  it('an approved note still takes the posted path: its journal head is reversed', async () => {
    vi.mocked(lockCreditNoteForUpdate).mockResolvedValue(note({ status: 'approved', gl_journal_entry_id: 'je-1' }) as never);
    vi.mocked(sql).mockImplementation((async () => [{ id: ID, credit_note_number: 'RTN0000001', type: 'supplier', status: 'cancelled' }]) as never);
    await cancelCreditNote(COMPANY, ID, USER, 'dup');
    expect(reverseJournalEntry).toHaveBeenCalledWith(COMPANY, 'head-1', USER, undefined);
  });

  it('an already cancelled note is still refused by the old message', async () => {
    vi.mocked(lockCreditNoteForUpdate).mockResolvedValue(note({ status: 'cancelled' }) as never);
    await expect(cancelCreditNote(COMPANY, ID, USER)).rejects.toThrow('Cannot cancel credit note with status: cancelled');
  });
});
