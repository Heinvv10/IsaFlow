/**
 * Wave 7 AAa: the pinned data of the AP/AR half of actorIdTextCensus.test.ts (kept apart so that file stays under 300 lines).
 *
 * AP_AR_SITES: file -> line -> exact trimmed text of every line that names an actor column (created_by, approved_by,
 * cancelled_by, processed_by, confirmed_by) in a tracked src/ or pages/ file whose code names one of the 10 AP/AR tables.
 * AP_AR_UUID_AUTHOR_EXEMPT: every other uuid cast in those files, pinned: the uuid[] document-author arrays (content_authors;
 * approval_add_author), a column AAb does not turn to TEXT, and a regex-guarded cast of created_by.
 */
export const AP_AR_SITES: Readonly<Record<string, Readonly<Record<number, string>>>> = {
  "pages/api/accounting/ai-invoice-pipeline.ts": {
    203: "reference, status, created_by, notes,",
  },
  "pages/api/accounting/capture/[id]/post.ts": {
    235: "reference, status, created_by, notes,",
  },
  "pages/api/accounting/supplier-returns.ts": {
    97: "status, credit_date, created_by, created_at",
  },
  "src/modules/accounting/services/ap/batchPaymentApproval.ts": {
    91: "UPDATE supplier_payments SET status = 'approved', approved_by = ${userId}, approved_at = NOW()",
    99: "UPDATE supplier_payments SET approved_by = ${userId}, approved_at = NOW()",
  },
  "src/modules/accounting/services/ap/batchPaymentService.ts": {
    87: "payment_count, total_amount, created_by",
    104: "status, batch_id, created_by",
    184: "SET status = 'processed', processed_by = ${userId}, processed_at = NOW(), updated_at = NOW()",
    294: "processedBy: row.processed_by ? String(row.processed_by) : undefined,",
    296: "createdBy: String(row.created_by),",
  },
  "src/modules/accounting/services/ap/billPurchaseOrderLinks.ts": {
    129: "INSERT INTO purchase_order_bill_links (company_id, purchase_order_id, supplier_invoice_id, amount, source, created_by)",
  },
  "src/modules/accounting/services/ap/goodsReceivedReadService.ts": {
    50: "cancelled_at: stamp(r.cancelled_at), cancelled_by: short(r.cancelled_by), cancel_reason: free(r.cancel_reason, 500),",
    59: "SELECT g.id, g.grn_number, g.status, g.received_date, g.received_by, g.created_by, g.notes, g.purchase_order_id, g.external_system, g.external_ref,",
    60: "g.cancelled_at, g.cancelled_by, g.cancel_reason, g.created_at, po.po_number, po.status AS po_status, po.supplier_id, s.name AS supplier_name,",
  },
  "src/modules/accounting/services/ap/migrationApService.ts": {
    208: "status, reference, created_by,",
  },
  "src/modules/accounting/services/ap/provisionalInvoiceSettlement.ts": {
    111: "created_by, approved_by, approved_at, processed_at",
  },
  "src/modules/accounting/services/ap/purchaseOrderBillLink.ts": {
    73: "company_id, purchase_order_id, supplier_invoice_id, amount, source, external_system, external_ref, created_by",
  },
  "src/modules/accounting/services/ap/supplierAutoAllocate.ts": {
    146: "created_by, approved_by, approved_at, processed_at",
  },
  "src/modules/accounting/services/ap/supplierBankPaymentService.ts": {
    250: "created_by, approved_by, approved_at, processed_at",
  },
  "src/modules/accounting/services/ap/supplierInvoiceQueryService.ts": {
    78: "si.notes, si.created_by, si.approved_by, si.approved_at,",
  },
  "src/modules/accounting/services/ap/supplierInvoiceService.ts": {
    163: "cost_center_id, notes, created_by,",
  },
  "src/modules/accounting/services/ap/supplierInvoiceWorkflowService.ts": {
    99: "SET status = 'approved', approved_by = ${userId}, approved_at = NOW()",
    154: "SET status = 'approved', approved_by = ${userId}, approved_at = NOW(),",
  },
  "src/modules/accounting/services/ap/supplierPaymentApproval.ts": {
    59: "SET status = 'approved', approved_by = ${userId}, approved_at = NOW()",
  },
  "src/modules/accounting/services/ap/supplierPaymentService.ts": {
    218: "bank_account_id, reference, description, created_by",
  },
  "src/modules/accounting/services/ap/supplierRefundDocument.ts": {
    231: "created_by, approved_by, approved_at, processed_at",
  },
  "src/modules/accounting/services/ar/creditNoteApproveService.ts": {
    242: "UPDATE credit_notes SET status = ${finalStatus}, approved_by = ${userId},",
  },
  "src/modules/accounting/services/ar/creditNoteCancelService.ts": {
    159: "SET status = 'cancelled', cancelled_by = ${userId},",
  },
  "src/modules/accounting/services/ar/creditNoteDraftCancelService.ts": {
    53: "SET status = 'cancelled', cancelled_by = ${userId}, cancelled_at = NOW(), cancel_reason = ${reason || null}",
  },
  "src/modules/accounting/services/ar/creditNotePdfBuilder.ts": {
    32: "public.approval_company_member_name(cn.company_id, cn.approved_by::TEXT) AS approved_by_name",
  },
  "src/modules/accounting/services/ar/creditNoteService.ts": {
    164: "project_id, created_by, actor_type, actor_token_jti, cc1_id, cc2_id, bu_id, gl_account_id, vat_basis, vat_ack_matches",
  },
  "src/modules/accounting/services/ar/customerBankReceipt.ts": {
    21: "gl_journal_entry_id, created_by, confirmed_by, confirmed_at",
  },
  "src/modules/accounting/services/ar/customerInvoiceUpstreamAuthors.ts": {
    39: "unnest(ri.content_authors || ARRAY[ri.created_by]) a",
    46: "unnest(t.content_authors || ARRAY[CASE WHEN t.created_by",
    47: "~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN t.created_by::UUID END]) a",
  },
  "src/modules/accounting/services/ar/customerPaymentAllocationService.ts": {
    152: "SET status = 'confirmed', confirmed_by = ${userId}, confirmed_at = NOW(),",
    275: "createdBy: String(row.created_by),",
    276: "confirmedBy: row.confirmed_by ? String(row.confirmed_by) : undefined,",
  },
  "src/modules/accounting/services/ar/customerPaymentService.ts": {
    160: "bank_reference, bank_account_id, description, project_id, created_by",
    209: "createdBy: String(row.created_by),",
    210: "confirmedBy: row.confirmed_by ? String(row.confirmed_by) : undefined,",
  },
  "src/modules/accounting/services/ar/customerRefundDocument.ts": {
    159: "gl_journal_entry_id, created_by, confirmed_by, confirmed_at",
  },
  "src/modules/accounting/services/ar/gatewayInvoiceReceiptService.ts": {
    75: "created_by: string;",
    149: "already.created_by,",
    169: "SELECT COALESCE(client_id, customer_id) AS client_id, created_by",
    179: "const actorId = await resolveCompanyActor(companyId, String(invoice.created_by));",
    193: "bank_reference, bank_account_id, description, created_by",
  },
  "src/modules/accounting/services/ar/gatewaySettledReceipt.ts": {
    43: "created_by: string;",
    73: "SELECT cp.id, cp.created_by::text AS created_by, cp.bank_account_id::text AS bank_account_id,",
  },
  "src/modules/accounting/services/ar/portalChatbotService.ts": {
    177: "/\\b(?:company_id|customer_id|client_id|invoice_id|supplier_id|deleted_at|amount_paid|total_amount|portal_token|created_by)\\b/i,",
  },
  "src/modules/accounting/services/ar/recurringInvoiceRun.ts": {
    142: "status, notes, created_by",
  },
  "src/modules/accounting/services/ar/recurringInvoiceService.ts": {
    102: "total_amount, payment_terms, created_by, content_authors",
    154: "createdBy: String(row.created_by),",
  },
  "src/modules/accounting/services/ar/writeOffService.ts": {
    104: "company_id, client_id, invoice_id, amount, reason, write_off_date, created_by",
    187: "SET status = 'approved', approved_by = ${userId}, approved_at = NOW()",
    283: "approvedBy: row.approved_by ? String(row.approved_by) : undefined,",
    285: "createdBy: String(row.created_by),",
  },
  "src/modules/accounting/services/bank/splitJournalDocuments.ts": {
    48: "SELECT 'supplier' AS kind, created_by::TEXT AS created_by, total_amount AS total, status <> 'cancelled' AS live",
    51: "SELECT 'supplier', created_by::TEXT, total_amount, status <> 'cancelled'",
    54: "SELECT 'customer', created_by::TEXT, total_amount, status <> 'cancelled'",
    63: "createdBy: r.created_by == null ? null : String(r.created_by),",
  },
  "src/modules/accounting/services/capture/provisionalAttachSettle.ts": {
    92: "SET status = 'draft', approved_by = NULL, approved_at = NULL,",
  },
  "src/modules/accounting/services/core/anomalyScanService.ts": {
    46: "SELECT je.id, je.entry_date as date, jl.debit + jl.credit as amount, je.created_by as user_id, je.description",
  },
  "src/modules/accounting/services/core/recurringTransactionInvoices.ts": {
    81: "notes, subtotal, tax_amount, total_amount, status, created_by",
    218: "reference, notes, subtotal, tax_amount, total_amount, status, created_by,",
  },
  "src/modules/accounting/services/core/sageSupplierInvoiceImportService.ts": {
    153: "amount_paid, status, sage_invoice_id, notes, created_by,",
  },
  "src/modules/accounting/services/core/softDeleteJournalService.ts": {
    193: "(company_id, entity_type, entity_id, reversal_journal_entry_id, created_by)",
    198: "created_by = EXCLUDED.created_by,",
  },
  "src/modules/accounting/services/gl/manualJournalAuthors.ts": {
    42: "unnest(rj.content_authors || ARRAY[rj.created_by]) a",
    49: "unnest(t.content_authors || ARRAY[CASE WHEN t.created_by",
    50: "~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN t.created_by::UUID END]) a",
  },
  "src/modules/accounting/services/gl/recurringJournalService.ts": {
    89: "end_date, lines, total_amount, created_by, auto_post",
    271: "createdBy: String(row.created_by),",
  },
  "src/modules/accounting/services/items/adjustmentService.ts": {
    86: "adjustment_date, created_by",
    126: "SET status = 'approved', approved_by = ${userId}, approved_at = NOW()",
    215: "approvedBy: row.approved_by ? String(row.approved_by) : undefined,",
    217: "createdBy: String(row.created_by),",
  },
  "src/modules/accounting/services/reports/customReportFieldDefs.ts": {
    40: "{ field: 'created_by',   label: 'Created By',     type: 'text',     sortable: true,  filterable: true,  totalable: false, sqlExpr: 'je.created_by' },",
  },
  "src/modules/accounting/services/reports/glLineExportService.ts": {
    175: "COALESCE(public.approval_company_member_name(je.company_id, je.created_by::TEXT),",
    176: "je.created_by::TEXT) AS created_by_name,",
  },
  "src/modules/accounting/services/reports/vatAdjustmentService.ts": {
    60: "company_id, adjustment_date, vat_period, adjustment_type, amount, reason, created_by",
    183: "SET status = 'approved', approved_by = ${userId}, approved_at = NOW(),",
    215: "approvedBy: row.approved_by ? String(row.approved_by) : undefined,",
    217: "createdBy: String(row.created_by),",
  },
  "src/modules/admin/services/sageMigrationCommitService.ts": {
    189: "amount_paid, status, notes, created_by, currency_code, exchange_rate, functional_total",
  },
};

export const AP_AR_UUID_AUTHOR_EXEMPT: Readonly<Record<string, Readonly<Record<number, string>>>> = {
"src/modules/accounting/services/ar/customerInvoiceUpstreamAuthors.ts": {
    47: "~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN t.created_by::UUID END]) a",
    62: "SELECT DISTINCT a FROM unnest(${authors}::UUID[]) a WHERE a <> ALL(content_authors) ORDER BY a)",
  },
  "src/modules/accounting/services/ar/recurringInvoiceService.ts": {
    109: "ARRAY[${userId}::UUID]",
  },
  "src/modules/accounting/services/gl/manualJournalAuthors.ts": {
    50: "~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN t.created_by::UUID END]) a",
    70: "SET content_authors = approval_add_author(je.content_authors, ${editedBy}::UUID)",
  },
};
