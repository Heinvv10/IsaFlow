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

/** The VALUES lines that bind an actor on a line that does not name the column (multi-line INSERTs), pinned as in the HYa half. */
export const AP_AR_VALUE_BINDS: Readonly<Record<string, Readonly<Record<number, string>>>> = {
"pages/api/accounting/ai-invoice-pipeline.ts": {
    213: "${userId}, ${invoiceInput.notes ?? null},",
  },
  "pages/api/accounting/capture/[id]/post.ts": {
    243: "${approval.status}, ${userId}, ${invoiceInput.notes ?? null},",
  },
  "pages/api/accounting/supplier-returns.ts": {
    101: "'draft', NOW(), ${userId}, NOW()",
  },
  "src/modules/accounting/services/ap/batchPaymentService.ts": {
    90: "${input.notes || null}, ${input.payments.length}, 0, ${userId}",
    107: "${payTotal}, ${paymentMethod}, 'draft', ${id}::UUID, ${userId}",
  },
  "src/modules/accounting/services/ap/billPurchaseOrderLinks.ts": {
    130: "VALUES (${companyId}::UUID, ${p.poId}::UUID, ${billId}::UUID, ${(p.amountCents / 100).toFixed(2)}::NUMERIC, 'app', ${userId})",
  },
  "src/modules/accounting/services/ap/migrationApService.ts": {
    215: "${inv.reference ?? null}, ${userId},",
  },
  "src/modules/accounting/services/ap/provisionalInvoiceSettlement.ts": {
    115: "${claim.journalEntryId}::UUID, ${createdBy}, ${createdBy}, NOW(), NOW()",
  },
  "src/modules/accounting/services/ap/purchaseOrderBillLink.ts": {
    76: "${p.ref?.system ?? null}, ${p.ref?.ref ?? null}, ${opts.userId}",
    118: "updated_at = NOW(), updated_by = ${opts.userId}",
  },
  "src/modules/accounting/services/ap/supplierAutoAllocate.ts": {
    152: "${createdBy}, ${createdBy}, NOW(), NOW()",
  },
  "src/modules/accounting/services/ap/supplierBankPaymentService.ts": {
    256: "${createdBy}, ${createdBy}, NOW(), NOW()",
  },
  "src/modules/accounting/services/ap/supplierInvoiceService.ts": {
    174: "${input.notes || null}, ${userId},",
  },
  "src/modules/accounting/services/ap/supplierPaymentService.ts": {
    222: "${input.reference || null}, ${input.description || null}, ${userId}",
  },
  "src/modules/accounting/services/ap/supplierRefundDocument.ts": {
    237: "${createdBy}, ${createdBy}, NOW(), NOW()",
  },
  "src/modules/accounting/services/ar/creditNoteService.ts": {
    172: "${projectId}, ${userId},",
  },
  "src/modules/accounting/services/ar/customerBankReceipt.ts": {
    25: "${r.journalEntryId}::UUID, ${r.createdBy}, ${r.createdBy}, NOW()",
  },
  "src/modules/accounting/services/ar/customerPaymentService.ts": {
    165: "${input.projectId || null}, ${userId}",
  },
  "src/modules/accounting/services/ar/customerRefundDocument.ts": {
    164: "${journalEntryId}::UUID, ${createdBy}, ${createdBy}, NOW()",
  },
  "src/modules/accounting/services/ar/gatewayInvoiceReceiptService.ts": {
    197: "${description}, ${actorId}",
  },
  "src/modules/accounting/services/ar/recurringInvoiceRun.ts": {
    148: "'draft', ${ri.description || ri.template_name}, ${userId}",
  },
  "src/modules/accounting/services/ar/recurringInvoiceService.ts": {
    108: "${taxAmount}, ${totalAmount}, ${input.paymentTerms || null}, ${userId},",
    109: "ARRAY[${userId}::UUID]",
  },
  "src/modules/accounting/services/ar/writeOffService.ts": {
    108: "${userId}",
  },
  "src/modules/accounting/services/core/recurringTransactionInvoices.ts": {
    95: "${userId}",
    233: "${userId},",
  },
  "src/modules/accounting/services/core/sageSupplierInvoiceImportService.ts": {
    160: "${rowVatNotStated ? SAGE_VAT_NOT_STATED_NOTE : null}, ${userId},",
  },
  "src/modules/accounting/services/core/softDeleteJournalService.ts": {
    195: "${reversalJournalEntryId}::UUID, ${userId})",
  },
  "src/modules/accounting/services/gl/manualJournalAuthors.ts": {
    70: "SET content_authors = approval_add_author(je.content_authors, ${editedBy}::UUID)",
  },
  "src/modules/accounting/services/gl/recurringJournalService.ts": {
    93: "${JSON.stringify(input.lines)}::JSONB, ${totalDebit}, ${userId}, ${recurringJournalAutoPosts(input.autoPost)}",
  },
  "src/modules/accounting/services/items/adjustmentService.ts": {
    91: "${userId}",
  },
  "src/modules/accounting/services/reports/vatAdjustmentService.ts": {
    63: "${input.adjustmentType}, ${input.amount}, ${input.reason}, ${userId}",
  },
  "src/modules/admin/services/sageMigrationCommitService.ts": {
    194: "${amountPaid}, 'approved', ${inv.reference ?? null}, ${userId}, 'ZAR', 1.0, ${inv.totalAmount}",
  },
};

