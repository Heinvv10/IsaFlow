/**
 * R-035 PR5: every writer of a supplier payment's or batch's content and
 * status, classified. Money leaves through approveSupplierPayment /
 * processSupplierPayment and approveBatch / processBatch, each of which runs
 * the approval gate under its row lock (and the migration 867 triggers back
 * them); the bank-feed creators record money already moved under the declared
 * exemption (approvalGateExemptCensus); every other creator writes a DRAFT,
 * and every editor of what a payment pays, or where the money goes, stamps
 * itself as an author. A payment's batch_id is set only by the INSERT that
 * creates it: migration 914 refuses every UPDATE of it, so no writer below may
 * move a payment between batches.
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
  it('INSERTs: two draft creators, three bank-line creators (exempt for bank evidence only), a refund, two scripts', () => {
    expect(matching(/INSERT\s+INTO\s+supplier_payments\b/)).toEqual([
      'scripts/import-sage-britech.ts', // raw 'processed'; refused under enforcement (it sets no GUC)
      'scripts/seed-historical-data.mjs', // demo seed; its status is not even a legal one
      `${AP}batchPaymentService.ts`, // createBatch: members as 'draft'
      `${AP}provisionalInvoiceSettlement.ts`, // bank line: exempt only when it is bank evidence (D2)
      `${AP}supplierAutoAllocate.ts`, // bank line: exempt only when it is bank evidence (D2)
      `${AP}supplierBankPaymentService.ts`, // bank line: exempt only when it is bank evidence (D2)
      `${AP}supplierPaymentService.ts`, // createSupplierPayment: column default 'draft'
      `${AP}supplierRefundDocument.ts`, // a refund: money in, passed by content (867)
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
      `${AP}payingAccountAuthors.ts`, // paying-account edit: content_authors only (923)
      `${AP}provisionalSettlementVoid.ts`, // -> cancelled
      `${AP}supplierPaymentApplicationService.ts`, // posted payment: processed -> reconciled
      `${AP}supplierPaymentApproval.ts`, // approveSupplierPayment: draft -> approved, after the gate
      `${AP}supplierPaymentAuthors.ts`, // bank-detail edit: content_authors only
      `${AP}supplierPaymentCancel.ts`, // -> cancelled
      `${AP}supplierPaymentUnapply.ts`, // posted payment: reconciled -> processed
      `${AP}supplierPaymentWorkflowService.ts`, // processSupplierPayment: approved -> processed in its one write, after the gate; void -> cancelled
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
      `${AP}batchPaymentApproval.ts`, `${AP}batchPaymentReversal.ts`, `${AP}batchPaymentService.ts`,
      `${AP}payingAccountAuthors.ts`, // paying-account edit: content_authors only (923)
      `${AP}supplierPaymentAuthors.ts`,
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
      // The take-on import locks every overwritten supplier (and its batches) up front, so its per-row call passes a literal
      // false; updateSupplier decides per write.
      const arg = rel.endsWith('migrationContactService.ts') ? 'false' : 'bankMayChange';
      expect(t, rel).toMatch(new RegExp(String.raw`const before = await lockSupplierBankDetails\(companyId, [\w.]+, ${arg}\);\s+const (rows|\[after\]) = \(await sql\x60\s+UPDATE suppliers SET`));
      expect(t, rel).toMatch(/bankDetailsChange\(before, (rows\[0\]!|after)\)/);
      expect(t, rel).toMatch(/if \(change !== 'none'\) await recordBankDetailsSetter\(companyId, [\w.]+, \w+, change\)/);
    }
  });

  // A literal `false` tells lockSupplierBankDetails no batch need locking first: right only where the caller already
  // locked every batch of every supplier it writes, up front (the take-on import).
  it('a literal false bankMayChange is passed only by the take-on import', () => {
    expect(matching(/lockSupplierBankDetails\(\s*\w+,\s*[\w.]+,\s*false\s*\)/)).toEqual([
      'src/modules/accounting/services/core/migrationContactService.ts',
    ]);
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
    // Only through the helpers: no other file names the column (the payee's, and since 923 the paying account's).
    expect(matching(/bank_details_setters/)).toEqual([
      'src/modules/accounting/services/ap/payingAccountAuthors.ts', 'src/modules/accounting/services/ap/supplierPaymentAuthors.ts',
    ]);
  });

  // Round 1 LOW (b): batch before members, the order approveBatch / processBatch take.
  it('both merges lock the batches of the payments they move before moving them', () => {
    for (const rel of ['pages/api/accounting/supplier-merge.ts', 'src/modules/accounting/services/core/duplicateMergeService.ts']) {
      expect(text(rel), rel).toMatch(/lockBatchesPayingSupplier\(companyId, \w+, null\);[\s\S]{0,400}UPDATE supplier_payments/);
    }
  });
});

// ap/batchBeforeSupplierLock relies on this: a payment joins a batch only by an INSERT naming its supplier, whose
// foreign key takes KEY SHARE on the supplier row, so a held supplier `FOR UPDATE` blocks every way a batch can gain
// that supplier. An UPDATE that attached an existing payment to a batch takes no supplier lock and would reopen the
// supplier-then-batch order against the bank-file gate.
//
// Two layers, neither parsing SQL well enough to be trusted alone. FILE level (the one that cannot be argued with):
// a source file that mentions both `supplier_payments` and `batch_id` must be in the pinned list below, each with the
// reason it may. STATEMENT level, inside those files: any UPDATE on supplier_payments mentioning batch_id must be one of
// the four that only FILTER members by it, pinned whole. NAMED LIMITS: an edit inside an allowlisted file that the
// statement layer misparses (ON CONFLICT DO UPDATE, MERGE, a nested template backtick, a comment between UPDATE and
// the table), a statement assembled from fragments in different files, SQL functions and migrations, and a table or
// column name built at run time are not caught; a
// BEFORE UPDATE OF batch_id trigger would close them (pending Hein's migration decision).
describe('batch membership', () => {
  const TABLE = String.raw`(?:ONLY\s+)?(?:"?\w+"?\.)?"?supplier_payments(?!\w)"?`; // optionally ONLY / schema-qualified / quoted
  const filesWhere = (test: (t: string) => boolean) => files.filter((f) => test(f.text)).map((f) => f.rel).sort();
  const updates = (t: string) => [...t.matchAll(new RegExp(String.raw`UPDATE\s+${TABLE}[^\x60]*`, 'gi'))].map((m) => m[0].replace(/\s+/g, ' ').trim());
  const insertColumns = (t: string) => [...t.matchAll(new RegExp(String.raw`INSERT\s+INTO\s+${TABLE}\s*\(([^)]*)\)`, 'gi'))].map((m) => m[1]!);
  const insertsWithoutColumns = (t: string) => new RegExp(String.raw`INSERT\s+INTO\s+${TABLE}\s*(?!\s*\()\S`, 'i').test(t);

  const READS = 'reads batch_id (a SELECT or filter, or a comment)';
  const PINNED_FILES: Record<string, string> = {
    'scripts/ap-backfill-supplier-payments.ts': 'l.batch_id of its own backfill log, not the payment column',
    'src/lib/mcp/tools/listSupplierPayments.ts': 'maps a read row to the tool output',
    'pages/api/accounting/eft-generate.ts': READS,
    'pages/api/accounting/netcash/submit.ts': READS,
    [`${AP}batchApprovedDigest.ts`]: READS,
    [`${AP}batchBeforeSupplierLock.ts`]: 'the lock helper: reads the batch set, and says why it may',
    [`${AP}batchPaymentApproval.ts`]: 'approveBatch: UPDATE filters members by batch_id (pinned below)',
    [`${AP}batchPaymentMembers.ts`]: READS,
    [`${AP}batchPaymentReversal.ts`]: 'reverseBatch: UPDATE filters members by batch_id (pinned below)',
    [`${AP}batchPaymentService.ts`]: 'createBatch: the ONLY INSERT of batch_id (pinned below); process / cancel filter by it',
    [`${AP}payingAccountAuthors.ts`]: 'locks single payments (batch_id IS NULL); stamping writes content_authors only',
    [`${AP}provisionalSettlementClaim.ts`]: 'bt.import_batch_id (bank_transactions); the substring matches',
    [`${AP}supplierBatchAllocationPlan.ts`]: READS,
    [`${AP}supplierPaymentAuthors.ts`]: 'reads the batch set of a supplier (stamping authors writes content_authors only)',
    [`${AP}supplierPaymentCancel.ts`]: READS,
    [`${AP}supplierPaymentListService.ts`]: READS,
    [`${AP}supplierPaymentRow.ts`]: 'row mapper',
    [`${AP}supplierPaymentUnapply.ts`]: READS,
    'src/modules/accounting/services/bank/bankAllocationService.ts': 'allocation_batch_id (bank_transactions); the substring matches',
    'src/modules/accounting/services/bank/bankChainLineReversal.ts': 'reads a batch label (id::TEXT AS batch_id)',
    'src/modules/accounting/services/bank/reverseLinesCreditLast.ts': 'reads a processed batch\'s members for the range dry run\'s credit check',
    'src/modules/accounting/services/core/costCentreUsageGuard.ts': 'dimension_tag_batches.batch_id, not the payment column',
    'src/modules/accounting/services/gl/approvalDocuments.ts': READS,
    'src/modules/accounting/services/gl/approvalEnforcementPreview.ts': READS,
    'src/modules/accounting/services/gl/approvalMatching.ts': READS,
    'scripts/seed-demo-data.ts': 'offline seed; inserts payments without batch_id (via batchInsert, runtime-built names: named limit); import_batch_id is bank rows',
  };
  it('only the pinned files mention both supplier_payments and batch_id', () => {
    expect(filesWhere((t) => /supplier_payments/i.test(t) && /batch_id/i.test(t))).toEqual(Object.keys(PINNED_FILES).sort());
  });

  it('no UPDATE of supplier_payments mentions batch_id, but the five that only filter members by it', () => {
    const mentioning = files.flatMap((f) => updates(f.text).filter((u) => /batch_id/i.test(u)).map((u) => `${f.rel}: ${u}`)).sort();
    expect(mentioning).toEqual([
      `${AP}batchPaymentApproval.ts: UPDATE supplier_payments SET approved_by = \${userId}::UUID, approved_at = NOW() WHERE batch_id = \${id}::UUID AND company_id = \${companyId}::UUID AND status IS DISTINCT FROM 'cancelled'`,
      `${AP}batchPaymentApproval.ts: UPDATE supplier_payments SET status = 'approved', approved_by = \${userId}::UUID, approved_at = NOW() WHERE batch_id = \${id}::UUID AND company_id = \${companyId}::UUID AND status = 'draft'`,
      `${AP}batchPaymentReversal.ts: UPDATE supplier_payments SET status = 'cancelled', updated_at = NOW() WHERE batch_id = \${batchId}::UUID AND company_id = \${companyId}::UUID AND status = 'processed' RETURNING id`,
      `${AP}batchPaymentService.ts: UPDATE supplier_payments SET status = 'cancelled' WHERE batch_id = \${id}::UUID AND status IN ('draft', 'approved') AND company_id = \${companyId}::UUID`,
      `${AP}batchPaymentService.ts: UPDATE supplier_payments SET status = 'processed' WHERE batch_id = \${id}::UUID AND batch_id IN (SELECT id FROM supplier_payment_batches WHERE company_id = \${companyId}::UUID)`,
    ]);
  });

  // A column-less INSERT ... SELECT / VALUES would set batch_id without naming it, so it could not be counted below.
  it('every INSERT into supplier_payments names its columns', () => {
    expect(filesWhere(insertsWithoutColumns)).toEqual([]);
  });

  it('batch_id is INSERTed only by createBatch, into the batch it just created', () => {
    expect(filesWhere((t) => insertColumns(t).some((c) => /\bbatch_id\b/.test(c)))).toEqual([`${AP}batchPaymentService.ts`]);
  });
});
