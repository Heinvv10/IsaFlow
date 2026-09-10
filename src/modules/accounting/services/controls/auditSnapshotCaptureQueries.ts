import type {ControlTx} from './contracts';
import type {AuditSnapshotData} from './auditSnapshotSeal';
export type SnapshotRow=Omit<AuditSnapshotData['records'][number],'source'|'version'>&{version:number|string|null};
export interface SnapshotSource {
 source:string;family:'journals'|'ar'|'ap'|'bank'|'payroll';
 counts(ctx:ControlTx,cutoff:string):Promise<{count:number;excludedCount:number}>;
 page(ctx:ControlTx,cutoff:string,after:string|null):Promise<SnapshotRow[]>;
}
export const ledgerSnapshotSources:SnapshotSource[]=[
{source:'journal_entry',family:'journals',
 async counts(ctx,cutoff){
  const [row]=await ctx.sql`SELECT COUNT(*) FILTER(WHERE (r.entry_date IS NULL OR r.entry_date<=${cutoff}::date))::int AS count,
   COUNT(*) FILTER(WHERE NOT (r.entry_date IS NULL OR r.entry_date<=${cutoff}::date))::int AS "excludedCount"
   FROM gl_journal_entries r LEFT JOIN fiscal_periods period ON period.company_id=r.company_id AND period.id=r.fiscal_period_id LEFT JOIN gl_journal_entries original ON original.company_id=r.company_id AND original.id=r.reversal_of_id LEFT JOIN captured_documents d ON d.company_id=r.company_id AND d.id=r.source_document_id WHERE r.company_id=${ctx.principal.companyId}::uuid` as Array<{count:number;excludedCount:number}>;
  return row!;
 },
 async page(ctx,cutoff,after){
  return await ctx.sql`SELECT r.id::text,v.version,jsonb_build_object('currency',(SELECT c.default_currency FROM companies c WHERE c.id=${ctx.principal.companyId}::uuid),'entry_date',r.entry_date::text,'status',r.status,'source',r.source,'fiscal_period_id',period.id,'period_parent_unavailable',r.fiscal_period_id IS NOT NULL AND period.id IS NULL,'posted_at',r.posted_at::text,'reversed_at',r.reversed_at::text,'reversal_of_id',original.id,'reversal_parent_unavailable',r.reversal_of_id IS NOT NULL AND original.id IS NULL,'created_at',r.created_at::text,'updated_at',r.updated_at::text,'source_document_id',d.id,'source_document_hash',d.raw_bytes_sha256,'source_document_unavailable',r.source_document_id IS NOT NULL AND d.id IS NULL)||CASE WHEN v.lineage_count>1 THEN jsonb_build_object('control_lineage_forked',true) ELSE '{}'::jsonb END||CASE WHEN v.version_count>1 AND v.entity_id<>r.id::text THEN jsonb_build_object('control_lineage_tie_unresolvable',true) ELSE '{}'::jsonb END AS data
   FROM gl_journal_entries r LEFT JOIN fiscal_periods period ON period.company_id=r.company_id AND period.id=r.fiscal_period_id LEFT JOIN gl_journal_entries original ON original.company_id=r.company_id AND original.id=r.reversal_of_id LEFT JOIN captured_documents d ON d.company_id=r.company_id AND d.id=r.source_document_id LEFT JOIN LATERAL(SELECT cv.*,count(*) OVER() AS lineage_count,count(*) OVER(PARTITION BY cv.version) AS version_count FROM control_entity_versions cv WHERE cv.company_id=${ctx.principal.companyId}::uuid AND cv.entity_type='journal_entry' AND lower(cv.entity_id)=r.id::text ORDER BY cv.version DESC,(cv.entity_id=r.id::text) DESC,cv.entity_id COLLATE "C" LIMIT 1) v ON true
   WHERE r.company_id=${ctx.principal.companyId}::uuid AND (r.entry_date IS NULL OR r.entry_date<=${cutoff}::date) AND (${after}::uuid IS NULL OR r.id>${after}::uuid)
   ORDER BY r.id LIMIT 1000` as SnapshotRow[];
 }
},
{source:'journal_line',family:'journals',
 async counts(ctx,cutoff){
  const [row]=await ctx.sql`SELECT COUNT(*) FILTER(WHERE (p.entry_date IS NULL OR p.entry_date<=${cutoff}::date))::int AS count,
   COUNT(*) FILTER(WHERE NOT (p.entry_date IS NULL OR p.entry_date<=${cutoff}::date))::int AS "excludedCount"
   FROM gl_journal_lines r JOIN gl_journal_entries p ON p.company_id=r.company_id AND p.id=r.journal_entry_id LEFT JOIN gl_accounts a ON a.company_id=r.company_id AND a.id=r.gl_account_id WHERE r.company_id=${ctx.principal.companyId}::uuid` as Array<{count:number;excludedCount:number}>;
  return row!;
 },
 async page(ctx,cutoff,after){
  return await ctx.sql`SELECT r.id::text,NULL::int AS version,jsonb_build_object('currency',(SELECT c.default_currency FROM companies c WHERE c.id=${ctx.principal.companyId}::uuid),'journal_entry_id',p.id,'gl_account_id',a.id,'gl_account_code',a.account_code,'gl_account_type',a.account_type,'gl_account_subtype',a.account_subtype,'gl_account_normal_balance',a.normal_balance,'gl_account_active',a.is_active,'gl_account_default_vat_code',a.default_vat_code,'debit',r.debit::text,'credit',r.credit::text,'vat_type',r.vat_type,'account_parent_unavailable',a.id IS NULL,'created_at',r.created_at::text,'updated_at',r.updated_at::text) AS data
   FROM gl_journal_lines r JOIN gl_journal_entries p ON p.company_id=r.company_id AND p.id=r.journal_entry_id LEFT JOIN gl_accounts a ON a.company_id=r.company_id AND a.id=r.gl_account_id 
   WHERE r.company_id=${ctx.principal.companyId}::uuid AND (p.entry_date IS NULL OR p.entry_date<=${cutoff}::date) AND (${after}::uuid IS NULL OR r.id>${after}::uuid)
   ORDER BY r.id LIMIT 1000` as SnapshotRow[];
 }
},
{source:'bank_transaction',family:'bank',
 async counts(ctx,cutoff){
  const [row]=await ctx.sql`SELECT COUNT(*) FILTER(WHERE (r.transaction_date IS NULL OR r.transaction_date<=${cutoff}::date))::int AS count,
   COUNT(*) FILTER(WHERE NOT (r.transaction_date IS NULL OR r.transaction_date<=${cutoff}::date))::int AS "excludedCount"
   FROM bank_transactions r LEFT JOIN gl_accounts a ON a.company_id=r.company_id AND a.id=r.bank_account_id WHERE r.company_id=${ctx.principal.companyId}::uuid` as Array<{count:number;excludedCount:number}>;
  return row!;
 },
 async page(ctx,cutoff,after){
  return await ctx.sql`SELECT r.id::text,v.version,jsonb_build_object('currency',(SELECT c.default_currency FROM companies c WHERE c.id=${ctx.principal.companyId}::uuid),'transaction_date',r.transaction_date::text,'value_date',r.value_date::text,'bank_account_id',a.id,'gl_account_code',a.account_code,'gl_account_type',a.account_type,'gl_account_subtype',a.account_subtype,'gl_account_normal_balance',a.normal_balance,'gl_account_active',a.is_active,'gl_account_default_vat_code',a.default_vat_code,'account_parent_unavailable',a.id IS NULL,'amount',r.amount::text,'status',r.status,'allocation_type',r.allocation_type,'created_at',r.created_at::text,'updated_at',r.updated_at::text)||CASE WHEN v.lineage_count>1 THEN jsonb_build_object('control_lineage_forked',true) ELSE '{}'::jsonb END||CASE WHEN v.version_count>1 AND v.entity_id<>r.id::text THEN jsonb_build_object('control_lineage_tie_unresolvable',true) ELSE '{}'::jsonb END AS data
   FROM bank_transactions r LEFT JOIN gl_accounts a ON a.company_id=r.company_id AND a.id=r.bank_account_id LEFT JOIN LATERAL(SELECT cv.*,count(*) OVER() AS lineage_count,count(*) OVER(PARTITION BY cv.version) AS version_count FROM control_entity_versions cv WHERE cv.company_id=${ctx.principal.companyId}::uuid AND cv.entity_type='bank_transaction' AND lower(cv.entity_id)=r.id::text ORDER BY cv.version DESC,(cv.entity_id=r.id::text) DESC,cv.entity_id COLLATE "C" LIMIT 1) v ON true
   WHERE r.company_id=${ctx.principal.companyId}::uuid AND (r.transaction_date IS NULL OR r.transaction_date<=${cutoff}::date) AND (${after}::uuid IS NULL OR r.id>${after}::uuid)
   ORDER BY r.id LIMIT 1000` as SnapshotRow[];
 }
},
{source:'bank_statement_import',family:'bank',
 async counts(ctx,cutoff){
  const [row]=await ctx.sql`SELECT COUNT(*) FILTER(WHERE (r.period_end IS NULL OR r.period_end<=${cutoff}::date))::int AS count,
   COUNT(*) FILTER(WHERE NOT (r.period_end IS NULL OR r.period_end<=${cutoff}::date))::int AS "excludedCount"
   FROM bank_statement_imports r LEFT JOIN gl_accounts a ON a.company_id=r.company_id AND a.id=r.bank_account_id LEFT JOIN captured_documents d ON d.company_id=r.company_id AND d.id=r.source_document_id WHERE r.company_id=${ctx.principal.companyId}::uuid` as Array<{count:number;excludedCount:number}>;
  return row!;
 },
 async page(ctx,cutoff,after){
  return await ctx.sql`SELECT r.id::text,v.version,jsonb_build_object('currency',(SELECT c.default_currency FROM companies c WHERE c.id=${ctx.principal.companyId}::uuid),'bank_account_id',a.id,'gl_account_code',a.account_code,'gl_account_type',a.account_type,'gl_account_subtype',a.account_subtype,'gl_account_normal_balance',a.normal_balance,'gl_account_active',a.is_active,'gl_account_default_vat_code',a.default_vat_code,'account_parent_unavailable',a.id IS NULL,'period_start',r.period_start::text,'period_end',r.period_end::text,'opening_balance',r.opening_balance::text,'closing_balance',r.closing_balance::text,'row_count',r.row_count,'imported_count',r.imported_count,'status',r.status,'source_document_id',d.id,'source_document_hash',d.raw_bytes_sha256,'source_document_unavailable',r.source_document_id IS NOT NULL AND d.id IS NULL,'updated_at',r.updated_at::text)||CASE WHEN v.lineage_count>1 THEN jsonb_build_object('control_lineage_forked',true) ELSE '{}'::jsonb END||CASE WHEN v.version_count>1 AND v.entity_id<>r.id::text THEN jsonb_build_object('control_lineage_tie_unresolvable',true) ELSE '{}'::jsonb END AS data
   FROM bank_statement_imports r LEFT JOIN gl_accounts a ON a.company_id=r.company_id AND a.id=r.bank_account_id LEFT JOIN captured_documents d ON d.company_id=r.company_id AND d.id=r.source_document_id LEFT JOIN LATERAL(SELECT cv.*,count(*) OVER() AS lineage_count,count(*) OVER(PARTITION BY cv.version) AS version_count FROM control_entity_versions cv WHERE cv.company_id=${ctx.principal.companyId}::uuid AND cv.entity_type='bank_statement_import' AND lower(cv.entity_id)=r.id::text ORDER BY cv.version DESC,(cv.entity_id=r.id::text) DESC,cv.entity_id COLLATE "C" LIMIT 1) v ON true
   WHERE r.company_id=${ctx.principal.companyId}::uuid AND (r.period_end IS NULL OR r.period_end<=${cutoff}::date) AND (${after}::uuid IS NULL OR r.id>${after}::uuid)
   ORDER BY r.id LIMIT 1000` as SnapshotRow[];
 }
}
];
/** Retain prepared facts and execution identity separately; existence is never independent review. */
ledgerSnapshotSources.push({source:'bank_statement_attestation_intent',family:'bank',
 async counts(ctx,cutoff){
  const [row]=await ctx.sql`SELECT COUNT(*) FILTER(WHERE period_end<=${cutoff}::date)::int AS count,
   COUNT(*) FILTER(WHERE period_end>${cutoff}::date)::int AS "excludedCount"
   FROM control_bank_statement_attestation_intents WHERE company_id=${ctx.principal.companyId}::uuid` as Array<{count:number;excludedCount:number}>;
  return row!;
 },
 async page(ctx,cutoff,after){
  return await ctx.sql`SELECT r.id::text,v.version,jsonb_build_object('bank_account_id',a.id,'gl_account_code',a.account_code,'gl_account_type',a.account_type,'gl_account_subtype',a.account_subtype,'gl_account_normal_balance',a.normal_balance,'gl_account_active',a.is_active,'gl_account_default_vat_code',a.default_vat_code,'account_parent_unavailable',a.id IS NULL,
   'source_document_id',d.id,'source_document_unavailable',d.id IS NULL,'expected_source_hash',r.expected_source_hash,
   'source_fingerprint',r.source_fingerprint,'period_start',r.period_start::text,'period_end',r.period_end::text,
   'source_count',r.source_count,'opening_balance',r.opening_balance::text,'closing_balance',r.closing_balance::text,
   'currency',r.currency,'execution_effect_id',effect.id,'created_at',r.created_at::text)||CASE WHEN v.lineage_count>1 THEN jsonb_build_object('control_lineage_forked',true) ELSE '{}'::jsonb END||CASE WHEN v.version_count>1 AND v.entity_id<>r.id::text THEN jsonb_build_object('control_lineage_tie_unresolvable',true) ELSE '{}'::jsonb END||CASE WHEN effect.receipt_count>1 THEN jsonb_build_object('control_receipt_twinned',true) ELSE '{}'::jsonb END AS data
   FROM control_bank_statement_attestation_intents r
   LEFT JOIN gl_accounts a ON a.company_id=r.company_id AND a.id=r.bank_account_id
   LEFT JOIN captured_documents d ON d.company_id=r.company_id AND d.id=r.source_document_id
   LEFT JOIN LATERAL(SELECT fx.id,count(*) OVER() AS receipt_count FROM control_operation_effects fx WHERE fx.company_id=r.company_id AND fx.entity_type='bank_statement_attestation_intent'
    AND lower(fx.entity_id)=r.id::text AND fx.operation='bank_statement.attest'
    ORDER BY EXISTS(SELECT 1 FROM control_operation_approvals ap WHERE ap.company_id=fx.company_id AND ap.consumed_effect_id=fx.id AND ap.status='consumed') DESC,(fx.entity_id=r.id::text) DESC,fx.committed_at,fx.id LIMIT 1) effect ON true
   LEFT JOIN LATERAL(SELECT cv.*,count(*) OVER() AS lineage_count,count(*) OVER(PARTITION BY cv.version) AS version_count FROM control_entity_versions cv WHERE cv.company_id=r.company_id AND cv.entity_type='bank_statement_attestation_intent' AND lower(cv.entity_id)=r.id::text ORDER BY cv.version DESC,(cv.entity_id=r.id::text) DESC,cv.entity_id COLLATE "C" LIMIT 1) v ON true
   WHERE r.company_id=${ctx.principal.companyId}::uuid AND r.period_end<=${cutoff}::date AND (${after}::uuid IS NULL OR r.id>${after}::uuid)
   ORDER BY r.id LIMIT 1000` as SnapshotRow[];
 }
});
