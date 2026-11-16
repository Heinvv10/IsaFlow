/**
 * Audit WP2 row 9 — which throws a bank route may answer 4xx (`bankRefusalStatus`). Everything it does not recognise
 * must come back null, so the route rethrows and withAuth rolls the request back on the 500.
 */
import { describe, expect, it } from 'vitest';
import { REFUSAL_CODES } from '@/lib/mcp/tools/refusalCodes';
import { BANK_ROUTE_PREWRITE_CODES } from '@/modules/accounting/services/bank/bankRoutePrewriteCodes';
import { bankRefusalStatus } from '@/modules/accounting/services/bank/bankRouteRefusal';
import { BankRequestRefusal } from '@/modules/accounting/services/bank/bankRequestRefusal';
import { BankAllocationRefusal } from '@/modules/accounting/services/bank/bankAllocationRefusal';
import { BankMatchTargetError } from '@/modules/accounting/services/bank/bankTxStatusErrors';

const named = (name: string, code?: string) => Object.assign(new Error(name), { name, ...(code ? { code } : {}) });

describe('bankRefusalStatus', () => {
  it.each([
    ['a bare Error', new Error('Bank transaction not found')],
    ['a TypeError', new TypeError("Cannot read properties of undefined (reading 'id')")],
    ['a SQLSTATE (unique violation)', named('error', '23505')],
    ['an unknown string code', named('Error', 'SOMETHING_ELSE')],
    ['a held row (lock_not_available)', named('error', '55P03')],
    ['not an Error at all', 'boom'],
  ])('does not classify %s (rethrown: 500, rolled back)', (_what, err) => {
    expect(bankRefusalStatus(err)).toBeNull();
  });

  it.each([
    ['a BankRequestRefusal 404', new BankRequestRefusal('Reconciliation x not found', 404), 404],
    ['a BankRequestRefusal 409', new BankRequestRefusal('Another change won', 409), 409],
    ['a BankRequestRefusal (default)', new BankRequestRefusal('Adjustment bank account does not match'), 400],
    ['a BankAllocationRefusal', new BankAllocationRefusal('Transaction already allocated'), 400],
    ['a retryable BankAllocationRefusal', new BankAllocationRefusal('changed', undefined, { retryable: true }), 409],
    ['a claimed match target', new BankMatchTargetError('LINE_CLAIMED', 'claimed'), 400],
    ['a missing reconciliation on a match', new BankMatchTargetError('RECONCILIATION_NOT_FOUND', 'gone'), 404],
    ['a closed period (by name)', named('ClosedFiscalPeriodError'), 400],
    ['a missing system account (by name)', named('MissingSystemAccountError'), 400],
    ['a registered typed refusal (VAT lock)', named('VatPeriodLockedError', 'VAT_PERIOD_LOCKED'), 400],
  ])('answers %s with %s', (_what, err, status) => {
    expect(bankRefusalStatus(err)).toBe(status);
  });
});

// Safe by construction: a 400 COMMITs, so a code is answered only when it is LISTED as raised before the write.
describe('the code allowlist (bankRoutePrewriteCodes)', () => {
  it('every listed code is still a registered refusal code', () => {
    expect([...BANK_ROUTE_PREWRITE_CODES].filter((c) => !REFUSAL_CODES.has(c))).toEqual([]);
  });

  it('answers every listed code 400, and NO other member of REFUSAL_CODES — a new code is a 500 until it is classified', () => {
    const byClass = new Set(['BANK_ALLOCATION_REFUSED', 'BANK_REQUEST_REFUSED']); // answered by class, with their own status
    const answered = [...REFUSAL_CODES].filter((c) => !byClass.has(c) && bankRefusalStatus(named('SomeRefusal', c)) === 400).sort();
    expect(answered).toEqual([...BANK_ROUTE_PREWRITE_CODES].sort());
  });

  it('a refusal raised AFTER its write is never answered 4xx (BANK_DIMENSION_SYNC_REFUSED: a bank row changed mid-sync)', () => {
    expect(REFUSAL_CODES.has('BANK_DIMENSION_SYNC_REFUSED')).toBe(true);
    expect(bankRefusalStatus(named('BankDimensionSyncRefusal', 'BANK_DIMENSION_SYNC_REFUSED'))).toBeNull();
  });
});
