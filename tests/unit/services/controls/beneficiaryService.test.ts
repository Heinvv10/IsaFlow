import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { withControlRequest, requireControlTx } from '@/modules/accounting/services/controls/context';
import * as service from '@/modules/accounting/services/controls/beneficiaryService';
import * as q from '@/modules/accounting/services/controls/beneficiaryQueries';
import { bankFingerprint, sealBeneficiary } from '@/modules/accounting/services/controls/beneficiaryValidation';
import { assertEffectivePermission } from '@/lib/auth/effectivePermissions';
import { recordCommittedChange } from '@/modules/accounting/services/controls/changeEventService';
vi.mock('@/lib/auth/effectivePermissions', () => ({ assertEffectivePermission: vi.fn() }));
vi.mock('@/modules/accounting/services/controls/changeEventService', () => ({ recordCommittedChange: vi.fn() }));
vi.mock('@/modules/accounting/services/controls/beneficiaryQueries', () => ({
  lockBank: vi.fn(), latestVersion: vi.fn(), pendingProposal: vi.fn(), validateEvidence: vi.fn(),
  insertProposal: vi.fn(), loadProposal: vi.fn(), lockAuthorities: vi.fn(), activateBank: vi.fn(),
  insertVersion: vi.fn(), markVerified: vi.fn(), markTerminal: vi.fn(), assertPoliciesSupported: vi.fn(),
}));
const companyId = '11111111-1111-4111-8111-111111111111';
const ref = { entityType: 'supplier' as const, entityId: '22222222-2222-4222-8222-222222222222' };
const oldBank = { bankName: 'Old', accountNumber: '00123456789', branchCode: '001234', accountType: 'cheque' };
const bank = { ...oldBank, accountNumber: '00987654321' };
const evidence = [{ store: 'captured' as const, evidenceId: '44444444-4444-4444-8444-444444444444', entityType: 'supplier_invoice', entityId: ref.entityId, hash: 'a'.repeat(64), version: null }];
const proposalId = '33333333-3333-4333-8333-333333333333';
const client = { query: vi.fn().mockResolvedValue({ rows: [] }) } as unknown as PoolClient;
function run<T>(personId: string, fn: (ctx: ReturnType<typeof requireControlTx>) => Promise<T>, authMethod: 'cookie' | 'pat' = 'cookie', impersonatorPersonId: string | null = null) {
  return withControlRequest({ client, userId: personId, companyId, claims: {} },
    { personId, companyId, authMethod, connectionId: proposalId, grantId: proposalId, grantedScopes: ['write:beneficiaries'], impersonatorPersonId }, () => fn(requireControlTx()));
}
beforeEach(() => {
  vi.clearAllMocks();
  process.env.ENCRYPTION_KEY = 'synthetic-beneficiary-encryption-key-only';
  process.env.CONTROL_FINGERPRINT_KEY = 'synthetic-beneficiary-fingerprint-key-only';
  vi.mocked(assertEffectivePermission).mockResolvedValue(undefined);
  vi.mocked(q.lockBank).mockResolvedValue(oldBank);
  vi.mocked(q.latestVersion).mockResolvedValue(null);
  vi.mocked(q.pendingProposal).mockResolvedValue(null);
  vi.mocked(q.validateEvidence).mockResolvedValue(evidence);
  vi.mocked(q.lockAuthorities).mockResolvedValue(undefined);
  vi.mocked(q.loadProposal).mockImplementation(async () => ({ id: proposalId, company_id: companyId,
    entity_type: 'supplier', entity_id: ref.entityId, requester_person_id: 'u1', status: 'pending',
    details_envelope: sealBeneficiary(companyId, ref, bank).envelope,
    details_fingerprint: sealBeneficiary(companyId, ref, bank).fingerprint,
    base_bank_fingerprint: bankFingerprint(companyId, ref, oldBank), base_verified_version: null,
    evidence_refs: evidence, requester_auth_method: 'cookie', requester_grant_id: null, requester_granted_scopes: null,
  }));
});
describe('beneficiary workflow kernel', () => {
  it('proposes encrypted material without activating banking', async () => {
    const result = await run('u1', ctx => service.proposeBeneficiaryChange(ctx, ref, bank, evidence));
    expect(result.status).toBe('pending');
    expect(q.activateBank).not.toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(q.insertProposal).mock.calls)).not.toContain(bank.accountNumber);
    expect(assertEffectivePermission).toHaveBeenCalledWith(expect.anything(), 'write:beneficiaries', ref);
    expect(recordCommittedChange).toHaveBeenCalled();
  });
  it('ordinary contact scope is insufficient', async () => {
    vi.mocked(assertEffectivePermission).mockRejectedValue(new Error('forbidden'));
    await expect(run('u1', ctx => service.proposeBeneficiaryChange(ctx, ref, bank, evidence))).rejects.toThrow();
    expect(q.insertProposal).not.toHaveBeenCalled();
  });
  it('refuses same person and agent verification even with a different token', async () => {
    await expect(run('u1', ctx => service.verifyBeneficiaryChange(ctx, proposalId, evidence))).rejects.toThrow();
    await expect(run('u2', ctx => service.verifyBeneficiaryChange(ctx, proposalId, evidence), 'pat')).rejects.toThrow();
    expect(q.activateBank).not.toHaveBeenCalled();
  });
  it('independent human verifies original and new evidence then activates once', async () => {
    const result = await run('u2', ctx => service.verifyBeneficiaryChange(ctx, proposalId, evidence));
    expect(result).toEqual({ proposalId, status: 'verified', version: 1 });
    expect(q.validateEvidence).toHaveBeenCalledTimes(2);
    expect(q.activateBank).toHaveBeenCalledWith(expect.anything(), ref, bank);
    expect(q.markVerified).toHaveBeenCalledTimes(1);
  });
  it('refuses changed original banking and changed beneficiary version', async () => {
    vi.mocked(q.lockBank).mockResolvedValue(bank);
    await expect(run('u2', ctx => service.verifyBeneficiaryChange(ctx, proposalId, evidence))).rejects.toThrow('STALE');
    expect(q.activateBank).not.toHaveBeenCalled();
  });
  it('refuses revoked requester authority before touching beneficiary rows', async () => {
    vi.mocked(q.lockAuthorities).mockRejectedValue(new Error('revoked'));
    await expect(run('u2', ctx => service.verifyBeneficiaryChange(ctx, proposalId, evidence))).rejects.toThrow('revoked');
    expect(q.lockBank).not.toHaveBeenCalled();
  });
  it('refuses legacy banking and puts pending changes on hold', async () => {
    await expect(run('u1', ctx => service.getVerifiedBeneficiary(ctx, ref))).rejects.toThrow('LEGACY_UNVERIFIED');
    vi.mocked(q.pendingProposal).mockResolvedValue(proposalId);
    await expect(run('u1', ctx => service.getVerifiedBeneficiary(ctx, ref))).rejects.toThrow('PENDING_HOLD');
  });
  it('refuses forged transaction context', async () => {
    await expect(service.proposeBeneficiaryChange({ sql: vi.fn(), principal: {} } as never, ref, bank, evidence)).rejects.toThrow();
    expect(q.insertProposal).not.toHaveBeenCalled();
  });
});

