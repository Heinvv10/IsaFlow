import type {ControlTx} from '../controls/contracts';
export async function readBankPreparedRows(ctx:ControlTx,bankId:string,approvalVisible:boolean,intentId:string|null){
 const company=ctx.principal.companyId,person=ctx.principal.personId;
 return ctx.sql`WITH intents AS (
  SELECT id,created_at,accounting_date::text,amount::text,currency,payload AS plan,'bank_allocation_intent' AS entity_type,'bank_allocation.post' AS operation
   FROM control_bank_allocation_intents WHERE company_id=${company}::uuid AND bank_transaction_id=${bankId}::uuid AND requester_person_id=${person}
  UNION ALL
  SELECT r.id,r.created_at,r.reversal_date::text,o.amount::text,o.currency,
   jsonb_build_object('originalIntentId',r.original_intent_id,'bankTransactionId',r.bank_transaction_id,'reversalDate',r.reversal_date::text,'reason',r.reason),
   'bank_allocation_reversal_intent','bank_allocation.reverse'
   FROM control_bank_allocation_reversal_intents r JOIN control_bank_allocation_intents o ON o.company_id=r.company_id AND o.id=r.original_intent_id AND o.bank_transaction_id=r.bank_transaction_id
   WHERE r.company_id=${company}::uuid AND r.bank_transaction_id=${bankId}::uuid AND r.requester_person_id=${person}
 ), selected AS (
  SELECT i.*,EXISTS(SELECT 1 FROM control_operation_effects e WHERE e.company_id=${company}::uuid AND e.entity_type=i.entity_type AND e.entity_id=i.id::text AND e.operation=i.operation) AS executed
   FROM intents i
 ), population AS (
  SELECT *,count(*) OVER()::int AS total FROM selected WHERE (${intentId}::uuid IS NOT NULL AND id=${intentId}::uuid) OR (${intentId}::uuid IS NULL AND NOT executed)
 ) SELECT p.*,a.summary AS approval FROM population p LEFT JOIN LATERAL (
  SELECT jsonb_build_object('id',a.id,'status',a.status,'operation',a.operation,'entityType',a.entity_type,'entityId',a.entity_id,'requestedAt',a.requested_at,'expiresAt',a.expires_at) AS summary
   FROM control_operation_approvals a WHERE ${approvalVisible}::boolean AND a.company_id=${company}::uuid AND a.requester_person_id=${person}
    AND a.operation=p.operation AND a.entity_type=p.entity_type AND a.entity_id=p.id::text
   ORDER BY a.requested_at DESC,a.id DESC LIMIT 1
 ) a ON true ORDER BY p.created_at DESC,p.id DESC LIMIT 50`;
}
