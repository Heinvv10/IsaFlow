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
  });

  it('the writers of bank_transactions.import_batch_id are exactly these, each beside its batch row', () => {
    expect(filesMatching(/INSERT INTO bank_transactions\s*\([^)]*\bimport_batch_id\b/)).toEqual([
      CLASSIFIED,
      `${B}bankImportService.ts`, // importParsedTransactions (with its batch row); importBankStatement — LEGACY, no batch row, no non-test caller
      `${B}bankStatementOcrService.ts`,
      `${B}feed/bankIngestionPersistence.ts`,
    ].sort());
    expect(filesMatching(/\bimportBankStatement\(/)).toEqual([`${B}bankImportService.ts`]); // the legacy entry point stays uncalled
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
  const IMPORTER = /\b(assertImporterMayAllocate|importerAllocationRefusal|importerRefusalForLineId|importerHeldLineSkips)\(/;
  it('the callers of the hand-keyed gates are these, and each asks the importer check too', () => {
    const DEFINERS = [`src/modules/accounting/services/ap/bankLinePaymentGate.ts`, `${B}bankLineJournalGate.ts`];
    const NO_IMPORT = ['pages/api/accounting/bank-transactions-manual.ts']; // inserts its own hand-keyed line: no batch, no importer
    const callers = filesMatching(HAND_KEYED).filter((f) => !DEFINERS.includes(f));
    expect(callers).toEqual([
      ...NO_IMPORT, `${MCP}bulkAllocationSkip.ts`, `${MCP}writeApplySupplierPayment.ts`,
      'src/modules/accounting/services/ap/provisionalSettlementClaim.ts', `${B}bankAllocationService.ts`,
      `${B}bankRuleAutoPostLine.ts`, 'src/modules/accounting/services/capture/provisionalPostingService.ts',
    ].sort());
    for (const file of callers.filter((f) => !NO_IMPORT.includes(f))) expect(textOf(file), file).toMatch(IMPORTER);
    expect(textOf(`${MCP}writeBankSplit.ts`)).toMatch(IMPORTER); // the split dry run, ahead of the service
  });

  it('one arm mapping: no site but the gate decides supplier_payment vs manual_journal for an importer check', () => {
    for (const file of [`${B}bankRuleAutoPostLine.ts`, `${MCP}bulkAllocationSkip.ts`,
      'src/modules/accounting/services/capture/provisionalPostingService.ts', `${B}bankReversalGate.ts`]) {
      expect(textOf(file), file).toMatch(/\bimporterArmOf\(/);
    }
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
      `${B}bankImportService.ts: sweep(companyId, outflowIds.map((r) => String(r.id)), 'import', systemUser, systemUser)`,
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
