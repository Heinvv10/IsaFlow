import type {SnapshotSource,SnapshotRow} from './auditSnapshotCaptureQueries';
/** Staging population, not additional native ledger cash/invoices. Missing source facts stay unknown. */
export const sageInvoiceSnapshotSources:SnapshotSource[]=[{
 source:'sage_supplier_invoice',family:'ap',
 async counts(ctx,cutoff){
  const [row]=await ctx.sql`SELECT count(*) FILTER(WHERE s.invoice_date IS NULL OR s.invoice_date<=${cutoff}::date)::int AS count,
   count(*) FILTER(WHERE s.invoice_date>${cutoff}::date)::int AS "excludedCount"
   FROM sage_supplier_invoices s WHERE s.company_id=${ctx.principal.companyId}::uuid` as Array<{count:number;excludedCount:number}>;
  return row!;
 },
 async page(ctx,cutoff,after){
  return await ctx.sql`SELECT s.id::text,v.version,jsonb_build_object(
   'sage_id',s.sage_id,'invoice_number',s.invoice_number,'invoice_date',s.invoice_date::text,
   'invoice_date_unavailable',s.invoice_date IS NULL,'total_amount',s.total_amount::text,'total_amount_unavailable',s.total_amount IS NULL,
   'currency',NULL,'amount_currency_unavailable',true,'supplier_identity_unavailable',true,'net_tax_breakdown_unavailable',true,
   'migration_status',s.migration_status,'imported_at',s.imported_at::text,
   'gl_supplier_invoice_id',i.id,'native_parent_unavailable',i.id IS NULL,
   'owned_native_within_cutoff',i.id IS NOT NULL AND i.invoice_date<=${cutoff}::date,
   'staging_population_not_additive_to_native',true) AS data
   FROM sage_supplier_invoices s LEFT JOIN supplier_invoices i ON i.company_id=s.company_id AND i.id=s.gl_supplier_invoice_id
   LEFT JOIN control_entity_versions v ON v.company_id=s.company_id AND v.entity_type='sage_supplier_invoice' AND v.entity_id=s.id::text
   WHERE s.company_id=${ctx.principal.companyId}::uuid AND (s.invoice_date IS NULL OR s.invoice_date<=${cutoff}::date)
    AND (${after}::uuid IS NULL OR s.id>${after}::uuid) ORDER BY s.id LIMIT 1000` as SnapshotRow[];
 }
}];
