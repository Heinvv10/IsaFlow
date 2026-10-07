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
  it('is set in exactly one place, and read only by the migration 712, 865 and 867 triggers', () => {
    expect(filesMentioning('approval_gate_exempt')).toEqual([
      'scripts/migrations/sql/712_supplier_invoice_approval_enforcement.sql',
      'scripts/migrations/sql/865_customer_invoice_approval_enforcement.sql',
      'scripts/migrations/sql/867_supplier_payment_approval_enforcement.sql',
      'src/modules/accounting/services/gl/approvalGateExempt.ts',
    ]);
  });

  // R-035 PR5 (Q4, D2): a payment recorded from a bank line records money that
  // has already moved — but only a line from a live feed or an imported
  // statement says so. Exactly three creators may ask, naming the line, and the
  // wrapper reads the line's provenance itself before it sets the GUC.
  it('the bank-feed value is named only by its wrapper and the 867 trigger', () => {
    expect(filesMentioning("'bank_feed'")).toEqual([
      'scripts/migrations/sql/867_supplier_payment_approval_enforcement.sql',
      'src/modules/accounting/services/gl/approvalGateExempt.ts',
    ]);
  });

  it('the bank-feed wrapper is called by exactly the three bank-line payment creators, naming the line, around their INSERT', () => {
    const callers = filesMentioning('withApprovalGateExemptBankFeed(');
    expect(callers).toEqual([
      'src/modules/accounting/services/ap/provisionalInvoiceSettlement.ts',
      'src/modules/accounting/services/ap/supplierAutoAllocate.ts',
      'src/modules/accounting/services/ap/supplierBankPaymentService.ts',
    ]);
    for (const file of callers) {
      const text = readFileSync(path.join(ROOT, file), 'utf8');
      expect(text.match(/withApprovalGateExemptBankFeed\(companyId, [\w.]*bankTxId, \(\) => sql`\s*INSERT INTO supplier_payments \(/g), file).toHaveLength(1);
    }
  });

  it('the wrapper sets the GUC only for a line that is bank evidence', () => {
    const text = readFileSync(path.join(ROOT, 'src/modules/accounting/services/gl/approvalGateExempt.ts'), 'utf8');
    expect(text).toMatch(/if \(!als\.getStore\(\)\?\.client \|\| !\(await bankLineIsEvidenced\(companyId, bankTxId\)\)\) return write\(\);/);
    const gate = readFileSync(path.join(ROOT, 'src/modules/accounting/services/ap/bankLinePaymentGate.ts'), 'utf8');
    expect(gate).toMatch(/return line\.bank_feed_connection_id != null \|\| line\.import_batch_id != null;/);
  });

  // The entry points that would record a supplier payment from a bank line refuse a hand-keyed one first (409).
  it('every entry point that pays a supplier from a bank line checks the line first', () => {
    const at = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');
    expect(at('src/modules/accounting/services/bank/bankAllocationService.ts'))
      .toMatch(/if \(allocType === 'supplier' && entityId && isSpent\) await assertBankLineMayPaySupplier\(companyId, tx, totalAmount\);/);
    expect(at('pages/api/accounting/bank-transactions-manual.ts'))
      .toMatch(/if \(allocationType === 'supplier' && type === 'spend'\) \{\s+const refusal = await manualLinePaymentRefusal\(companyId, numericAmount\);/);
    expect(at('src/modules/accounting/services/bank/bankRuleAutoPostLine.ts'))
      .toMatch(/!isBankEvidenced\(locked\)\s+&& await manualLinePaymentRefusal\(companyId, totalAmount\)\) \{\s+return \{ kind: 'approval_required' \};/);
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
