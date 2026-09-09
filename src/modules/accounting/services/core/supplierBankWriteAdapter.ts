import { randomUUID } from 'node:crypto';
import { als } from '@/lib/als';
import { withSavepoint, type DbRow } from '@/lib/neon';
import { assertEffectivePermission } from '@/lib/auth/effectivePermissions';
import { requireControlTx } from '../controls/context';
import { proposeBeneficiaryChange } from '../controls/beneficiaryService';
import { normalizeBeneficiaryDetails, BeneficiaryError, type BeneficiaryDetails } from '../controls/beneficiaryValidation';
import { recordCommittedChange } from '../controls/changeEventService';
import { readControlEntityVersion } from '../controls/operationVersions';
import type { ControlTx, EvidenceRef } from '../controls/contracts';
import type { SupplierWriteInput } from './supplierWriteService';

const FIELDS = { bankName:'bank_name', bankAccountNumber:'bank_account_number', bankBranchCode:'bank_branch_code', bankAccountType:'bank_account_type' } as const;
export async function supplierWrite<T>(companyId: string, action: (ctx: ControlTx) => Promise<T>): Promise<T> {
  try {
    const ctx = requireControlTx();
    if (ctx.principal.companyId !== companyId) throw new BeneficiaryError('COMPANY_MISMATCH');
    return await withSavepoint(`supplier_${randomUUID().replaceAll('-','').slice(0,20)}`, async () => {
      await assertEffectivePermission(ctx,'write:contacts');
      return action(ctx);
    });
  } catch (error) {
    const store = als.getStore(); if (store) store.controlWriteFailed = true;
    throw error;
  }
}
export async function lockSupplier(ctx: ControlTx, id: string): Promise<DbRow | null> {
  const rows = await ctx.sql`SELECT * FROM suppliers WHERE company_id=${ctx.principal.companyId}::uuid
    AND id=${id}::uuid AND deleted_at IS NULL FOR UPDATE` as DbRow[];
  return rows[0] ?? null;
}
/** Omitted/null/blank fields retain the existing COALESCE contract. Actual changes require separate authority. */
export async function prepareBankChange(ctx: ControlTx, input: SupplierWriteInput, before: DbRow | null): Promise<BeneficiaryDetails | null> {
  const values: Record<string,string | null> = {};
  let changed = false;
  for (const [field,column] of Object.entries(FIELDS)) {
    const supplied = input[field as keyof typeof FIELDS];
    if (supplied != null && typeof supplied !== 'string') throw new BeneficiaryError('INVALID_MATERIAL');
    const incoming = supplied?.trim() || null;
    const existing = before?.[column] == null ? null : String(before[column]).trim();
    values[field] = incoming ?? existing;
    if (incoming !== null && incoming !== existing) changed = true;
  }
  if (!changed) return null;
  const details = normalizeBeneficiaryDetails({ bankName:values.bankName,accountNumber:values.bankAccountNumber,
    branchCode:values.bankBranchCode,accountType:values.bankAccountType });
  // Normalized bank aliases and harmless whitespace are not new bank instructions.
  if (before) {
    try {
      const previous = normalizeBeneficiaryDetails({ bankName:before.bank_name,accountNumber:before.bank_account_number,
        branchCode:before.bank_branch_code,accountType:before.bank_account_type });
      if (JSON.stringify(previous) === JSON.stringify(details)) return null;
    } catch (error) {
      if (!(error instanceof BeneficiaryError)) throw error; // Legacy malformed banking still needs a new verified proposal.
    }
  }
  await assertEffectivePermission(ctx,'write:beneficiaries');
  return details;
}
export async function finishSupplierWrite(ctx: ControlTx, row: DbRow, before: DbRow | null,
  bank: BeneficiaryDetails | null, evidence: readonly EvidenceRef[] = []): Promise<DbRow> {
  const ref = { entityType:'supplier' as const,entityId:String(row.id) };
  const proposal = bank ? await proposeBeneficiaryChange(ctx,ref,bank,evidence) : null;
  const version = await readControlEntityVersion(ctx,ref);
  await recordCommittedChange(ctx,{ ...ref,previousVersion:version?.version ?? null,newVersion:(version?.version ?? 0)+1,
    action:before === null ? 'supplier.create' : 'supplier.update',accountingDate:null,before,after:row,
    bindingHash:null,protectedEvidenceRef:null });
  const pending = proposal ?? (await ctx.sql`SELECT id AS "proposalId",status FROM control_beneficiary_proposals
    WHERE company_id=${ctx.principal.companyId}::uuid AND entity_type='supplier' AND entity_id=${ref.entityId}::uuid AND status='pending'`)[0] ?? null;
  return { ...Object.fromEntries(Object.entries(row).filter(([key])=>!Object.values(FIELDS).includes(key as typeof FIELDS[keyof typeof FIELDS]))),
    beneficiary_review:pending };
}
