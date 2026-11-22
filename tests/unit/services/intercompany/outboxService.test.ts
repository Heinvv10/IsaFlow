/**
 * Intercompany P2, the sender's outbox is one call of the database's `intercompany_send_for_source`: its answer becomes a MirrorOutcome (every
 * reason the database gives is mapped, an unknown one is `failed`), a document the database refuses to send is logged AT ERROR with its reason
 * (nothing re-sends it, so the log is how it is found), and a database refusal never fails the approval.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  sql: vi.fn(async (..._a: unknown[]) => [] as unknown[]),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@/lib/neon', () => ({ sql: m.sql, withSavepoint: async (_n: string, fn: () => Promise<unknown>) => fn() }));
vi.mock('@/lib/logger', () => ({ log: m.log }));

import { mirrorApprovedCreditNote, mirrorApprovedInvoice } from '@/modules/accounting/services/intercompany/outboxService';

beforeEach(() => vi.clearAllMocks());
const answers = (row: Record<string, unknown>) => m.sql.mockResolvedValueOnce([row]);

describe('mirrorApprovedInvoice / mirrorApprovedCreditNote', () => {
  it('a message id is a sent message', async () => {
    answers({ message_id: 'm-1', reason: null, detail: null });
    expect(await mirrorApprovedInvoice('co', 'inv')).toEqual({ sent: true, messageId: 'm-1' });
    expect(m.log.info).toHaveBeenCalledWith('Intercompany message sent', expect.objectContaining({ kind: 'invoice', messageId: 'm-1' }), 'intercompany');
  });

  it.each(['no_connection', 'before_cutover', 'no_cutover', 'already_sent', 'not_found', 'not_approved', 'no_journal', 'forbidden', 'unmirrorable'])('%s is mapped, not collapsed to failed', async (reason) => {
    answers({ message_id: null, reason, detail: 'why' });
    expect(await mirrorApprovedCreditNote('co', 'cn')).toEqual({ sent: false, reason });
  });

  it('a reason the database does not give is failed', async () => {
    answers({ message_id: null, reason: 'made_up', detail: null });
    expect(await mirrorApprovedInvoice('co', 'inv')).toEqual({ sent: false, reason: 'failed' });
    m.sql.mockResolvedValueOnce([]);
    expect(await mirrorApprovedInvoice('co', 'inv')).toEqual({ sent: false, reason: 'failed' });
  });

  it('a document the database finds is not in the ledger as its own posting (no_journal) is logged AT ERROR with the database\'s reason', async () => {
    answers({ message_id: null, reason: 'no_journal', detail: 'the journal\'s receivable is not the document\'s total' });
    await mirrorApprovedInvoice('co', 'inv');
    expect(m.log.error).toHaveBeenCalledWith(expect.stringMatching(/approval journal is not the document's own posting/),
      expect.objectContaining({ companyId: 'co', sourceId: 'inv', reason: 'the journal\'s receivable is not the document\'s total' }), 'intercompany');
  });

  it('a document the receiver could not read (unmirrorable) is logged AT ERROR with its reason', async () => {
    answers({ message_id: null, reason: 'unmirrorable', detail: 'a line is negative' });
    await mirrorApprovedInvoice('co', 'inv');
    expect(m.log.error).toHaveBeenCalledWith(expect.stringMatching(/cannot be mirrored: the receiver could not read it/), expect.objectContaining({ reason: 'a line is negative' }), 'intercompany');
  });

  it('a database error is logged with the SQLSTATE only and never thrown into the approval', async () => {
    m.sql.mockRejectedValueOnce(Object.assign(new Error('secret detail'), { code: '23514' }));
    expect(await mirrorApprovedInvoice('co', 'inv')).toEqual({ sent: false, reason: 'failed' });
    expect(m.log.error).toHaveBeenCalledWith('Intercompany message not sent', expect.objectContaining({ code: '23514' }), 'intercompany');
    expect(JSON.stringify(m.log.error.mock.calls)).not.toContain('secret detail');
  });
});
