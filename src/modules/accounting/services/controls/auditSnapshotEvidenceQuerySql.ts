import type {ControlTx} from './contracts';
export interface SnapshotEvidenceRelation {store:'captured'|'procurement'|'bank_attachment';documentId:string;parentSource:string;parentId:string;relation:string}
/** Fixed-depth owned joins, never a truncated graph walk. */
export async function querySnapshotEvidence(ctx:ControlTx,roots:readonly {source:string;id:string}[],after:string|null,limit:number){
 const company=ctx.principal.companyId;
 const [result]=await ctx.sql`WITH requested AS (
  SELECT source,id::uuid FROM jsonb_to_recordset(${JSON.stringify(roots)}::jsonb) AS r(source text,id text)
 ), roots AS (
  SELECT q.source,q.id,jsonb_build_object('source_document_id',to_jsonb(p)->'source_document_id','purchase_order_id',to_jsonb(p)->'purchase_order_id','grn_id',to_jsonb(p)->'grn_id') AS data FROM requested q JOIN gl_journal_entries p ON p.id=q.id AND p.company_id=${company}::uuid WHERE q.source='journal_entry' UNION ALL
  SELECT q.source,q.id,jsonb_build_object('source_document_id',to_jsonb(p)->'source_document_id','purchase_order_id',to_jsonb(p)->'purchase_order_id','grn_id',to_jsonb(p)->'grn_id') AS data FROM requested q JOIN gl_journal_lines p ON p.id=q.id AND p.company_id=${company}::uuid JOIN gl_journal_entries owner ON owner.id=p.journal_entry_id AND owner.company_id=p.company_id WHERE q.source='journal_line' UNION ALL
  SELECT q.source,q.id,jsonb_build_object('source_document_id',to_jsonb(p)->'source_document_id','purchase_order_id',to_jsonb(p)->'purchase_order_id','grn_id',to_jsonb(p)->'grn_id') AS data FROM requested q JOIN customer_invoices p ON p.id=q.id AND p.company_id=${company}::uuid WHERE q.source='customer_invoice' UNION ALL
  SELECT q.source,q.id,jsonb_build_object('source_document_id',to_jsonb(p)->'source_document_id','purchase_order_id',to_jsonb(p)->'purchase_order_id','grn_id',to_jsonb(p)->'grn_id') AS data FROM requested q JOIN supplier_invoices p ON p.id=q.id AND p.company_id=${company}::uuid WHERE q.source='supplier_invoice' UNION ALL
  SELECT q.source,q.id,jsonb_build_object('source_document_id',to_jsonb(p)->'source_document_id','purchase_order_id',to_jsonb(p)->'purchase_order_id','grn_id',to_jsonb(p)->'grn_id') AS data FROM requested q JOIN customer_payments p ON p.id=q.id AND p.company_id=${company}::uuid WHERE q.source='customer_payment' UNION ALL
  SELECT q.source,q.id,jsonb_build_object('source_document_id',to_jsonb(p)->'source_document_id','purchase_order_id',to_jsonb(p)->'purchase_order_id','grn_id',to_jsonb(p)->'grn_id') AS data FROM requested q JOIN supplier_payments p ON p.id=q.id AND p.company_id=${company}::uuid WHERE q.source='supplier_payment' UNION ALL
  SELECT q.source,q.id,jsonb_build_object('source_document_id',to_jsonb(p)->'source_document_id','purchase_order_id',to_jsonb(p)->'purchase_order_id','grn_id',to_jsonb(p)->'grn_id') AS data FROM requested q JOIN bank_transactions p ON p.id=q.id AND p.company_id=${company}::uuid WHERE q.source='bank_transaction' UNION ALL
  SELECT q.source,q.id,jsonb_build_object('source_document_id',to_jsonb(p)->'source_document_id','purchase_order_id',to_jsonb(p)->'purchase_order_id','grn_id',to_jsonb(p)->'grn_id') AS data FROM requested q JOIN bank_statement_imports p ON p.id=q.id AND p.company_id=${company}::uuid WHERE q.source='bank_statement_import' UNION ALL
  SELECT q.source,q.id,jsonb_build_object('source_document_id',to_jsonb(p)->'source_document_id','purchase_order_id',to_jsonb(p)->'purchase_order_id','grn_id',to_jsonb(p)->'grn_id') AS data FROM requested q JOIN control_bank_statement_attestation_intents p ON p.id=q.id AND p.company_id=${company}::uuid WHERE q.source='bank_statement_attestation_intent'
 UNION ALL SELECT q.source,q.id,'{}'::jsonb FROM requested q JOIN customer_invoice_items p ON p.id=q.id JOIN customer_invoices owner ON owner.id=p.invoice_id AND owner.company_id=${company}::uuid WHERE q.source='customer_invoice_line'
 UNION ALL SELECT q.source,q.id,'{}'::jsonb FROM requested q JOIN supplier_invoice_items p ON p.id=q.id JOIN supplier_invoices owner ON owner.id=p.supplier_invoice_id AND owner.company_id=${company}::uuid WHERE q.source='supplier_invoice_line'
 UNION ALL SELECT q.source,q.id,'{}'::jsonb FROM requested q JOIN customer_payment_allocations p ON p.id=q.id JOIN customer_payments owner ON owner.id=p.payment_id AND owner.company_id=${company}::uuid WHERE q.source='customer_payment_allocation'
 UNION ALL SELECT q.source,q.id,'{}'::jsonb FROM requested q JOIN payment_allocations p ON p.id=q.id JOIN supplier_payments owner ON owner.id=p.payment_id AND owner.company_id=${company}::uuid WHERE q.source='supplier_payment_allocation'
 UNION ALL SELECT q.source,q.id,'{}'::jsonb FROM requested q JOIN payroll_run_lines p ON p.id=q.id JOIN payroll_run_headers owner ON owner.id=p.run_id AND owner.company_id=${company}::uuid WHERE q.source='payroll_run_line'
 UNION ALL SELECT q.source,q.id,'{}'::jsonb FROM requested q JOIN payroll_run_headers p ON p.id=q.id AND p.company_id=${company}::uuid WHERE q.source='payroll_run'
 ), parents(kind,id) AS (
  SELECT 'supplier_invoice',id FROM sage_supplier_invoices WHERE company_id=${company}::uuid UNION ALL
  SELECT 'customer_invoice',id FROM customer_invoices WHERE company_id=${company}::uuid UNION ALL
  SELECT 'customer_payment',id FROM customer_payments WHERE company_id=${company}::uuid UNION ALL
  SELECT 'supplier_payment',id FROM supplier_payments WHERE company_id=${company}::uuid UNION ALL
  SELECT 'credit_note',id FROM credit_notes WHERE company_id=${company}::uuid UNION ALL
  SELECT 'purchase_order',id FROM purchase_orders WHERE company_id=${company}::uuid UNION ALL
  SELECT 'grn',id FROM goods_received_notes WHERE company_id=${company}::uuid UNION ALL
  SELECT 'goods_received_note',id FROM goods_received_notes WHERE company_id=${company}::uuid UNION ALL
  SELECT 'goods_receipt_note',id FROM goods_received_notes WHERE company_id=${company}::uuid
 ), targets(source,root_id,kind,id) AS (
  SELECT r.source,r.id,r.source,r.id FROM roots r WHERE r.source IN ('customer_invoice','customer_payment','supplier_payment')
  UNION SELECT r.source,r.id,'supplier_invoice',s.id FROM roots r JOIN sage_supplier_invoices s
   ON s.company_id=${company}::uuid AND s.gl_supplier_invoice_id=r.id WHERE r.source='supplier_invoice'
  UNION SELECT r.source,r.id,'purchase_order',p.id FROM roots r JOIN purchase_orders p
   ON p.company_id=${company}::uuid AND p.id::text=r.data->>'purchase_order_id' WHERE r.source='supplier_invoice'
  UNION SELECT r.source,r.id,a.kind,g.id FROM roots r JOIN goods_received_notes g
   ON g.company_id=${company}::uuid AND g.id::text=r.data->>'grn_id'
   CROSS JOIN (VALUES('grn'),('goods_received_note'),('goods_receipt_note')) a(kind) WHERE r.source='supplier_invoice'
 ), owned_documents AS (
  SELECT d.id,d.entity_type,d.entity_id FROM procurement_documents d JOIN parents p ON p.kind=d.entity_type AND p.id=d.entity_id
 ), relations(store,document_id,parent_source,parent_id,relation) AS (
  SELECT 'captured',d.id,r.source,r.id,'source_document' FROM roots r JOIN captured_documents d
   ON d.company_id=${company}::uuid AND d.id::text=r.data->>'source_document_id'
  UNION SELECT 'captured',d.id,r.source,r.id,'matched_invoice' FROM roots r JOIN captured_documents d
   ON d.company_id=${company}::uuid AND d.matched_invoice_id=r.id WHERE r.source='supplier_invoice'
  UNION SELECT 'captured',d.id,r.source,r.id,'matched_bank' FROM roots r JOIN captured_documents d
   ON d.company_id=${company}::uuid AND d.matched_bank_tx_id=r.id WHERE r.source='bank_transaction'
  UNION SELECT 'bank_attachment',a.id,r.source,r.id,'bank_attachment' FROM roots r JOIN bank_transaction_attachments a
   ON a.bank_transaction_id=r.id WHERE r.source='bank_transaction'
  UNION SELECT 'procurement',d.id,t.source,t.root_id,'document_parent' FROM targets t JOIN owned_documents d
   ON d.entity_type=t.kind AND d.entity_id=t.id
  UNION SELECT 'procurement',d.id,t.source,t.root_id,'document_link' FROM targets t JOIN document_links l
   ON l.linked_entity_type=t.kind AND l.linked_entity_id=t.id JOIN owned_documents d ON d.id=l.document_id
 ), bounded AS (SELECT * FROM relations LIMIT 100001), keyed AS (
  SELECT *,concat_ws('|',store,document_id::text,parent_source,parent_id::text,relation) COLLATE "C" AS key FROM bounded
 ), page AS (SELECT * FROM keyed WHERE ${after}::text IS NULL OR key>${after}::text COLLATE "C" ORDER BY key LIMIT ${limit+1})
 SELECT (SELECT count(*)::int FROM bounded) AS count,(SELECT count(*)::int FROM roots) AS root_count,
  COALESCE(jsonb_agg(jsonb_build_object('store',store,'documentId',document_id,'parentSource',parent_source,'parentId',parent_id,'relation',relation,'key',key) ORDER BY key),'[]'::jsonb) AS rows
 FROM page` as {count:number;root_count:number;rows:Array<SnapshotEvidenceRelation&{key:string}>}[];
 if(!result)throw new Error('Evidence relation query incomplete');return result;
}
