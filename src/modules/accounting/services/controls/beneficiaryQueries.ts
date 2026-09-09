import {lockEmployeeBank,activateEmployeeBank} from './employeeBeneficiaryBank';
import {validateEmployeeBeneficiaryEvidence} from './employeeBeneficiaryEvidence';
import { randomUUID } from 'node:crypto';
import { UUID_RE } from '@/lib/validation';
import { isActiveUserAccount, type UserAccountRow } from '@/lib/auth/userAccountStatus';
import { permissionReason } from '@/lib/auth/effectivePermissionPolicy';
import type { ModulePermission } from '@/lib/auth/permissionService';
import type { ControlTx, EvidenceRef } from './contracts';
import type { ProtectedChange } from './changeProtection';
import { BeneficiaryError, type BeneficiaryDetails, type BeneficiaryRef } from './beneficiaryValidation';
import {loadOwnedCapturedEvidence} from './capturedEvidenceSource';
import {isCapturedEvidenceUnavailable} from './capturedEvidenceScan';
import {canonicalJson} from './canonical';

export interface Proposal {
  id: string; company_id: string; entity_type: BeneficiaryRef['entityType']; entity_id: string;
  requester_person_id: string; requester_auth_method: 'cookie' | 'pat' | 'oauth';
  requester_grant_id: string | null; requester_granted_scopes: string[] | null;
  details_envelope: ProtectedChange; details_fingerprint: string; base_bank_fingerprint: string;
  base_verified_version: string | number | null; evidence_refs: EvidenceRef[]; status: string;
}
export interface VerifiedVersion {
  id: string; version: string | number; details_envelope: ProtectedChange; fingerprint: string;
}
export async function lockBank(ctx: ControlTx, ref: BeneficiaryRef): Promise<unknown> {
  if (ref.entityType === 'supplier') {
    const rows = await ctx.sql`SELECT bank_name AS "bankName",bank_account_number AS "accountNumber",
      bank_branch_code AS "branchCode",bank_account_type AS "accountType" FROM suppliers
      WHERE company_id=${ctx.principal.companyId}::uuid AND id=${ref.entityId}::uuid AND deleted_at IS NULL AND is_active=true FOR UPDATE`;
    if (rows.length !== 1) throw new BeneficiaryError('NOT_FOUND');
    return rows[0];
  }
  return lockEmployeeBank(ctx,ref.entityId);
}
export async function pendingProposal(ctx: ControlTx, ref: BeneficiaryRef): Promise<string | null> {
  const rows = await ctx.sql`SELECT id FROM control_beneficiary_proposals WHERE company_id=${ctx.principal.companyId}::uuid
    AND entity_type=${ref.entityType} AND entity_id=${ref.entityId}::uuid AND status='pending'` as { id: string }[];
  return rows[0]?.id ?? null;
}
export async function latestVersion(ctx: ControlTx, ref: BeneficiaryRef): Promise<VerifiedVersion | null> {
  const rows = await ctx.sql`SELECT id,version,details_envelope,fingerprint FROM control_beneficiary_versions
    WHERE company_id=${ctx.principal.companyId}::uuid AND entity_type=${ref.entityType} AND entity_id=${ref.entityId}::uuid
    ORDER BY version DESC LIMIT 1` as VerifiedVersion[];
  return rows[0] ?? null;
}
export async function loadProposal(ctx: ControlTx, id: string, lock = false): Promise<Proposal> {
  const rows = lock
    ? await ctx.sql`SELECT * FROM control_beneficiary_proposals WHERE company_id=${ctx.principal.companyId}::uuid AND id=${id}::uuid FOR UPDATE`
    : await ctx.sql`SELECT * FROM control_beneficiary_proposals WHERE company_id=${ctx.principal.companyId}::uuid AND id=${id}::uuid`;
  if (rows.length !== 1) throw new BeneficiaryError('NOT_FOUND');
  return rows[0] as Proposal;
}
export async function validateEvidence(ctx: ControlTx, ref: BeneficiaryRef, evidence: readonly EvidenceRef[]): Promise<EvidenceRef[]> {
  const saved=JSON.parse(canonicalJson({ref,evidence})) as {ref:BeneficiaryRef;evidence:EvidenceRef[]};ref=saved.ref;evidence=saved.evidence;
  if (!Array.isArray(evidence) || evidence.length < 1 || evidence.length > 10) throw new BeneficiaryError('EVIDENCE_REQUIRED');
  if (ref.entityType === 'employee') return validateEmployeeBeneficiaryEvidence(ctx,ref,evidence);
  const result: EvidenceRef[] = [];
  const deadline=AbortSignal.timeout(20000);
  for (const e of [...evidence].sort((a, b) => a.evidenceId < b.evidenceId ? -1 : 1)) {
    if (e.store !== 'captured') throw new BeneficiaryError('EVIDENCE_STORE_UNSUPPORTED');
    if (e.entityType !== 'supplier_invoice' || !UUID_RE.test(e.entityId) || !UUID_RE.test(e.evidenceId)
      || e.version !== null || !e.hash || !/^[a-f0-9]{64}$/.test(e.hash)
      || result.some(r => r.evidenceId === e.evidenceId)) throw new BeneficiaryError('INVALID_EVIDENCE');
    const rows = await ctx.sql`SELECT d.id,d.raw_bytes_sha256 FROM captured_documents d
      JOIN supplier_invoices i ON i.id=d.matched_invoice_id AND i.company_id=d.company_id
      WHERE d.company_id=${ctx.principal.companyId}::uuid AND d.id=${e.evidenceId}::uuid
        AND i.id=${e.entityId}::uuid AND i.supplier_id=${ref.entityId}::uuid
        AND d.status NOT IN ('rejected','deleted') FOR SHARE OF d,i` as {id:string;raw_bytes_sha256:string|null}[];
    const row = rows[0];
    if (rows.length !== 1 || !row || row.raw_bytes_sha256 !== e.hash) {
      throw new BeneficiaryError('EVIDENCE_UNAVAILABLE_OR_CHANGED');
    }
    const stored=await loadOwnedCapturedEvidence(ctx,row.id,'read:invoices',deadline).catch(error=>{
      if(isCapturedEvidenceUnavailable(error))throw new BeneficiaryError('EVIDENCE_UNAVAILABLE_OR_CHANGED');
      throw error;
    });
    if(!stored?.recordedHashVerified||stored.sha256!==e.hash)throw new BeneficiaryError('EVIDENCE_UNAVAILABLE_OR_CHANGED');
    result.push({ store: 'captured', evidenceId: e.evidenceId, entityType: 'supplier_invoice', entityId: e.entityId, version: null, hash: e.hash });
  }
  return result;
}
interface Authority extends UserAccountRow {
  person_id: string; role: string; company_status: string | null; company_suspended_at: Date | string | null;
  permissions: Record<string, unknown>[]; grant_valid: boolean; current_scopes: string[] | null;
}
export async function lockAuthorities(ctx: ControlTx, proposalId: string, requireRequester = true): Promise<void> {
  const rows = await ctx.sql`SELECT * FROM public.control_beneficiary_authorities(${ctx.principal.companyId}::uuid,${proposalId}::uuid)` as Authority[];
  if (!rows.some(r => r.person_id === ctx.principal.personId)) throw new BeneficiaryError('CURRENT_AUTHORITY_REQUIRED');
  if (!requireRequester) return; // Rejection may terminate an intent whose requester lost authority.
  const proposal = await loadProposal(ctx, proposalId);
  const requester = rows.find(r => r.person_id === proposal.requester_person_id);
  if (!requester || !rows.some(r => r.person_id === ctx.principal.personId) || !isActiveUserAccount(requester)
    || requester.company_suspended_at != null || ['suspended', 'deleted'].includes(requester.company_status ?? '')
    || requester.grant_valid !== true || !Array.isArray(requester.permissions)) throw new BeneficiaryError('REQUESTER_REVOKED');
  const overrides: ModulePermission[] = requester.permissions.map(p => ({ moduleKey: String(p.module_key), moduleName: String(p.module_key),
    canRead: p.can_read === true, canWrite: p.can_write === true, canDelete: p.can_delete === true,
    canExport: p.can_export === true, canApprove: p.can_approve === true,
    accountRangeFrom: p.account_range_from == null ? null : String(p.account_range_from),
    accountRangeTo: p.account_range_to == null ? null : String(p.account_range_to), restrictions: p.restrictions as Record<string, unknown> }));
  const scopes = proposal.requester_auth_method === 'cookie' ? null
    : (proposal.requester_granted_scopes ?? []).filter(s => requester.current_scopes?.includes(s));
  if (permissionReason(requester.role, 'write:beneficiaries', scopes, overrides)
    || (proposal.entity_type==='employee' && permissionReason(requester.role,'write:payroll',scopes,overrides))) throw new BeneficiaryError('REQUESTER_REVOKED');
}
/** Configured beneficiary policy evaluation is supplied by the approval facade; never silently skip one. */
export async function assertPoliciesSupported(ctx: ControlTx): Promise<void> {
  await ctx.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`control-policy:${ctx.principal.companyId}`},0))`;
  const rows = await ctx.sql`SELECT id FROM approval_rules WHERE company_id=${ctx.principal.companyId}::uuid
    AND is_active=true AND (document_type LIKE 'beneficiary%' OR document_type IN ('supplier_bank','employee_bank','all','*')) FOR SHARE`;
  if (rows.length) throw new BeneficiaryError('CONFIGURED_POLICY_REQUIRES_APPROVAL_FACADE');
}
export async function insertProposal(ctx: ControlTx, p: Proposal): Promise<void> {
  await ctx.sql`INSERT INTO control_beneficiary_proposals(id,company_id,entity_type,entity_id,requester_person_id,
    requester_auth_method,requester_grant_id,requester_granted_scopes,details_envelope,details_fingerprint,
    base_bank_fingerprint,base_verified_version,evidence_refs,status)
    VALUES(${p.id}::uuid,${ctx.principal.companyId}::uuid,${p.entity_type},${p.entity_id}::uuid,${p.requester_person_id},
      ${p.requester_auth_method},${p.requester_grant_id}::uuid,${p.requester_granted_scopes}::text[],${JSON.stringify(p.details_envelope)}::jsonb,
      ${p.details_fingerprint},${p.base_bank_fingerprint},${p.base_verified_version},${JSON.stringify(p.evidence_refs)}::jsonb,'pending')`;
}
export async function activateBank(ctx: ControlTx, ref: BeneficiaryRef, d: BeneficiaryDetails): Promise<void> {
  if (ref.entityType === 'supplier') {
    const rows = await ctx.sql`UPDATE suppliers SET bank_name=${d.bankName},bank_account_number=${d.accountNumber},
      bank_branch_code=${d.branchCode},bank_account_type=${d.accountType},updated_at=clock_timestamp()
      WHERE company_id=${ctx.principal.companyId}::uuid AND id=${ref.entityId}::uuid RETURNING id`;
    if (rows.length !== 1) throw new BeneficiaryError('NOT_FOUND');
  } else {
    await activateEmployeeBank(ctx,ref.entityId,d);
  }
}
export async function insertVersion(ctx: ControlTx, p: Proposal, version: number): Promise<void> {
  await ctx.sql`INSERT INTO control_beneficiary_versions(id,company_id,entity_type,entity_id,version,proposal_id,
    details_envelope,fingerprint,verified_by_person_id,verified_at)
    VALUES(${randomUUID()}::uuid,${ctx.principal.companyId}::uuid,${p.entity_type},${p.entity_id}::uuid,${version},${p.id}::uuid,
      ${JSON.stringify(p.details_envelope)}::jsonb,${p.details_fingerprint},${ctx.principal.personId},clock_timestamp())`;
}
export async function markVerified(ctx: ControlTx, proposalId: string): Promise<void> {
  const rows = await ctx.sql`UPDATE control_beneficiary_proposals SET status='verified',verified_by_person_id=${ctx.principal.personId},
    verified_at=clock_timestamp() WHERE company_id=${ctx.principal.companyId}::uuid AND id=${proposalId}::uuid AND status='pending' RETURNING id`;
  if (rows.length !== 1) throw new BeneficiaryError('STALE_PROPOSAL');
}

export async function markTerminal(ctx: ControlTx, proposalId: string, status: 'rejected' | 'cancelled'): Promise<void> {
  const rows = await ctx.sql`UPDATE control_beneficiary_proposals SET status=${status}
    WHERE company_id=${ctx.principal.companyId}::uuid AND id=${proposalId}::uuid AND status='pending' RETURNING id`;
  if (rows.length !== 1) throw new BeneficiaryError('STALE_PROPOSAL');
}
