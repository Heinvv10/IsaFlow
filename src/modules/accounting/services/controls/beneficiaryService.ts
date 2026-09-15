import { randomUUID } from 'node:crypto';
import { als } from '@/lib/als';
import { withSavepoint } from '@/lib/neon';
import { UUID_RE } from '@/lib/validation';
import { assertEffectivePermission } from '@/lib/auth/effectivePermissions';
import { assertControlTx } from './context';
import { recordCommittedChange } from './changeEventService';
import type { ControlPrincipal, ControlTx, EvidenceRef } from './contracts';
import { assertIndependentHumanReview } from './independentReview';
import { BeneficiaryError, bankFingerprint, normalizeBeneficiaryDetails, openBeneficiary, sealBeneficiary,
  validateBeneficiaryRef, type BeneficiaryDetails, type BeneficiaryRef } from './beneficiaryValidation';
import * as q from './beneficiaryQueries';

export type { BeneficiaryDetails, BeneficiaryRef } from './beneficiaryValidation';
export { BeneficiaryError } from './beneficiaryValidation';
/**
 * Who may propose beneficiary bank details, AND where each one's grant id comes
 * from — one total decision per principal kind.
 *
 * Both halves used to be allow-by-omission. The guard named the kinds it
 * refused, so a new principal kind could propose by default; and the grant id
 * was derived by fall-through, so that kind would not merely be admitted, it
 * would be ISSUED an identifier the code never meant to give it. Beneficiary
 * bank details are the payment-fraud surface — the row an attacker edits to
 * redirect money — so neither half may be reached by omission.
 *
 * A Record over the whole `authMethod` union makes a seventh principal kind a
 * type error here until someone answers both questions for it. In src, not in
 * a test: `tests/**` is outside tsconfig, so an exhaustiveness check written
 * there compile-checks nothing. The permitted set matches `q.Proposal`'s own
 * `requester_auth_method` type and migration 802's CHECK, which also requires a
 * non-null grant id for every non-cookie proposer.
 */
type ProposerAuthMethod = q.Proposal['requester_auth_method'];
const BENEFICIARY_PROPOSER: Readonly<Record<ControlPrincipal['authMethod'], 'refused' | 'none' | 'connection' | 'grant'>> =
  Object.freeze({ cookie: 'none', pat: 'connection', oauth: 'grant',
    job: 'refused', platform_import: 'refused', gateway: 'refused' });
