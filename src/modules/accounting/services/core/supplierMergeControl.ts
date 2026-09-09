import type { DbRow } from '@/lib/neon';
import { UUID_RE } from '@/lib/validation';
import { supplierWrite } from './supplierBankWriteAdapter';
import { recordCommittedChange } from '../controls/changeEventService';
import { readControlEntityVersion } from '../controls/operationVersions';

export class SupplierMergeControlError extends Error {
  readonly code = 'SUPPLIER_MERGE_REQUIRES_REVIEW';
  constructor() { super('SUPPLIER_MERGE_REQUIRES_REVIEW: These suppliers have financial documents, banking verification or approval history. Review and resolve those dependencies before merging; payment identities cannot be reassigned.'); }
}
/** Only financially unreferenced contacts can merge; historical/prepared payment identities are never rewritten. */
export async function mergeControlledSuppliers(companyId: string, targetId: string, sourceId: string) {
  return supplierWrite(companyId,async ctx => {
    if (!UUID_RE.test(targetId) || !UUID_RE.test(sourceId) || targetId===sourceId) throw new Error('Invalid supplier merge identities');
    const ids=[sourceId,targetId].sort();
    const suppliers=await ctx.sql`SELECT * FROM suppliers WHERE company_id=${companyId}::uuid
      AND id=ANY(${ids}::uuid[]) AND deleted_at IS NULL AND is_active=true ORDER BY id FOR UPDATE` as DbRow[];
    if (suppliers.length!==2) throw new Error('One or both suppliers not found or do not belong to this company');
    const dependencies=await ctx.sql`SELECT EXISTS (
      SELECT 1 FROM supplier_payments WHERE company_id=${companyId}::uuid AND supplier_id=ANY(${ids}::uuid[])
      UNION ALL SELECT 1 FROM supplier_invoices WHERE company_id=${companyId}::uuid AND supplier_id=ANY(${ids}::uuid[])
      UNION ALL SELECT 1 FROM supplier_purchase_orders WHERE company_id=${companyId}::uuid AND supplier_id=ANY(${ids}::uuid[])
      UNION ALL SELECT 1 FROM control_beneficiary_versions WHERE company_id=${companyId}::uuid AND entity_type='supplier' AND entity_id=ANY(${ids}::uuid[])
      UNION ALL SELECT 1 FROM control_beneficiary_proposals WHERE company_id=${companyId}::uuid AND entity_type='supplier'
        AND entity_id=ANY(${ids}::uuid[]) AND status IN ('pending','verified')
      UNION ALL SELECT 1 FROM control_operation_approvals a WHERE a.company_id=${companyId}::uuid AND (
        (a.entity_type='supplier' AND a.entity_id=ANY(${ids}::text[])) OR
        EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(a.binding->'beneficiaries','[]'::jsonb)) b
          WHERE b->>'entityType'='supplier' AND b->>'entityId'=ANY(${ids}::text[])) OR
        EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(a.binding->'sourceVersions','[]'::jsonb)) b
          WHERE b->>'entityType'='supplier' AND b->>'entityId'=ANY(${ids}::text[]))
      )
    ) AS blocked` as {blocked:boolean}[];
    if (dependencies.length!==1 || dependencies[0]!.blocked!==false) throw new SupplierMergeControlError();
    const rows=await ctx.sql`UPDATE suppliers SET deleted_at=clock_timestamp(),is_active=false,name=name || ' [MERGED]',updated_at=clock_timestamp()
      WHERE company_id=${companyId}::uuid AND id=${sourceId}::uuid RETURNING *` as DbRow[];
    if (rows.length!==1) throw new Error('Supplier disappeared during merge');
    const ref={entityType:'supplier',entityId:sourceId},version=await readControlEntityVersion(ctx,ref);
    await recordCommittedChange(ctx,{...ref,previousVersion:version?.version ?? null,newVersion:(version?.version ?? 0)+1,
      action:'supplier.merge',accountingDate:null,before:suppliers.find(s=>s.id===sourceId)!,after:{...rows[0],mergedInto:targetId},
      bindingHash:null,protectedEvidenceRef:null});
    return {reassignedTransactions:0};
  });
}
