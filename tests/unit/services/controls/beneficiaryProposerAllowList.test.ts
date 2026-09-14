/**
 * Only a person may propose beneficiary bank details — and only a person gets
 * an identifier recorded against the proposal.
 *
 * Beneficiary bank details are the payment-fraud surface: the row an attacker
 * edits to redirect money. The guard used to name the kinds it REFUSED, so a
 * new principal kind could propose by default, and the grant id was derived by
 * fall-through, so that kind would have been issued an identifier as well.
 * Both are one total map now; this pins both halves.
 *
 * The compile-time half cannot live here — `tsconfig.json` excludes `tests/**`,
 * so no test file is ever typechecked. It lives in the source map, proven by
 * mutation (a seventh authMethod raises TS2741 at the map).
 */
import { beforeEach, expect, it, vi } from 'vitest';
import type { ControlPrincipal, ControlTx } from '@/modules/accounting/services/controls/contracts';

const mock = vi.hoisted(() => {
  // `sealBeneficiary` really encrypts, and it runs BEFORE the principal guard.
  process.env.ENCRYPTION_KEY ??= 'x'.repeat(64);
  process.env.CONTROL_FINGERPRINT_KEY ??= 'y'.repeat(64);
  return { insert: vi.fn(async () => undefined) };
});
vi.mock('@/modules/accounting/services/controls/context', () => ({ assertControlTx: vi.fn() }));
vi.mock('@/lib/auth/effectivePermissions', () => ({ assertEffectivePermission: vi.fn(async () => undefined) }));
vi.mock('@/modules/accounting/services/controls/changeEventService', () => ({
  recordCommittedChange: vi.fn(async () => undefined),
}));
vi.mock('@/lib/neon', () => ({ withSavepoint: (_label: string, fn: () => Promise<unknown>) => fn() }));
vi.mock('@/modules/accounting/services/controls/beneficiaryQueries', () => ({
  lockBank: vi.fn(async () => ({})), pendingProposal: vi.fn(async () => false),
  latestVersion: vi.fn(async () => null), validateEvidence: vi.fn(async () => []),
  insertProposal: mock.insert,
}));

import { proposeBeneficiaryChange, BeneficiaryError } from '@/modules/accounting/services/controls/beneficiaryService';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const PERSON = '22222222-2222-4222-8222-222222222222';
const ENTITY = '33333333-3333-4333-8333-333333333333';
const CONNECTION = '44444444-4444-4444-8444-444444444444';
const GRANT = '55555555-5555-4555-8555-555555555555';

/** Every principal kind: may it propose, and which identifier is recorded. */
const EXPECTED: Record<ControlPrincipal['authMethod'], string | null | 'refused'> = {
  cookie: null, pat: CONNECTION, oauth: GRANT,
  job: 'refused', platform_import: 'refused', gateway: 'refused',
};

function ctxFor(authMethod: ControlPrincipal['authMethod']): ControlTx {
  return {
    principal: { companyId: COMPANY, personId: PERSON, authMethod, connectionId: CONNECTION, grantId: GRANT,
      actingFirmId: null, requestId: 'r', operationId: 'o', provenance: 'human', delegatedByPersonId: null,
      impersonatorPersonId: null, grantedScopes: null } as ControlPrincipal,
    sql: (async () => []) as unknown as ControlTx['sql'],
  };
}
/** Real material: `normalizeBeneficiaryDetails` refuses anything else BEFORE the
 *  principal guard, which would make every case pass for the wrong reason. */
const bank = { bankName: 'FNB', accountNumber: '1234567890', branchCode: '250655', accountType: 'cheque' };

beforeEach(() => { vi.clearAllMocks(); });

for (const [authMethod, expected] of Object.entries(EXPECTED) as Array<[ControlPrincipal['authMethod'], string | null | 'refused']>) {
  it(`${expected === 'refused' ? 'refuses' : 'admits'} a ${authMethod} principal proposing beneficiary bank details`, async () => {
    const run = proposeBeneficiaryChange(ctxFor(authMethod), { entityType: 'supplier', entityId: ENTITY }, bank, []);
    if (expected === 'refused') {
      await expect(run).rejects.toBeInstanceOf(BeneficiaryError);
      await expect(run).rejects.toMatchObject({ code: 'UNSUPPORTED_PRINCIPAL' });
      // Nothing is written, so no identifier is issued to a caller never admitted.
      expect(mock.insert).not.toHaveBeenCalled();
      return;
    }
    await expect(run).resolves.toMatchObject({ status: 'pending' });
    const proposal = mock.insert.mock.calls[0]?.[1] as { requester_auth_method: string; requester_grant_id: string | null };
    expect(proposal.requester_auth_method).toBe(authMethod);
    expect(proposal.requester_grant_id).toBe(expected);
  });
}