export const AP_AR_TABLE = /\b(supplier_invoices|supplier_payments|customer_payments|credit_notes|recurring_invoices|customer_write_offs|accounting_adjustments|supplier_payment_batches|recurring_journals|vat_adjustments)\b/;
export const AP_AR_COLUMN = /\b(created_by|approved_by|cancelled_by|processed_by|confirmed_by)\b/;
/** `${expr}` followed by any `::type` chain ending in uuid (pg_catalog., quoted, uuid[]), or `CAST(${expr} AS uuid)`. */
const UUID_T = '"?(?:pg_catalog\\.)?"?uuid"?(?:\\[\\])?';
const BIND_CAST = new RegExp(`\\$\\{([^}]*)\\}\\s*(?:::\\s*[\\w."]+(?:\\[\\])?\\s*)*::\\s*${UUID_T}|CAST\\s*\\(\\s*\\$\\{([^}]*)\\}\\s+AS\\s+${UUID_T}`, 'gi');
/** An actor column cast to uuid on the column side: `col::uuid`, `CAST(col AS uuid)`. */
const COLUMN_CAST = new RegExp(`\\b(?:created_by|approved_by|cancelled_by|processed_by|confirmed_by)\\s*(?:::\\s*[\\w."]+\\s*)*::\\s*${UUID_T}|CAST\\s*\\(\\s*(?:\\w+\\.)?(?:created_by|approved_by|cancelled_by|processed_by|confirmed_by)\\s+AS\\s+${UUID_T}`, 'i');
const ACT_COL = '(?:created_by|approved_by|cancelled_by|processed_by|confirmed_by)';
/** `col <op> [ANY(]${x}::uuid`, and the reversed `${x}::uuid <op> col`, whatever x is. */
const COMPARE_CAST = new RegExp(`\\b${ACT_COL}\\s*(?:=|<>|!=|IS\\s+(?:NOT\\s+)?DISTINCT\\s+FROM|IN)\\s*(?:ANY\\s*\\(\\s*)?\\(?\\s*(?:\\$\\{[^}]*\\}|\\$\\d+)\\s*(?:::\\s*[\\w."]+(?:\\[\\])?\\s*)*::\\s*${UUID_T}|::\\s*${UUID_T}\\s*(?:=|<>|!=|IS\\s+(?:NOT\\s+)?DISTINCT\\s+FROM)\\s*(?:\\w+\\.)?${ACT_COL}\\b`, 'i');
/** A bare bind of an actor-shaped expression on a line that does not name the column (a VALUES line). */
export const AP_AR_ACTOR_BIND_LINE = /\$\{[^}]*\b(userId|createdBy|actorId|approverUserId|processedBy|approvedBy|editedBy|by|user\.id|actor\.userId)\b[^}]*\}/;
export const isValuesBindLine = (l: string) => AP_AR_ACTOR_BIND_LINE.test(l) && !AP_AR_COLUMN.test(l) && /^\s*(\$\{|['"\w.[]|\))/.test(l);
/**
 * Fail closed: in an AP/AR file that writes an actor column, every uuid-cast bind is refused unless its expression is
 * listed here, verbatim, as a non-actor id (company, invoice, supplier, journal, bank account, dimension row ids).
 */
export const AP_AR_NON_ACTOR_BINDS: ReadonlySet<string> = new Set([
  'String(bankAccount.id)', 'String(bill.id)', 'String(bill.supplier_id)', '[...billIds]', '[...movedLineIds]',
  'alloc.invoiceId', 'bankAccountId', 'bankTxId', 'batchIds', 'batches', 'billId', 'cEntry', 'cLine',
  'claim.bankAccountId', 'claim.journalEntryId', 'companyId', 'created.id', 'creditNoteId', 'customerId',
  'dims.cc1Id ?? null', 'dims?.buId || null', 'dims?.cc1Id || null', 'dims?.cc2Id || null', 'documentId',
  'dupHit.supplierInvoiceId', 'entityId', 'entry.id', 'eventId', 'f.poId', 'f.supplierId', 'filters.clientId',
  'glAccountId', 'grnId', 'id', 'input.clientId', 'input.entityId', 'input.invoiceId', 'input.supplierId',
  'invoice.client_id', 'invoice.id', 'invoice.supplierId', 'invoiceId', 'invoiceIds', 'invoiceTable',
  'item.buId || null', 'item.cc1Id || null', 'item.cc2Id || null', 'item.itemId || null', 'je.id', 'journal.id',
  'journalEntry.id', 'journalEntryId', 'journalId', 'line.buId ?? null', 'line.cc1Id ?? null', 'line.cc2Id ?? null',
  'linkId', 'named', 'p.billId', 'p.invoice_id', 'p.lineWrites.map((l) => l.billLineId)',
  'p.lineWrites.map((l) => l.poItemId)', 'p.poId', 'p.supplierId', 'paymentId', 'plan.clientId', 'poId',
  'r.bankAccountId', 'r.companyId', 'r.customerId', 'r.journalEntryId', 'reversalJournalEntryId', 'ri.client_id',
  'source.id', 'stale.map((l) => String(l.id))', 'supplierId', 'supplierMatch.supplierId', 'template.id',
  'validation.supplierId', 'wo.invoice_id',
]);
/** Every uuid cast on a line that is not a listed non-actor bind (an actor suspect), or a column-side actor cast. */
export function apArCasts(line: string): string[] {
  const hits = [...line.matchAll(BIND_CAST)].map((m) => (m[1] ?? m[2] ?? '').trim()).filter((e) => !AP_AR_NON_ACTOR_BINDS.has(e));
  if (COLUMN_CAST.test(line) || COMPARE_CAST.test(line)) hits.push('<column>');
  return hits;
}

/** Spellings of an actor cast that apArCasts must see (each mutation-proved red on the real code), and clean lines it must pass. */
export const AP_AR_CAST_SPELLINGS: readonly string[] = [
  'approved_by = ${userId}::UUID', 'created_by = ${String(userId)}::UUID', '${createdBy}::uuid, NOW()', 'x = CAST(${userId} AS uuid)',
  'x = CAST(${userId} AS pg_catalog.uuid)', 'x = CAST(${userId} AS "uuid")', '${userId}::pg_catalog.uuid', '${userId}::"uuid"',
  '${userId}::text::uuid', 'created_by <> ${userId}::UUID', 'created_by != ${userId}::uuid', 'created_by IS DISTINCT FROM ${userId}::uuid',
  '${userId}::uuid = approved_by', 'approved_by = ANY(${invoiceIds}::uuid[])', 'WHERE created_by::uuid = $1',
  'WHERE CAST(si.created_by AS uuid) = $1', 'WHERE approved_by::pg_catalog.uuid = $1', 'created_by IN (${companyId}::uuid)',
  'WHERE sp.created_by = $1::uuid', '${companyId}::uuid <> sp.created_by',
];
export const AP_AR_CAST_CLEAN: readonly string[] = [
  'WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID', 'SET approved_by = ${userId}, approved_at = NOW()',
  'WHERE created_by::text = ${userId}', 'WHERE lower(created_by::text) = lower(${userId})',
];
