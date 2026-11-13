/**
 * deleteDraftCreditNote — order of effects against a scripted sql: the lock is taken first, every refusal is raised
 * before any write (no UPDATE, no DELETE ran), and the attachment detach comes BEFORE the delete. Real-database
 * behaviour (the lock under concurrency, cascades, RLS) is in delete-draft-credit-note.int.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/modules/accounting/services/core/auditTrailService', () => ({ logAuditOrThrow: vi.fn() }));
vi.mock('@/modules/accounting/services/ar/creditNoteLock', () => ({ lockCreditNoteForUpdate: vi.fn() }));

import { sql } from '@/lib/neon';
import { logAuditOrThrow } from '@/modules/accounting/services/core/auditTrailService';
import { lockCreditNoteForUpdate } from '@/modules/accounting/services/ar/creditNoteLock';
import { CreditNoteDeleteRefusal, deleteDraftCreditNote } from '@/modules/accounting/services/ar/creditNoteDeleteService';

const COMPANY = 'cccccccc-0000-4000-8000-cccccccccccc';
const USER = 'dddddddd-0000-4000-8000-dddddddddddd';
const ID = '0b0b0b0b-0000-4000-8000-000000000001';

function note(over: Record<string, unknown> = {}) {
  return {
    id: ID, credit_note_number: 'CN-2026-00001', type: 'customer', status: 'draft', credit_date: '2026-11-01',
    subtotal: '100.00', tax_rate: '15.00', tax_amount: '15.00', total_amount: '115.00', applied_amount: '0.00',
    gl_journal_entry_id: null, client_id: 'cust-1', ...over,
  };
}

/** The sql calls after the lock, by the first word and table of each statement. */
const statements = () => vi.mocked(sql).mock.calls.map((c) => (c[0] as unknown as string[]).join('?').replace(/\s+/g, ' ').trim());
const wrote = () => statements().some((s) => /^(UPDATE|DELETE)/.test(s));

