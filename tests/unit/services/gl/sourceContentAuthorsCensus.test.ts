/**
 * R-035 PR4 round 2 (Hein, 2026-10-06: whoever sets the price upstream is an
 * author): every writer of the content a customer invoice is CONVERTED from —
 * quotes and their lines, sales orders and their items, time entries (and
 * their copies) — classified. A writer that changes what the source bills on a document that
 * may still be converted stamps the editor into content_authors (read by
 * approval_document_authors, migration 865); every other write is creation
 * (the creator is created_by), a status / link move, or a column the invoice
 * never reads. A new writer fails this census until it is classified here.
 *
 * Walks the source tree on disk (approvalGateExemptCensus's reasons).
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../../../..');
const ROOTS = ['src', 'pages', 'lib'];

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
    else if (/\.(ts|tsx|js|mjs|cjs|sql)$/.test(entry.name)) out.push(full);
  }
}

const files = (() => {
  const all: string[] = [];
  for (const root of ROOTS) walk(path.join(ROOT, root), all);
  return all.map((f) => ({ rel: path.relative(ROOT, f), text: readFileSync(f, 'utf8') }));
})();
const writers = (table: string) => files
  .filter((f) => new RegExp(`(UPDATE|INSERT INTO|DELETE FROM)\\s+(public\\.)?${table}\\b`).test(f.text))
  .map((f) => f.rel).sort();
const text = (rel: string) => files.find((f) => f.rel === rel)!.text;

const STAMPS = {
  'src/modules/accounting/services/ar/sourceContentEditor.ts': 'the quote and sales-order draft edits: stamps when the fingerprint moved',
  'src/modules/accounting/services/ar/customerMergeService.ts': 'merge: re-points a quote/order customer — stamps the merging user',
  'src/modules/accounting/services/core/timeTrackingService.ts': 'time-entries PUT: stamps on a rate, billable or someone-else\'s-hours change',
  'src/modules/accounting/services/practice/practiceTimeEntryService.ts': 'practice timesheet edit: stamps when the resolved rate or billable flag changes',
};

describe('writers of the content an invoice is converted from', () => {
  it('quotes and their lines', () => {
    expect(writers('customer_quotes')).toEqual([
      'src/modules/accounting/services/ar/customerMergeService.ts', // client re-point: stamped
      'src/modules/accounting/services/ar/quoteConvertService.ts', // status + link claims only
      'src/modules/accounting/services/ar/quoteService.ts', // create (created_by); updateQuote inside withSourceEditorStamp; status (terminal once converted)
      'src/modules/accounting/services/ar/sourceContentEditor.ts', // the stamp
    ]);
    expect(writers('customer_quote_lines')).toEqual(['src/modules/accounting/services/ar/quoteService.ts']);
    expect(text('src/modules/accounting/services/ar/quoteService.ts'))
      .toMatch(/withSourceEditorStamp\(companyId, \{ kind: 'quote', id \}, editedBy/);
    expect(text('src/modules/accounting/services/ar/quoteService.ts')).toMatch(/status NOT IN \('converted', 'converted_to_order'\)/);
  });

  it('sales orders and their items', () => {
    expect(writers('customer_sales_orders')).toEqual([
      'src/modules/accounting/services/ar/customerMergeService.ts', // customer re-point: stamped
      'src/modules/accounting/services/ar/quoteConvertService.ts', // create from a quote (creator = created_by; quote via quote_id)
      'src/modules/accounting/services/ar/salesOrderEditService.ts', // draft edit inside withSourceEditorStamp
      'src/modules/accounting/services/ar/salesOrderService.ts', // create, delete (draft)
      'src/modules/accounting/services/ar/salesOrderWorkflowService.ts', // confirm / invoice claims + link: status only
      'src/modules/accounting/services/ar/sourceContentEditor.ts', // the stamp
    ]);
    expect(writers('customer_sales_order_items')).toEqual([
      'src/modules/accounting/services/ar/quoteConvertService.ts', // create
      'src/modules/accounting/services/ar/salesOrderEditService.ts', // draft edit (stamped)
      'src/modules/accounting/services/ar/salesOrderService.ts', // create
      'src/modules/accounting/services/core/duplicateMergeService.ts', // item_id only: never copied onto an invoice
    ]);
    expect(text('src/modules/accounting/services/ar/salesOrderEditService.ts'))
      .toMatch(/withSourceEditorStamp\(companyId, \{ kind: 'sales_order', id \}, editedBy/);
  });

  it('time entries', () => {
    expect(writers('time_entries')).toEqual([
      'pages/api/accounting/time-entries-invoice.ts', // billing claim: status + link
      'src/modules/accounting/services/ar/customerMergeService.ts', // customer_id: not the price
      'src/modules/accounting/services/core/timeTrackingService.ts', // create (stamps a logger who types a rate); edit (stamped); submit/approve: status
      'src/modules/accounting/services/practice/practiceTimeEntryService.ts', // create; timesheet edit (stamped)
      'src/modules/accounting/services/practice/practiceTimeEntryWorkflow.ts', // duplicate (stamps a copier of someone else's entry); submit / approve / bill / write off: status + link
      'src/modules/accounting/services/reports/timeTrackingReportService.ts', // markAsInvoiced: status + link
    ]);
    // Bulk-from-template creates under the CALLER's own name (createPracticeEntry):
    // effort. The duplicate copies the SOURCE's logger, so a copier of someone
    // else's entry is its author (round 4, REPRO F) — the route passes the caller;
    // either way the copy keeps the source's authors (round 5, REPRO G).
    const workflow = text('src/modules/accounting/services/practice/practiceTimeEntryWorkflow.ts');
    expect(workflow).toMatch(/const srcAuthors = \(src\.content_authors \?\? \[\]\) as string\[\];/);
    expect(workflow).toMatch(
      /CASE WHEN \$\{copiedBy\}::UUID IS DISTINCT FROM \$\{String\(src\.user_id\)\}::UUID\s+THEN approval_add_author\(\$\{srcAuthors\}::UUID\[\], \$\{copiedBy\}::UUID\) ELSE \$\{srcAuthors\}::UUID\[\] END/);
    expect(text('pages/api/accounting/practice/time-entries/duplicate.ts'))
      .toMatch(/duplicatePracticeEntry\(companyId, id, newDate, req\.user\.id\)/);
  });

  it('every stamping writer goes through approval_add_author with the acting user', () => {
    for (const [rel, why] of Object.entries(STAMPS)) {
      expect(text(rel), `${rel}: ${why}`).toMatch(/approval_add_author\(content_authors, \$\{(editedBy|by)\}::UUID\)/);
    }
  });
});
