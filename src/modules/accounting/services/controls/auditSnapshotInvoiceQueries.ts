import type {SnapshotSource,SnapshotRow} from './auditSnapshotCaptureQueries';
export const invoiceSnapshotSources:SnapshotSource[]=[
{source:'customer_invoice',family:'ar',
 async counts(ctx,cutoff){
  const [row]=await ctx.sql`SELECT COUNT(*) FILTER(WHERE (r.invoice_date IS NULL OR r.invoice_date<=${cutoff}::date))::int AS count,
   COUNT(*) FILTER(WHERE NOT (r.invoice_date IS NULL OR r.invoice_date<=${cutoff}::date))::int AS "excludedCount"
   FROM customer_invoices r LEFT JOIN customers s ON s.company_id=r.company_id AND s.id=COALESCE(r.client_id,r.customer_id) LEFT JOIN captured_documents d ON d.company_id=r.company_id AND d.id=r.source_document_id WHERE r.company_id=${ctx.principal.companyId}::uuid` as Array<{count:number;excludedCount:number}>;
  return row!;
 },
 async page(ctx,cutoff,after){
  return await ctx.sql`SELECT r.id::text,v.version,jsonb_build_object('invoice_date',r.invoice_date::text,'due_date',r.due_date::text,'party_id',s.id,'party_parent_unavailable',s.id IS NULL,'subtotal',r.subtotal::text,'tax_amount',r.tax_amount::text,'total_amount',r.total_amount::text,'amount_paid',r.amount_paid::text,'currency',r.currency_code,'status',r.status,'paid_at',r.paid_at::text,'deleted_at',r.deleted_at::text,'created_at',r.created_at::text,'updated_at',r.updated_at::text,'source_document_id',d.id,'source_document_hash',d.raw_bytes_sha256,'source_document_unavailable',r.source_document_id IS NOT NULL AND d.id IS NULL) AS data
   FROM customer_invoices r LEFT JOIN customers s ON s.company_id=r.company_id AND s.id=COALESCE(r.client_id,r.customer_id) LEFT JOIN captured_documents d ON d.company_id=r.company_id AND d.id=r.source_document_id LEFT JOIN control_entity_versions v ON v.company_id=${ctx.principal.companyId}::uuid AND v.entity_type='customer_invoice' AND v.entity_id=r.id::text
   WHERE r.company_id=${ctx.principal.companyId}::uuid AND (r.invoice_date IS NULL OR r.invoice_date<=${cutoff}::date) AND (${after}::uuid IS NULL OR r.id>${after}::uuid)
   ORDER BY r.id LIMIT 1000` as SnapshotRow[];
 }
},
{source:'customer_invoice_line',family:'ar',
 async counts(ctx,cutoff){
  const [row]=await ctx.sql`SELECT COUNT(*) FILTER(WHERE (p.invoice_date IS NULL OR p.invoice_date<=${cutoff}::date))::int AS count,
   COUNT(*) FILTER(WHERE NOT (p.invoice_date IS NULL OR p.invoice_date<=${cutoff}::date))::int AS "excludedCount"
   FROM customer_invoice_items r JOIN customer_invoices p ON p.id=r.invoice_id AND p.company_id=${ctx.principal.companyId}::uuid LEFT JOIN gl_accounts a ON a.company_id=p.company_id AND a.id=r.gl_account_id WHERE p.company_id=${ctx.principal.companyId}::uuid` as Array<{count:number;excludedCount:number}>;
  return row!;
 },
 async page(ctx,cutoff,after){
  return await ctx.sql`SELECT r.id::text,NULL::int AS version,jsonb_build_object('currency',p.currency_code,'invoice_id',p.id,'quantity',r.quantity::text,'unit_price',r.unit_price::text,'amount',r.amount::text,'tax_rate',r.tax_rate::text,'gl_account_id',a.id,'account_parent_unavailable',r.gl_account_id IS NOT NULL AND a.id IS NULL,'updated_at',r.updated_at::text) AS data
   FROM customer_invoice_items r JOIN customer_invoices p ON p.id=r.invoice_id AND p.company_id=${ctx.principal.companyId}::uuid LEFT JOIN gl_accounts a ON a.company_id=p.company_id AND a.id=r.gl_account_id 
   WHERE p.company_id=${ctx.principal.companyId}::uuid AND (p.invoice_date IS NULL OR p.invoice_date<=${cutoff}::date) AND (${after}::uuid IS NULL OR r.id>${after}::uuid)
   ORDER BY r.id LIMIT 1000` as SnapshotRow[];
 }
},
{source:'customer_payment',family:'ar',
 async counts(ctx,cutoff){
  const [row]=await ctx.sql`SELECT COUNT(*) FILTER(WHERE (r.payment_date IS NULL OR r.payment_date<=${cutoff}::date))::int AS count,
   COUNT(*) FILTER(WHERE NOT (r.payment_date IS NULL OR r.payment_date<=${cutoff}::date))::int AS "excludedCount"
   FROM customer_payments r LEFT JOIN customers s ON s.company_id=r.company_id AND s.id=r.client_id LEFT JOIN gl_accounts a ON a.company_id=r.company_id AND a.id=r.bank_account_id WHERE r.company_id=${ctx.principal.companyId}::uuid` as Array<{count:number;excludedCount:number}>;
  return row!;
 },
 async page(ctx,cutoff,after){
  return await ctx.sql`SELECT r.id::text,v.version,jsonb_build_object('currency',r.currency_code,'payment_date',r.payment_date::text,'party_id',s.id,'party_parent_unavailable',s.id IS NULL,'total_amount',r.total_amount::text,'bank_account_id',a.id,'account_parent_unavailable',r.bank_account_id IS NOT NULL AND a.id IS NULL,'status',r.status,'created_at',r.created_at::text,'updated_at',r.updated_at::text) AS data
   FROM customer_payments r LEFT JOIN customers s ON s.company_id=r.company_id AND s.id=r.client_id LEFT JOIN gl_accounts a ON a.company_id=r.company_id AND a.id=r.bank_account_id LEFT JOIN control_entity_versions v ON v.company_id=${ctx.principal.companyId}::uuid AND v.entity_type='customer_payment' AND v.entity_id=r.id::text
   WHERE r.company_id=${ctx.principal.companyId}::uuid AND (r.payment_date IS NULL OR r.payment_date<=${cutoff}::date) AND (${after}::uuid IS NULL OR r.id>${after}::uuid)
   ORDER BY r.id LIMIT 1000` as SnapshotRow[];
 }
},
{source:'customer_payment_allocation',family:'ar',
 async counts(ctx,cutoff){
  const [row]=await ctx.sql`SELECT COUNT(*) FILTER(WHERE (p.payment_date IS NULL OR p.payment_date<=${cutoff}::date))::int AS count,
   COUNT(*) FILTER(WHERE NOT (p.payment_date IS NULL OR p.payment_date<=${cutoff}::date))::int AS "excludedCount"
   FROM customer_payment_allocations r JOIN customer_payments p ON p.id=r.payment_id AND p.company_id=${ctx.principal.companyId}::uuid LEFT JOIN customer_invoices i ON i.company_id=p.company_id AND i.id=r.invoice_id WHERE p.company_id=${ctx.principal.companyId}::uuid` as Array<{count:number;excludedCount:number}>;
  return row!;
 },
 async page(ctx,cutoff,after){
  return await ctx.sql`SELECT r.id::text,NULL::int AS version,jsonb_build_object('currency',i.currency_code,'payment_id',p.id,'invoice_id',i.id,'invoice_parent_unavailable',i.id IS NULL,'amount_allocated',r.amount_allocated::text,'application_intent_id',r.application_intent_id,'reversed_at',r.reversed_at::text,'reversal_intent_id',r.reversal_intent_id,'created_at',r.created_at::text) AS data
   FROM customer_payment_allocations r JOIN customer_payments p ON p.id=r.payment_id AND p.company_id=${ctx.principal.companyId}::uuid LEFT JOIN customer_invoices i ON i.company_id=p.company_id AND i.id=r.invoice_id 
   WHERE p.company_id=${ctx.principal.companyId}::uuid AND (p.payment_date IS NULL OR p.payment_date<=${cutoff}::date) AND (${after}::uuid IS NULL OR r.id>${after}::uuid)
   ORDER BY r.id LIMIT 1000` as SnapshotRow[];
 }
},
{source:'supplier_invoice',family:'ap',
 async counts(ctx,cutoff){
  const [row]=await ctx.sql`SELECT COUNT(*) FILTER(WHERE (r.invoice_date IS NULL OR r.invoice_date<=${cutoff}::date))::int AS count,
   COUNT(*) FILTER(WHERE NOT (r.invoice_date IS NULL OR r.invoice_date<=${cutoff}::date))::int AS "excludedCount"
   FROM supplier_invoices r LEFT JOIN suppliers s ON s.company_id=r.company_id AND s.id=r.supplier_id LEFT JOIN captured_documents d ON d.company_id=r.company_id AND d.id=r.source_document_id WHERE r.company_id=${ctx.principal.companyId}::uuid` as Array<{count:number;excludedCount:number}>;
  return row!;
 },
 async page(ctx,cutoff,after){
  return await ctx.sql`SELECT r.id::text,v.version,jsonb_build_object('invoice_date',r.invoice_date::text,'due_date',r.due_date::text,'party_id',s.id,'party_parent_unavailable',s.id IS NULL,'subtotal',r.subtotal::text,'tax_amount',r.tax_amount::text,'total_amount',r.total_amount::text,'amount_paid',r.amount_paid::text,'currency',r.currency,'status',r.status,'paid_at',r.paid_at::text,'deleted_at',r.deleted_at::text,'created_at',r.created_at::text,'updated_at',r.updated_at::text,'source_document_id',d.id,'source_document_hash',d.raw_bytes_sha256,'source_document_unavailable',r.source_document_id IS NOT NULL AND d.id IS NULL) AS data
   FROM supplier_invoices r LEFT JOIN suppliers s ON s.company_id=r.company_id AND s.id=r.supplier_id LEFT JOIN captured_documents d ON d.company_id=r.company_id AND d.id=r.source_document_id LEFT JOIN control_entity_versions v ON v.company_id=${ctx.principal.companyId}::uuid AND v.entity_type='supplier_invoice' AND v.entity_id=r.id::text
   WHERE r.company_id=${ctx.principal.companyId}::uuid AND (r.invoice_date IS NULL OR r.invoice_date<=${cutoff}::date) AND (${after}::uuid IS NULL OR r.id>${after}::uuid)
   ORDER BY r.id LIMIT 1000` as SnapshotRow[];
 }
},
{source:'supplier_invoice_line',family:'ap',
 async counts(ctx,cutoff){
  const [row]=await ctx.sql`SELECT COUNT(*) FILTER(WHERE (p.invoice_date IS NULL OR p.invoice_date<=${cutoff}::date))::int AS count,
   COUNT(*) FILTER(WHERE NOT (p.invoice_date IS NULL OR p.invoice_date<=${cutoff}::date))::int AS "excludedCount"
   FROM supplier_invoice_items r JOIN supplier_invoices p ON p.id=r.supplier_invoice_id AND p.company_id=${ctx.principal.companyId}::uuid LEFT JOIN gl_accounts a ON a.company_id=p.company_id AND a.id=r.gl_account_id WHERE p.company_id=${ctx.principal.companyId}::uuid` as Array<{count:number;excludedCount:number}>;
  return row!;
 },
 async page(ctx,cutoff,after){
  return await ctx.sql`SELECT r.id::text,NULL::int AS version,jsonb_build_object('currency',p.currency,'invoice_id',p.id,'quantity',r.quantity::text,'unit_price',r.unit_price::text,'amount',r.line_total::text,'tax_rate',r.tax_rate::text,'gl_account_id',a.id,'account_parent_unavailable',r.gl_account_id IS NOT NULL AND a.id IS NULL,'updated_at',r.updated_at::text) AS data
   FROM supplier_invoice_items r JOIN supplier_invoices p ON p.id=r.supplier_invoice_id AND p.company_id=${ctx.principal.companyId}::uuid LEFT JOIN gl_accounts a ON a.company_id=p.company_id AND a.id=r.gl_account_id 
   WHERE p.company_id=${ctx.principal.companyId}::uuid AND (p.invoice_date IS NULL OR p.invoice_date<=${cutoff}::date) AND (${after}::uuid IS NULL OR r.id>${after}::uuid)
   ORDER BY r.id LIMIT 1000` as SnapshotRow[];
 }
},
{source:'supplier_payment',family:'ap',
 async counts(ctx,cutoff){
  const [row]=await ctx.sql`SELECT COUNT(*) FILTER(WHERE (r.payment_date IS NULL OR r.payment_date<=${cutoff}::date))::int AS count,
   COUNT(*) FILTER(WHERE NOT (r.payment_date IS NULL OR r.payment_date<=${cutoff}::date))::int AS "excludedCount"
   FROM supplier_payments r LEFT JOIN suppliers s ON s.company_id=r.company_id AND s.id=r.supplier_id LEFT JOIN gl_accounts a ON a.company_id=r.company_id AND a.id=r.bank_account_id WHERE r.company_id=${ctx.principal.companyId}::uuid` as Array<{count:number;excludedCount:number}>;
  return row!;
 },
 async page(ctx,cutoff,after){
  return await ctx.sql`SELECT r.id::text,v.version,jsonb_build_object('currency',NULL::text,'payment_date',r.payment_date::text,'party_id',s.id,'party_parent_unavailable',s.id IS NULL,'total_amount',r.total_amount::text,'bank_account_id',a.id,'account_parent_unavailable',r.bank_account_id IS NOT NULL AND a.id IS NULL,'status',r.status,'created_at',r.created_at::text,'updated_at',r.updated_at::text) AS data
   FROM supplier_payments r LEFT JOIN suppliers s ON s.company_id=r.company_id AND s.id=r.supplier_id LEFT JOIN gl_accounts a ON a.company_id=r.company_id AND a.id=r.bank_account_id LEFT JOIN control_entity_versions v ON v.company_id=${ctx.principal.companyId}::uuid AND v.entity_type='supplier_payment' AND v.entity_id=r.id::text
   WHERE r.company_id=${ctx.principal.companyId}::uuid AND (r.payment_date IS NULL OR r.payment_date<=${cutoff}::date) AND (${after}::uuid IS NULL OR r.id>${after}::uuid)
   ORDER BY r.id LIMIT 1000` as SnapshotRow[];
 }
},
{source:'supplier_payment_allocation',family:'ap',
 async counts(ctx,cutoff){
  const [row]=await ctx.sql`SELECT COUNT(*) FILTER(WHERE (p.payment_date IS NULL OR p.payment_date<=${cutoff}::date))::int AS count,
   COUNT(*) FILTER(WHERE NOT (p.payment_date IS NULL OR p.payment_date<=${cutoff}::date))::int AS "excludedCount"
   FROM payment_allocations r JOIN supplier_payments p ON p.id=r.payment_id AND p.company_id=${ctx.principal.companyId}::uuid LEFT JOIN supplier_invoices i ON i.company_id=p.company_id AND i.id=r.invoice_id WHERE p.company_id=${ctx.principal.companyId}::uuid` as Array<{count:number;excludedCount:number}>;
  return row!;
 },
 async page(ctx,cutoff,after){
  return await ctx.sql`SELECT r.id::text,NULL::int AS version,jsonb_build_object('currency',i.currency,'payment_id',p.id,'invoice_id',i.id,'invoice_parent_unavailable',i.id IS NULL,'amount_allocated',r.amount_allocated::text,'application_intent_id',r.application_intent_id,'reversed_at',r.reversed_at::text,'reversal_intent_id',r.reversal_intent_id,'created_at',r.created_at::text) AS data
   FROM payment_allocations r JOIN supplier_payments p ON p.id=r.payment_id AND p.company_id=${ctx.principal.companyId}::uuid LEFT JOIN supplier_invoices i ON i.company_id=p.company_id AND i.id=r.invoice_id 
   WHERE p.company_id=${ctx.principal.companyId}::uuid AND (p.payment_date IS NULL OR p.payment_date<=${cutoff}::date) AND (${after}::uuid IS NULL OR r.id>${after}::uuid)
   ORDER BY r.id LIMIT 1000` as SnapshotRow[];
 }
}
];
