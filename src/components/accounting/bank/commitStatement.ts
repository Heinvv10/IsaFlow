import { assertOk, apiFetch } from '@/lib/apiFetch';
import { readFileForUpload, type CollectedFile } from '@/lib/bulkUpload/folderTraversal';
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
    importWarnings: imported ? strings(data.warnings) : [],
  };
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((w): w is string => typeof w === 'string' && w !== '') : []);

/**
 * The route's `autoPost.warnings`, read as a server's answer: only object
 * elements with at least one warning, label and description as strings (a
 * wrong shape shows nothing rather than throwing in render), in a fixed order —
 * by label (date first), then description — whatever order the sweep sent.
 */
function droppedLines(v: unknown): DroppedPickLine[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((e): e is Record<string, unknown> => typeof e === 'object' && e !== null && !Array.isArray(e))
    .map((e) => ({
      txId: typeof e.txId === 'string' ? e.txId : undefined,
      journalEntryId: typeof e.journalEntryId === 'string' ? e.journalEntryId : undefined,
      label: typeof e.label === 'string' ? e.label : '',
      description: typeof e.description === 'string' ? e.description : null,
      warnings: strings(e.warnings),
    }))
    .filter((l) => l.warnings.length > 0)
    .sort((a, b) => a.label.localeCompare(b.label, 'en', { numeric: true }) || (a.description ?? '').localeCompare(b.description ?? ''));
}