function mayProposeBeneficiary(authMethod: ControlPrincipal['authMethod']): authMethod is ProposerAuthMethod {
  return BENEFICIARY_PROPOSER[authMethod] !== 'refused';
}
const positiveVersion = (value: string | number): number => {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1) throw new BeneficiaryError('INVALID_STORED_VERSION');
  return n;
};
function snapshot(value: unknown): unknown {
  try { return normalizeBeneficiaryDetails(value); }
  catch { return value; } // Malformed legacy material remains unverified, but still bound against edits.
}
async function mutation<T>(ctx: ControlTx, action: () => Promise<T>): Promise<T> {
  try {
    assertControlTx(ctx);
    return await withSavepoint(`beneficiary_${randomUUID().replaceAll('-', '').slice(0, 18)}`, action);
  } catch (error) {
    const store = als.getStore();
    if (store) store.controlWriteFailed = true;
    throw error;
  }
}
/** Maintenance creates a hold and encrypted proposal; it does not change active bank details. */
export async function proposeBeneficiaryChange(ctx: ControlTx, input: BeneficiaryRef,
  bank: BeneficiaryDetails, evidenceRefs: readonly EvidenceRef[]): Promise<{ proposalId: string; status: 'pending' }> {
  return mutation(ctx, async () => {
    const ref = validateBeneficiaryRef(input), details = normalizeBeneficiaryDetails(bank);
    await assertEffectivePermission(ctx, 'write:beneficiaries', ref);
    if(ref.entityType==='employee')await assertEffectivePermission(ctx,'write:payroll',ref);
    const currentBank = snapshot(await q.lockBank(ctx, ref));
    if (await q.pendingProposal(ctx, ref)) throw new BeneficiaryError('PENDING_HOLD');
    const previous = await q.latestVersion(ctx, ref);
    if (!Array.isArray(evidenceRefs)) throw new BeneficiaryError('INVALID_EVIDENCE');
    const evidence = evidenceRefs.length ? await q.validateEvidence(ctx, ref, evidenceRefs) : [];
    const sealed = sealBeneficiary(ctx.principal.companyId, ref, details);
    const p = ctx.principal;
    if (!mayProposeBeneficiary(p.authMethod)) throw new BeneficiaryError('UNSUPPORTED_PRINCIPAL');
    const grantSource = BENEFICIARY_PROPOSER[p.authMethod];
    const proposal: q.Proposal = { id: randomUUID(), company_id: p.companyId, entity_type: ref.entityType, entity_id: ref.entityId,
      requester_person_id: p.personId, requester_auth_method: p.authMethod,
      requester_grant_id: grantSource === 'none' ? null : grantSource === 'connection' ? p.connectionId : p.grantId,
      requester_granted_scopes: p.grantedScopes === null ? null : [...p.grantedScopes],
      details_envelope: sealed.envelope, details_fingerprint: sealed.fingerprint,
      base_bank_fingerprint: bankFingerprint(p.companyId, ref, currentBank),
      base_verified_version: previous === null ? null : positiveVersion(previous.version), evidence_refs: evidence, status: 'pending' };
    await q.insertProposal(ctx, proposal);
    await recordCommittedChange(ctx, { entityType: `beneficiary_${ref.entityType}_proposal`, entityId: proposal.id,
      previousVersion: null, newVersion: 1, action: 'beneficiary.propose', accountingDate: null,
      before: null, after: { status: 'pending', beneficiary: ref, details, evidence }, bindingHash: null, protectedEvidenceRef: null });
    return { proposalId: proposal.id, status: 'pending' };
  });
}
/** Independent cookie-authenticated evidence review is the mandatory activation approval. */
export async function verifyBeneficiaryChange(ctx: ControlTx, proposalId: string,
  evidenceRefs: readonly EvidenceRef[]): Promise<{ proposalId: string; status: 'verified'; version: number }> {
  return mutation(ctx, async () => {
    if (!UUID_RE.test(proposalId)) throw new BeneficiaryError('INVALID_PROPOSAL');
    if (ctx.principal.authMethod !== 'cookie' || ctx.principal.provenance !== 'human') throw new BeneficiaryError('HUMAN_REQUIRED');
    // This helper locks caller/requester in a common order before either live permission lookup.
    await q.lockAuthorities(ctx, proposalId);
    const initial = await q.loadProposal(ctx, proposalId);
    assertIndependentHumanReview(ctx.principal, initial.requester_person_id);
    if (initial.requester_person_id === ctx.principal.personId) throw new BeneficiaryError('INDEPENDENT_PERSON_REQUIRED');
    const ref = validateBeneficiaryRef({ entityType: initial.entity_type, entityId: initial.entity_id });
    await assertEffectivePermission(ctx, 'write:beneficiaries', ref);
    if(ref.entityType==='employee')await assertEffectivePermission(ctx,'write:payroll',ref);
    await assertEffectivePermission(ctx, 'write:approvals', ref);
    await q.assertPoliciesSupported(ctx);
    const currentBank = snapshot(await q.lockBank(ctx, ref));
    const proposal = await q.loadProposal(ctx, proposalId, true);
    const previous = await q.latestVersion(ctx, ref);
    const oldVersion = previous === null ? null : positiveVersion(previous.version);
    if (proposal.status !== 'pending' || (proposal.base_verified_version === null ? null : positiveVersion(proposal.base_verified_version)) !== oldVersion
      || proposal.base_bank_fingerprint !== bankFingerprint(ctx.principal.companyId, ref, currentBank)) throw new BeneficiaryError('STALE_PROPOSAL');
    if (proposal.evidence_refs.length) await q.validateEvidence(ctx, ref, proposal.evidence_refs);
    const evidence = await q.validateEvidence(ctx, ref, evidenceRefs);
    const details = openBeneficiary(ctx.principal.companyId, ref, proposal.details_envelope, proposal.details_fingerprint);
    const version = (oldVersion ?? 0) + 1;
    await q.activateBank(ctx, ref, details);
    await q.insertVersion(ctx, proposal, version);
    await q.markVerified(ctx, proposalId);
    await recordCommittedChange(ctx, { entityType: `beneficiary_${ref.entityType}`, entityId: ref.entityId,
      previousVersion: oldVersion, newVersion: version, action: 'beneficiary.activate', accountingDate: null,
      before: { details: currentBank, version: oldVersion }, after: { status: 'verified', details, version, evidence, proposalId },
      bindingHash: null, protectedEvidenceRef: null });
    await recordCommittedChange(ctx, { entityType: `beneficiary_${ref.entityType}_proposal`, entityId: proposalId,
      previousVersion: 1, newVersion: 2, action: 'beneficiary.verify', accountingDate: null,
      before: { status: 'pending' }, after: { status: 'verified', evidence, version }, bindingHash: null, protectedEvidenceRef: null });
    return { proposalId, status: 'verified', version };
  });
}
/** INTERNAL EXECUTOR ONLY: plaintext result must never become a generic API/UI/MCP response. */
export async function getVerifiedBeneficiary(ctx: ControlTx, input: BeneficiaryRef): Promise<{
  beneficiaryId: string; entityType: BeneficiaryRef['entityType']; entityId: string;
  details: BeneficiaryDetails; version: number; fingerprint: string;
}> {
  assertControlTx(ctx);
  const ref = validateBeneficiaryRef(input);
  await assertEffectivePermission(ctx, ref.entityType === 'supplier' ? 'write:bank-tx' : 'write:payroll', ref);
  const current = snapshot(await q.lockBank(ctx, ref));
  if (await q.pendingProposal(ctx, ref)) throw new BeneficiaryError('PENDING_HOLD');
  const verified = await q.latestVersion(ctx, ref);
  if (!verified) throw new BeneficiaryError('LEGACY_UNVERIFIED');
  const details = openBeneficiary(ctx.principal.companyId, ref, verified.details_envelope, verified.fingerprint);
  if (bankFingerprint(ctx.principal.companyId, ref, current) !== verified.fingerprint) throw new BeneficiaryError('BANKING_CHANGED');
  return { ...ref, beneficiaryId: verified.id, details, version: positiveVersion(verified.version), fingerprint: verified.fingerprint };
}

