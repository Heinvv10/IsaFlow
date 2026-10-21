/**
 * R-035 PR4: every way a customer invoice comes into existence or gets
 * approved, classified. An invoice enters the AR population through
 * approveCustomerInvoice, which runs the approval gate under its row lock (and
 * the migration 865 trigger backs it); the importers enter it directly under
 * the declared exemption (approvalGateExemptCensus); every other writer must
 * write a DRAFT.
 *
 * A new INSERT site or a new caller of approveCustomerInvoice fails this
 * census until it is classified here. Offline scripts are pinned too: they
 * write as the owner role, which the trigger still holds to enforcement.
 *
 * Walks the source tree on disk, not `git ls-files`, as approvalGateExemptCensus
 * does: an untracked new writer must fail too.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../../../..');
const ROOTS = ['src', 'pages', 'scripts', 'lib'];
const SOURCE = /\.(ts|tsx|js|mjs|cjs|sql)$/;

function walk(dir: string, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (SOURCE.test(entry.name)) out.push(full);
  }
}

const files = (() => {
  const all: string[] = [];
  for (const root of ROOTS) walk(path.join(ROOT, root), all);
  return all.map((f) => ({ rel: path.relative(ROOT, f), text: readFileSync(f, 'utf8') }));
})();

const matching = (pattern: RegExp) => files.filter((f) => pattern.test(f.text)).map((f) => f.rel).sort();
const text = (rel: string) => files.find((f) => f.rel === rel)!.text;

/** The column list and VALUES of the first customer_invoices INSERT in a file. */
const insertOf = (rel: string) => {
  const t = text(rel);
  const at = t.search(/INSERT\s+INTO\s+customer_invoices/i);
  return t.slice(at, t.indexOf('RETURNING', at));
};

describe('customer-invoice writers', () => {
  const DRAFTS: string[] = [
    'pages/api/accounting/time-entries-invoice.ts', // billing time entries
    'src/modules/accounting/services/ar/customerInvoiceCreateService.ts', // the create route and MCP create_draft_invoice
    'src/modules/accounting/services/ar/quoteConvertService.ts', // quote → invoice
    'src/modules/accounting/services/ar/recurringInvoiceRun.ts', // then gated or held (unattended)
    'src/modules/accounting/services/ar/salesOrderWorkflowService.ts', // sales order → invoice
    'src/modules/accounting/services/core/recurringTransactionInvoices.ts', // then gated or held (unattended)
    'src/modules/accounting/services/practice/practiceWipService.ts', // WIP billing
  ];
  const IMPORTERS: string[] = [
    'src/modules/accounting/services/core/migrationImportService.ts', // AR take-on
    'src/modules/accounting/services/core/sageCustomerImportService.ts', // Sage staging import
    'src/modules/admin/services/sageMigrationCommitService.ts', // Sage migration commit
  ];
  const OFFLINE: string[] = [
    'scripts/import-sage-britech.ts',
    'scripts/migrations/sql/251_demo_seed_data.sql',
    'scripts/qa-seed/transactions.ts',
    'scripts/seed-historical-data.mjs',
  ];

  it('INSERT an invoice in exactly the classified places', () => {
    expect(matching(/INSERT\s+INTO\s+(public\.)?customer_invoices\b/i)).toEqual([...DRAFTS, ...IMPORTERS, ...OFFLINE].sort());
  });

  it('every in-app creator writes a draft', () => {
    for (const rel of DRAFTS) expect(insertOf(rel), rel).toMatch(/'draft'/);
    for (const rel of DRAFTS) expect(insertOf(rel), rel).not.toMatch(/'(approved|sent|paid|partially_paid|overdue)'/);
  });

  it('every importer writes under the exemption, with its rank check named for customer invoices', () => {
    for (const rel of IMPORTERS) {
      expect(text(rel), rel).toMatch(/withApprovalGateExempt\(\{[^}]*documentType: 'customer_invoice'[^}]*\}, \(\) => sql`\s*INSERT INTO customer_invoices/);
    }
  });

  it('approveCustomerInvoice — the gated posting path — is called by exactly the classified callers', () => {
    expect(matching(/\bapproveCustomerInvoice\(/)).toEqual([
      'pages/api/accounting/customer-invoices-detail.ts', // POST approve: 409 via respondIfApprovalRequired
      'scripts/sandbox/reviewerSandboxBooks.ts', // the fictional reviewer sandbox seed (docs/mcp/REVIEWER-SANDBOX.md)
      'src/lib/mcp/tools/writeBulkFinalizeInvoices.ts', // bulk: pre-read skip + racedReason approval_required
      'src/lib/mcp/tools/writeInvoices.ts', // finalize_invoice: pre-read refusal (Q6)
      'src/modules/accounting/services/ar/customerInvoiceApprovalService.ts', // the definition: assertApprovalCleared under the lock
      'src/modules/accounting/services/ar/recurringInvoiceRun.ts', // only when the gate clears; else held
      'src/modules/accounting/services/core/recurringTransactionInvoices.ts', // autoPost: only when the gate clears; else held
    ]);
    expect(text('src/modules/accounting/services/ar/customerInvoiceApprovalService.ts'))
      .toMatch(/assertApprovalCleared\(companyId, 'customer_invoice', invoiceId\)/);
  });
});
