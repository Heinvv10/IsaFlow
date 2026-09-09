import type {ControlTx} from './contracts';
import type {EvidenceIdentity,EvidenceNeighbor} from './transactionEvidenceTypes';
/** JSON references establish recorded intent only. Evidence additionally requires its actual persisted parent. */
export async function listApprovalEvidenceNeighbors(ctx:ControlTx,ref:EvidenceIdentity,offset:number,limit:number):Promise<{links:EvidenceNeighbor[];total:number}>{
 const c=ctx.principal.companyId,t=ref.entityType,id=ref.entityId;
 const rows=await ctx.sql`WITH approvals AS (
   SELECT id,entity_type,entity_id,binding FROM control_operation_approvals WHERE company_id=${c}::uuid
 ), source_refs AS (
   SELECT a.id,e->>'entityType' AS target_type,e->>'entityId' AS target_id,'approval_source_version'::text AS relation,NULL::text AS gap
   FROM approvals a CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(a.binding->'sourceVersions')='array' THEN a.binding->'sourceVersions' ELSE '[]'::jsonb END) e
 ), evidence_refs AS (
   SELECT a.id,a.entity_type,a.entity_id,e FROM approvals a JOIN control_operation_decisions d ON d.approval_id=a.id AND d.company_id=${c}::uuid
   CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(d.evidence_refs)='array' THEN d.evidence_refs ELSE '[]'::jsonb END) e
 ), checked AS (
   SELECT r.*,((e->>'version') IS NULL AND (e->>'entityType')=r.entity_type AND (e->>'entityId')=r.entity_id AND (
    ((e->>'store')='captured' AND EXISTS(SELECT 1 FROM captured_documents cd WHERE cd.company_id=${c}::uuid AND cd.id::text=e->>'evidenceId' AND (e->>'hash' IS NULL OR cd.raw_bytes_sha256=e->>'hash')
      AND ((r.entity_type='bank_transaction' AND cd.matched_bank_tx_id::text=r.entity_id AND EXISTS(
        SELECT 1 FROM bank_transactions b WHERE b.company_id=${c}::uuid AND b.id::text=r.entity_id))
       OR EXISTS(SELECT 1 FROM supplier_invoices i WHERE i.company_id=${c}::uuid AND (i.source_document_id=cd.id OR cd.matched_invoice_id=i.id)
        AND ((r.entity_type='supplier_invoice' AND i.id::text=r.entity_id) OR (r.entity_type='supplier_payment' AND EXISTS(
         SELECT 1 FROM payment_allocations pa JOIN supplier_payments p ON p.id=pa.payment_id AND p.company_id=${c}::uuid
         WHERE pa.invoice_id=i.id AND p.id::text=r.entity_id AND p.supplier_id=i.supplier_id)))))))
    OR ((e->>'store')='bank_attachment' AND e->>'hash' IS NULL AND r.entity_type='bank_transaction' AND EXISTS(
      SELECT 1 FROM bank_transaction_attachments ba JOIN bank_transactions b ON b.id=ba.bank_transaction_id AND b.company_id=${c}::uuid
      WHERE ba.id::text=e->>'evidenceId' AND b.id::text=r.entity_id))
    OR ((e->>'store')='procurement' AND e->>'hash' IS NULL AND EXISTS(SELECT 1 FROM procurement_documents pd WHERE pd.id::text=e->>'evidenceId' AND pd.entity_id::text=r.entity_id
      AND pd.entity_type=CASE WHEN r.entity_type='sage_supplier_invoice' THEN 'supplier_invoice' WHEN r.entity_type='goods_received_note' THEN 'grn' ELSE r.entity_type END
      AND r.entity_type IN ('sage_supplier_invoice','supplier_payment','customer_invoice','customer_payment','credit_note','purchase_order','goods_received_note')))
   )) AS parent_valid FROM evidence_refs r
 ), relationships AS (
   SELECT * FROM source_refs
   UNION ALL SELECT id,CASE e->>'store' WHEN 'captured' THEN 'captured_document' WHEN 'procurement' THEN 'procurement_document'
     WHEN 'bank_attachment' THEN 'bank_attachment' ELSE 'unsupported' END,e->>'evidenceId','approval_decision_evidence',
     CASE WHEN parent_valid THEN NULL ELSE 'APPROVAL_EVIDENCE_PARENT_UNVERIFIED' END FROM checked
 ), neighbors AS (
   SELECT DISTINCT CASE WHEN ${t}='operation_approval' AND id::text=${id} THEN target_type ELSE 'operation_approval' END AS entity_type,
     CASE WHEN ${t}='operation_approval' AND id::text=${id} THEN target_id ELSE id::text END AS entity_id,relation,gap
   FROM relationships WHERE (${t}='operation_approval' AND id::text=${id}) OR (gap IS NULL AND target_type=${t} AND target_id=${id})
 ), page AS (SELECT * FROM neighbors ORDER BY entity_type,entity_id,relation,gap LIMIT ${limit} OFFSET ${offset})
 SELECT (SELECT count(*)::integer FROM neighbors) AS total,COALESCE(jsonb_agg(page ORDER BY entity_type,entity_id,relation,gap),'[]'::jsonb) AS links FROM page` as
 {total:number;links:{entity_type:EvidenceIdentity['entityType'];entity_id:string;relation:string;gap:string|null}[]}[];
 return{total:rows[0]?.total??0,links:(rows[0]?.links??[]).map(r=>({target:{entityType:r.entity_type,entityId:r.entity_id},relation:r.relation,...(r.gap?{gap:r.gap}:{})}))};
}
