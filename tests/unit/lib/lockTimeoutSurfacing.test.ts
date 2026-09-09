/**
 * A typed row-lock timeout must reach the caller as its own "retry" message.
 *
 * Both filters that stand between a service error and a caller key on the
 * presence of a `code` property, because a pg driver error always carries a
 * SQLSTATE and could leak schema names. The seven lock helpers set a `code`
 * too, so their timeouts were being discarded with the driver errors: the
 * receipt-match route turned routine 5s contention into a 500, and an MCP agent
 * — the audience the "retry in a moment" wording was written for — got the
 * generic fallback instead.
 */
import { describe, it, expect } from 'vitest';
import { isCallerSafeError, isLockTimeoutError } from '@/lib/lockTimeout';
import { safeErrorText } from '@/lib/mcp/tools/toolHelpers';
import { CustomerInvoiceLockTimeoutError } from '@/modules/accounting/services/ar/customerInvoiceLock';
import { CreditNoteLockTimeoutError } from '@/modules/accounting/services/ar/creditNoteLock';
import { SupplierInvoiceLockTimeoutError } from '@/modules/accounting/services/ap/supplierInvoiceLock';
import { BankTransactionLockTimeoutError } from '@/modules/accounting/services/bank/bankTxLock';
import { PaymentLockTimeoutError } from '@/modules/accounting/services/core/paymentLock';
import { GlAccountLockTimeoutError } from '@/modules/accounting/services/gl/glAccountLock';
import { ReclassLineLockTimeoutError } from '@/modules/accounting/services/gl/reclassification/lineLock';

function driverError(code: string): Error {
  return Object.assign(new Error('duplicate key value violates unique constraint "uq_x"'), { code });
}

describe('isLockTimeoutError', () => {
  it('recognises every hand-thrown lock timeout', () => {
    for (const err of [
      new CustomerInvoiceLockTimeoutError('Invoice INV-1'),
      new CreditNoteLockTimeoutError('cn-1'),
      new SupplierInvoiceLockTimeoutError('si-1'),
    ]) {
      expect(isLockTimeoutError(err)).toBe(true);
      expect(err.message).toMatch(/retry in a moment/);
    }
  });

  it('does not recognise a driver error, whatever its SQLSTATE', () => {
    // 55P03 is the raw code the helpers CATCH. An unmapped one reaching here
    // still must not be surfaced — only the typed rethrow may be.
    for (const code of ['23505', '42703', '55P03', '25P02']) {
      expect(isLockTimeoutError(driverError(code))).toBe(false);
    }
  });

  it('is false for a non-Error and for a code that is not a string', () => {
    expect(isLockTimeoutError('LOCK_TIMEOUT')).toBe(false);
    expect(isLockTimeoutError(Object.assign(new Error('x'), { code: 42 }))).toBe(false);
  });
});

describe('isCallerSafeError — the receipt-match route predicate', () => {
  it('admits a plain refusal and a lock timeout, refuses a driver error', () => {
    expect(isCallerSafeError(new Error('R200.00 exceeds the R100.00 outstanding'))).toBe(true);
    expect(isCallerSafeError(new CustomerInvoiceLockTimeoutError('Invoice INV-1'))).toBe(true);
    expect(isCallerSafeError(driverError('23505'))).toBe(false);
  });
});

describe('safeErrorText — what an MCP agent is told', () => {
  it('passes the lock timeout through instead of the fallback', () => {
    const err = new CustomerInvoiceLockTimeoutError('Invoice INV-1');
    expect(safeErrorText(err, 'Could not apply this receipt.')).toBe(err.message);
  });

  it('still hides a driver error behind the fallback', () => {
    expect(safeErrorText(driverError('23505'), 'Could not apply this receipt.'))
      .toBe('Could not apply this receipt.');
  });

  it('still passes an ordinary refusal through', () => {
    expect(safeErrorText(new Error('Invoice has no outstanding balance'), 'fallback'))
      .toBe('Invoice has no outstanding balance');
  });
});

/**
 * The suffix is a contract, not a naming preference: `isCallerSafeError` decides
 * on it whether a typed error's own message may be shown to a caller. A lock
 * error that drops it silently loses its retry wording the moment its route or
 * tool adopts one of the two filters — which is what `RECLASS_LINE_LOCKED` was
 * one adoption away from doing. This enumerates every typed lock error in the
 * codebase so a new one that forgets the suffix fails here instead.
 */
describe('every typed lock-timeout error carries the _LOCK_TIMEOUT suffix', () => {
  const all = [
    new CustomerInvoiceLockTimeoutError('Invoice INV-1'),
    new CreditNoteLockTimeoutError('cn-1'),
    new SupplierInvoiceLockTimeoutError('si-1'),
    new BankTransactionLockTimeoutError('tx-1'),
    new PaymentLockTimeoutError('pay-1'),
    new GlAccountLockTimeoutError('gl-1'),
    new ReclassLineLockTimeoutError(3),
  ];

  it.each(all.map(e => [e.name, e] as const))('%s', (_name, err) => {
    expect(err.code.endsWith('_LOCK_TIMEOUT')).toBe(true);
    expect(isCallerSafeError(err)).toBe(true);
    expect(err.message).toMatch(/retry in a moment/);
  });

  it('gives each one a distinct code, so a consumer can tell them apart', () => {
    const codes = all.map(e => e.code);
    expect(new Set(codes).size).toBe(codes.length);
  });
});
