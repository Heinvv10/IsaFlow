import type { ControlTx } from './contracts';
import { loadDocumentRow } from './transactionEvidenceDocuments';
import { listDomainEvidenceNeighbors } from './transactionEvidenceRelations';
import { listDocumentEvidenceNeighbors } from './transactionEvidenceDocumentLinks';
import type { EvidenceIdentity,EvidenceNode,EvidenceNeighbor } from './transactionEvidenceTypes';
const SAFE_STATUS=new Set(['draft','pending','approved','posted','reversed','processed','paid','partially_paid','cancelled','rejected','consumed',
  'imported','allocated','reconciled','active','inactive','matched','reviewed','attached','submitted','received','partially_received','accepted']);
/** Only allowlisted scalar metadata is selected, never descriptions, amounts, URLs or protected values. */
export async function loadEvidenceNode(ctx:ControlTx,ref:EvidenceIdentity,permissions:ReadonlySet<string>):Promise<EvidenceNode|null>{
  const c=ctx.principal.companyId,t=ref.entityType,id=ref.entityId;
  let row:{id:string;status:string|null;hash_available?:boolean;reversed?:boolean}|null;
  if(['captured_document','procurement_document','bank_attachment'].includes(t))row=await loadDocumentRow(ctx,ref,permissions);
  else{
    const rows=await ctx.sql`SELECT id,status,false AS reversed FROM (
      SELECT id,to_jsonb(s)->>'status' AS status FROM suppliers s WHERE ${t==='supplier'} AND company_id=${c}::uuid AND id=${id}::uuid
      UNION ALL SELECT id,to_jsonb(i)->>'status' FROM supplier_invoices i WHERE ${t==='supplier_invoice'} AND company_id=${c}::uuid AND id=${id}::uuid
      UNION ALL SELECT id,to_jsonb(i)->>'status' FROM sage_supplier_invoices i WHERE ${t==='sage_supplier_invoice'} AND company_id=${c}::uuid AND id=${id}::uuid
      UNION ALL SELECT id,to_jsonb(p)->>'status' FROM supplier_payments p WHERE ${t==='supplier_payment'} AND company_id=${c}::uuid AND id=${id}::uuid
      UNION ALL SELECT id,to_jsonb(b)->>'status' FROM bank_transactions b WHERE ${t==='bank_transaction'} AND company_id=${c}::uuid AND id=${id}::uuid
      UNION ALL SELECT id,to_jsonb(j)->>'status' FROM gl_journal_entries j WHERE ${t==='journal_entry'} AND company_id=${c}::uuid AND id=${id}::uuid
      UNION ALL SELECT id,status FROM control_operation_approvals WHERE ${t==='operation_approval'} AND company_id=${c}::uuid AND id=${id}::uuid
      UNION ALL SELECT id,to_jsonb(i)->>'status' FROM customer_invoices i WHERE ${t==='customer_invoice'} AND company_id=${c}::uuid AND id=${id}::uuid
      UNION ALL SELECT id,to_jsonb(p)->>'status' FROM customer_payments p WHERE ${t==='customer_payment'} AND company_id=${c}::uuid AND id=${id}::uuid
      UNION ALL SELECT id,to_jsonb(n)->>'status' FROM credit_notes n WHERE ${t==='credit_note'} AND company_id=${c}::uuid AND id=${id}::uuid
      UNION ALL SELECT id,status FROM purchase_orders WHERE ${t==='purchase_order'} AND company_id=${c}::uuid AND id=${id}::uuid
      UNION ALL SELECT id,status FROM goods_received_notes WHERE ${t==='goods_received_note'} AND company_id=${c}::uuid AND id=${id}::uuid
    ) owned LIMIT 2` as Array<{id:string;status:string|null;reversed:boolean}>;
    row=rows.length===1?rows[0]!:null;
  }
  if(!row)return null;
  const history=await ctx.sql`SELECT v.version,(SELECT min(e.occurred_at) FROM control_change_events e
      WHERE e.company_id=${c}::uuid AND e.entity_type=${t} AND e.entity_id=${id}) AS recorded_since
    FROM control_entity_versions v WHERE v.company_id=${c}::uuid AND v.entity_type=${t} AND v.entity_id=${id} LIMIT 1` as
    {version:string|number;recorded_since:Date|string|null}[];
  const version=history[0]?Number(history[0].version):null;
  const recorded=history[0]?.recorded_since;
  const flags:EvidenceNode['flags']=[];
  if(version===null||!recorded)flags.push('untracked');
  if(row.status==='reversed'||row.status==='cancelled')flags.push('reversed');
  if(row.hash_available===false)flags.push('missing');
  return{...ref,status:row.status&&SAFE_STATUS.has(row.status)?row.status:'unknown',
    version:version!==null&&Number.isSafeInteger(version)&&version>0?version:null,
    recordedSince:recorded?new Date(recorded).toISOString():null,
    hashAvailability:row.hash_available===undefined?'not_applicable':row.hash_available?'available':'missing',flags};
}
/** Each underlying result is keyset-equivalent ordered and bounded to100; merge pages without losing counts. */
export async function listEvidenceNeighbors(ctx:ControlTx,ref:EvidenceIdentity,offset:number,limit:number):Promise<{links:EvidenceNeighbor[];total:number}>{
  // Separate deterministic streams keep SQL pages <=100. Offsets span domain then document streams.
  const domain=await listDomainEvidenceNeighbors(ctx,ref,offset,limit);
  const documentOffset=Math.max(0,offset-domain.total);
  const documents=await listDocumentEvidenceNeighbors(ctx,ref,documentOffset,Math.max(1,limit-domain.links.length));
  return{links:[...domain.links,...documents.links.slice(0,limit-domain.links.length)],total:domain.total+documents.total};
}
