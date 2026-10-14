/**
 * Bank controls step 2, slice a: the census that keeps importer ≠ allocator
 * (Hein's decision 2) and reversal gating (decision 4) in front of every path.
 * Walks src/ and pages/ on disk with comments stripped; a new writer or caller
 * fails here until it is classified. Behaviour is proven against real Postgres
 * in tests/integration/bank-controls-*.int.test.ts.
 *
 *  1. Every path that gives a bank line an import_batch_id, and every writer of
 *     bank_import_batches, with the channel it records; nothing UPDATEs a batch.
 *  2. Every caller of the hand-keyed gates also asks the importer check — the
 *     same choke points, one arm mapping (importerArmOf).
 *  3. Every sweep entry names the person who triggered it.
 *  4. Every caller of reverseReconciledTransaction and undoRow, and the checks
 *     that stand in front of them.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../../../..');
function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
}
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/.*$/gm, '');
const SOURCES = (() => {
  const files: string[] = [];
  for (const root of ['src', 'pages']) walk(path.join(ROOT, root), files);
  return files.map((f) => ({ file: path.relative(ROOT, f).split(path.sep).join('/'), text: strip(readFileSync(f, 'utf8')) }));
})();
const filesMatching = (re: RegExp) => SOURCES.filter((s) => re.test(s.text)).map((s) => s.file).sort();
const textOf = (file: string) => SOURCES.find((s) => s.file === file)!.text;
const before = (file: string, first: string, then: string) => {
  const t = textOf(file);
  expect(t.indexOf(first), `${file}: ${first}`).toBeGreaterThan(-1);
  expect(t.indexOf(first), `${file}: ${first} before ${then}`).toBeLessThan(t.indexOf(then));
};

const B = 'src/modules/accounting/services/bank/';
const MCP = 'src/lib/mcp/tools/';
const CLASSIFIED = 'pages/api/accounting/bank-transactions-import-classified.ts';
const BULK_COMMIT = 'pages/api/accounting/bank-transactions-bulk-commit.ts';

describe('1. every import path records the importer', () => {
  it('the writers of bank_import_batches, each with its channel', () => {
    const channels: Record<string, RegExp> = {
      [`${B}bankImportService.ts`]: /\$\{options\.importChannel \?\? null\}/, // upload (bulk-commit) and mcp (agent import)
      [`${B}feed/bankIngestionPersistence.ts`]: /'extension'\)/,
      [CLASSIFIED]: /'classified'\)/,
      [`${B}bankStatementOcrService.ts`]: /'statement_ocr',/,
    };
    expect(filesMatching(/INSERT INTO bank_import_batches/)).toEqual(Object.keys(channels).sort());
    for (const [file, channel] of Object.entries(channels)) expect(textOf(file), file).toMatch(channel);
  });

  it('nothing UPDATEs a batch: who imported it, from what file and how is fixed once written (877)', () => {
    expect(filesMatching(/UPDATE\s+bank_import_batches/)).toEqual([]);
    expect(filesMatching(/UPDATE\s+bank_transactions\s+SET[^`;]*\bimport_batch_id\s*=/)).toEqual([]);
    // …nor a line's feed connection: both are fixed at INSERT (877's bank_transaction_batch_fixed — breaker R2-3).
    expect(filesMatching(/UPDATE\s+bank_transactions\s+SET[^`;]*\bbank_feed_connection_id\s*=/)).toEqual([]);
    // …nor DELETEs one: a batch row is its lines' provenance (877 refuses it while a line names it — breaker #684 REPRO 5).
    expect(filesMatching(/DELETE\s+FROM\s+bank_import_batches/)).toEqual([]);
  });

  it('the writers of bank_transactions.import_batch_id are exactly these, each beside its batch row', () => {
    expect(filesMatching(/INSERT INTO bank_transactions\s*\([^)]*\bimport_batch_id\b/)).toEqual([
      CLASSIFIED,
      `${B}bankImportService.ts`, // importParsedTransactions, with its batch row (the legacy importBankStatement is deleted)
      `${B}bankStatementOcrService.ts`,
      `${B}feed/bankIngestionPersistence.ts`,
    ].sort());
    expect(filesMatching(/\bimportBankStatement\b/)).toEqual([]); // the legacy importer (no batch row) is gone
  });

  it('the upload and the MCP import pass the person, the channel and the file hash', () => {
    expect(filesMatching(/\bimportParsedTransactions\(/)).toEqual([BULK_COMMIT, `${B}bankImportService.ts`, `${B}bankStatementImportService.ts`]);
    expect(textOf(BULK_COMMIT)).toMatch(/\.\.\.uploadProvenance\(authReq\.user\?\.id, \{ pdfBase64, csvContent \}\)/);
    expect(textOf(`${B}importProvenance.ts`)).toMatch(/importedBy: userId, importChannel: 'upload', fileSha256: statementFileSha256\(file\)/);
    expect(filesMatching(/\bimportStatementForAgent\(/)).toEqual([`${MCP}writeBankImport.ts`, `${B}bankStatementImportService.ts`]);
    expect(textOf(`${MCP}writeBankImport.ts`)).toMatch(/provenance: \{ importedBy: ctx\.userId, importChannel: 'mcp', fileSha256: statementFileSha256\(\{ csvContent: content \}\) \}/);
    expect(textOf(`${B}bankStatementImportService.ts`)).toMatch(/AND \(import_channel = 'mcp' OR imported_by LIKE 'mcp:%'\)/);
  });
});

describe('2. every hand-keyed gate site also asks the importer check', () => {
  const HAND_KEYED = /\b(assertBankLineMayPostToAccounts|assertBankLineMayPaySupplier|handKeyedLineJournalRefusal|manualLinePaymentRefusal|handKeyedAccountLineSkips)\(/;
  const IMPORTER = /\b(assertImporterMayAllocate|assertImporterMayAllocateAs|importerAllocationRefusal|importerRefusalForLineId|importerHeldLineSkips)\(/;
  it('the callers of the hand-keyed gates are these, and each asks the importer check too', () => {
    const DEFINERS = [`src/modules/accounting/services/ap/bankLinePaymentGate.ts`, `${B}bankLineJournalGate.ts`];
    const NO_IMPORT = ['pages/api/accounting/bank-transactions-manual.ts']; // inserts its own hand-keyed line: no batch, no importer
    const callers = filesMatching(HAND_KEYED).filter((f) => !DEFINERS.includes(f));
    expect(callers).toEqual([
      ...NO_IMPORT, `${MCP}bulkAllocationSkip.ts`, `${MCP}writeApplySupplierPayment.ts`, `${MCP}writeBankSplit.ts`,
      'src/modules/accounting/services/ap/provisionalSettlementClaim.ts', `${B}bankAllocationService.ts`,
      `${B}bankRuleAutoPostLine.ts`, `${B}bankSplitContacts.ts`,
      'src/modules/accounting/services/capture/provisionalPostingService.ts',
    ].sort());
    for (const file of callers.filter((f) => !NO_IMPORT.includes(f))) expect(textOf(file), file).toMatch(IMPORTER);
    // writeBankSplit: the split dry run asks the service's own hand-keyed journal gate (PR #711), and the importer check.
  });

  it('one arm mapping: no site but the gate decides supplier_payment vs manual_journal for an importer check', () => {
    for (const file of [`${B}bankRuleAutoPostLine.ts`, `${MCP}bulkAllocationSkip.ts`,
      'src/modules/accounting/services/capture/provisionalPostingService.ts']) {
      expect(textOf(file), file).toMatch(/\bimporterArmOf\(/);
    }
    // The reversal and match gates read one allocation's arm through allocationFacts, which maps it by importerArmOf.
    expect(textOf(`${B}bankLineImporterGate.ts`)).toMatch(/importerArmOf\(d\.kind, 'document', Number\(line\.amount\)\)/);
    expect(textOf(`${B}bankReversalGate.ts`)).toMatch(/\ballocationFacts\(/);
    expect(textOf(`${B}bankAllocationService.ts`)).toMatch(/\bassertImporterMayAllocateAs\(companyId, tx, userId, allocType, entityId\)/);
  });
});

describe('3. every sweep names the person who triggered it', () => {
  it('each call of the auto-post gate passes triggeredBy, and an import passes its importer', () => {
    const calls = SOURCES.flatMap((s) => [...s.text.matchAll(/\b(?:sweep|gateSweep)\(companyId,[^\n]*/g)]
      .map((m) => `${s.file}: ${m[0]}`)).filter((c) => !c.includes('autoPostGateService.ts')).sort();
    const expected = [
      "pages/api/accounting/smart-categorize.ts: sweep(companyId, categorizedIds, 'categorization', userId, userId)",
      `${B}bankImportService.ts: sweep(companyId, outflowIds.map((r) => String(r.id)), 'import', systemUser, importedBy ?? systemUser)`,
      `${B}llmCategorizationPass.ts: gateSweep(companyId, ids, 'categorization', userId, userId)`,
    ];
    expect(calls).toHaveLength(expected.length);
    for (const call of expected) expect(calls.some((c) => c.startsWith(call)), call).toBe(true);
  });
});

