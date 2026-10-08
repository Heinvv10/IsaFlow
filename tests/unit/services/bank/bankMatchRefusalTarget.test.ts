/**
 * bank-match-confirm's match-only arms (`journal_line`, `bank_transfer`): `matchTransaction` is their first write, so its
 * target refusal is decided before anything is written and is a 4xx the person can act on, not a 500 (brk-nrfa round 21
 * L1). A claimed line is 409; a reversed or missing one 400. On the document arms the same throw stays unclassified.
 */
import { describe, expect, it } from 'vitest';
import { classifyBankMatchRefusal } from '@/modules/accounting/services/bank/bankMatchRefusalStatus';
import { BankMatchTargetError } from '@/modules/accounting/services/bank/bankTxStatusMutations';

describe('classifyBankMatchRefusal — BankMatchTargetError on the match-only arms', () => {
  it.each([
    ['LINE_CLAIMED', 'journal_line', 409], ['LINE_CLAIMED', 'bank_transfer', 409],
    ['LINE_REVERSED', 'journal_line', 400], ['LINE_REVERSED', 'bank_transfer', 400],
    ['LINE_NOT_FOUND', 'journal_line', 400], ['LINE_NOT_FOUND', 'bank_transfer', 400],
  ] as const)('%s on %s answers %d', (code, candidateType, status) => {
    const refusal = classifyBankMatchRefusal(new BankMatchTargetError(code, `refused: ${code}`), candidateType);
    expect(refusal).toEqual({ status, message: `refused: ${code}`, contended: false });
  });

  it.each(['supplier_invoice', 'customer_invoice', undefined])('stays unclassified on the %s arm (500, unwinds)', (arm) => {
    expect(classifyBankMatchRefusal(new BankMatchTargetError('LINE_REVERSED', 'x'), arm)).toBeNull();
  });

  it('does not classify an ordinary Error named differently', () => {
    expect(classifyBankMatchRefusal(new Error('LINE_CLAIMED'), 'journal_line')).toBeNull();
  });
});
