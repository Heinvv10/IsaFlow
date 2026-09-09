import type {ControlTx} from './contracts';
import {RISK_SOURCE_LIMIT} from './invoiceRiskQueriesResult';
interface ImportRiskRow {id:string;sage_id:string|null;invoice_number:string|null;invoice_date:string|null;total_amount:string|null;
 migration_status:string|null;gl_supplier_invoice_id:string|null;owned_native_id:string|null}
/** Staging lacks supplier, currency, net/tax and byte evidence; an owned native link is the only safe mirror exclusion. */
export async function loadInvoiceRiskImports(ctx:ControlTx,cutoff:string|null){
 const rows=await ctx.sql`SELECT s.id,s.sage_id,s.invoice_number,s.invoice_date::text,s.total_amount::text,s.migration_status,
  s.gl_supplier_invoice_id,i.id AS owned_native_id,count(*) OVER()::int AS population_count,
  count(i.id) OVER()::int AS mapped_count
  FROM sage_supplier_invoices s LEFT JOIN supplier_invoices i ON i.company_id=s.company_id AND i.id=s.gl_supplier_invoice_id
   AND (${cutoff}::date IS NULL OR i.invoice_date<=${cutoff}::date)
  WHERE s.company_id=${ctx.principal.companyId}::uuid
   AND (${cutoff}::date IS NULL OR s.invoice_date IS NULL OR s.invoice_date<=${cutoff}::date)
  ORDER BY s.id LIMIT ${RISK_SOURCE_LIMIT+1}` as Array<ImportRiskRow&{population_count:number;mapped_count:number}>;
 return{rows:rows.map(({population_count:_count,mapped_count:_mapped,...row})=>row),
  populationCount:rows[0]?.population_count??0,mappedCount:rows[0]?.mapped_count??0};
}
