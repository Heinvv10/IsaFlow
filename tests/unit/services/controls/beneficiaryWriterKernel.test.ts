import { expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { proposeBeneficiaryChange, verifyBeneficiaryChange } from '@/modules/accounting/services/controls/beneficiaryService';
import { withControlRequest, requireControlTx } from '@/modules/accounting/services/controls/context';
import { bankFingerprint, sealBeneficiary } from '@/modules/accounting/services/controls/beneficiaryValidation';
const companyId = '11111111-1111-4111-8111-111111111111', id = '22222222-2222-4222-8222-222222222222';
const ref = { entityType: 'supplier' as const, entityId: id };
const bank = { bankName: 'Synthetic bank', accountNumber: '00123456789', branchCode: '001234', accountType: 'cheque' };
vi.mock('@/lib/auth/effectivePermissions', () => ({ assertEffectivePermission: vi.fn() }));
vi.mock('@/modules/accounting/services/controls/changeEventService', () => ({ recordCommittedChange: vi.fn() }));
const mocks = vi.hoisted(() => ({ validateEvidence: vi.fn().mockRejectedValue(new Error('EVIDENCE_REQUIRED')), insertProposal: vi.fn(), activateBank: vi.fn(), loadProposal: vi.fn() }));
vi.mock('@/modules/accounting/services/controls/beneficiaryQueries', () => ({ ...mocks,
  lockBank: vi.fn().mockResolvedValue(null), pendingProposal: vi.fn().mockResolvedValue(null), latestVersion: vi.fn().mockResolvedValue(null),
  lockAuthorities: vi.fn(), assertPoliciesSupported: vi.fn() }));
const client = { query: vi.fn().mockResolvedValue({ rows: [] }) } as unknown as PoolClient;
function run<T>(personId: string, fn: (ctx: ReturnType<typeof requireControlTx>) => Promise<T>) {
  process.env.ENCRYPTION_KEY = 'synthetic-beneficiary-encryption-key-only';
  process.env.CONTROL_FINGERPRINT_KEY = 'synthetic-beneficiary-fingerprint-key-only';
  return withControlRequest({ client, userId:personId, companyId, claims:{} }, { personId,companyId,authMethod:'cookie' }, () => fn(requireControlTx()));
}
it('creates encrypted pending intent for a bankless new supplier without inventing evidence', async () => {
  expect(await run('u1', ctx => proposeBeneficiaryChange(ctx,ref,bank,[]))).toMatchObject({ status:'pending' });
  expect(mocks.validateEvidence).not.toHaveBeenCalled();
  expect(mocks.insertProposal.mock.calls[0]![1].evidence_refs).toEqual([]);
  expect(mocks.activateBank).not.toHaveBeenCalled();
});
it('verification still refuses empty evidence when the proposal had none', async () => {
  await expect(run('u2', async ctx => {
    const sealed = sealBeneficiary(companyId,ref,bank);
    mocks.loadProposal.mockResolvedValue({ id,entity_type:'supplier',entity_id:id,requester_person_id:'u1',status:'pending',
      base_verified_version:null,base_bank_fingerprint:bankFingerprint(companyId,ref,null),evidence_refs:[],
      details_envelope:sealed.envelope,details_fingerprint:sealed.fingerprint });
    return verifyBeneficiaryChange(ctx,id,[]);
  })).rejects.toThrow('EVIDENCE_REQUIRED');
  expect(mocks.activateBank).not.toHaveBeenCalled();
});
