import type {ControlTx} from './contracts';
import type {EvidenceIdentity,EvidenceNeighbor} from './transactionEvidenceTypes';
/** A cross-link cannot confer ownership: procurement's original parent must independently belong to this tenant. */
export async function listDocumentEvidenceNeighbors(ctx:ControlTx,ref:EvidenceIdentity,offset:number,limit:number):Promise<{links:EvidenceNeighbor[];total:number}>{
  const c=ctx.principal.companyId,t=ref.entityType,id=ref.entityId;
  const rows=await ctx.sql`WITH parents(kind,graph_type,id) AS (
    SELECT 'supplier_invoice','sage_supplier_invoice',id FROM sage_supplier_invoices WHERE company_id=${c}::uuid
    UNION ALL SELECT 'supplier_payment','supplier_payment',id FROM supplier_payments WHERE company_id=${c}::uuid
    UNION ALL SELECT 'customer_invoice','customer_invoice',id FROM customer_invoices WHERE company_id=${c}::uuid
    UNION ALL SELECT 'customer_payment','customer_payment',id FROM customer_payments WHERE company_id=${c}::uuid
    UNION ALL SELECT 'credit_note','credit_note',id FROM credit_notes WHERE company_id=${c}::uuid
    UNION ALL SELECT 'purchase_order','purchase_order',id FROM purchase_orders WHERE company_id=${c}::uuid
    UNION ALL SELECT 'grn','goods_received_note',id FROM goods_received_notes WHERE company_id=${c}::uuid
    UNION ALL SELECT 'goods_received_note','goods_received_note',id FROM goods_received_notes WHERE company_id=${c}::uuid
  ), owned_documents AS (
    SELECT d.id,p.graph_type,p.id AS parent_id FROM procurement_documents d JOIN parents p ON p.kind=d.entity_type AND p.id=d.entity_id
  ), relationships(a_type,a_id,b_type,b_id,relation) AS (
    SELECT 'procurement_document',id::text,graph_type,parent_id::text,'document_parent' FROM owned_documents
    UNION ALL SELECT 'procurement_document',d.id::text,p.graph_type,p.id::text,'document_link'
      FROM owned_documents d JOIN document_links l ON l.document_id=d.id JOIN parents p ON p.kind=l.linked_entity_type AND p.id=l.linked_entity_id
    UNION ALL SELECT 'captured_document',id::text,'supplier_invoice',to_jsonb(d)->>'matched_invoice_id','captured_invoice' FROM captured_documents d WHERE company_id=${c}::uuid
    UNION ALL SELECT 'captured_document',id::text,'bank_transaction',to_jsonb(d)->>'matched_bank_tx_id','captured_bank' FROM captured_documents d WHERE company_id=${c}::uuid
    UNION ALL SELECT 'supplier_invoice',id::text,'captured_document',to_jsonb(i)->>'source_document_id','source_document' FROM supplier_invoices i WHERE company_id=${c}::uuid
    UNION ALL SELECT 'customer_invoice',id::text,'captured_document',to_jsonb(i)->>'source_document_id','source_document' FROM customer_invoices i WHERE company_id=${c}::uuid
    UNION ALL SELECT 'journal_entry',id::text,'captured_document',to_jsonb(j)->>'source_document_id','source_document' FROM gl_journal_entries j WHERE company_id=${c}::uuid
    UNION ALL SELECT 'bank_attachment',a.id::text,'bank_transaction',b.id::text,'bank_attachment'
      FROM bank_transaction_attachments a JOIN bank_transactions b ON b.id=a.bank_transaction_id WHERE b.company_id=${c}::uuid
  ), neighbors AS (
    SELECT DISTINCT CASE WHEN a_type=${t} AND a_id=${id} THEN b_type ELSE a_type END AS entity_type,
      CASE WHEN a_type=${t} AND a_id=${id} THEN b_id ELSE a_id END AS entity_id,relation
    FROM relationships WHERE a_id IS NOT NULL AND b_id IS NOT NULL AND ((a_type=${t} AND a_id=${id}) OR (b_type=${t} AND b_id=${id}))
  ), page AS (SELECT * FROM neighbors ORDER BY entity_type,entity_id,relation LIMIT ${limit} OFFSET ${offset})
  SELECT (SELECT count(*)::integer FROM neighbors) AS total,COALESCE(jsonb_agg(page ORDER BY entity_type,entity_id,relation),'[]'::jsonb) AS links FROM page` as
    {total:number;links:{entity_type:EvidenceIdentity['entityType'];entity_id:string;relation:string}[]}[];
  return{total:rows[0]?.total??0,links:(rows[0]?.links??[]).map(r=>({target:{entityType:r.entity_type,entityId:r.entity_id},relation:r.relation}))};
}
