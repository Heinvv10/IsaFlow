import { createHash, randomUUID } from 'node:crypto';
import { UUID_RE } from '@/lib/validation';
import { isActiveUserAccount, type UserAccountRow } from '@/lib/auth/userAccountStatus';
import { permissionReason } from '@/lib/auth/effectivePermissionPolicy';
import type { ModulePermission } from '@/lib/auth/permissionService';
import type { ControlTx, EvidenceRef } from './contracts';
import type { ProtectedChange } from './changeProtection';
import { BeneficiaryError, type BeneficiaryDetails, type BeneficiaryRef } from './beneficiaryValidation';

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
  const parents = await ctx.sql`SELECT id FROM payroll_employees WHERE company_id=${ctx.principal.companyId}::uuid
    AND id=${ref.entityId}::uuid AND status='active' FOR UPDATE`;
  if (parents.length !== 1) throw new BeneficiaryError('NOT_FOUND');
  const rows = await ctx.sql`SELECT b.bank_name AS "bankName",b.account_number AS "accountNumber",
    b.branch_code AS "branchCode",b.account_type AS "accountType" FROM payroll_bank_details b
    JOIN payroll_employees e ON e.id=b.employee_id WHERE e.company_id=${ctx.principal.companyId}::uuid
    AND e.id=${ref.entityId}::uuid AND b.is_active=true ORDER BY b.id FOR UPDATE OF b`;
  if (rows.length > 1) throw new BeneficiaryError('AMBIGUOUS_BANKING');
  return rows[0] ?? null;
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
  if (!Array.isArray(evidence) || evidence.length < 1 || evidence.length > 10) throw new BeneficiaryError('EVIDENCE_REQUIRED');
  if (ref.entityType !== 'supplier') throw new BeneficiaryError('EMPLOYEE_EVIDENCE_PARENT_UNSUPPORTED');
  const result: EvidenceRef[] = [];
  for (const e of [...evidence].sort((a, b) => a.evidenceId < b.evidenceId ? -1 : 1)) {
    if (e.store !== 'captured') throw new BeneficiaryError('EVIDENCE_STORE_UNSUPPORTED');
    if (e.entityType !== 'supplier_invoice' || !UUID_RE.test(e.entityId) || !UUID_RE.test(e.evidenceId)
      || e.version !== null || !e.hash || !/^[a-f0-9]{64}$/.test(e.hash)
      || result.some(r => r.evidenceId === e.evidenceId)) throw new BeneficiaryError('INVALID_EVIDENCE');
    const rows = await ctx.sql`SELECT d.raw_bytes,d.raw_bytes_sha256 FROM captured_documents d
      JOIN supplier_invoices i ON i.id=d.matched_invoice_id AND i.company_id=d.company_id
      WHERE d.company_id=${ctx.principal.companyId}::uuid AND d.id=${e.evidenceId}::uuid
        AND i.id=${e.entityId}::uuid AND i.supplier_id=${ref.entityId}::uuid
        AND d.status NOT IN ('rejected','deleted') FOR SHARE OF d,i` as { raw_bytes: Buffer | null; raw_bytes_sha256: string | null }[];
    const row = rows[0];
    if (rows.length !== 1 || !Buffer.isBuffer(row?.raw_bytes) || !row.raw_bytes.length || row.raw_bytes.length > 10 * 1024 * 1024
      || createHash('sha256').update(row.raw_bytes).digest('hex') !== e.hash || row.raw_bytes_sha256 !== e.hash) {
      throw new BeneficiaryError('EVIDENCE_UNAVAILABLE_OR_CHANGED');
    }
    result.push({ store: 'captured', evidenceId: e.evidenceId, entityType: 'supplier_invoice', entityId: e.entityId, version: null, hash: e.hash });
  }
  return result;
}
interface Authority extends UserAccountRow {
  person_id: string; role: string; company_status: string | null; company_suspended_at: Date | string | null;
  permissions: Record<string, unknown>[]; grant_valid: boolean; current_scopes: string[] | null;
}
export async function lockAuthorities(ctx: ControlTx, proposalId: string): Promise<void> {
  const rows = await ctx.sql`SELECT * FROM public.control_beneficiary_authorities(${ctx.principal.companyId}::uuid,${proposalId}::uuid)` as Authority[];
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
  if (permissionReason(requester.role, 'write:beneficiaries', scopes, overrides)) throw new BeneficiaryError('REQUESTER_REVOKED');
}
/** Configured beneficiary policy evaluation is supplied by the approval facade; never silently skip one. */
export async function assertPoliciesSupported(ctx: ControlTx): Promise<void> {
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
    await ctx.sql`UPDATE payroll_bank_details b SET is_active=false FROM payroll_employees e
      WHERE e.company_id=${ctx.principal.companyId}::uuid AND e.id=${ref.entityId}::uuid AND b.employee_id=e.id AND b.is_active=true`;
    await ctx.sql`INSERT INTO payroll_bank_details(employee_id,bank_name,account_number,account_type,branch_code)
      SELECT id,${d.bankName},${d.accountNumber},${d.accountType},${d.branchCode} FROM payroll_employees
      WHERE company_id=${ctx.principal.companyId}::uuid AND id=${ref.entityId}::uuid`;
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
