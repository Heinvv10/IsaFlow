import type { ControlTx } from './contracts';
import { readPermission,type EvidenceIdentity,type EvidenceEntityType } from './transactionEvidenceTypes';
export interface EvidenceRow { id:string;status:string|null;hash_available?:boolean;reversed?:boolean }
/** Legacy procurement 'supplier_invoice' means Sage, never a union of unrelated table identities. */
export function procurementParentType(type:string):EvidenceEntityType|null {
  const types:Record<string,EvidenceEntityType>={supplier_invoice:'sage_supplier_invoice',supplier_payment:'supplier_payment',
    customer_invoice:'customer_invoice',customer_payment:'customer_payment',credit_note:'credit_note',purchase_order:'purchase_order',grn:'goods_received_note',goods_received_note:'goods_received_note'};
  return types[type]??null;
}
export async function loadDocumentRow(ctx:ControlTx,ref:EvidenceIdentity,permissions:ReadonlySet<string>):Promise<EvidenceRow|null>{
  const c=ctx.principal.companyId;
  if(ref.entityType==='captured_document'){
    const rows=await ctx.sql`SELECT id,status,(to_jsonb(d)->>'raw_bytes_sha256' IS NOT NULL AND to_jsonb(d)->>'raw_bytes' IS NOT NULL) AS hash_available
      FROM captured_documents d WHERE company_id=${c}::uuid AND id=${ref.entityId}::uuid LIMIT 1` as EvidenceRow[];
    return rows[0]??null;
  }
  if(ref.entityType==='bank_attachment'){
    const rows=await ctx.sql`SELECT a.id,'attached'::text AS status,false AS hash_available FROM bank_transaction_attachments a
      JOIN bank_transactions b ON b.id=a.bank_transaction_id WHERE b.company_id=${c}::uuid AND a.id=${ref.entityId}::uuid LIMIT 1` as EvidenceRow[];
    return rows[0]??null;
  }
  const rows=await ctx.sql`WITH parents AS (
    SELECT 'supplier_invoice' AS kind,id FROM sage_supplier_invoices WHERE company_id=${c}::uuid
    UNION ALL SELECT 'supplier_payment',id FROM supplier_payments WHERE company_id=${c}::uuid
    UNION ALL SELECT 'customer_invoice',id FROM customer_invoices WHERE company_id=${c}::uuid
    UNION ALL SELECT 'customer_payment',id FROM customer_payments WHERE company_id=${c}::uuid
    UNION ALL SELECT 'credit_note',id FROM credit_notes WHERE company_id=${c}::uuid
    UNION ALL SELECT 'purchase_order',id FROM purchase_orders WHERE company_id=${c}::uuid
    UNION ALL SELECT 'grn',id FROM goods_received_notes WHERE company_id=${c}::uuid
    UNION ALL SELECT 'goods_received_note',id FROM goods_received_notes WHERE company_id=${c}::uuid
  ) SELECT d.id,d.entity_type,CASE WHEN d.is_active THEN 'attached' ELSE 'inactive' END AS status,false AS hash_available
    FROM procurement_documents d JOIN parents p ON p.kind=d.entity_type AND p.id=d.entity_id
    WHERE d.id=${ref.entityId}::uuid LIMIT 2` as Array<EvidenceRow&{entity_type:string}>;
  if(rows.length!==1)return null;
  const parent=procurementParentType(rows[0]!.entity_type);
  return parent&&permissions.has(readPermission(parent))?rows[0]!:null;
}
