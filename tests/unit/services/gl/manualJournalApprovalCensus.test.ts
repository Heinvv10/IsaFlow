/**
 * R-035 PR6: the census of what posts a journal, and which of it the
 * manual-journal gate governs (Hein, 2026-10-06, decision 2: the human-composed
 * paths only).
 *
 * postJournalEntry is the primitive behind every posting and stays ungated, so
 * the control is WHO calls it. Every source file that calls it is classified
 * here — gated (and how), or exempt (and why); a new caller fails this test
 * until someone classifies it. Walked on DISK (not `git ls-files`), so an
 * untracked new caller fails too; comments are stripped first.
 *
 * Also pinned: the files that insert a journal header directly, the only
 * writers of a journal's LINES after creation (the draft-edit census — there is
 * no draft-journal edit route), and the only writers of the 869 marker and of a
 * journal's content_authors.
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
  return files.map((f) => ({ file: path.relative(ROOT, f), text: strip(readFileSync(f, 'utf8')) }));
})();
const count = (text: string, re: RegExp) => (text.match(re) ?? []).length;
const filesMatching = (re: RegExp) => SOURCES.filter((s) => re.test(s.text)).map((s) => s.file).sort();
const textOf = (file: string) => SOURCES.find((s) => s.file === file)!.text;

const A = 'src/modules/accounting/services/';
const GATED: Record<string, string> = {
  'pages/api/accounting/journal-entries-action.ts': 'UI post: gateManualJournalPost under the row lock, then mark + post',
  'src/lib/mcp/tools/writeJournals.ts': 'MCP post_journal: refused from a pre-read under the lock (Q6), then mark + post',
  'pages/api/accounting/receipt-to-journal.ts': 'receipt autoPost: decided before the claim, held as draft + request',
  [`${A}gl/glImportExecuteService.ts`]: 'GL import post-immediately: held as draft + request per journal',
  [`${A}gl/reclassification/post.ts`]: 'reclassification: MCP refuses up front; every journal marked under enforcement',
  [`${A}gl/recurringJournalService.ts`]: 'recurring journal run: held as draft + request, schedule advances',
  [`${A}core/recurringTransactionService.ts`]: 'recurring-transaction journal autoPost: held as draft + request',
};
const EXEMPT: Record<string, string> = {
  [`${A}gl/journalEntryPostService.ts`]: 'the primitive itself: re-enters for the s16(3) companion of a journal already gated',
  [`${A}gl/journalEntryPostingService.ts`]: 'reversal of a posted journal: not in decision 2 (follow-up for Hein)',
  [`${A}gl/closeRun/closeRunService.ts`]: 'close-run: "Not gated" per the PR6 spec — PENDING Hein: it posts any draft a person approves',
  'src/lib/mcp/tools/writeOpeningBalance.ts': 'opening balances: an import (Q1), decision 2',
  [`${A}gl/openingBalancePostingService.ts`]: 'opening balances (writes source manual): decision 2',
  [`${A}core/migrationOpeningBalanceService.ts`]: 'migration opening balances: import (Q1)',
  [`${A}core/migrationWizardOpeningBalanceService.ts`]: 'migration wizard opening balances: import (Q1)',
  [`${A}core/migrationImportService.ts`]: 'migration import: Q1',
  [`${A}core/sageImportService.ts`]: 'Sage import: Q1',
  [`${A}ap/migrationApService.ts`]: 'AP take-on: Q1',
  [`${A}ap/batchPaymentService.ts`]: 'payment batch posting: a gated document (payment_batch, PR5)',
  [`${A}ap/provisionalInvoiceSettlement.ts`]: 'bank-feed settlement of a bill: Q4 / system',
  [`${A}ap/supplierInvoiceWorkflowService.ts`]: 'supplier invoice posting: a gated document (PR2)',
  [`${A}ap/supplierPaymentWorkflowService.ts`]: 'supplier payment posting: a gated document (PR5)',
  [`${A}ar/creditNoteApproveService.ts`]: 'credit note posting: a gated document (PR3)',
  [`${A}ar/customerInvoiceGlPosting.ts`]: 'customer invoice posting: a gated document (PR4)',
  [`${A}ar/customerPaymentAllocationService.ts`]: 'customer receipt: money in (PR5 out of scope)',
  [`${A}ar/gatewayFeeService.ts`]: 'Paystack gateway fee: system journal of a receipt',
  [`${A}ar/writeOffService.ts`]: 'write-off: system journal of an invoice',
  [`${A}bank/bankAllocationService.ts`]: 'bank allocation: system journal of a bank line',
  [`${A}bank/bankReconciliationService.ts`]: 'bank reconciliation adjustment: system journal',
  [`${A}bank/bankRuleAutoPostLine.ts`]: 'bank auto-post sweep: decision 2',
  [`${A}capture/pettyCashJournalService.ts`]: 'petty cash capture: document posting',
  [`${A}capture/provisionalPostingService.ts`]: 'provisional capture posting: document posting',
  [`${A}expense/expenseClaimService.ts`]: 'expense claim posting: document posting',
  [`${A}gl/glCrossModuleHooks.ts`]: 'cross-module document hooks: system journals',
  [`${A}items/adjustmentService.ts`]: 'stock adjustment: document posting',
  [`${A}loans/loanGlPostingService.ts`]: 'loan posting: system journal',
  [`${A}loans/loanPaymentService.ts`]: 'loan payment: system journal',
  [`${A}loans/loanPeriodCloseService.ts`]: 'loan period close: system journal',
  [`${A}payroll/payrollJournalPostingService.ts`]: 'payroll: decision 2',
  [`${A}payroll/taxDirectivePaymentService.ts`]: 'payroll tax directive: system journal',
  [`${A}payroll/uifPaymentService.ts`]: 'payroll UIF: system journal',
  [`${A}reports/drcVatService.ts`]: 'DRC VAT: decision 2 (VAT)',
  [`${A}reports/vatAdjustmentService.ts`]: 'VAT adjustment: decision 2 (VAT)',
  [`${A}reports/vatSubmissionService.ts`]: 'VAT submission: decision 2 (VAT)',
};

describe('the callers of postJournalEntry', () => {
  it('are each classified gated or exempt, and nothing else calls it', () => {
    const callers = filesMatching(/(?<!function )\bpostJournalEntry\(/);
    expect(callers).toEqual(Object.keys({ ...GATED, ...EXEMPT }).sort());
    const calls = SOURCES.reduce((n, s) => n + count(s.text, /(?<!function )\bpostJournalEntry\(/g), 0);
    expect(calls).toBe(46);
  });

  it('every gated path consults the gate before it posts', () => {
    const before = (file: string, gate: string, post: string) => {
      const text = textOf(file);
      expect(text.indexOf(gate), `${file}: ${gate}`).toBeGreaterThan(-1);
      expect(text.indexOf(gate), `${file}: ${gate} before ${post}`).toBeLessThan(text.lastIndexOf(post));
    };
    before('pages/api/accounting/journal-entries-action.ts', 'gateManualJournalPost(', 'postJournalEntry(');
    before('src/lib/mcp/tools/writeJournals.ts', 'agentManualJournalRefusal(', 'postJournalEntry(');
    before('pages/api/accounting/receipt-to-journal.ts', 'newManualJournalGate(', 'claimCapturedDocumentForPosting(');
    before('pages/api/accounting/receipt-to-journal.ts', 'settleUnattendedJournal(', 'postJournalEntry(');
    for (const file of [`${A}gl/glImportExecuteService.ts`, `${A}gl/recurringJournalService.ts`, `${A}core/recurringTransactionService.ts`]) {
      before(file, 'newManualJournalGate(', 'createJournalEntry(');
      before(file, 'settleUnattendedJournal(', 'postJournalEntry(');
    }
    before(`${A}gl/reclassification/post.ts`, 'markManualJournal(', 'postJournalEntry(');
    before('src/lib/mcp/tools/writeReclassification.ts', 'agentNewManualJournalsRefusal(', 'postReclassBatch(');
  });
});

describe('the other journal writers', () => {
  it('only these insert a journal header directly (bank-transfers posts raw: not in decision 2, follow-up for Hein)', () => {
    expect(filesMatching(/INSERT INTO gl_journal_entries/)).toEqual([
      'pages/api/accounting/bank-transfers.ts',
      `${A}gl/assetDepreciationPosting.ts`,
      `${A}gl/journalEntryCrudService.ts`,
      `${A}gl/yearEndJournalPoster.ts`,
    ]);
  });

  it("only the account merge (it authors the drafts it re-points) and the late-claim split rewrite a journal's lines", () => {
    expect(filesMatching(/UPDATE gl_journal_lines/)).toEqual([`${A}gl/accountMergeService.ts`, `${A}gl/vatLateClaimSplit.ts`]);
    expect(textOf(`${A}gl/accountMergeService.ts`)).toMatch(/repointDocumentRows\(companyId, sourceId, targetId, userId, movedLineIds\)/);
    expect(textOf(`${A}gl/accountMergeDocumentRows.ts`)).toMatch(/stampMergedDraftJournals\(companyId, movedJournalLineIds, editedBy\)/);
    expect(filesMatching(/DELETE FROM gl_journal_lines/)).toEqual([]);
  });

  it('only manualJournalApproval writes the marker, and only it and manualJournalAuthors write a journal\'s authors', () => {
    expect(filesMatching(/approval_document_type/)).toEqual([`${A}gl/manualJournalApproval.ts`]);
    expect(filesMatching(/UPDATE gl_journal_entries[\s\S]{0,80}content_authors/)).toEqual([
      `${A}gl/manualJournalApproval.ts`, `${A}gl/manualJournalAuthors.ts`,
    ]);
  });
});
