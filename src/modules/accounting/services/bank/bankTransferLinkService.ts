import {withSavepoint} from '@/lib/neon';
import {requireControlTx} from '../controls/context';
import {assertEffectivePermission} from '@/lib/auth/effectivePermissions';
import {getApprovalRequirements,requestOperationApproval} from '../controls/approvalRequestService';
import {prepareBankAllocation,executeBankAllocation} from './bankAllocationControl';
import {loadBankAllocationIntent} from './bankAllocationMaterial';
import type {ControlTx} from '../controls/contracts';
import type {TransferLinkResult} from './bankTransferLinkPasses';
export type {TransferLinkResult} from './bankTransferLinkPasses';
type Selection={batchId?:string;bankAccountId?:string;originalBankId?:string};
/** Current owned observations select work; only the shared intent service may link a bank leg. */
async function candidates(ctx:ControlTx,selection:Selection){
 const company=ctx.principal.companyId;
 return await ctx.sql`SELECT DISTINCT n.id,n.bank_account_id,o.bank_account_id AS counterparty_account_id,
  EXISTS(SELECT 1 FROM control_bank_allocation_intents i JOIN control_operation_effects e ON e.company_id=i.company_id
   AND e.entity_type='bank_allocation_intent' AND lower(e.entity_id)=i.id::text AND e.operation='bank_allocation.post'
   AND e.result->>'journalEntryId'=j.id::text WHERE i.company_id=${company}::uuid AND i.bank_transaction_id=o.id
    AND j.source='auto_bank_transfer' AND j.source_record_id=o.id
    AND i.payload->>'kind'='transfer' AND i.payload->'transfer'->>'mode'='post'
    AND i.payload->'transfer'->'oppositeBankTransactionId'='null'::jsonb) AS controlled
  FROM bank_transactions n JOIN bank_transactions o ON o.company_id=n.company_id AND o.bank_account_id<>n.bank_account_id
   AND o.amount=-n.amount AND o.transaction_date BETWEEN n.transaction_date-2 AND n.transaction_date+2
  JOIN gl_journal_lines ol ON ol.company_id=o.company_id AND ol.id=o.matched_journal_line_id
  JOIN gl_journal_entries j ON j.company_id=o.company_id AND j.id=ol.journal_entry_id
  JOIN gl_journal_lines nl ON nl.company_id=j.company_id AND nl.journal_entry_id=j.id AND nl.gl_account_id=n.bank_account_id
   AND nl.debit-nl.credit=n.amount
  WHERE n.company_id=${company}::uuid AND n.status='imported' AND n.matched_journal_line_id IS NULL
   AND o.status IN('allocated','matched','reconciled') AND o.allocation_type IN('transfer','account')
   AND j.status='posted' AND j.reversed_at IS NULL
   AND NOT EXISTS(SELECT 1 FROM bank_transactions used WHERE used.company_id=${company}::uuid AND used.matched_journal_line_id=nl.id)
   AND (${selection.batchId??null}::uuid IS NULL OR n.import_batch_id=${selection.batchId??null}::uuid)
   AND (${selection.bankAccountId??null}::uuid IS NULL OR n.bank_account_id=${selection.bankAccountId??null}::uuid)
   AND (${selection.originalBankId??null}::uuid IS NULL OR o.id=${selection.originalBankId??null}::uuid)
  ORDER BY n.id,o.bank_account_id LIMIT 101` as {id:string;bank_account_id:string;counterparty_account_id:string;controlled:boolean}[];
}
async function prepareOrResume(ctx:ControlTx,bankId:string,counterpartyAccountId:string){
 const saved=await ctx.sql`SELECT i.id,a.id AS approval_id FROM control_bank_allocation_intents i
  JOIN control_operation_approvals a ON a.company_id=i.company_id AND lower(a.entity_id)=i.id::text AND a.entity_type='bank_allocation_intent'
   AND a.operation='bank_allocation.post' AND a.requester_person_id=i.requester_person_id
  WHERE i.company_id=${ctx.principal.companyId}::uuid AND i.bank_transaction_id=${bankId}::uuid
   AND i.requester_person_id=${ctx.principal.personId} AND i.payload->>'kind'='transfer'
   AND i.payload->>'counterpartyAccountId'=${counterpartyAccountId} AND a.status IN('pending','approved') AND a.expires_at>clock_timestamp()
   AND NOT EXISTS(SELECT 1 FROM control_operation_effects e WHERE e.company_id=i.company_id AND lower(e.entity_id)=i.id::text
    AND e.entity_type='bank_allocation_intent' AND e.operation='bank_allocation.post') ORDER BY a.requested_at DESC,a.id LIMIT 1` as {id:string;approval_id:string}[];
 const existing=saved[0];
 if(existing){await loadBankAllocationIntent(ctx,existing.id);return{intentId:existing.id,approvalId:existing.approval_id};}
 const prepared=await prepareBankAllocation(ctx,{version:1,kind:'transfer',bankTransactionId:bankId,counterpartyAccountId});
 const requirements=await getApprovalRequirements(ctx,prepared.operation);
 if(!requirements.requiresApproval)return{intentId:prepared.intentId,approvalId:null};
 const approval=await requestOperationApproval(ctx,prepared.operation);return{intentId:prepared.intentId,approvalId:approval.id};
}
export async function runControlledTransferLinks(companyId:string,selection:Selection):Promise<TransferLinkResult>{
 const result:TransferLinkResult={linked:0,passes:0,failed:false,pending:[]};
 try{return await withSavepoint('controlled_transfer_links',async()=>{
  const ctx=requireControlTx();if(ctx.principal.companyId!==companyId)throw new Error('Transfer tenant mismatch');
  await assertEffectivePermission(ctx,'write:bank-tx');await assertEffectivePermission(ctx,'write:post');
  await ctx.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`control-policy:${companyId}`},0))`;
  const rows=await candidates(ctx,selection);if(rows.length>100)throw new Error('Transfer linking population exceeds bounded batch');
  const processed=new Set<string>();
  for(const row of rows){
   if(processed.has(row.id))continue;processed.add(row.id);
   if(rows.some(candidate=>candidate.id===row.id&&!candidate.controlled)){result.failed=true;continue;}
   try{await withSavepoint('controlled_transfer_link',async()=>{
    const saved=await prepareOrResume(ctx,row.id,row.counterparty_account_id);
    if(saved.approvalId){
     const [approval]=await ctx.sql`SELECT status FROM control_operation_approvals WHERE company_id=${companyId}::uuid AND id=${saved.approvalId}::uuid` as {status:string}[];
     if(approval?.status==='pending'){result.pending.push({bankTransactionId:row.id,intentId:saved.intentId,approvalId:saved.approvalId});return;}
    }
    await executeBankAllocation(ctx,saved.intentId,{...(saved.approvalId?{approvalId:saved.approvalId}:{})});result.linked++;
   });}catch{result.failed=true;}
  }
  result.passes=result.linked?1:0;return result;
 });}catch{return{linked:0,passes:0,failed:true,pending:[]};}
}
export function autoLinkImportedBatchTransfers(companyId:string,batchId:string){return runControlledTransferLinks(companyId,{batchId});}
export function relinkTransferCounterparts(companyId:string,bankAccountId:string){return runControlledTransferLinks(companyId,{bankAccountId});}
