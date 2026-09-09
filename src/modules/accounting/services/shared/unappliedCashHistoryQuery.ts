import {sql} from '@/lib/neon';

/** One statement observes payment, lifecycle and application history consistently. */
export async function queryUnappliedCashHistory(companyId:string,kind:'customer'|'supplier',asAt:string){
 const result=await sql`
 WITH census AS (
  SELECT (
   (SELECT COUNT(*) FROM customer_payments WHERE company_id=${companyId}::uuid AND ${kind}='customer' AND payment_date<=${asAt}::date)
   +(SELECT COUNT(*) FROM supplier_payments WHERE company_id=${companyId}::uuid AND ${kind}='supplier' AND payment_date<=${asAt}::date)
  )::text AS population_count
 ), payments AS (
  SELECT cp.id,cp.company_id,cp.payment_number,cp.payment_date,cp.total_amount,cp.status,
   cp.bank_reference AS reference,cp.description,cp.gl_journal_entry_id,cp.created_at,cp.updated_at,
   c.id AS party_id,c.name AS party_name
  FROM customer_payments cp LEFT JOIN customers c ON c.company_id=cp.company_id AND c.id=cp.client_id AND c.deleted_at IS NULL
  WHERE cp.company_id=${companyId}::uuid AND ${kind}='customer' AND cp.payment_date<=${asAt}::date
  UNION ALL
  SELECT sp.id,sp.company_id,sp.payment_number,sp.payment_date,sp.total_amount,sp.status,
   sp.reference,sp.description,sp.gl_journal_entry_id,sp.created_at,sp.updated_at,s.id,s.name
  FROM supplier_payments sp LEFT JOIN suppliers s ON s.company_id=sp.company_id AND s.id=sp.supplier_id AND s.deleted_at IS NULL
  WHERE sp.company_id=${companyId}::uuid AND ${kind}='supplier' AND sp.payment_date<=${asAt}::date
 ), allocations AS (
  SELECT a.* FROM customer_payment_allocations a JOIN payments p ON p.id=a.payment_id AND p.company_id=${companyId}::uuid WHERE ${kind}='customer'
 ), allocation_rows AS (
  SELECT a.payment_id,a.invoice_id,a.amount_allocated,a.application_intent_id,a.reversal_intent_id,a.reversed_at,a.created_at
  FROM allocations a
  UNION ALL
  SELECT a.payment_id,a.invoice_id,a.amount_allocated,a.application_intent_id,a.reversal_intent_id,a.reversed_at,a.created_at
  FROM payment_allocations a JOIN payments p ON p.id=a.payment_id AND p.company_id=${companyId}::uuid WHERE ${kind}='supplier'
 )
 , history AS (
 SELECT p.*,je.status AS journal_status,je.entry_date AS journal_date,je.posting_agent,
  je.created_at AS journal_created_at,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('date',j.entry_date,'id',j.id,'createdAt',j.created_at))
   FROM gl_journal_entries j WHERE j.company_id=p.company_id AND j.reversal_of_id=je.id AND j.status='posted'),'[]'::jsonb) AS contras,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('date',e.accounting_date,'occurredAt',e.occurred_at,'committedAt',f.committed_at))
   FROM control_change_events e JOIN control_operation_effects f ON f.company_id=e.company_id AND f.operation_id=e.operation_id
   WHERE e.company_id=p.company_id AND e.entity_type=${kind}||'_payment' AND e.entity_id=p.id::text
    AND e.accounting_date IS NOT NULL AND (
     (e.action=${kind}||'_payment.'||CASE WHEN ${kind}='customer' THEN 'cancel' ELSE 'void' END
       AND f.operation=e.action AND f.entity_id=p.id::text AND f.entity_type=e.entity_type AND f.binding_hash=e.binding_hash)
     OR (e.action='bank_allocation.payment_cancelled' AND f.operation='bank_allocation.reverse'
       AND f.result->>'originalJournalEntryId'=je.id::text)
    )),'[]'::jsonb) AS cancellations,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('amount',a.amount_allocated::text,'createdAt',a.created_at,
    'applicationId',a.application_intent_id,'applicationDate',app.accounting_date,'applicationCreatedAt',app.created_at,
    'inverseId',a.reversal_intent_id,'reversedAt',a.reversed_at,'inverseDate',inv.reversal_date,'inverseCreatedAt',inv.created_at))
   FROM allocation_rows a
   LEFT JOIN control_cash_application_intents app ON app.company_id=p.company_id AND app.id=a.application_intent_id AND app.payment_id=p.id AND app.kind=${kind}
   LEFT JOIN control_cash_application_reversal_intents inv ON inv.company_id=p.company_id AND inv.id=a.reversal_intent_id AND inv.original_intent_id=app.id
   WHERE a.payment_id=p.id),'[]'::jsonb) AS allocations
 FROM payments p LEFT JOIN gl_journal_entries je ON je.company_id=p.company_id AND je.id=p.gl_journal_entry_id
 ORDER BY p.payment_date,p.id LIMIT 100001
 ) SELECT history.*,census.population_count FROM census LEFT JOIN history ON TRUE ORDER BY history.payment_date,history.id
 ` as Record<string,unknown>[];
 if(!result.length)throw new Error('Independent cash population census unavailable');
 const populationCount=Number(result[0]!.population_count);
 if(result.some(row=>Number(row.population_count)!==populationCount))throw new Error('Inconsistent cash population census');
 return{populationCount,rows:result.filter(row=>row.id!=null).map(({population_count:_count,...row})=>row)};
}
