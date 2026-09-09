import type {ControlTx} from './contracts';
import type {EvidenceIdentity,EvidenceNeighbor} from './transactionEvidenceTypes';
/** Associations come exclusively from persisted foreign keys; endpoints are separately authorized. */
export async function listDomainEvidenceNeighbors(ctx:ControlTx,ref:EvidenceIdentity,offset:number,limit:number):Promise<{links:EvidenceNeighbor[];total:number}>{
  const c=ctx.principal.companyId,t=ref.entityType,id=ref.entityId;
  const rows=await ctx.sql`WITH relationships(a_type,a_id,b_type,b_id,relation) AS (
    SELECT 'supplier',supplier_id::text,'supplier_invoice',id::text,'supplier_invoice' FROM supplier_invoices WHERE company_id=${c}::uuid
    UNION ALL SELECT 'supplier',supplier_id::text,'supplier_payment',id::text,'supplier_payment' FROM supplier_payments WHERE company_id=${c}::uuid
    UNION ALL SELECT 'supplier',to_jsonb(i)->>'supplier_id','sage_supplier_invoice',id::text,'supplier_invoice' FROM sage_supplier_invoices i WHERE company_id=${c}::uuid
    UNION ALL SELECT 'supplier_invoice',a.invoice_id::text,'supplier_payment',a.payment_id::text,'payment_allocation'
      FROM payment_allocations a JOIN supplier_invoices i ON i.id=a.invoice_id AND i.company_id=${c}::uuid
      JOIN supplier_payments p ON p.id=a.payment_id AND p.company_id=${c}::uuid
    UNION ALL SELECT 'supplier_invoice',id::text,'journal_entry',gl_journal_entry_id::text,'posted_journal' FROM supplier_invoices WHERE company_id=${c}::uuid
    UNION ALL SELECT 'supplier_payment',id::text,'journal_entry',gl_journal_entry_id::text,'posted_journal' FROM supplier_payments WHERE company_id=${c}::uuid
    UNION ALL SELECT 'bank_transaction',b.id::text,'journal_entry',l.journal_entry_id::text,'matched_journal_line'
      FROM bank_transactions b JOIN gl_journal_lines l ON l.id=b.matched_journal_line_id AND l.company_id=${c}::uuid WHERE b.company_id=${c}::uuid
    UNION ALL SELECT 'bank_transaction',id::text,'journal_entry',to_jsonb(b)->>'transfer_journal_entry_id','transfer_journal' FROM bank_transactions b WHERE company_id=${c}::uuid
    UNION ALL SELECT 'journal_entry',id::text,'journal_entry',to_jsonb(j)->>'reversal_of_id','reversal' FROM gl_journal_entries j WHERE company_id=${c}::uuid
    UNION ALL SELECT 'operation_approval',id::text,entity_type,entity_id,'approval_subject' FROM control_operation_approvals WHERE company_id=${c}::uuid
    UNION ALL SELECT 'supplier',supplier_id::text,'purchase_order',id::text,'purchase_order' FROM purchase_orders WHERE company_id=${c}::uuid
    UNION ALL SELECT 'purchase_order',purchase_order_id::text,'goods_received_note',id::text,'goods_received' FROM goods_received_notes WHERE company_id=${c}::uuid
    UNION ALL SELECT 'supplier',to_jsonb(n)->>'supplier_id','credit_note',id::text,'supplier_credit' FROM credit_notes n WHERE company_id=${c}::uuid AND type='supplier'
    UNION ALL SELECT 'supplier_invoice',to_jsonb(n)->>'supplier_invoice_id','credit_note',id::text,'invoice_credit' FROM credit_notes n WHERE company_id=${c}::uuid AND type='supplier'
  ), neighbors AS (
    SELECT DISTINCT CASE WHEN a_type=${t} AND a_id=${id} THEN b_type ELSE a_type END AS entity_type,
      CASE WHEN a_type=${t} AND a_id=${id} THEN b_id ELSE a_id END AS entity_id,relation
    FROM relationships WHERE a_id IS NOT NULL AND b_id IS NOT NULL AND ((a_type=${t} AND a_id=${id}) OR (b_type=${t} AND b_id=${id}))
  ), page AS (SELECT * FROM neighbors ORDER BY entity_type,entity_id,relation LIMIT ${limit} OFFSET ${offset})
  SELECT (SELECT count(*)::integer FROM neighbors) AS total,COALESCE(jsonb_agg(page ORDER BY entity_type,entity_id,relation),'[]'::jsonb) AS links FROM page` as
    {total:number;links:{entity_type:EvidenceIdentity['entityType'];entity_id:string;relation:string}[]}[];
  return{total:rows[0]?.total??0,links:(rows[0]?.links??[]).map(r=>({target:{entityType:r.entity_type,entityId:r.entity_id},relation:r.relation}))};
}
