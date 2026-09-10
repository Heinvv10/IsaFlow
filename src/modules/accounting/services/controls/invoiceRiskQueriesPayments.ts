import type {ControlTx} from './contracts';
import {RISK_SOURCE_LIMIT} from './invoiceRiskQueriesResult';
export interface PaymentRiskRow {supplier_owned?:boolean;id:string;supplier_id:string;payment_date:string;total_amount:string;status:string;reference:string|null;version:number|string|null;
 allocations:Array<{invoice_id:string;amount:string;currency:string|null}>;
 attempts:Array<{intent_id:string;preparation_id:string;attempted_at:string;verified_at?:string|null;beneficiary_version_id?:string|null}>;
 allocation_count?:number;attempt_count?:number;processed_at?:string|null;legacy_verified_at?:string|null}
export async function loadPaymentRiskPopulation(ctx:ControlTx,cutoff:string|null){
 const company=ctx.principal.companyId;
 const rows=await ctx.sql`WITH population AS (
  SELECT p.id,(s.id IS NOT NULL) AS supplier_owned,p.supplier_id,p.payment_date::text,p.total_amount::text,p.status,p.reference,p.processed_at::text,v.version,
   COALESCE(a.allocations,'[]'::jsonb) AS allocations,COALESCE(a.n,0)::int AS allocation_count,
   COALESCE(r.attempts,'[]'::jsonb) AS attempts,COALESCE(r.n,0)::int AS attempt_count,b.verified_at::text AS legacy_verified_at
  FROM supplier_payments p LEFT JOIN suppliers s ON s.company_id=p.company_id AND s.id=p.supplier_id
  LEFT JOIN control_entity_versions v ON v.company_id=p.company_id AND v.entity_type='supplier_payment' AND lower(v.entity_id)=p.id::text
  LEFT JOIN LATERAL (SELECT jsonb_agg(jsonb_build_object('invoice_id',x.invoice_id,'amount',x.amount_allocated::text,'currency',x.currency) ORDER BY x.invoice_id) AS allocations,max(x.n) AS n
   FROM (SELECT pa.invoice_id,pa.amount_allocated,i.currency,count(*) OVER() AS n FROM payment_allocations pa
    LEFT JOIN supplier_invoices i ON i.company_id=p.company_id AND i.id=pa.invoice_id AND i.supplier_id=p.supplier_id
    WHERE pa.payment_id=p.id ORDER BY pa.invoice_id LIMIT 101) x) a ON true
  LEFT JOIN LATERAL (SELECT jsonb_agg(jsonb_build_object('intent_id',x.intent_id,'preparation_id',x.preparation_id,'attempted_at',x.attempted_at,
   'verified_at',x.verified_at,'beneficiary_version_id',x.beneficiary_version_id) ORDER BY x.intent_id) AS attempts,max(x.n) AS n
   FROM (SELECT ri.intent_id,ri.preparation_id,o.attempted_at,bv.verified_at,bv.id AS beneficiary_version_id,count(*) OVER() AS n
    FROM control_payment_release_items ri JOIN control_payment_release_outbox o ON o.company_id=ri.company_id AND o.intent_id=ri.intent_id
    LEFT JOIN control_payment_preparations prep ON prep.company_id=ri.company_id AND prep.id=ri.preparation_id AND prep.payment_id=ri.payment_id
    LEFT JOIN control_beneficiary_versions bv ON bv.company_id=prep.company_id AND bv.id=prep.beneficiary_version_id AND bv.entity_type='supplier' AND bv.entity_id=p.supplier_id
    WHERE ri.company_id=p.company_id AND ri.payment_id=p.id AND o.state IN ('attempting','accepted','unknown','exported') ORDER BY ri.intent_id LIMIT 101) x) r ON true
  LEFT JOIN LATERAL (SELECT verified_at FROM control_beneficiary_versions b WHERE b.company_id=p.company_id AND b.entity_type='supplier'
   AND b.entity_id=p.supplier_id AND b.verified_at<=p.processed_at ORDER BY b.version DESC LIMIT 1) b ON true
  WHERE p.company_id=${company}::uuid AND (${cutoff}::date IS NULL OR p.payment_date<=${cutoff}::date)
 ) SELECT *,count(*) OVER()::int AS population_count,clock_timestamp()::text AS captured_at FROM population ORDER BY id LIMIT ${RISK_SOURCE_LIMIT+1}` as Array<PaymentRiskRow&{population_count:number;captured_at:string}>;
 return{rows:rows.map(({population_count:_count,captured_at:_time,...row})=>row),populationCount:rows[0]?.population_count??0,capturedAt:rows[0]?.captured_at??new Date().toISOString()};
}
