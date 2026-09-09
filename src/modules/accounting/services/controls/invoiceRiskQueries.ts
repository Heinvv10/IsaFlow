import type {ControlTx} from './contracts';
import {RISK_SOURCE_LIMIT} from './invoiceRiskQueriesResult';
export interface InvoiceRiskRow {supplier_owned?:boolean;id:string;supplier_id:string;invoice_date:string;invoice_number:string;subtotal:string;tax_amount:string;total_amount:string;
 currency:string;status:string;document_id:string|null;file_hash:string|null;file_verified:boolean;version:number|string|null}
export async function loadInvoiceRiskPopulation(ctx:ControlTx,cutoff:string|null){
 const rows=await ctx.sql`WITH population AS (
  SELECT i.id,(s.id IS NOT NULL) AS supplier_owned,i.supplier_id,i.invoice_date::text,i.invoice_number,i.subtotal::text,i.tax_amount::text,i.total_amount::text,i.currency,i.status,
   d.id AS document_id,d.raw_bytes_sha256 AS file_hash,
   COALESCE(d.raw_bytes IS NOT NULL AND octet_length(d.raw_bytes)>0 AND octet_length(d.raw_bytes)<=10485760
    AND encode(digest(d.raw_bytes,'sha256'),'hex')=d.raw_bytes_sha256,false) AS file_verified,v.version
  FROM supplier_invoices i LEFT JOIN suppliers s ON s.company_id=i.company_id AND s.id=i.supplier_id
  LEFT JOIN captured_documents d ON d.company_id=i.company_id AND d.id=i.source_document_id AND d.status NOT IN ('deleted','rejected')
  LEFT JOIN control_entity_versions v ON v.company_id=i.company_id AND v.entity_type='supplier_invoice' AND v.entity_id=i.id::text
  WHERE i.company_id=${ctx.principal.companyId}::uuid AND (${cutoff}::date IS NULL OR i.invoice_date<=${cutoff}::date)
 ) SELECT *,count(*) OVER()::int AS population_count,clock_timestamp()::text AS captured_at FROM population ORDER BY id LIMIT ${RISK_SOURCE_LIMIT+1}` as Array<InvoiceRiskRow&{population_count:number;captured_at:string}>;
 return{rows:rows.map(({population_count:_count,captured_at:_time,...row})=>row),populationCount:rows[0]?.population_count??0,capturedAt:rows[0]?.captured_at??new Date().toISOString()};
}
