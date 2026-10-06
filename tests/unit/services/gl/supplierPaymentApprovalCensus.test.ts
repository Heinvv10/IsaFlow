/**
 * R-035 PR5: every writer of a supplier payment's or batch's content and
 * status, classified. Money leaves through approveSupplierPayment /
 * processSupplierPayment and approveBatch / processBatch, each of which runs
 * the approval gate under its row lock (and the migration 867 triggers back
 * them); the bank-feed creators record money already moved under the declared
 * exemption (approvalGateExemptCensus); every other creator writes a DRAFT,
 * and every editor of what a payment pays, or where the money goes, stamps
 * itself as an author.
 *
 * A new INSERT, UPDATE or caller fails this census until it is classified
 * here. Walks the tree on disk, as approvalGateExemptCensus does.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../../../..');
const ROOTS = ['src', 'pages', 'scripts', 'lib'];
const SOURCE = /\.(ts|tsx|js|mjs|cjs)$/;

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
const AP = 'src/modules/accounting/services/ap/';

describe('supplier-payment writers', () => {
  it('INSERTs: two draft creators, the four bank-feed creators (exempt), two offline scripts', () => {
    expect(matching(/INSERT\s+INTO\s+supplier_payments\b/)).toEqual([
      'scripts/import-sage-britech.ts', // raw 'processed'; refused under enforcement (it sets no GUC)
      'scripts/seed-historical-data.mjs', // demo seed; its status is not even a legal one
      `${AP}batchPaymentService.ts`, // createBatch: members as 'draft'
      `${AP}provisionalInvoiceSettlement.ts`, // bank-feed
      `${AP}supplierAutoAllocate.ts`, // bank-feed
      `${AP}supplierBankPaymentService.ts`, // bank-feed
      `${AP}supplierPaymentService.ts`, // createSupplierPayment: column default 'draft'
      `${AP}supplierRefundDocument.ts`, // bank-feed
    ]);
    const createInsert = text(`${AP}supplierPaymentService.ts`).match(/INSERT INTO supplier_payments \([^)]*\)/)![0];
    expect(createInsert).not.toMatch(/status/);
    expect(text(`${AP}batchPaymentService.ts`)).toMatch(/\$\{paymentMethod\}, 'draft', \$\{id\}::UUID/);
  });

  it('UPDATEs, each classified', () => {
    expect(matching(/UPDATE\s+supplier_payments\b/)).toEqual([
      'pages/api/accounting/supplier-merge.ts', // re-points supplier_id: stamps (below)
      `${AP}batchPaymentApproval.ts`, // approveBatch: members draft -> approved, after the gate
      `${AP}batchPaymentReversal.ts`, // processed batch -> cancelled members
      `${AP}batchPaymentService.ts`, // processBatch: members -> processed, after the gate; cancelBatch
      `${AP}provisionalSettlementVoid.ts`, // -> cancelled
      `${AP}supplierPaymentApplicationService.ts`, // posted payment: processed -> reconciled
      `${AP}supplierPaymentApproval.ts`, // approveSupplierPayment: draft -> approved, after the gate
      `${AP}supplierPaymentAuthors.ts`, // bank-detail edit: content_authors only
      `${AP}supplierPaymentCancel.ts`, // -> cancelled
      `${AP}supplierPaymentUnapply.ts`, // posted payment: reconciled -> processed
      `${AP}supplierPaymentWorkflowService.ts`, // processSupplierPayment claim, after the gate; void -> cancelled
      'src/modules/accounting/services/bank/bankAllocationUnwind.ts', // -> cancelled
      'src/modules/accounting/services/core/duplicateMergeService.ts', // re-points supplier_id: stamps (below)
    ]);
  });

  it("only the four instruction paths move a payment INTO 'approved' or 'processed'", () => {
    expect(matching(/UPDATE\s+supplier_payments\s+SET\s+status\s*=\s*'(approved|processed)'/)).toEqual([
      `${AP}batchPaymentApproval.ts`,
      `${AP}batchPaymentService.ts`,
      `${AP}supplierPaymentApproval.ts`,
      `${AP}supplierPaymentWorkflowService.ts`,
    ]);
  });

  it('a merge that re-points a payment stamps the merging user onto it and its batch', () => {
    const merges = matching(/UPDATE\s+supplier_payments\s+SET\s+supplier_id/);
    expect(merges).toEqual(['pages/api/accounting/supplier-merge.ts', 'src/modules/accounting/services/core/duplicateMergeService.ts']);
    for (const rel of merges) {
      expect(text(rel), rel).toMatch(/UPDATE\s+supplier_payments\s+SET\s+supplier_id = [^,]+,\s+content_authors = approval_add_author\(content_authors/);
      expect(text(rel), rel).toMatch(/stampBatchesOfMovedPayments\(companyId, /);
    }
  });

  it('allocations are written only at creation and to posted payments', () => {
    expect(matching(/(INSERT\s+INTO|DELETE\s+FROM|UPDATE)\s+payment_allocations\b/)).toEqual([
      'scripts/seed-demo-data.ts',
      `${AP}batchPaymentService.ts`, // createBatch
      `${AP}supplierPaymentApplicationService.ts`, // posted payments only (refuses draft / approved)
      `${AP}supplierPaymentService.ts`, // createSupplierPayment
      `${AP}supplierPaymentUnapply.ts`, // posted payments only
      'src/modules/accounting/services/bank/bankAllocationUnwind.ts', // a bank-feed payment's unwind
    ]);
  });
});

describe('batch writers', () => {
  it('one creator; status moves only through approve / process (gated), cancel and reverse', () => {
    expect(matching(/INSERT\s+INTO\s+supplier_payment_batches/)).toEqual([`${AP}batchPaymentService.ts`]);
    expect(matching(/UPDATE\s+supplier_payment_batches/)).toEqual([
      `${AP}batchPaymentApproval.ts`, `${AP}batchPaymentReversal.ts`, `${AP}batchPaymentService.ts`, `${AP}supplierPaymentAuthors.ts`,
    ]);
  });
});

describe('who reaches the four choke points', () => {
  it('the two action routes and MCP settle_by_contra, nobody else', () => {
    expect(matching(/\b(approveSupplierPayment|processSupplierPayment|approveBatch|processBatch)\(/)).toEqual([
      'pages/api/accounting/batch-payments-action.ts',
      'pages/api/accounting/supplier-payments-action.ts',
      'src/lib/mcp/tools/writeSettleByContra.ts',
      `${AP}batchPaymentApproval.ts`, // the definition
      `${AP}batchPaymentService.ts`, // the definition
      `${AP}supplierPaymentApproval.ts`, // the definition
      `${AP}supplierPaymentWorkflowService.ts`, // the definition
    ]);
  });

  it('each choke point consults the gate', () => {
    expect(text(`${AP}supplierPaymentApproval.ts`)).toMatch(/await assertPaymentApprovalCleared\(companyId, payment\);\s+const rows/);
    expect(text(`${AP}supplierPaymentWorkflowService.ts`)).toMatch(/await assertPaymentApprovalCleared\(companyId, payment\);/);
    expect(text(`${AP}batchPaymentApproval.ts`)).toMatch(/await assertApprovalCleared\(companyId, 'payment_batch', id\);/);
    expect(text(`${AP}batchPaymentService.ts`)).toMatch(/await assertApprovalCleared\(companyId, 'payment_batch', id\);/);
  });
});

describe('who changes where the money goes', () => {
  // Round 1 (blind MEDIUM 2): the change is judged against the row as LOCKED,
  // read before the UPDATE, and the setters list is append-only.
  it('every UPDATE of a supplier bank column locks the row first and records its setter', () => {
    const editors = matching(/UPDATE\s+suppliers\s+SET[\s\S]{0,1500}?bank_account_number\s*=/);
    expect(editors).toEqual([
      'src/modules/accounting/services/core/migrationContactService.ts',
      'src/modules/accounting/services/core/supplierWriteService.ts',
    ]);
    for (const rel of editors) {
      const t = text(rel);
      expect(t, rel).toMatch(/const before = await lockSupplierBankDetails\(companyId, [\w.]+\);\s+const (rows|\[after\]) = \(await sql`\s+UPDATE suppliers SET/);
      expect(t, rel).toMatch(/bankDetailsChange\(before, (rows\[0\]!|after)\)/);
      expect(t, rel).toMatch(/if \(change !== 'none'\) await recordBankDetailsSetter\(companyId, [\w.]+, \w+, change\)/);
    }
  });

  // Decision (b): a supplier CREATED with bank details records its creator as their setter.
  it('every INSERT of a supplier carrying bank columns records the creator as setter', () => {
    const creators = matching(/INSERT\s+INTO\s+suppliers\s*\([^)]*bank_account_number/);
    expect(creators).toEqual([
      'src/modules/accounting/services/core/migrationContactService.ts',
      'src/modules/accounting/services/core/supplierWriteService.ts',
    ]);
    for (const rel of creators) {
      expect(text(rel), rel).toMatch(/hasBankDetails\(\w+(\[0\]!)?\)\) await recordBankDetailsSetter\(companyId, .*, 'repointed'\);/);
    }
    // Only through the helper: no other file names the column.
    expect(matching(/bank_details_setters/)).toEqual(['src/modules/accounting/services/ap/supplierPaymentAuthors.ts']);
  });

  // Round 1 LOW (b): batch before members, the order approveBatch / processBatch take.
  it('both merges lock the batches of the payments they move before moving them', () => {
    for (const rel of ['pages/api/accounting/supplier-merge.ts', 'src/modules/accounting/services/core/duplicateMergeService.ts']) {
      expect(text(rel), rel).toMatch(/lockBatchesPayingSupplier\(companyId, \w+, null\);[\s\S]{0,400}UPDATE supplier_payments/);
    }
  });
});
