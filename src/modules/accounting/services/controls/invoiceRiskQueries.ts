import type {ControlTx} from './contracts';
import {RISK_SOURCE_LIMIT} from './invoiceRiskQueriesResult';
import {scanCapturedEvidence} from './capturedEvidenceScan';
export interface InvoiceRiskRow {supplier_owned?:boolean;id:string;supplier_id:string;invoice_date:string;invoice_number:string;subtotal:string;tax_amount:string;total_amount:string;
 currency:string;status:string;document_id:string|null;file_hash:string|null;file_verified:boolean;version:number|string|null}
export async function loadInvoiceRiskPopulation(ctx:ControlTx,cutoff:string|null){
 const rows=await ctx.sql`WITH population AS (
  SELECT i.id,(s.id IS NOT NULL) AS supplier_owned,i.supplier_id,i.invoice_date::text,i.invoice_number,i.subtotal::text,i.tax_amount::text,i.total_amount::text,i.currency,i.status,
   d.id AS document_id,d.raw_bytes_sha256 AS file_hash,
   false AS file_verified,v.version
  FROM supplier_invoices i LEFT JOIN suppliers s ON s.company_id=i.company_id AND s.id=i.supplier_id
  LEFT JOIN captured_documents d ON d.company_id=i.company_id AND d.id=i.source_document_id AND d.status NOT IN ('deleted','rejected')
  LEFT JOIN LATERAL(SELECT cv.* FROM control_entity_versions cv WHERE cv.company_id=i.company_id AND cv.entity_type='supplier_invoice' AND cv.entity_id_canonical=i.id::text ORDER BY cv.version DESC,(cv.entity_id=i.id::text) DESC,cv.entity_id COLLATE "C" LIMIT 1) v ON true
  WHERE i.company_id=${ctx.principal.companyId}::uuid AND (${cutoff}::date IS NULL OR i.invoice_date<=${cutoff}::date)
 ) SELECT *,count(*) OVER()::int AS population_count,clock_timestamp()::text AS captured_at FROM population ORDER BY id LIMIT ${RISK_SOURCE_LIMIT+1}` as Array<InvoiceRiskRow&{population_count:number;captured_at:string}>;
 const evidence=await scanCapturedEvidence(ctx,rows.length>RISK_SOURCE_LIMIT?[]:rows.map(row=>row.document_id),'read:invoices');
 return{rows:rows.map(({population_count:_count,captured_at:_time,...row})=>({...row,file_verified:row.document_id!==null&&row.file_hash!==null&&evidence.verified.get(row.document_id)===row.file_hash})),
  evidenceMissing:evidence.evidenceMissing,populationCount:rows[0]?.population_count??0,capturedAt:rows[0]?.captured_at??new Date().toISOString()};
}