describe('4. every reversal path passes the reversal gate', () => {
  it('the callers of reverseReconciledTransaction', () => {
    const callers = filesMatching(/\breverseReconciledTransaction\(/).filter((f) => f !== `${B}bankAllocationService.ts`);
    expect(callers).toEqual([
      'pages/api/accounting/bank-transactions-action.ts', `${MCP}writeBankAllocate.ts`, `${MCP}writeBankReverseBatch.ts`,
      `${MCP}writeBankReverseRange.ts`, 'src/modules/accounting/services/ap/paymentJournalReversal.ts',
      `${B}autoPostUndoService.ts`, 'src/modules/accounting/services/core/paymentVoidService.ts',
    ].sort());
  });

  it('the choke point decides before any write and audits after; the MCP tools ask first; the screen answers 403', () => {
    const svc = `${B}bankAllocationService.ts`;
    before(svc, 'await assertMayReverse(companyId, tx,', 'reverseDocumentChainLine(companyId, tx,');
    before(svc, 'await assertMayReverse(companyId, tx,', "withSavepoint('bank_reverse_reconciled'");
    for (const tool of ['writeBankAllocate.ts', 'writeBankReverseBatch.ts', 'writeBankReverseRange.ts']) {
      before(`${MCP}${tool}`, 'await agentReversalRefusal(', 'await reverseReconciledTransaction(');
    }
    before(`${MCP}writeBankReverseRange.ts`, 'await agentReversalRefusal(', 'if (dryRun)');
    before('pages/api/accounting/bank-transactions-action.ts', 'respondIfBankControlRefused(res, err)', "badRequest(res, message)");
  });

  it('the callers of undoRow, each judged at the run level first', () => {
    expect(filesMatching(/\bundoRow\(/)).toEqual([`${B}autoPostHandCorrection.ts`, `${B}autoPostUndoService.ts`]);
    before(`${B}autoPostUndoService.ts`, 'await assertMayUndoRun(companyId, runId, userId)', '() => undoRow(companyId, runId, userId, txId)');
    before(`${B}autoPostHandCorrection.ts`, 'await assertMayUndoRun(companyId, runId, userId)', 'await undoRow(companyId, runId, userId, txId)');
  });
});

describe('5. #684 follow-ups: the GL reversal, Dismiss and the match writers', () => {
  const GL = 'src/modules/accounting/services/gl/';
  it('every caller of reverseJournalEntry, classified by whether it can reach a bank allocation\'s journal', () => {
    const CALLERS: Record<string, string> = {
      'pages/api/accounting/journal-entries-action.ts': 'GL reverse of ANY journal: lockJournalCashForGlReversal first (409 under enforcement)',
      [`${MCP}writeJournalReverse.ts`]: 'MCP reverse_journal_entry: lockJournalCashForGlReversal first, dry run included',
      [`${B}bankAllocationService.ts`]: 'the choke point itself (assertMayReverse, audited)',
      [`${B}bankChainLineReversal.ts`]: "the choke point's document arm, called from it only",
      [`${B}autoPostUndoService.ts`]: "undoRow's provisional/hand-reversed arms, behind assertMayUndoRun",
      [`${B}provisionalDismissService.ts`]: 'Dismiss: assertMayReverse per line under the line locks, audited',
      'src/modules/accounting/services/core/paymentVoidService.ts': 'void: a bank-linked payment goes through the choke point',
      'src/modules/accounting/services/ap/batchPaymentReversal.ts': "a batch's own reversal (via the choke point when bank-linked)",
      'src/modules/accounting/services/ap/provisionalSettlementVoid.ts': "R-127 settlement undo: the provisional's reversal judged by assertMayReverse under the line lock, audited",
      'src/modules/accounting/services/ap/supplierInvoiceWorkflowService.ts': "a bill's own journal",
      'src/modules/accounting/services/ap/supplierPaymentWorkflowService.ts': "a payment document's own reversal",
      'src/modules/accounting/services/ar/customerPaymentAllocationService.ts': 'a receipt (money in: ungated)',
      'src/modules/accounting/services/ar/creditNoteCancelService.ts': "a credit note's own journal",
      'src/modules/accounting/services/ar/customerInvoiceCancelService.ts': "an invoice's own journal",
      'src/modules/accounting/services/core/softDeleteJournalService.ts': "an invoice's journal on delete",
      'src/modules/accounting/services/core/migrationWizardOpeningBalanceService.ts': 'opening balances',
      'src/modules/accounting/services/payroll/payrollJournalPostingService.ts': "a pay run's journal",
    };
    const callers = filesMatching(/\breverseJournalEntry\(/).filter((f) => f !== `${GL}journalEntryPostingService.ts`);
    expect(callers).toEqual(Object.keys(CALLERS).sort());
    // The GL entrance locks the chain's lines and judges THAT set (the TOCTOU fix); its locked set rides into the claim.
    before('pages/api/accounting/journal-entries-action.ts', 'const cashLinesLocked = await lockJournalCashForGlReversal(companyId, id)', 'reverseJournalEntry(companyId, id');
    before(`${MCP}writeJournalReverse.ts`, 'cashLinesLocked = await lockJournalCashForGlReversal(ctx.companyId, id)', 'if (args.dry_run === true)');
    before(`${B}bankReversalGate.ts`, 'const locked = await refuseJournalCashOfCompletedReconciliation(companyId, journalEntryId)', "throw new BankControlError('REVERSE_FROM_BANK_LINE'");
    expect(filesMatching(/\brefuseJournalCashOfCompletedReconciliation\(/).sort()).toEqual([`${B}bankReversalGate.ts`, `${B}reconciledCash.ts`]);
    before(`${B}provisionalDismissService.ts`, 'await assertMayReverse(companyId, line, jeId, userId)', 'reverseJournalEntry(companyId, head, userId)');
    before(`${B}provisionalDismissService.ts`, 'await lockBankTransactionsInIdOrder(', 'await assertMayReverse(');
    const settle = 'src/modules/accounting/services/ap/provisionalSettlementVoid.ts';
    before(settle, 'await lockBankTransactionForUpdate(companyId, bankTransactionId)', 'clearance = await assertMayReverse(companyId, tx,');
    before(settle, 'clearance = await assertMayReverse(companyId, tx,', 'UPDATE supplier_payments SET status = \'cancelled\'');
    before(settle, 'reverseJournalEntry(companyId, provisionalHead', 'await auditedReversal(companyId, bankTransactionId, userId, clearance');
  });

  it('every caller of matchTransaction asks the importer first; auto-match skips for the person who ran it', () => {
    expect(filesMatching(/(?<!\.)\bmatchTransaction\(/).filter((f) => !f.endsWith('bankTxStatusMutations.ts')).sort()).toEqual([
      'pages/api/accounting/bank-match-confirm.ts', 'pages/api/accounting/bank-transactions-action.ts', `${B}bankAutoMatchService.ts`,
    ]);
    const confirm = textOf('pages/api/accounting/bank-match-confirm.ts');
    expect(confirm.match(/await assertImporterMayMatch\(companyId, bankTransactionId, candidateId, userId\);\s+await matchTransaction\(/g)).toHaveLength(2);
    before('pages/api/accounting/bank-transactions-action.ts', 'await assertImporterMayMatch(', 'await matchTransaction(');
    // Blind review round 3 (MEDIUM-A): the run's pairs are judged for its person before the loop, skipped and counted.
    before(`${B}bankAutoMatchService.ts`, 'await importerHeldMatchPairs(companyId, triggeredBy,', 'matchTransaction(companyId, match.bankTransactionId');
    expect(textOf(`${B}bankAutoMatchService.ts`)).toMatch(/importerHeld\.has\(match\.bankTransactionId\)\) \{ skippedImporter\+\+; continue; \}/);
    before(`${B}bankAutoMatchService.ts`, 'if (!triggeredBy) throw new Error(', 'await importerHeldMatchPairs('); // fails closed
    // The match gate (explicit and auto) judges the arm and the creator from what the line is matched to (R2-6).
    before(`${B}bankLineImporterGate.ts`, 'const facts = await allocationFacts(companyId, { amount: row.amount, auto_post_run_id: null }, rootId)',
      'return importerAllocationRefusal(companyId, row, actorUserId, facts.arm)');
    const calls = SOURCES.flatMap((x) => [...x.text.matchAll(/\bautoMatchTransactions\(([^)]*)\)/g)].map((m) => `${x.file}: ${m[1]}`))
      .filter((c) => !c.includes('bankAutoMatchService.ts')).sort();
    expect(calls).toEqual([
      'pages/api/accounting/bank-transactions-action.ts: companyId, body.bankAccountId, body.reconciliationId, userId',
      `${MCP}writeBankReconciliation.ts: ctx.companyId, bankAccountId, started.id, ctx.userId`,
    ]);
  });

  it('every document reversal that unmatches a statement line from its journal is judged as the bank reverse is', () => {
    const UNMATCHERS: Record<string, string | null> = {
      [`${B}bankChainLineReversal.ts`]: null, // the choke point's document arm: assertMayReverse already ran
      'src/modules/accounting/services/core/paymentVoidService.ts': null, // a linked line goes through the choke point; one matched since the peek is a retry
      'src/modules/accounting/services/ap/supplierPaymentWorkflowService.ts': 'await lockJournalAndUnmatch(companyId, journalId, leg,',
      'src/modules/accounting/services/ar/customerPaymentAllocationService.ts': 'await lockJournalAndUnmatch(companyId, journalId, leg, label)',
      'src/modules/accounting/services/ap/batchPaymentReversal.ts': 'await reverseBatchWithLeg(companyId, batchId, userId, peekedJournal, leg)',
    };
    expect(filesMatching(/\blockJournalAndUnmatch\(|\breverseBatchWithLeg\(/)
      .filter((f) => !f.endsWith('paymentJournalReversal.ts')).sort()).toEqual(Object.keys(UNMATCHERS).sort());
    for (const [file, write] of Object.entries(UNMATCHERS)) {
      if (write) before(file, 'await assertMayReverseMatchedLeg(', write);
    }
    before('src/modules/accounting/services/core/paymentVoidService.ts', 'await reverseReconciledTransaction(', 'await lockJournalAndUnmatch(');
  });
});

describe('6. every route that can raise a bank-control refusal answers it (blind review #684 MEDIUM-1)', () => {
  const THROWERS = /\b(allocateTransaction|splitAllocateTransaction|reverseReconciledTransaction|dismissProvisionalEntry|undoRun|undoAnyway|approveSupplierInvoice|postSupplierInvoiceToGL|voidSupplierPayment|cancelCustomerPayment|assertImporterMayMatch|lockJournalCashForGlReversal|confirmCustomerMatch|confirmSupplierMatch|attachEvidenceAndSettleApproved|confirmReceiptMatch|applyBankLineToSupplierInvoices|voidPaymentDocument|reverseBatch|assertMayReverseMatchedLeg|voidProvisionalSettlement|voidSettlementDocument|assertMayReverse)\(/;
  const EXEMPT: Record<string, RegExp> = {
    // A per-item answer: the refused id carries its reason, the batch goes on.
    'pages/api/accounting/supplier-invoices-bulk-action.ts': /err instanceof BankControlError \? \{ reason: err\.code \}/,
    // The settle refusal is caught in provisionalAttachSettle: the bill goes back to draft with the reason in its notes.
    'pages/api/accounting/ai-invoice-pipeline.ts': /attachEvidenceAndSettleApproved\(/,
    // Money in: a customer receipt is no gated arm (importerArmOf), so allocateTransaction cannot refuse it here.
    'pages/api/accounting/ar/receipt-match/confirm.ts': /confirmReceiptMatch\(/,
    // Allocates the hand-keyed line it inserts itself: no batch, so no importer to refuse.
    'pages/api/accounting/bank-transactions-manual.ts': /allocateTransaction\(/,
  };
  it('each route calling a service that raises BankControlError maps it with respondIfBankControlRefused, or is classified', () => {
    const routes = SOURCES.filter((x) => x.file.startsWith('pages/api/') && THROWERS.test(x.text)).map((x) => x.file).sort();
    expect(routes.length).toBeGreaterThan(8);
    for (const route of routes) {
      const exempt = EXEMPT[route];
      if (exempt) expect(textOf(route), route).toMatch(exempt);
      else expect(textOf(route), `${route} must answer BankControlError (respondIfBankControlRefused)`).toMatch(/respondIfBankControlRefused\(res, err\)/);
    }
    for (const route of Object.keys(EXEMPT)) expect(routes, `stale exemption ${route}`).toContain(route);
  });
});
