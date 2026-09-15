/**
 * PRD-060 Phase 6: Sage Data Importers
 *
 * Neither importer's body lives here any more; both are re-exported from this
 * module because every caller — sageMigrationService, core/index.ts and the
 * tests — has imported both from here.
 *
 * - Supplier invoices: sageSupplierInvoiceImportService.ts (savepointed
 *   per-record, so one duplicate costs one row rather than the run).
 * - Ledger transactions: sageHistoricalLedgerImport.ts. That path no longer
 *   reads `sage_ledger_transactions` at all — it executes explicitly saved,
 *   independently approved historical-import intents through the controls
 *   kernel, which INSERTs the header at status='draft' with
 *   source='auto_gl_import' and then posts it with `postJournalEntry`. The
 *   INSERT-at-'posted' this file once carried is gone, and the relink guard
 *   in sageLedgerRelinkGuard.ts has nothing left to guard on this path.
 *
 * BL-40: Every SELECT/JOIN/INSERT/UPDATE in both is scoped by company_id to
 * prevent cross-tenant data leaks and silent INSERT failures caused by
 * missing NOT NULL company_id columns.
 */

export { importSupplierInvoices } from './sageSupplierInvoiceImportService';

// Ledger execution is backed by saved actual Sage-column evidence and independent approval.
export { importLedgerTransactions } from './sageHistoricalLedgerImport';
export type { SavedSageLedgerImports } from './sageHistoricalLedgerImport';
