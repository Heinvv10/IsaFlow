import { assertOk, apiFetch } from '@/lib/apiFetch';
import { readFileForUpload, type CollectedFile } from '@/lib/bulkUpload/folderTraversal';
import type { BulkCommitResponse } from './bulkImportTypes';

/** One bank line that auto-posted without its predicted cost centre (the route's `data.autoPost.warnings[]`). */
export interface DroppedPickLine {
  txId?: string; journalEntryId?: string; label?: string; description?: string | null; warnings?: string[];
}

/**
 * Commit one statement of a bulk import (bank-transactions-bulk-commit). Returns
 * the route's answer and, separately, the bank lines whose auto-post could not
 * apply a predicted cost centre (`autoPost.warnings`), so the caller can report
 * them once for the whole run. Not `data.warnings` — those are the import's own
 * problems (a failed auto-post, a parse error), and "Posted — <error>" would
 * read them as success.
 */
export async function commitStatement(args: {
  bankAccountId: string;
  bulkImportId: string;
  bulkSequence: number;
  statementDate: string;
  applyBankRules: boolean;
  collected: CollectedFile;
}): Promise<{ data: BulkCommitResponse; dropped: DroppedPickLine[] }> {
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
  // One reading of the answer for both: the status and the dropped picks come from the same object.
  const data = (json?.data ?? json) as BulkCommitResponse & { autoPost?: { warnings?: unknown } };
  const list = data?.status === 'imported' ? data.autoPost?.warnings : undefined;
  return { data, dropped: Array.isArray(list) ? list as DroppedPickLine[] : [] };
}
