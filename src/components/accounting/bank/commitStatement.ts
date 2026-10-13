import { assertOk, apiFetch } from '@/lib/apiFetch';
import { readFileForUpload, type CollectedFile } from '@/lib/bulkUpload/folderTraversal';
import { warningMessages } from '@/lib/warningMessages';
import type { BulkCommitResponse } from './bulkImportTypes';

/** One bank line that auto-posted without its predicted cost centre (the route's `data.autoPost.warnings[]`). */
export interface DroppedPickLine {
  txId?: string; journalEntryId?: string; label?: string; description?: string | null; warnings?: string[];
}

/**
 * Commit one statement of a bulk import (bank-transactions-bulk-commit). Returns
 * the route's answer and, separately: the bank lines whose auto-post could not
 * apply a predicted cost centre (`autoPost.warnings`), for the caller to report
 * once for the whole run; and the import's own problems (`data.warnings`: a
 * failed auto-post, a parse error), for the file's row. The two are never mixed
 * — "Posted — <error>" would read a problem as a success.
 */
export async function commitStatement(args: {
  bankAccountId: string;
  bulkImportId: string;
  bulkSequence: number;
  statementDate: string;
  applyBankRules: boolean;
  collected: CollectedFile;
}): Promise<{ data: BulkCommitResponse; dropped: DroppedPickLine[]; importWarnings: string[] }> {
  const { collected } = args;
  const res = await apiFetch('/api/accounting/bank-transactions-bulk-commit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      bankAccountId: args.bankAccountId,
      bulkImportId: args.bulkImportId,
      bulkSequence: args.bulkSequence,
      filename: collected.file.name,
      statementDate: args.statementDate,
      sourceFileSizeBytes: collected.sizeBytes,
      applyBankRules: args.applyBankRules,
      ...(await readFileForUpload(collected)),
    }),
  });
  await assertOk(res, 'Could not import this statement - try again');
  const json = await res.json();
  // One reading of the answer for all: the status, the dropped picks and the import's own warnings come from one object.
  const data = (json?.data ?? json) as BulkCommitResponse & { autoPost?: { warnings?: unknown }; warnings?: unknown };
  const imported = data?.status === 'imported';
  return {
    data,
    dropped: imported ? droppedLines(data.autoPost?.warnings) : [],
    importWarnings: imported ? warningMessages(data.warnings) : [],
  };
}

/**
 * The route's `autoPost.warnings`, read as a server's answer: only object
 * elements with at least one warning, label and description as strings (a
 * wrong shape never throws in render), in a fixed order — by label (date first;
 * a line with none last), then description, then line id — whatever order the
 * sweep sent.
 */
function droppedLines(v: unknown): DroppedPickLine[] {
  // A lone object is a list of one; a bare sentence is a line that has only its warning.
  const list = Array.isArray(v) ? v : v === null || v === undefined ? [] : [v];
  return list
    .map((e): Record<string, unknown> | null => (typeof e === 'string' ? { warnings: [e] }
      : typeof e === 'object' && e !== null && !Array.isArray(e) ? e as Record<string, unknown> : null))
    .filter((e): e is Record<string, unknown> => e !== null)
    .map((e) => ({
      txId: typeof e.txId === 'string' ? e.txId : undefined,
      journalEntryId: typeof e.journalEntryId === 'string' ? e.journalEntryId : undefined,
      label: typeof e.label === 'string' ? e.label : '',
      description: typeof e.description === 'string' ? e.description : null,
      warnings: warningMessages(e.warnings),
    }))
    .filter((l) => l.warnings.length > 0)
    .sort((a, b) => Number(a.label === '') - Number(b.label === '')
      || a.label.localeCompare(b.label, 'en', { numeric: true })
      || (a.description ?? '').localeCompare(b.description ?? '')
      || (a.txId ?? '').localeCompare(b.txId ?? ''));
}