async function terminateProposal(ctx: ControlTx, proposalId: string, reason: string, status: 'rejected' | 'cancelled') {
  return mutation(ctx, async () => {
    if (!UUID_RE.test(proposalId) || typeof reason !== 'string' || !reason.trim() || reason.length > 1000) {
      throw new BeneficiaryError('INVALID_DECISION');
    }
    if (ctx.principal.authMethod !== 'cookie' || ctx.principal.provenance !== 'human') throw new BeneficiaryError('HUMAN_REQUIRED');
    await q.lockAuthorities(ctx, proposalId, false);
    const initial = await q.loadProposal(ctx, proposalId);
    const isRequester = initial.requester_person_id === ctx.principal.personId;
    if (status === 'cancelled' && !isRequester) throw new BeneficiaryError('REQUESTER_REQUIRED');
    if (status === 'rejected') assertIndependentHumanReview(ctx.principal, initial.requester_person_id);
    if (status === 'rejected' && isRequester) throw new BeneficiaryError('INDEPENDENT_PERSON_REQUIRED');
    const ref = validateBeneficiaryRef({ entityType: initial.entity_type, entityId: initial.entity_id });
    await assertEffectivePermission(ctx, 'write:beneficiaries', ref);
    if(ref.entityType==='employee')await assertEffectivePermission(ctx,'write:payroll',ref);
    if (status === 'rejected') await assertEffectivePermission(ctx, 'write:approvals', ref);
    await q.lockBank(ctx, ref);
    const proposal = await q.loadProposal(ctx, proposalId, true);
    if (proposal.status !== 'pending') throw new BeneficiaryError('STALE_PROPOSAL');
    await q.markTerminal(ctx, proposalId, status);
    await recordCommittedChange(ctx, { entityType: `beneficiary_${ref.entityType}_proposal`, entityId: proposalId,
      previousVersion: 1, newVersion: 2, action: `beneficiary.${status === 'rejected' ? 'reject' : 'cancel'}`, accountingDate: null,
      before: { status: 'pending' }, after: { status, decisionReason: reason.trim() }, bindingHash: null, protectedEvidenceRef: null });
    return { proposalId, status };
  });
}
/** Rejection preserves the current verified bank and records the independent decision in protected evidence. */
export function rejectBeneficiaryChange(ctx: ControlTx, proposalId: string, reason: string) {
  return terminateProposal(ctx, proposalId, reason, 'rejected');
}
/** Only the authenticated human requester may withdraw their pending intent. */
export function cancelBeneficiaryChange(ctx: ControlTx, proposalId: string, reason: string) {
  return terminateProposal(ctx, proposalId, reason, 'cancelled');
}
