/**
 * R-035 decision Q1: only the importers of documents approved or issued in
 * their source system may exempt a write from an approval backstop — the
 * three bill importers from the supplier-invoice one (migration 712), and the
 * AR take-on, the Sage customer-invoice import and the Sage migration commit
 * from the customer-invoice one (migration 865). The credit-note backstop
 * (migration 862) honours no exemption at all — no importer writes credit
 * notes — so 862 must not name the GUC either. The exemption is a GUC any statement could set,
 * so the control is WHO sets it: this census walks the source tree on disk
 * (not `git ls-files` — an untracked new setter must fail too) and pins every
 * file that names it.
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

function filesMentioning(needle: string): string[] {
  const files: string[] = [];
  for (const root of ROOTS) walk(path.join(ROOT, root), files);
  return files
    .filter((f) => readFileSync(f, 'utf8').includes(needle))
    .map((f) => path.relative(ROOT, f))
    .sort();
}

describe('the approval-gate import exemption', () => {
  it('is set in exactly one place, and read only by the migration 712 and 865 triggers', () => {
    expect(filesMentioning('approval_gate_exempt')).toEqual([
      'scripts/migrations/sql/712_supplier_invoice_approval_enforcement.sql',
      'scripts/migrations/sql/865_customer_invoice_approval_enforcement.sql',
      'src/modules/accounting/services/gl/approvalGateExempt.ts',
    ]);
  });

  it('is called by exactly the Sage imports, the Sage migration commit and the AP and AR take-ons', () => {
    expect(filesMentioning('withApprovalGateExempt(')).toEqual([
      'src/modules/accounting/services/ap/migrationApService.ts',
      'src/modules/accounting/services/core/migrationImportService.ts',
      'src/modules/accounting/services/core/sageCustomerImportService.ts',
      'src/modules/accounting/services/core/sageSupplierInvoiceImportService.ts',
      'src/modules/admin/services/sageMigrationCommitService.ts',
    ]);
  });

  it('exempts a customer invoice only where the importer says so — every customer-invoice write names its type', () => {
    for (const file of [
      'src/modules/accounting/services/core/migrationImportService.ts',
      'src/modules/accounting/services/core/sageCustomerImportService.ts',
      'src/modules/admin/services/sageMigrationCommitService.ts',
    ]) {
      const text = readFileSync(path.join(ROOT, file), 'utf8');
      expect(text, file).toMatch(/withApprovalGateExempt\(\{[^}]*documentType: 'customer_invoice'/);
      expect(text, file).toMatch(/assertMayImportOpenBills\(companyId, userId, 'customer_invoice'\)/);
    }
  });
});
