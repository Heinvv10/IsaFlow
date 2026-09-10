import type { ControlTx } from './contracts';
import {retainedLineage} from './operationVersions';
import { loadDocumentRow } from './transactionEvidenceDocuments';
import { listDomainEvidenceNeighbors } from './transactionEvidenceRelations';
import { listApprovalEvidenceNeighbors } from './transactionEvidenceApprovals';
import { listDocumentEvidenceNeighbors } from './transactionEvidenceDocumentLinks';
import type { EvidenceIdentity,EvidenceNode,EvidenceNeighbor } from './transactionEvidenceTypes';
const SAFE_STATUS=new Set(['draft','pending','approved','posted','reversed','processed','paid','partially_paid','cancelled','rejected','consumed',
  'imported','allocated','reconciled','active','inactive','matched','reviewed','attached','submitted','received','partially_received','accepted','confirmed','applied']);
/** Only allowlisted scalar metadata is selected, never descriptions, amounts, URLs or protected values. */
export async function loadEvidenceNode(ctx:ControlTx,ref:EvidenceIdentity,permissions:ReadonlySet<string>):Promise<EvidenceNode|null>{
  const c=ctx.principal.companyId,t=ref.entityType,id=ref.entityId;
  let row:{id:string;status:string|null;hash_available?:boolean;reversed?:boolean}|null;
  if(['captured_document','procurement_document','bank_attachment'].includes(t))row=await loadDocumentRow(ctx,ref,permissions);
  else{
    const rows=await ctx.sql`SELECT id,status,reversed FROM (
      SELECT id,to_jsonb(s)->>'status' AS status,false AS reversed FROM suppliers s WHERE ${t==='supplier'} AND company_id=${c}::uuid AND id=${id}::uuid
      UNION ALL SELECT id,to_jsonb(i)->>'status',false AS reversed FROM supplier_invoices i WHERE ${t==='supplier_invoice'} AND company_id=${c}::uuid AND id=${id}::uuid
      UNION ALL SELECT id,to_jsonb(i)->>'status',false AS reversed FROM sage_supplier_invoices i WHERE ${t==='sage_supplier_invoice'} AND company_id=${c}::uuid AND id=${id}::uuid
      UNION ALL SELECT id,to_jsonb(p)->>'status',false AS reversed FROM supplier_payments p WHERE ${t==='supplier_payment'} AND company_id=${c}::uuid AND id=${id}::uuid
      UNION ALL SELECT id,to_jsonb(b)->>'status',false AS reversed FROM bank_transactions b WHERE ${t==='bank_transaction'} AND company_id=${c}::uuid AND id=${id}::uuid
      UNION ALL SELECT id,to_jsonb(j)->>'status',(j.reversed_at IS NOT NULL) AS reversed FROM gl_journal_entries j WHERE ${t==='journal_entry'} AND company_id=${c}::uuid AND id=${id}::uuid
      UNION ALL SELECT id,status,false AS reversed FROM control_operation_approvals WHERE ${t==='operation_approval'} AND company_id=${c}::uuid AND id=${id}::uuid
      UNION ALL SELECT id,to_jsonb(i)->>'status',false AS reversed FROM customer_invoices i WHERE ${t==='customer_invoice'} AND company_id=${c}::uuid AND id=${id}::uuid
      UNION ALL SELECT id,to_jsonb(p)->>'status',false AS reversed FROM customer_payments p WHERE ${t==='customer_payment'} AND company_id=${c}::uuid AND id=${id}::uuid
      UNION ALL SELECT id,to_jsonb(n)->>'status',false AS reversed FROM credit_notes n WHERE ${t==='credit_note'} AND company_id=${c}::uuid AND id=${id}::uuid
      UNION ALL SELECT id,status,false AS reversed FROM purchase_orders WHERE ${t==='purchase_order'} AND company_id=${c}::uuid AND id=${id}::uuid
      UNION ALL SELECT id,status,false AS reversed FROM goods_received_notes WHERE ${t==='goods_received_note'} AND company_id=${c}::uuid AND id=${id}::uuid
      UNION ALL SELECT id,CASE WHEN is_active THEN 'active' ELSE 'inactive' END,false FROM gl_accounts WHERE ${t==='gl_account'} AND company_id=${c}::uuid AND id=${id}::uuid
      UNION ALL SELECT id,status,false FROM fiscal_periods WHERE ${t==='fiscal_period'} AND company_id=${c}::uuid AND id=${id}::uuid
      UNION ALL SELECT id,'active',false FROM companies WHERE ${t==='company_gl_settings'} AND id=${c}::uuid AND id=${id}::uuid
    ) owned LIMIT 2` as Array<{id:string;status:string|null;reversed:boolean}>;
    row=rows.length===1?rows[0]!:null;
  }
  if(!row)return null;
  // The same lineage recordCommittedChange extends; its first retained event dates it, not a sibling spelling's.
  const lineages=await ctx.sql`SELECT v.entity_id,v.version,(SELECT min(e.occurred_at) FROM control_change_events e
      WHERE e.company_id=v.company_id AND e.entity_type=v.entity_type AND e.entity_id=v.entity_id) AS recorded_since
    FROM control_entity_versions v WHERE v.company_id=${c}::uuid AND v.entity_type=${t} AND lower(v.entity_id)=lower(${id})
    ORDER BY (v.entity_id=lower(${id})) DESC,v.entity_id LIMIT 2` as
    {entity_id:string;version:string|number;recorded_since:Date|string|null}[];
  const canonical=lineages.find(row=>row.entity_id===id.toLowerCase()),ambiguous=!canonical&&lineages.length>1;
  const lineage=ambiguous?undefined:retainedLineage(lineages,id),history=lineage?[lineage]:[];
  const version=history[0]?Number(history[0].version):null;
  const recorded=history[0]?.recorded_since;
  const flags:EvidenceNode['flags']=[];
  if(ambiguous)flags.push('ambiguous');else if(version===null||!recorded)flags.push('untracked');
  if(row.reversed||row.status==='reversed')flags.push('reversed');
  if(row.hash_available===false)flags.push('missing');
  return{...ref,status:row.status&&SAFE_STATUS.has(row.status)?row.status:'unknown',
    version:version!==null&&Number.isSafeInteger(version)&&version>0?version:null,
    recordedSince:recorded?new Date(recorded).toISOString():null,
    hashAvailability:row.hash_available===undefined?'not_applicable':row.hash_available?'available':'missing',flags};
}
/** Each underlying result is keyset-equivalent ordered and bounded to100; merge pages without losing counts. */
export async function listEvidenceNeighbors(ctx:ControlTx,ref:EvidenceIdentity,offset:number,limit:number):Promise<{links:EvidenceNeighbor[];total:number}>{
  const links:EvidenceNeighbor[]=[];
  let total=0;
  for(const read of [listDomainEvidenceNeighbors,listDocumentEvidenceNeighbors,listApprovalEvidenceNeighbors]){
    const page=await read(ctx,ref,Math.max(0,offset-total),Math.max(1,limit-links.length));
    links.push(...page.links.slice(0,limit-links.length));total+=page.total;
  }
  return{links,total};
}
