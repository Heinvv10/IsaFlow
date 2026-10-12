import { assertOk, apiFetch } from '@/lib/apiFetch';
import { readFileForUpload, type CollectedFile } from '@/lib/bulkUpload/folderTraversal';
import { notifyPostingWarnings } from '@/components/accounting/postingWarningsNotice';
import type { BulkCommitResponse } from './bulkImportTypes';

/**
 * Commit one statement of a bulk import (bank-transactions-bulk-commit) and say
 * what the import's auto-post could not do: a line that posted without its
 * predicted cost centre is reported by bank line from `data.autoPost.warnings`.
 * Not `data.warnings` — those are the import's own problems (a failed
 * auto-post, a parse error), and "Posted — <error>" would read them as success.
 */
export async function commitStatement(args: {
  bankAccountId: string;
  bulkImportId: string;
  bulkSequence: number;
  statementDate: string;
  applyBankRules: boolean;
  collected: CollectedFile;
}): Promise<BulkCommitResponse> {
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
  const data = (json?.data ?? json) as BulkCommitResponse;
  if (data.status === 'imported') notifyPostingWarnings({ data: { autoPost: json?.data?.autoPost } });
  return data;
}
