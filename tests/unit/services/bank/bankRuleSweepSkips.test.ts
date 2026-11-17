/**
 * WP2 row 5 round 2 (LOW 1): which counted skip a rule-sweep line's throw is. A period closed between the transfer
 * line's pre-flight and its post (ClosedFiscalPeriodError, raised through the line's rolled-back savepoint) is the
 * closed-period skip autoPostRuleLine makes of it, not a run-wide failure; a fault is still rethrown (null).
 */
import { describe, expect, it } from 'vitest';
import { sweepLineSkip } from '@/modules/accounting/services/bank/bankRuleSweepSkips';
import { ClosedFiscalPeriodError } from '@/modules/accounting/services/gl/journalEntryPostingGuards';
import { DuplicateTransferError } from '@/modules/accounting/services/bank/transferDuplicateGuard';

describe('sweepLineSkip', () => {
  it('a period closed under a transfer line is the closed-period skip', () => {
    expect(sweepLineSkip(new ClosedFiscalPeriodError('closed'))).toBe('closed_period');
  });
  it('a movement already in the ledger is the duplicate-transfer skip', () => {
    expect(sweepLineSkip(new DuplicateTransferError())).toBe('duplicate_transfer');
  });
  it('anything else is a failure, rethrown', () => {
    expect(sweepLineSkip(new Error('boom'))).toBeNull();
  });
});