/** Reads come back empty unless a test overrides them; the writes return one row. */
function db(over: { alloc?: number; dispute?: boolean; pending?: boolean } = {}) {
  vi.mocked(sql).mockImplementation((async (strings: TemplateStringsArray) => {
    const s = strings.join('?');
    if (/credit_note_allocations/.test(s)) return [{ n: over.alloc ?? 0 }];
    if (/customer_invoice_disputes/.test(s)) return over.dispute ? [{ id: 'd-1' }] : [];
    if (/approval_requests/.test(s)) return over.pending ? [{ id: 'r-1' }] : [];
    if (/UPDATE procurement_documents/.test(s)) return [{ id: 'doc-1' }, { id: 'doc-2' }];
    if (/DELETE FROM credit_notes/.test(s)) return [{ id: ID }];
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
  vi.mocked(logAuditOrThrow).mockReset();
  vi.mocked(lockCreditNoteForUpdate).mockResolvedValue(note() as never);
  db();
});

describe('deleteDraftCreditNote', () => {
  it('locks the note first, detaches attachments, then deletes — and returns the values to re-create it', async () => {
    const r = await deleteDraftCreditNote(COMPANY, ID, USER);
    expect(lockCreditNoteForUpdate).toHaveBeenCalledWith(COMPANY, ID);
    const s = statements();
    const detach = s.findIndex((x) => x.startsWith('UPDATE procurement_documents'));
    const del = s.findIndex((x) => x.startsWith('DELETE FROM credit_notes'));
    expect(detach).toBeGreaterThan(-1);
    expect(del).toBeGreaterThan(detach);
    expect(s[del]).toMatch(/company_id/);
    expect(s[del]).toMatch(/status = 'draft'/);
    expect(r).toMatchObject({ id: ID, creditNoteNumber: 'CN-2026-00001', totalAmount: 115, clientId: 'cust-1', attachmentsDetached: 2 });
  });

  it('a missing (or another company\'s) note is NOT_FOUND and nothing is written', async () => {
    vi.mocked(lockCreditNoteForUpdate).mockResolvedValue(null);
    expect((await refusalOf(deleteDraftCreditNote(COMPANY, ID, USER))).code).toBe('NOT_FOUND');
    expect(vi.mocked(sql)).not.toHaveBeenCalled();
  });

  it.each(['approved', 'partially_applied', 'applied'])('%s is refused and pointed to cancel_credit_note', async (status) => {
    vi.mocked(lockCreditNoteForUpdate).mockResolvedValue(note({ status }) as never);
    const e = await refusalOf(deleteDraftCreditNote(COMPANY, ID, USER));
    expect(e.code).toBe('NOT_DRAFT');
    expect(e.message).toContain('cancel_credit_note');
    expect(e.message).toContain(status);
    expect(wrote()).toBe(false);
  });

  it('a cancelled note is refused as the record of its reversal', async () => {
    vi.mocked(lockCreditNoteForUpdate).mockResolvedValue(note({ status: 'cancelled' }) as never);
    const e = await refusalOf(deleteDraftCreditNote(COMPANY, ID, USER));
    expect(e.code).toBe('NOT_DRAFT');
    expect(e.message).toContain('already cancelled');
    expect(wrote()).toBe(false);
  });

  it('a "draft" that carries a GL journal is corrupt state: refused, not deleted', async () => {
    vi.mocked(lockCreditNoteForUpdate).mockResolvedValue(note({ gl_journal_entry_id: 'je-1' }) as never);
    const e = await refusalOf(deleteDraftCreditNote(COMPANY, ID, USER));
    expect(e.code).toBe('HAS_JOURNAL');
    expect(e.message).toContain('je-1');
    expect(wrote()).toBe(false);
  });

  it('a "draft" with allocation rows or applied_amount is corrupt state: refused', async () => {
    db({ alloc: 1 });
    expect((await refusalOf(deleteDraftCreditNote(COMPANY, ID, USER))).code).toBe('HAS_APPLICATIONS');
    db();
    vi.mocked(lockCreditNoteForUpdate).mockResolvedValue(note({ applied_amount: '10.00' }) as never);
    expect((await refusalOf(deleteDraftCreditNote(COMPANY, ID, USER))).code).toBe('HAS_APPLICATIONS');
    expect(wrote()).toBe(false);
  });

  it('a note a dispute points at is refused', async () => {
    db({ dispute: true });
    expect((await refusalOf(deleteDraftCreditNote(COMPANY, ID, USER))).code).toBe('DISPUTE_NOTE');
    expect(wrote()).toBe(false);
  });

  it('a pending approval request is refused', async () => {
    db({ pending: true });
    expect((await refusalOf(deleteDraftCreditNote(COMPANY, ID, USER))).code).toBe('APPROVAL_PENDING');
    expect(wrote()).toBe(false);
  });

  it('a DELETE that matches no row throws (not a refusal): the caller\'s savepoint unwinds the detach', async () => {
    vi.mocked(sql).mockImplementation((async (strings: TemplateStringsArray) => {
      const s = strings.join('?');
      if (/credit_note_allocations/.test(s)) return [{ n: 0 }];
      if (/UPDATE procurement_documents/.test(s)) return [];
      return [];
    }) as never);
    const err = await deleteDraftCreditNote(COMPANY, ID, USER).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(CreditNoteDeleteRefusal);
  });

  it('writes one audit_log delete row with the note\'s values after the DELETE, in the same call', async () => {
    vi.mocked(lockCreditNoteForUpdate).mockResolvedValue(note({ reason: 'dup', external_ref: 'X-9' }) as never);
    await deleteDraftCreditNote(COMPANY, ID, USER);
    expect(logAuditOrThrow).toHaveBeenCalledTimes(1);
    const p = vi.mocked(logAuditOrThrow).mock.calls[0]![0];
    expect(p).toMatchObject({ companyId: COMPANY, userId: USER, action: 'delete', entityType: 'credit_note', entityId: ID, entityRef: 'CN-2026-00001' });
    const f = Object.fromEntries(p.changes!.fields.map((x) => [x.field, x.old]));
    expect(f).toMatchObject({ total_amount: '115', client_id: 'cust-1', reason: 'dup', external_ref: 'X-9', status: 'draft' });
    expect(p.changes!.metadata).toMatchObject({ attachments_detached: '2' });
  });

  it('no audit row is written for any refusal', async () => {
    db({ pending: true });
    await refusalOf(deleteDraftCreditNote(COMPANY, ID, USER));
    vi.mocked(lockCreditNoteForUpdate).mockResolvedValue(note({ status: 'approved' }) as never);
    await refusalOf(deleteDraftCreditNote(COMPANY, ID, USER));
    expect(logAuditOrThrow).not.toHaveBeenCalled();
  });

  it.each(['RTN0000001', 'RTN-0007', 'SR-2026-00003', 'CN-26-00001', 'CN-2026-', 'XCN-2026-00001'])(
    'a draft numbered %s (not the CN-year series) is a supplier-return number: refused, nothing written',
    async (number) => {
      vi.mocked(lockCreditNoteForUpdate).mockResolvedValue(note({ credit_note_number: number, type: 'supplier' }) as never);
      const e = await refusalOf(deleteDraftCreditNote(COMPANY, ID, USER));
      expect(e.code).toBe('OWN_SEQUENCE');
      expect(e.message).toContain('supplier return sequence');
      expect(wrote()).toBe(false);
      expect(logAuditOrThrow).not.toHaveBeenCalled();
    },
  );

  it.each(['CN-2026-00001', 'CN-2026-123456'])('a trigger-issued %s is deletable', async (number) => {
    vi.mocked(lockCreditNoteForUpdate).mockResolvedValue(note({ credit_note_number: number }) as never);
    expect((await deleteDraftCreditNote(COMPANY, ID, USER)).creditNoteNumber).toBe(number);
  });
});
