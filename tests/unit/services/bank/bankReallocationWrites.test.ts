/**
 * reallocate_bank_transaction's write-side checks (bankReallocationWrites): the bank-leg assertion that proves the
 * bank side did not move, and the restore that puts the line back to 'reconciled' with its reviewer and without its
 * auto-post run tag, refusing when the line moved under it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sqlMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/neon', () => ({ sql: sqlMock }));
vi.mock('@/modules/accounting/services/core/auditTrailService', () => ({ logAuditOrThrow: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

import { assertBankLegKept, auditReallocation, restoreReconciled } from '@/modules/accounting/services/bank/bankReallocationWrites';
import { BankReallocationRefusal } from '@/modules/accounting/services/bank/bankReallocationGuards';
import { logAuditOrThrow } from '@/modules/accounting/services/core/auditTrailService';
import { log } from '@/lib/logger';

const OLD = { lineId: 'old', glAccountId: 'bank', subtype: 'bank', debit: 0, credit: 100, vatType: null, cc1Id: null, cc2Id: null, buId: null };
const NOW = { journalId: 'new-je', lineId: 'new', glAccountId: 'bank', debit: 0, credit: 100, entryDate: '2026-06-10' };
const text = (i: number) => (sqlMock.mock.calls[i]![0] as TemplateStringsArray).join('?');

beforeEach(() => { sqlMock.mockReset(); vi.mocked(logAuditOrThrow).mockReset(); vi.mocked(log.info).mockReset(); });

describe('assertBankLegKept', () => {
  it('passes the same account, amount, direction and date on the new journal', () => {
    expect(assertBankLegKept(OLD, '2026-06-10', NOW, 'new-je')).toBe(NOW);
  });
  it.each([
    ['no bank leg', null],
    ['another journal', { ...NOW, journalId: 'other' }],
    ['another account', { ...NOW, glAccountId: 'bank-2' }],
    ['another amount', { ...NOW, credit: 100.01 }],
    ['the other direction', { ...NOW, debit: 100, credit: 0 }],
    ['another date', { ...NOW, entryDate: '2026-06-11' }],
  ])('refuses %s', (_label, now) => {
    expect(() => assertBankLegKept(OLD, '2026-06-10', now as never, 'new-je')).toThrow(BankReallocationRefusal);
  });
});

describe('restoreReconciled', () => {
  it('puts back reconciled with the original reviewer and clears the auto-post run, keyed on the new leg', async () => {
    sqlMock.mockResolvedValueOnce([{ id: 'tx' }]);
    await restoreReconciled('co', 'tx', 'rec', 'new', { at: '2026-07-01T08:00:00Z', by: 'u1' });
    const sqlText = text(0);
    expect(sqlText).toMatch(/status = 'reconciled', reviewed_at = \?::TIMESTAMPTZ/);
    expect(sqlText).toMatch(/reviewed_by = \?::UUID, auto_post_run_id = NULL/);
    expect(sqlText).toMatch(/matched_journal_line_id = \?::UUID/);
    expect(sqlMock.mock.calls[0]!.slice(1)).toEqual(expect.arrayContaining(['2026-07-01T08:00:00Z', 'u1', 'rec', 'new']));
  });
  it('refuses when the line moved under it (no row updated): the savepoint takes everything back', async () => {
    sqlMock.mockResolvedValueOnce([]);
    await expect(restoreReconciled('co', 'tx', 'rec', 'new', { at: null, by: null })).rejects.toBeInstanceOf(BankReallocationRefusal);
  });
});

describe('auditReallocation', () => {
  const base = {
    companyId: 'co', userId: 'u', bankTxId: 'tx', target: { kind: 'account', glAccountId: 'acct' } as const,
    plan: { kind: 'reallocate', reconciliationId: 'rec', journalId: 'je', entryDate: '2026-06-10', bankLeg: OLD } as const,
    reviewed: { at: new Date('2026-07-01T08:00:00Z'), by: 'u1' }, autoPostRunId: 'run-1', newLineId: 'new',
    newJournalEntryId: 'new-je', reversalJournalEntryId: 'rev', postingAgent: 'mcp:x:v1',
  };
  it('records the original review stamp and the cleared auto-post run', async () => {
    await auditReallocation({ ...base, dryRun: false });
    expect(vi.mocked(logAuditOrThrow).mock.calls[0]![0].changes!.metadata).toMatchObject({
      operation: 'reallocate', originalReviewedAt: '2026-07-01T08:00:00.000Z', originalReviewedBy: 'u1',
      clearedAutoPostRunId: 'run-1', originalJournalEntryId: 'je', newJournalEntryId: 'new-je',
    });
    expect(vi.mocked(log.info).mock.calls[0]![0]).toBe('Reallocated reconciled bank transaction');
  });
  it('a dry run logs as one', async () => {
    await auditReallocation({ ...base, dryRun: true });
    expect(vi.mocked(log.info).mock.calls[0]![0]).toBe('Reallocation dry run (rolled back)');
  });
});
