import type {ControlTx} from '../controls/contracts';
export async function resolveBankApprovalTarget(ctx:ControlTx,approvalId:string,bankId?:string){
 const company=ctx.principal.companyId;
 const rows=await ctx.sql`SELECT i.bank_transaction_id FROM control_operation_approvals a JOIN control_bank_allocation_intents i
  ON i.company_id=a.company_id AND i.id::text=a.entity_id_canonical AND i.requester_person_id=a.requester_person_id
  WHERE a.company_id=${company}::uuid AND a.id=${approvalId}::uuid AND a.entity_type='bank_allocation_intent' AND a.operation='bank_allocation.post'
   AND (${bankId??null}::uuid IS NULL OR i.bank_transaction_id=${bankId??null}::uuid)
  UNION ALL
  SELECT i.bank_transaction_id FROM control_operation_approvals a JOIN control_bank_allocation_reversal_intents i
  ON i.company_id=a.company_id AND i.id::text=a.entity_id_canonical AND i.requester_person_id=a.requester_person_id
  WHERE a.company_id=${company}::uuid AND a.id=${approvalId}::uuid AND a.entity_type='bank_allocation_reversal_intent' AND a.operation='bank_allocation.reverse'
   AND (${bankId??null}::uuid IS NULL OR i.bank_transaction_id=${bankId??null}::uuid)` as {bank_transaction_id:string}[];
 if(rows.length!==1)throw new Error('Bank approval not found');return rows[0]!.bank_transaction_id;
}
export async function readBankPreparedRows(ctx:ControlTx,bankId:string,approvalVisible:boolean,intentId:string|null,approvalId:string|null=null){
 const company=ctx.principal.companyId,person=ctx.principal.personId;
 return ctx.sql`WITH intents AS (
  SELECT id,requester_person_id,created_at,accounting_date::text,amount::text,currency,payload AS plan,'bank_allocation_intent' AS entity_type,'bank_allocation.post' AS operation
   FROM control_bank_allocation_intents WHERE company_id=${company}::uuid AND bank_transaction_id=${bankId}::uuid
  UNION ALL
  SELECT r.id,r.requester_person_id,r.created_at,r.reversal_date::text,o.amount::text,o.currency,
   jsonb_build_object('originalIntentId',r.original_intent_id,'bankTransactionId',r.bank_transaction_id,'reversalDate',r.reversal_date::text,'reason',r.reason),
   'bank_allocation_reversal_intent','bank_allocation.reverse'
   FROM control_bank_allocation_reversal_intents r JOIN control_bank_allocation_intents o ON o.company_id=r.company_id AND o.id=r.original_intent_id AND o.bank_transaction_id=r.bank_transaction_id
   WHERE r.company_id=${company}::uuid AND r.bank_transaction_id=${bankId}::uuid
 ), selected AS (
  SELECT i.*,EXISTS(SELECT 1 FROM control_operation_effects e WHERE e.company_id=${company}::uuid AND e.entity_type=i.entity_type AND e.entity_id_canonical=i.id::text AND e.operation=i.operation) AS executed
   FROM intents i WHERE i.requester_person_id=${person} OR (${approvalId}::uuid IS NOT NULL AND EXISTS(
    SELECT 1 FROM control_operation_approvals a WHERE a.company_id=${company}::uuid AND a.id=${approvalId}::uuid
     AND a.entity_type=i.entity_type AND a.entity_id_canonical=i.id::text AND a.operation=i.operation AND a.requester_person_id=i.requester_person_id))
 ), population AS (
  SELECT *,count(*) OVER()::int AS total FROM selected i WHERE (${intentId}::uuid IS NOT NULL AND id=${intentId}::uuid)
   OR (${intentId}::uuid IS NULL AND ${approvalId}::uuid IS NULL AND NOT executed)
   OR (${approvalId}::uuid IS NOT NULL AND EXISTS(SELECT 1 FROM control_operation_approvals a WHERE a.company_id=${company}::uuid AND a.id=${approvalId}::uuid
     AND a.entity_type=i.entity_type AND a.entity_id_canonical=i.id::text AND a.operation=i.operation AND a.requester_person_id=i.requester_person_id))
 ) SELECT p.*,a.summary AS approval FROM population p LEFT JOIN LATERAL (
  SELECT jsonb_build_object('id',a.id,'status',a.status,'operation',a.operation,'entityType',a.entity_type,'entityId',a.entity_id,'requestedAt',a.requested_at,'expiresAt',a.expires_at) AS summary
   FROM control_operation_approvals a WHERE ${approvalVisible}::boolean AND a.company_id=${company}::uuid AND a.requester_person_id=p.requester_person_id
    AND (${approvalId}::uuid IS NULL OR a.id=${approvalId}::uuid)
    AND a.operation=p.operation AND a.entity_type=p.entity_type AND a.entity_id_canonical=p.id::text
   ORDER BY a.requested_at DESC,a.id DESC LIMIT 1
 ) a ON true ORDER BY p.created_at DESC,p.id DESC LIMIT 50`;
}
