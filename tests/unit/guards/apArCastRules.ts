/** Wave 7 AAa: the cast detectors and spellings of actorIdTextCensus.test.ts (split from apArActorSites.ts for the 300-line cap). */
export const AP_AR_TABLE = /\b(supplier_invoices|supplier_payments|customer_payments|credit_notes|recurring_invoices|customer_write_offs|accounting_adjustments|supplier_payment_batches|recurring_journals|vat_adjustments)\b/;
export const AP_AR_COLUMN = /\b(created_by|approved_by|cancelled_by|processed_by|confirmed_by)\b/;
/** `${expr}` followed by any `::type` chain ending in uuid (pg_catalog., quoted, uuid[]), or `CAST(${expr} AS uuid)`. */
const UUID_T = '"?(?:pg_catalog\\.)?"?uuid"?(?:\\[\\])?';
const BIND_CAST = new RegExp(`\\$\\{([^}]*)\\}\\s*(?:::\\s*[\\w."]+(?:\\[\\])?\\s*)*::\\s*${UUID_T}|CAST\\s*\\(\\s*\\$\\{([^}]*)\\}\\s+AS\\s+${UUID_T}`, 'gi');
/** `ARRAY[${x}]::uuid[]` and `(${x})::uuid`: a bind wrapped before the cast. */
const WRAPPED_CAST = new RegExp(`(?:ARRAY\\s*\\[\\s*|\\(\\s*)\\$\\{([^}]*)\\}\\s*[\\])]\\s*::\\s*${UUID_T}`, 'gi');
/** An actor column cast to uuid on the column side: `col::uuid`, `CAST(col AS uuid)`. */
const COLUMN_CAST = new RegExp(`\\b(?:created_by|approved_by|cancelled_by|processed_by|confirmed_by)\\s*(?:::\\s*[\\w."]+\\s*)*::\\s*${UUID_T}|CAST\\s*\\(\\s*(?:\\w+\\.)?(?:created_by|approved_by|cancelled_by|processed_by|confirmed_by)\\s+AS\\s+${UUID_T}`, 'i');
const ACT_COL = '(?:created_by|approved_by|cancelled_by|processed_by|confirmed_by)';
/** `col <op> [ANY(]${x}::uuid`, and the reversed `${x}::uuid <op> col`, whatever x is. */
const COMPARE_CAST = new RegExp(`\\b${ACT_COL}\\s*(?:=|<>|!=|IS\\s+(?:NOT\\s+)?DISTINCT\\s+FROM|IN)\\s*(?:ANY\\s*\\(\\s*)?\\(?\\s*(?:\\$\\{[^}]*\\}|\\$\\d+)\\s*(?:::\\s*[\\w."]+(?:\\[\\])?\\s*)*::\\s*${UUID_T}|\\b${ACT_COL}\\s*(?:=|<>|!=|IS\\s+(?:NOT\\s+)?DISTINCT\\s+FROM)\\s*(?:\\([^()]*(?:\\([^()]*\\)[^()]*)*\\)|(?!\\b(?:AND|OR|WHERE|SET|FROM|JOIN|ON)\\b)[^,;()])*?::\\s*${UUID_T}|::\\s*${UUID_T}\\s*(?:=|<>|!=|IS\\s+(?:NOT\\s+)?DISTINCT\\s+FROM)\\s*(?:\\w+\\.)?${ACT_COL}\\b`, 'i');
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
  'glAccountId', 'grnId', 'input.clientId', 'input.entityId', 'input.invoiceId', 'input.supplierId',
  'invoice.client_id', 'invoice.id', 'invoice.supplierId', 'invoiceId', 'invoiceIds', 'invoiceTable',
  'item.buId || null', 'item.cc1Id || null', 'item.cc2Id || null', 'item.itemId || null', 'je.id', 'journal.id',
  'journalEntry.id', 'journalEntryId', 'journalId', 'line.buId ?? null', 'line.cc1Id ?? null', 'line.cc2Id ?? null',
  'linkId', 'p.billId', 'p.invoice_id', 'p.lineWrites.map((l) => l.billLineId)',
  'p.lineWrites.map((l) => l.poItemId)', 'p.poId', 'p.supplierId', 'paymentId', 'plan.clientId', 'poId',
  'r.bankAccountId', 'r.companyId', 'r.customerId', 'r.journalEntryId', 'reversalJournalEntryId', 'ri.client_id',
  'source.id', 'stale.map((l) => String(l.id))', 'supplierId', 'supplierMatch.supplierId', 'template.id',
  'validation.supplierId', 'wo.invoice_id',
]);
/** Generic names that could alias an actor (`const id = userId`): allowed as a uuid bind only in the files that cast them for a row id. */
export const AP_AR_GENERIC_IN_FILE: Readonly<Record<string, ReadonlySet<string>>> = {
  'src/modules/accounting/services/ap/batchPaymentApproval.ts': new Set(['id']),
  'src/modules/accounting/services/ap/batchPaymentService.ts': new Set(['id']),
  'src/modules/accounting/services/ap/billPurchaseOrderLinks.ts': new Set(['named']),
  'src/modules/accounting/services/ap/supplierInvoiceWorkflowService.ts': new Set(['id']),
  'src/modules/accounting/services/ar/creditNoteDraftCancelService.ts': new Set(['id']),
  'src/modules/accounting/services/ar/creditNoteService.ts': new Set(['id']),
  'src/modules/accounting/services/core/recurringTransactionInvoices.ts': new Set(['id']),
  'src/modules/accounting/services/gl/recurringJournalService.ts': new Set(['id']),
};
export const apArNonActorOk = (expr: string, file: string): boolean => AP_AR_NON_ACTOR_BINDS.has(expr) || !!AP_AR_GENERIC_IN_FILE[file]?.has(expr);
/**
 * Every uuid cast in `text` (a whole file, so a cast split over lines is seen) that is not a listed non-actor bind, or
 * a column-side / compare actor cast; each hit is the index of the match (the caller maps it to a line).
 */
