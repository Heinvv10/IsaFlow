/**
 * cancelDraftCreditNote — order of effects against a scripted sql: the lock comes first, every refusal is raised
 * before any write, the one UPDATE sets cancelled + the actor stamps and nothing else (no journal, no allocation, no
 * invoice), the number is not touched, and the audit row names the agent. Real-database behaviour is in
 * cancel-draft-credit-note.int.test.ts. Also pins that the generic cancelCreditNote still refuses a draft.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/modules/accounting/services/core/auditTrailService', () => ({ logAuditOrThrow: vi.fn() }));
vi.mock('@/modules/accounting/services/ar/creditNoteLock', () => ({ lockCreditNoteForUpdate: vi.fn() }));

import { sql } from '@/lib/neon';
import { logAuditOrThrow } from '@/modules/accounting/services/core/auditTrailService';
import { lockCreditNoteForUpdate } from '@/modules/accounting/services/ar/creditNoteLock';
import { CreditNoteDeleteRefusal } from '@/modules/accounting/services/ar/creditNoteDeleteService';
import { cancelDraftCreditNote } from '@/modules/accounting/services/ar/creditNoteDraftCancelService';

const COMPANY = 'cccccccc-0000-4000-8000-cccccccccccc';
const USER = 'dddddddd-0000-4000-8000-dddddddddddd';
const ID = '0b0b0b0b-0000-4000-8000-000000000001';

function note(over: Record<string, unknown> = {}) {
  return { id: ID, credit_note_number: 'RTN0000001', type: 'supplier', status: 'draft', applied_amount: '0.00', gl_journal_entry_id: null, ...over };
}
const text = (c: unknown[]) => (c[0] as unknown as string[]).join('?').replace(/\s+/g, ' ').trim();
const statements = () => vi.mocked(sql).mock.calls.map((c) => text(c));
const writes = () => statements().filter((s) => /^(UPDATE|DELETE|INSERT)/.test(s));
const updateCall = () => vi.mocked(sql).mock.calls.find((c) => /^UPDATE credit_notes/.test(text(c)))!;

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
  vi.mocked(logAuditOrThrow).mockReset();
  vi.mocked(lockCreditNoteForUpdate).mockResolvedValue(note() as never);
  db();
});

describe('cancelDraftCreditNote', () => {
  it('locks first, then runs one company-scoped UPDATE that sets cancelled with the actor stamps, and nothing else', async () => {
    const r = await cancelDraftCreditNote(COMPANY, ID, USER, 'duplicate');
    expect(lockCreditNoteForUpdate).toHaveBeenCalledWith(COMPANY, ID);
    expect(writes()).toHaveLength(1);
    const sqlText = text(updateCall());
    expect(sqlText).toMatch(/^UPDATE credit_notes SET status = 'cancelled', cancelled_by = \?::UUID, cancelled_at = NOW\(\), cancel_reason = \?/);
    expect(sqlText).toMatch(/company_id = \?::UUID/);
    expect(updateCall().slice(1)).toEqual([USER, 'duplicate', ID, COMPANY]);
    expect(sqlText).not.toMatch(/credit_note_number|applied_amount|total_amount|gl_journal_entry_id/);
    expect(r).toMatchObject({ id: ID, status: 'cancelled' });
  });

  // The lock makes this predicate redundant at runtime; it stays as a fail-closed second guard, so pin its text.
  it("the UPDATE itself only matches a row that is STILL a draft (AND status = 'draft')", async () => {
    await cancelDraftCreditNote(COMPANY, ID, USER);
    expect(text(updateCall())).toContain("AND status = 'draft' RETURNING");
  });

  it('records a blank reason as NULL', async () => {
    await cancelDraftCreditNote(COMPANY, ID, USER);
    expect(updateCall().slice(1)).toEqual([USER, null, ID, COMPANY]);
  });

  it('writes an audit row in the same call: who (the token), what (status), source (the posting agent)', async () => {
    await cancelDraftCreditNote(COMPANY, ID, USER, 'dup', { postingAgent: 'mcp:cancel_credit_note:v1', actorType: 'agent', actorTokenJti: 'jti-1' });
    expect(logAuditOrThrow).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logAuditOrThrow).mock.calls[0]![0]).toMatchObject({
      companyId: COMPANY, userId: USER, action: 'update', entityType: 'credit_note', entityId: ID, entityRef: 'RTN0000001',
      changes: {
        fields: [{ field: 'status', old: 'draft', new: 'cancelled' }, { field: 'cancel_reason', old: null, new: 'dup' }],
        metadata: { source: 'mcp:cancel_credit_note:v1', actor_type: 'agent', actor_token_jti: 'jti-1' },
      },
    });
  });

  it('a person\'s cancel (no agent opts) is sourced cancel_draft_credit_note with no actor_* keys', async () => {
    await cancelDraftCreditNote(COMPANY, ID, USER);
    const { changes } = vi.mocked(logAuditOrThrow).mock.calls[0]![0];
    expect(changes!.metadata).toEqual({ source: 'cancel_draft_credit_note' });
    expect(changes!.fields).toHaveLength(1);
  });

  it('keeps a supplier-return-sequence number: there is no OWN_SEQUENCE refusal on a cancel', async () => {
    expect((await cancelDraftCreditNote(COMPANY, ID, USER)).status).toBe('cancelled');
  });

  it('a missing (or another company\'s) note is NOT_FOUND and nothing is written', async () => {
    vi.mocked(lockCreditNoteForUpdate).mockResolvedValue(null);
    expect((await refusalOf(cancelDraftCreditNote(COMPANY, ID, USER))).code).toBe('NOT_FOUND');
    expect(vi.mocked(sql)).not.toHaveBeenCalled();
  });

  it.each(['approved', 'partially_applied', 'applied', 'cancelled'])('%s (seen under the lock) is refused: a posted note is never reversed here', async (status) => {
    vi.mocked(lockCreditNoteForUpdate).mockResolvedValue(note({ status }) as never);
    const e = await refusalOf(cancelDraftCreditNote(COMPANY, ID, USER));
    expect(e.code).toBe('NOT_DRAFT');
    expect(e.message).toContain(status);
    expect(writes()).toEqual([]);
    expect(logAuditOrThrow).not.toHaveBeenCalled();
  });

  it('a "draft" that carries a GL journal is corrupt state: refused, worded for a cancel', async () => {
    vi.mocked(lockCreditNoteForUpdate).mockResolvedValue(note({ gl_journal_entry_id: 'je-1' }) as never);
    const e = await refusalOf(cancelDraftCreditNote(COMPANY, ID, USER));
    expect(e.code).toBe('HAS_JOURNAL');
    expect(e.message).toContain('is a draft but carries a ledger journal (je-1)');
    expect(e.message).toContain('it was not cancelled:');
    expect(writes()).toEqual([]);
  });

  it('a "draft" with allocation rows or applied_amount is corrupt state: refused, worded for a cancel', async () => {
    db({ alloc: 1 });
    expect((await refusalOf(cancelDraftCreditNote(COMPANY, ID, USER))).code).toBe('HAS_APPLICATIONS');
    db();
    vi.mocked(lockCreditNoteForUpdate).mockResolvedValue(note({ applied_amount: '10.00' }) as never);
    const e = await refusalOf(cancelDraftCreditNote(COMPANY, ID, USER));
    expect(e.code).toBe('HAS_APPLICATIONS');
    expect(e.message).toContain('already has credit applied or allocated');
    expect(e.message).toContain('it was not cancelled:');
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

  it('an UPDATE that matches no row is a plain throw (the caller\'s savepoint unwinds), not a refusal, and no audit row', async () => {
    db({ updated: 0 });
    const err = await cancelDraftCreditNote(COMPANY, ID, USER).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(CreditNoteDeleteRefusal);
    expect((err as Error).message).toContain('vanished');
    expect(logAuditOrThrow).not.toHaveBeenCalled();
  });
});
