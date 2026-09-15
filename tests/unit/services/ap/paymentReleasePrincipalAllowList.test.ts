/**
 * Only a person may push money out.
 *
 * `schedulePaymentReleaseDispatch` transmits real EFT batches to Netcash on its
 * own pool, outside any HTTP request. Its two principal guards used to name the
 * kinds they REFUSED, so every principal kind added later — the unattended
 * Paystack gateway most dangerously — was accepted by omission. They are an
 * allow-list now, and this pins it.
 *
 * `PERMITTED` is a total map over `ControlPrincipal['authMethod']`: adding a
 * new principal kind is a TYPE ERROR here until its author decides, in writing,
 * whether it may transmit money. That is the property, not the row count.
 */
import { beforeEach, expect, it, vi } from 'vitest';
import type { ControlPrincipal, ControlTx } from '@/modules/accounting/services/controls/contracts';

const mock = vi.hoisted(() => ({ observe: vi.fn() }));
vi.mock('@/modules/accounting/services/controls/context', () => ({
  assertControlTx: vi.fn(), withControlRequest: vi.fn(), requireControlTx: vi.fn(),
}));
vi.mock('@/lib/auth/effectivePermissions', () => ({ assertEffectivePermission: vi.fn(async () => undefined) }));
vi.mock('@/modules/accounting/services/controls/transactionObservers', () => ({
  observeControlTransaction: mock.observe, settleControlTransaction: vi.fn(),
}));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));
vi.mock('@/lib/logger', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { schedulePaymentReleaseDispatch } from '@/modules/accounting/services/ap/paymentReleaseDispatcher';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const PERSON = '22222222-2222-4222-8222-222222222222';
const INTENT = '33333333-3333-4333-8333-333333333333';

/** Every principal kind, and whether it may transmit money. Total by type. */
const PERMITTED: Record<ControlPrincipal['authMethod'], boolean> = {
  cookie: true, pat: true, oauth: true,
  job: false, platform_import: false, gateway: false,
};

function ctxFor(authMethod: ControlPrincipal['authMethod']): ControlTx {
  return {
    principal: { companyId: COMPANY, personId: PERSON, authMethod, connectionId: null, grantId: null,
      actingFirmId: null, requestId: 'r', operationId: 'o', provenance: 'human', delegatedByPersonId: null,
      impersonatorPersonId: null, grantedScopes: null } as ControlPrincipal,
    // The requester check passes, so a refusal can only come from the principal guard.
    sql: (async () => [{ requester_person_id: PERSON }]) as unknown as ControlTx['sql'],
  };
}

beforeEach(() => { vi.clearAllMocks(); });

for (const [authMethod, permitted] of Object.entries(PERMITTED) as Array<[ControlPrincipal['authMethod'], boolean]>) {
  it(`${permitted ? 'lets' : 'refuses'} a ${authMethod} principal ${permitted ? 'dispatch' : 'dispatching'} a release`, async () => {
    const run = schedulePaymentReleaseDispatch(ctxFor(authMethod), INTENT);
    if (permitted) {
      await expect(run).resolves.toBeUndefined();
      expect(mock.observe).toHaveBeenCalledOnce();
    } else {
      await expect(run).rejects.toThrow(/^Authenticated (fixed release|release principal) required$/);
      // Nothing is queued for after the commit, so nothing can transmit.
      expect(mock.observe).not.toHaveBeenCalled();
    }
  });
}