export function apArCastHits(text: string, file = ''): number[] {
  const ok = (e: string) => apArNonActorOk(e, file);
  const hits: number[] = [];
  for (const m of text.matchAll(BIND_CAST)) if (!ok((m[1] ?? m[2] ?? '').trim())) hits.push(m.index!);
  for (const m of text.matchAll(WRAPPED_CAST)) if (!ok(m[1]!.trim())) hits.push(m.index!);
  for (const re of [COLUMN_CAST, COMPARE_CAST]) { const g = new RegExp(re.source, 'gi'); for (const m of text.matchAll(g)) hits.push(m.index!); }
  return hits;
}
/** One string: the hits as a count (the spelling tests). */
export const apArCasts = (text: string, file = ''): number[] => apArCastHits(text, file);

/** Spellings of an actor cast that apArCasts must see (each mutation-proved red on the real code), and clean lines it must pass. */
export const AP_AR_CAST_SPELLINGS: readonly string[] = [
  'approved_by = ${userId}::UUID', 'created_by = ${String(userId)}::UUID', '${createdBy}::uuid, NOW()', 'x = CAST(${userId} AS uuid)',
  'x = CAST(${userId} AS pg_catalog.uuid)', 'x = CAST(${userId} AS "uuid")', '${userId}::pg_catalog.uuid', '${userId}::"uuid"',
  '${userId}::text::uuid', 'created_by <> ${userId}::UUID', 'created_by != ${userId}::uuid', 'created_by IS DISTINCT FROM ${userId}::uuid',
  '${userId}::uuid = approved_by', 'approved_by = ANY(${invoiceIds}::uuid[])', 'WHERE created_by::uuid = $1',
  'WHERE CAST(si.created_by AS uuid) = $1', 'WHERE approved_by::pg_catalog.uuid = $1', 'created_by IN (${companyId}::uuid)',
  'WHERE sp.created_by = $1::uuid', '${companyId}::uuid <> sp.created_by', 'approved_by = u.id::uuid', 'ARRAY[${userId}]::uuid[]',
  '(${userId})::uuid', 'approved_by = COALESCE(${userId}, approved_by::text)::uuid', '${userId}\n  ::uuid', 'x = ${id}::UUID', 'CAST(${userId}\n AS uuid)',
];
export const AP_AR_CAST_CLEAN: readonly string[] = [
  'WHERE id = ${invoiceId}::UUID AND company_id = ${companyId}::UUID', 'created_by = ${userId} AND id = ${invoiceId}::UUID', 'SET approved_by = ${userId}, approved_at = NOW()',
  'WHERE created_by::text = ${userId}', 'WHERE lower(created_by::text) = lower(${userId})',
];
