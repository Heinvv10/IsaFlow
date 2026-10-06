/**
 * R-035 PR3: every way a credit note comes into existence or gets posted,
 * classified. A credit note may be posted only through approveCreditNote,
 * which runs the approval gate under its row lock (and the migration 862
 * trigger backs it). Everything else that writes a note must write a DRAFT.
 *
 * A new INSERT site, a new caller of createCreditNote or a new caller of
 * approveCreditNote fails this census until it is classified here — "pin,
 * don't gate": the drafts-only creators (dispute resolution, supplier
 * returns, the create routes and MCP create_credit_note) are pinned, and
 * proven against a real database by r035-pr3-drafts.int.test.ts.
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

describe('credit-note writers', () => {
  it('INSERT a note in exactly the classified places, each as a draft', () => {
    const DRAFTS_ONLY: Record<string, string> = {
      // createCreditNote: the insert names no status, so the column default 'draft' applies.
      'src/modules/accounting/services/ar/creditNoteService.ts': 'createCreditNote',
      // A supplier return is a draft credit note, numbered from the supplier_return sequence.
      'pages/api/accounting/supplier-returns.ts': 'supplier return',
    };
    expect(matching(/INSERT\s+INTO\s+(public\.)?credit_notes\b/i)).toEqual(Object.keys(DRAFTS_ONLY).sort());

    const insertOf = (rel: string) => {
      const t = text(rel);
      const at = t.search(/INSERT\s+INTO\s+credit_notes/i);
      return t.slice(at, t.indexOf('RETURNING', at));
    };
    expect(insertOf('src/modules/accounting/services/ar/creditNoteService.ts')).not.toMatch(/\bstatus\b/);
    expect(insertOf('pages/api/accounting/supplier-returns.ts')).toMatch(/'draft'/);
  });

  it('createCreditNote (drafts only) is called by exactly the classified creators', () => {
    expect(matching(/\bcreateCreditNote\(/)).toEqual([
      'pages/api/accounting/credit-notes.ts', // POST: a draft
      'pages/api/accounting/supplier-credit-notes.ts', // POST: a draft, then (submitAction 'post') approveCreditNote
      'src/lib/mcp/tools/writeCreditNotesCreate.ts', // MCP create_credit_note: a draft
      'src/modules/accounting/services/ar/creditNoteService.ts', // the definition
      'src/modules/accounting/services/ar/disputeResolution.ts', // resolve_with_credit: a draft
    ]);
  });

  it('approveCreditNote — the gated posting path — is called by exactly the classified callers', () => {
    expect(matching(/\bapproveCreditNote\(/)).toEqual([
      'pages/api/accounting/credit-notes-action.ts', // 409 via respondIfApprovalRequired
      'pages/api/accounting/supplier-credit-notes.ts', // POST create-and-post: 409 naming the kept draft; PATCH post: 409
      'src/lib/mcp/tools/bulkApproveCreditNotesAdapter.ts', // bulk: pre-read skip + racedReason approval_required
      'src/lib/mcp/tools/writeCreditNotes.ts', // approve_credit_note: pre-read refusal (Q6)
      'src/modules/accounting/services/ar/creditNoteApproveService.ts', // the definition: assertApprovalCleared under the lock
    ]);
    expect(text('src/modules/accounting/services/ar/creditNoteApproveService.ts'))
      .toMatch(/assertApprovalCleared\(companyId, creditNoteApprovalType\(/);
  });
});