it('internal execution read uses domain write permission and refuses untracked bank edits', async () => {
  const sealed = sealBeneficiary(companyId, ref, oldBank);
  vi.mocked(q.latestVersion).mockResolvedValue({ id: proposalId, version: '1', details_envelope: sealed.envelope, fingerprint: sealed.fingerprint });
  const result = await run('u2', ctx => service.getVerifiedBeneficiary(ctx, ref));
  expect(result.details).toEqual(oldBank);
  expect(assertEffectivePermission).toHaveBeenCalledWith(expect.anything(), 'write:bank-tx', ref);
  expect(assertEffectivePermission).not.toHaveBeenCalledWith(expect.anything(), 'write:beneficiaries', ref);
  vi.mocked(q.lockBank).mockResolvedValue(bank);
  await expect(run('u2', ctx => service.getVerifiedBeneficiary(ctx, ref))).rejects.toThrow('BANKING_CHANGED');
});
it('concurrent pending proposal and configured unsupported policy cannot silently bypass approval', async () => {
  vi.mocked(q.pendingProposal).mockResolvedValue(proposalId);
  await expect(run('u1', ctx => service.proposeBeneficiaryChange(ctx, ref, bank, evidence))).rejects.toThrow('PENDING_HOLD');
  vi.mocked(q.assertPoliciesSupported).mockRejectedValue(new Error('configured policy'));
  await expect(run('u2', ctx => service.verifyBeneficiaryChange(ctx, proposalId, evidence))).rejects.toThrow('configured policy');
  expect(q.activateBank).not.toHaveBeenCalled();
});

it('rejection releases the proposal hold without activating banking', async () => {
  const result = await run('u2', ctx => service.rejectBeneficiaryChange(ctx, proposalId, 'Independent review found incorrect details'));
  expect(result).toEqual({ proposalId, status: 'rejected' });
  expect(q.markTerminal).toHaveBeenCalledWith(expect.anything(), proposalId, 'rejected');
  expect(q.activateBank).not.toHaveBeenCalled();
});
it('never accepts an impersonated session as the independent beneficiary reviewer', async () => {
  await expect(run('u2', ctx => service.verifyBeneficiaryChange(ctx, proposalId, evidence), 'cookie', 'u1'))
    .rejects.toThrow('Impersonated self approval is not permitted');
  await expect(run('u2', ctx => service.rejectBeneficiaryChange(ctx, proposalId, 'reject'), 'cookie', 'platform-admin'))
    .rejects.toThrow('An impersonated session cannot record an independent review');
  expect(q.activateBank).not.toHaveBeenCalled();
  expect(q.markTerminal).not.toHaveBeenCalled();
});
it('only the cookie requester can cancel, and cannot self-reject', async () => {
  await expect(run('u2', ctx => service.cancelBeneficiaryChange(ctx, proposalId, 'withdraw'))).rejects.toThrow('REQUESTER_REQUIRED');
  await expect(run('u1', ctx => service.rejectBeneficiaryChange(ctx, proposalId, 'reject'))).rejects.toThrow('INDEPENDENT_PERSON_REQUIRED');
  expect(await run('u1', ctx => service.cancelBeneficiaryChange(ctx, proposalId, 'withdraw'))).toEqual({ proposalId, status: 'cancelled' });
});

it('never persists a beneficiary proposal using a platform import target even if a permission adapter allows it',async()=>{
 const {withPlatformImportRequest,withPlatformImportTarget}=await import('@/lib/auth/platformImportAuthority');
 const parent={client,userId:'u1',claims:{sub:'u1'}};
 vi.mocked(client.query).mockResolvedValue({rows:[{role:'super_admin',is_active:true,status:'active',suspended_at:null,company_status:'active',company_suspended_at:null}]} as never);
 await expect(withPlatformImportRequest(parent,cap=>withPlatformImportTarget(cap,{action:'execute',companyId,importId:proposalId},
  ctx=>service.proposeBeneficiaryChange(ctx,ref,bank,evidence)))).rejects.toMatchObject({code:'UNSUPPORTED_PRINCIPAL'});
 expect(q.insertProposal).not.toHaveBeenCalled();
});
