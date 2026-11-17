/**
 * The refusal CODES the seven bank routes may answer 400 (audit WP2 row 9, round 2) — an explicit allowlist, not
 * "any code on REFUSAL_CODES".
 *
 * `REFUSAL_CODES` is the set an MCP tool may SHOW an agent; it says nothing about WHEN the refusal is raised. Some of
 * its members are raised after their request wrote (BANK_DIMENSION_SYNC_REFUSED: a bank row changed while the sync
 * ran, "rolled back"), and a new class lands there the moment it is declared. A 400 COMMITs (`withAuth`), so a
 * route that answered the whole set would commit a half-done request the first time one of those reached it.
 *
 * Here the default is the safe one: a code not listed is NOT classified, the route rethrows, the 500 rolls back. The
 * cost of a missing entry is a 500 where a 400 was right (visible, and a test pins each listed route's refusals); the
 * cost of an entry that is not pre-write is a commit — so an entry is added only with the line that raises it shown
 * to run before its route's first write, or inside the savepoint its throw rolls back (`withJournalDateRefusal`).
 * BANK_ALLOCATION_REFUSED and BANK_REQUEST_REFUSED are answered by class (they carry their own status), not here.
 * `bankRouteRefusal.test.ts` fails when a code here leaves `REFUSAL_CODES`, and checks every other member is refused.
 */
export const BANK_ROUTE_PREWRITE_CODES: ReadonlySet<string> = new Set([
  // The bank module's own refusals: a line/session/rule/run that is not there, input, a line already allocated, a feed
  // row not posted, a hand correction, a reallocation, cash on a completed reconciliation, completion refused.
  'BANK_ACCOUNT_GUARD_REFUSED', 'BANK_TX_ALLOCATED',
  'BANK_TX_NOT_POSTED', 'HAND_CORRECTION_REFUSED', 'REALLOCATION_REFUSED', 'RECONCILED_CASH',
  'RECONCILIATION_COMPLETED', 'RECONCILIATION_NOT_BALANCED', 'RECONCILIATION_REVIEW_REQUIRED',
  // Forensic controls on allocate / reverse (bankControlRefusal): decided from the locked row before any write.
  'AGENT_FORBIDDEN', 'ALLOCATOR_MAY_NOT_REVERSE', 'IMPORTER_MAY_NOT_ALLOCATE', 'REVERSE_FROM_BANK_LINE',
  // A supplier / customer line: the contact, the payment / receipt / refund gates (all before the document or journal).
  'SUPPLIER_NOT_FOUND', 'CUSTOMER_NOT_FOUND', 'SUPPLIER_PAYMENT_REFUSED', 'SUPPLIER_REFUND_REFUSED',
  'RECEIPT_REFUSED', 'FOREIGN_CURRENCY_SETTLEMENT',
  // The posting guards a bank journal meets before createJournalEntry inserts: dimensions, accounts, the date window,
  // a locked VAT period, a period that cannot be generated, a reversal dated before its original, a share with live
  // undos, a manual-journal approval, a login-as session.
  'DIMENSION_REFUSED', 'DOCUMENT_LINE_ACCOUNT_REFUSED', 'HEADER_ACCOUNT_REFUSED', 'JOURNAL_DATE_REFUSED',
  'VAT_PERIOD_LOCKED', 'FISCAL_PERIOD_NOT_GENERATED', 'REVERSAL_BEFORE_ORIGINAL', 'SHARE_HAS_LIVE_UNDOS',
  'APPROVAL_REQUIRED', 'RULE_AUTHORITY_REQUIRED', 'IMPERSONATION_FORBIDDEN',
]);
