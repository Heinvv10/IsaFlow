/** Wave 7 AAa: the pinned VALUES bind lines of actorIdTextCensus.test.ts (split from apArActorSites.ts for the 300-line cap). */
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
