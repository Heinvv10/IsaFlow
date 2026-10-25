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
//
// Round-5 blind review, HIGH-1: neither zero rows nor that 23505 identifies
// WHICH row holds the active slot. Both are re-read before being called
// `blocked`, so the webhook activating THIS row mid-request is reported as the
// success it is rather than as a durable, payer-visible failure.
//
// S-07e (migration 945): the mandate UPDATE and every read of the
// authorization code run on the migration_admin pool (`sqlMock` below is its
// tx), each scoped by the company; the app-pool `sql` is never used for them.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const sqlMock = vi.fn();
const appSqlMock = vi.fn();
const labels: string[] = [];

vi.mock('@/lib/neon', () => ({
  sql: (...args: unknown[]) => appSqlMock(...args),
}));
vi.mock('@/lib/auth/migrationAdminPool', () => ({
  migrationAdminSqlTx: async <T>(label: string, fn: (tx: typeof sqlMock) => Promise<T>) => {
    labels.push(label);
    return fn(sqlMock);
  },
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
    appSqlMock.mockReset();
    labels.length = 0;
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
    expect(sqlMock).not.toHaveBeenCalled();
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
    // The re-read: this row is untouched, so some OTHER row holds the slot.
    sqlMock.mockResolvedValueOnce([
      { id: 'm-1', status: 'pending', paystack_authorization_code: null },
    ]);

    const outcome = await activateAuthorisedMandate(
      'co-1',
      { id: 'm-1', status: 'pending', authorizationCode: null, linked: true },
      AUTH,
    );

    expect(outcome).toBe('blocked');
    expect(labels).toEqual(['mandate_activate', 'mandate_reclassify']);
    expect(appSqlMock).not.toHaveBeenCalled();
  });

  it('activates a pending mandate with the UPDATE scoped to the company and the mandate', async () => {
    sqlMock.mockResolvedValueOnce([{ id: 'm-1' }]);

    const outcome = await activateAuthorisedMandate(
      'co-1',
      { id: 'm-1', status: 'pending', authorizationCode: null, linked: true },
      AUTH,
    );

    expect(outcome).toBe('activated');
    expect(labels).toEqual(['mandate_activate']);
    const [strings, ...values] = sqlMock.mock.calls[0] as [string[], ...unknown[]];
    expect(strings.join('?')).toMatch(/UPDATE subscription_mandates[\s\S]*company_id = \?[\s\S]*status = 'pending'/);
    expect(values).toContain('co-1');
    expect(values).toContain('m-1');
    expect(values).toContain(AUTH.authorizationCode);
    expect(appSqlMock).not.toHaveBeenCalled();
  });

  it('reports already_active when the re-read shows the OTHER observer activated this row', async () => {
    sqlMock.mockResolvedValueOnce([]); // the conditional UPDATE matched nothing
    sqlMock.mockResolvedValueOnce([
      { id: 'm-1', status: 'active', paystack_authorization_code: AUTH.authorizationCode },
    ]);

    const outcome = await activateAuthorisedMandate(
      'co-1',
      { id: 'm-1', status: 'pending', authorizationCode: null, linked: true },
      AUTH,
    );

    // Before the fix this was `blocked`, and verify persisted
    // failure_reason = 'authorisation_blocked' against an active mandate.
    expect(outcome).toBe('already_active');
  });

  it('still labels an UNLINKED row that came back active carrying a different code', async () => {
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([
      { id: 'm-1', status: 'active', paystack_authorization_code: 'AUTH_someone_else' },
    ]);

    const outcome = await activateAuthorisedMandate(
      'co-1',
      { id: 'm-1', status: 'pending', authorizationCode: null, linked: false },
      AUTH,
    );

    expect(outcome).toBe('already_active_other_code');
  });

  it('reports not_pending when the row is gone or no longer activatable', async () => {
    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([]); // concurrently deleted

    expect(await activateAuthorisedMandate(
      'co-1',
      { id: 'm-1', status: 'pending', authorizationCode: null, linked: true },
      AUTH,
    )).toBe('not_pending');

    sqlMock.mockResolvedValueOnce([]);
    sqlMock.mockResolvedValueOnce([
      { id: 'm-1', status: 'revoked', paystack_authorization_code: null },
    ]);

    expect(await activateAuthorisedMandate(
      'co-1',
      { id: 'm-1', status: 'pending', authorizationCode: null, linked: true },
      AUTH,
    )).toBe('not_pending');
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
