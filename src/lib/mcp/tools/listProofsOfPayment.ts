/**
 * MCP read tool: `list_proofs_of_payment`.
 *
 * Finance needs to see the ABSA proofs of payment that did not attach to a bank line or did not archive to
 * SharePoint: the matcher's `ambiguous` / `refused` suggestions and the `too_large` / `failed` copies were only in
 * the tables (capture/pop/.claude.md, "Not built yet"). Each filed POP with its match and archive status.
 *
 * Offset-paged with `next_offset`, like list_supplier_payments; `total` and `summary` are over the WHOLE filter.
 * Read-only.
 */
import type { McpTool } from '../types';
import { listProofsOfPayment, type PopListRow } from '@/modules/accounting/services/capture/pop/popListService';
import {
  POP_ARCHIVE_STATUSES, POP_MATCH_FILTERS, type PopArchiveStatus, type PopMatchFilter,
} from '@/modules/accounting/services/capture/pop/popListStatus';
import { clampLimit, guardCastableArgs, ok, strArg, toolError } from './toolHelpers';
import { OFFSET_SCHEMA, nextOffsetFromTotal, parseOffset } from './pageArgs';

export const PROOFS_OF_PAYMENT_DEFAULT_LIMIT = 50;
/** A POP row with every field filled (a long SharePoint URL and path, a last error, three candidates) is about 1.7 KB of JSON: 50 stay under a client's ~90 KB result limit (readLimitsSize.test.ts). */
export const PROOFS_OF_PAYMENT_MAX_LIMIT = 50;
const DEFAULT_LIMIT = PROOFS_OF_PAYMENT_DEFAULT_LIMIT;
const MAX_LIMIT = PROOFS_OF_PAYMENT_MAX_LIMIT;

export const listProofsOfPaymentTool: McpTool = {
  name: 'list_proofs_of_payment',
  description:
    'Every ABSA proof of payment (POP) filed from the company\'s mirrored mailbox, newest payment first, with what became '
    + 'of it. match.status: attached (the matcher attached the POP to its bank line, bank_transaction_id), '
    + 'attached_manually (the matcher did not, whatever it decided, but a person linked the POP\'s document to a bank '
    + 'line in the app: bank_transaction_id; nothing to do), ambiguous (several lines, or another POP, matched: nothing '
    + 'attached; candidate_bank_transaction_ids is the suggestion for a person), not_found (no single free line yet; '
    + 're-checked until payment_date + 45 days), refused (one line matched but the attach was refused: refusal), pending '
    + '(not looked at yet). archive.status: archived (copied to SharePoint: web_url, path), too_large (over 4 MB, never '
    + 'uploaded), failed (gave up after repeated failures: last_error), pending (not copied yet; attempts / tries / '
    + 'last_error when it has failed before). archive_configured false means the company has no SharePoint target, so '
    + 'every POP stays archive pending. Filters: match_status (a status above, or unmatched = every POP on no bank line: '
    + 'neither attached nor attached_manually), archive_status, date_from / date_to on the payment date (YYYY-MM-DD), '
    + 'beneficiary '
    + '(case-insensitive substring, literal). total and summary (counts by match status and by archive status) are over '
    + `the WHOLE filter, not just the page. Up to limit rows (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}); call again `
    + 'with offset=next_offset until it is null. Read-only.',
  scope: 'read:reports',
  write: false,
  inputSchema: {
    type: 'object',
    properties: {
      match_status: { type: 'string', enum: [...POP_MATCH_FILTERS] },
      archive_status: { type: 'string', enum: [...POP_ARCHIVE_STATUSES] },
      date_from: { type: 'string', format: 'date', description: 'Payment date on or after, YYYY-MM-DD' },
      date_to: { type: 'string', format: 'date', description: 'Payment date on or before, YYYY-MM-DD' },
      beneficiary: { type: 'string', description: 'Case-insensitive substring of the beneficiary' },
      limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT },
      offset: OFFSET_SCHEMA,
    },
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const bad = guardCastableArgs(args, { date: ['date_from', 'date_to'] });
    if (bad) return bad;
    // The schema enums are documentation only; the transport validates nothing.
    const matchStatus = strArg(args, 'match_status');
    if (matchStatus && !(POP_MATCH_FILTERS as readonly string[]).includes(matchStatus)) {
      return toolError(`match_status must be one of: ${POP_MATCH_FILTERS.join(', ')}`);
    }
    const archiveStatus = strArg(args, 'archive_status');
    if (archiveStatus && !(POP_ARCHIVE_STATUSES as readonly string[]).includes(archiveStatus)) {
      return toolError(`archive_status must be one of: ${POP_ARCHIVE_STATUSES.join(', ')}`);
    }
    const dateFrom = strArg(args, 'date_from');
    const dateTo = strArg(args, 'date_to');
    if (dateFrom && dateTo && dateFrom > dateTo) return toolError('date_from must not be after date_to');
    const offset = parseOffset(args);
    if (typeof offset === 'string') return toolError(offset);

    const page = await listProofsOfPayment(ctx.companyId, {
      matchStatus: (matchStatus as PopMatchFilter | undefined) ?? null,
      archiveStatus: (archiveStatus as PopArchiveStatus | undefined) ?? null,
      dateFrom: dateFrom ?? null,
      dateTo: dateTo ?? null,
      beneficiary: strArg(args, 'beneficiary') ?? null,
      limit: clampLimit(args, DEFAULT_LIMIT, MAX_LIMIT),
      offset,
    });
    return ok({
      proofs_of_payment: page.rows.map(rowReply),
      total: page.total,
      summary: { by_match_status: page.summary.byMatch, by_archive_status: page.summary.byArchive },
      archive_configured: page.archiveConfigured,
      next_offset: nextOffsetFromTotal(offset, page.rows.length, page.total),
    });
  },
};

function rowReply(r: PopListRow) {
  return {
    pop_id: r.popId,
    transaction_number: r.transactionNumber,
    payment_date: r.paymentDate,
    amount: r.amount,
    beneficiary: r.beneficiary,
    payer_profile: r.payerProfile,
    captured_document_id: r.capturedDocumentId,
    created_at: r.createdAt,
    match: {
      status: r.match.status,
      bank_transaction_id: r.match.bankTransactionId,
      candidate_bank_transaction_ids: r.match.candidateBankTransactionIds,
      refusal: r.match.refusal,
      checked_at: r.match.checkedAt,
    },
    archive: {
      status: r.archive.status,
      web_url: r.archive.webUrl,
      path: r.archive.path,
      settled_at: r.archive.settledAt,
      attempts: r.archive.attempts,
      tries: r.archive.tries,
      last_attempt_at: r.archive.lastAttemptAt,
      last_error: r.archive.lastError,
    },
  };
}
