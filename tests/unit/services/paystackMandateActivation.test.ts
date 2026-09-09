// tests/unit/services/paystackMandateActivation.test.ts
//
// Round-4 blind review, MEDIUM-1 and LOW-1.
//
// MEDIUM-1: the pre-651 fallback resolves the company's ALREADY-ACTIVE mandate
// first, which is what makes a webhook REDELIVERY idempotent. When the code
// just captured differs, it is not a redelivery — a SECOND checkout was paid —
// and returning `already_active` reported that as success, discarding a
// charged authorisation with no record.
//
// LOW-1: the 23505 handler matched the SQLSTATE alone, so any other unique
// violation raised inside the savepoint was reported as "the company already
// has a different active mandate" and swallowed.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const sqlMock = vi.fn();

vi.mock('@/lib/neon', () => ({
  sql: (...args: unknown[]) => sqlMock(...args),
  withSavepoint: <T>(_name: string, fn: () => Promise<T>) => fn(),
}));

const { activateAuthorisedMandate } = await import(
  '@/modules/billing/services/paystackMandateActivation'
);

const AUTH = {
  authorizationCode: 'AUTH_just_charged',
  customerCode: null,
  last4: null,
  brand: null,
  expMonth: null,
  expYear: null,
  bank: null,
};

function pgError(code: string, constraint?: string) {
  return Object.assign(new Error(`duplicate key value violates unique constraint`), {
    code,
    constraint,
  });
}

describe('activateAuthorisedMandate', () => {
  beforeEach(() => {
    sqlMock.mockReset();
  });

  it('reports an unlinked already-active mandate carrying a DIFFERENT code, instead of success', async () => {
    const outcome = await activateAuthorisedMandate(
      'co-1',
      { id: 'm-1', status: 'active', authorizationCode: 'AUTH_earlier_checkout', linked: false },
      AUTH,
    );

    expect(outcome).toBe('already_active_other_code');
    expect(sqlMock).not.toHaveBeenCalled();
  });

  it('still treats a redelivery of the SAME code as already_active', async () => {
    const outcome = await activateAuthorisedMandate(
      'co-1',
      { id: 'm-1', status: 'active', authorizationCode: AUTH.authorizationCode, linked: false },
      AUTH,
    );

    expect(outcome).toBe('already_active');
  });

  it('does not second-guess a mandate the payment request explicitly linked', async () => {
    const outcome = await activateAuthorisedMandate(
      'co-1',
      { id: 'm-1', status: 'active', authorizationCode: 'AUTH_earlier_checkout', linked: true },
      AUTH,
    );

    expect(outcome).toBe('already_active');
  });

  it('absorbs 23505 only for ux_sub_mandates_company_active', async () => {
    sqlMock.mockRejectedValueOnce(pgError('23505', 'ux_sub_mandates_company_active'));

    const outcome = await activateAuthorisedMandate(
      'co-1',
      { id: 'm-1', status: 'pending', authorizationCode: null, linked: true },
      AUTH,
    );

    expect(outcome).toBe('blocked');
  });

  it('rethrows a 23505 raised by any OTHER constraint', async () => {
    sqlMock.mockRejectedValueOnce(pgError('23505', 'ux_some_future_index'));

    await expect(
      activateAuthorisedMandate(
        'co-1',
        { id: 'm-1', status: 'pending', authorizationCode: null, linked: true },
        AUTH,
      ),
    ).rejects.toMatchObject({ code: '23505', constraint: 'ux_some_future_index' });
  });

  it('rethrows a non-unique error untouched', async () => {
    sqlMock.mockRejectedValueOnce(pgError('40P01'));

    await expect(
      activateAuthorisedMandate(
        'co-1',
        { id: 'm-1', status: 'pending', authorizationCode: null, linked: true },
        AUTH,
      ),
    ).rejects.toMatchObject({ code: '40P01' });
  });

  it('never resurrects a revoked mandate', async () => {
    const outcome = await activateAuthorisedMandate(
      'co-1',
      { id: 'm-1', status: 'revoked', authorizationCode: null, linked: true },
      AUTH,
    );

    expect(outcome).toBe('not_pending');
    expect(sqlMock).not.toHaveBeenCalled();
  });
});
