/**
 * RED — written before creditNoteFifo.ts existed.
 *
 * Two pure rules the rest of the credit-note change hangs off:
 *
 *  1. The status a note lands in is DERIVED from what it consumed, never
 *     written by hand. 'approved' means nothing was applied, 'applied' means
 *     the whole face value was, and 'partially_applied' is the state that had
 *     no name before — the one every statement and ledger reader was forced to
 *     mis-report as one of the other two.
 *  2. Money is compared at a cent. A note that consumed 114.995 of 115 is
 *     fully applied; asserting equality on floats would call it partial.
 */
import { describe, it, expect } from 'vitest';
import { deriveCreditNoteStatus } from '@/modules/accounting/services/shared/creditNoteFifo';

describe('deriveCreditNoteStatus', () => {
  it('is approved when nothing was consumed', () => {
    expect(deriveCreditNoteStatus(0, 115)).toBe('approved');
  });

  it('is applied when the whole face value was consumed', () => {
    expect(deriveCreditNoteStatus(115, 115)).toBe('applied');
  });

  it('is partially_applied between the two', () => {
    expect(deriveCreditNoteStatus(40, 115)).toBe('partially_applied');
  });

  it('treats a sub-cent remainder as fully applied', () => {
    expect(deriveCreditNoteStatus(114.995, 115)).toBe('applied');
  });

  it('treats a sub-cent application as nothing applied', () => {
    expect(deriveCreditNoteStatus(0.004, 115)).toBe('approved');
  });
});
