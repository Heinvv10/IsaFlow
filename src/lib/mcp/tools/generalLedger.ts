/**
 * `general_ledger` — the whole ledger, filtered and paged.
 *
 * `search_gl` is the narrow view of the same data: ONE account, at most 200
 * rows, no cursor. It stays, because "show me account 1101 for March" should
 * not require paging a stream. This is the wide view: every account, every
 * filter, and a keyset that pages to exhaustion without losing a line.
 *
 * It is a WRAP. Every figure comes from `getGeneralLedgerLines` — including
 * `balanced`, which is NOT recomputed here. Three callers each rolling their own
 * balance check is how 7 of 118 accounts came to be stamped
 * "Difference R0.00 · Balanced".
 */
import type { McpTool } from '../types';
import {
  getGeneralLedgerLines,
  type GeneralLedgerCursor,
} from '@/modules/accounting/services/gl/generalLedgerStreamService';
import { GL_ACCOUNT_TYPES } from '@/modules/accounting/types/gl.types';
import {
  buildEnvelope,
  decodeCursor,
  encodeCursor,
  isDetailLevel,
  type DetailLevel,
} from '@/lib/mcp/contracts';
import { clampLimit, guardCastableArgs, ok, strArg, toolError } from './toolHelpers';

/** A read that consumed no ledger row has no `posted_through`. */
const NO_LEDGER_READ = '1970-01-01T00:00:00.000Z';

const CURSOR_PARTS = 4;

/** Every element of a string-array argument, or undefined when absent. */
function strArrayArg(args: Record<string, unknown>, key: string): string[] | undefined {
  const v = args[key];
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim());
  return out.length === 0 ? undefined : out;
}

function numArg(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key];
  if (typeof v !== 'number' || !Number.isFinite(v)) return undefined;
  return v;
}

export const generalLedgerTool: McpTool = {
  name: 'general_ledger',
  description:
    'The general ledger for a date range: every posted line, across every account, with a running balance that INCLUDES each account’s opening balance. ' +
    'Use search_gl instead when you want one account and at most 200 rows; use this when you want the whole ledger, several accounts, or a filter. ' +
    'Filters. Account-level (account_codes, account_ids, account_types) select whole accounts and PRESERVE runningBalance. Line-level (sources, min_amount, search) select some of an account’s lines, so runningBalance is null and runningBalanceSuppressed is true — a running total over a subset is not a balance the account ever held. ' +
    'balanced is true only when the period is read UNFILTERED and its debits equal its credits; under any filter it is null, because debits matching credits over a subset is a coincidence and not a check. ' +
    'totalDebit, totalCredit, lineCount and accountCount are over the WHOLE filtered set, never just the page. openingBalances carries an entry for every account in the set, zero included. ' +
    'Paging: call again with cursor set and every other argument unchanged until next_cursor is null. Every line is served exactly once. ' +
    'COMPLETENESS: universeTotal is the UNFILTERED posted line count for the period, so rowsTotal below it means you are holding an extract and excludedTotal says how many lines your filters removed. An unfiltered call has excludedTotal 0 and rowsTotal equal to universeTotal. ' +
    'detail: "summary" returns totals only; "standard" (default) and "full" return lines.',
  scope: 'read:reports',
  write: false,
  inputSchema: {
    type: 'object',
    properties: {
      period_start: { type: 'string', format: 'date', description: 'YYYY-MM-DD. Required.' },
      period_end: { type: 'string', format: 'date', description: 'YYYY-MM-DD. Required.' },
      account_codes: {
        type: 'array', items: { type: 'string' },
        description: 'Restrict to these account codes. Preserves runningBalance.',
      },
      account_ids: {
        type: 'array', items: { type: 'string' },
        description: 'Restrict to these account UUIDs. Preserves runningBalance.',
      },
      account_types: {
        type: 'array', items: { type: 'string', enum: [...GL_ACCOUNT_TYPES] },
        description: 'Restrict to these account types. Preserves runningBalance.',
      },
      sources: {
        type: 'array', items: { type: 'string' },
        description: 'Journal sources (e.g. manual, auto_invoice). SUPPRESSES runningBalance.',
      },
      min_amount: {
        type: 'number', minimum: 0,
        description: 'Only lines whose debit or credit is at least this. SUPPRESSES runningBalance.',
      },
      search: {
        type: 'string',
        description: 'Case-insensitive substring of the entry number or description. SUPPRESSES runningBalance.',
      },
      detail: { type: 'string', enum: ['summary', 'standard', 'full'] },
      limit: { type: 'integer', minimum: 1, maximum: 1000, description: 'Default 200, max 1000.' },
      cursor: { type: 'string', description: 'next_cursor from the previous page.' },
    },
    required: ['period_start', 'period_end'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const periodStart = strArg(args, 'period_start');
    const periodEnd = strArg(args, 'period_end');
    if (!periodStart || !periodEnd) {
      return toolError('period_start and period_end are required (YYYY-MM-DD)');
    }
    const accountIds = strArrayArg(args, 'account_ids');
    // Casts are validated BEFORE the query: a read tool runs with no savepoint,
    // so a 22P02 raised after it aborts the whole request transaction.
    const bad = guardCastableArgs(args, { date: ['period_start', 'period_end'] });
    if (bad) return bad;
    if (accountIds?.some((id) => guardCastableArgs({ id }, { uuid: ['id'] }) !== null)) {
      return toolError('invalid account_ids');
    }

    const accountTypes = strArrayArg(args, 'account_types');
    // Refuse an unknown type rather than filtering to nothing: an empty ledger
    // reads to an agent as "this company posted nothing", which is a wrong
    // answer dressed as a right one.
    const unknownType = accountTypes?.find(
      (t) => !(GL_ACCOUNT_TYPES as readonly string[]).includes(t),
    );
    if (unknownType !== undefined) {
      return toolError(`invalid account_types — expected one of: ${GL_ACCOUNT_TYPES.join(', ')}`);
    }

    const rawCursor = strArg(args, 'cursor');
    let after: GeneralLedgerCursor | null = null;
    if (rawCursor !== undefined) {
      const decoded = decodeCursor(rawCursor, CURSOR_PARTS);
      if (!decoded) return toolError('invalid cursor');
      after = {
        accountCode: decoded.parts[0]!,
        date: decoded.parts[1]!,
        // Microsecond precision, carried verbatim. Truncating it to
        // milliseconds re-admits every row inside that millisecond.
        createdKey: decoded.parts[2]!,
        lineId: decoded.parts[3]!,
      };
    }

    const rawDetail = strArg(args, 'detail');
    const detail: DetailLevel = isDetailLevel(rawDetail) ? rawDetail : 'standard';
    // A summary serves totals, so it fetches ONE row rather than a page it will
    // discard — the aggregates ride on any row. Asking for 200 and throwing
    // them away would read a page of a 21,871-line ledger to answer a question
    // about its totals.
    const isSummary = detail === 'summary';

    // companyId from ctx ONLY.
    const page = await getGeneralLedgerLines({
      companyId: ctx.companyId,
      periodStart,
      periodEnd,
      accountCodes: strArrayArg(args, 'account_codes'),
      accountIds,
      accountTypes,
      sources: strArrayArg(args, 'sources'),
      minAmount: numArg(args, 'min_amount'),
      search: strArg(args, 'search'),
      limit: isSummary ? 1 : clampLimit(args, 200, 1000),
      after,
    });

    const nextCursor =
      isSummary || page.next === null
        ? null
        : encodeCursor({
            parts: [page.next.accountCode, page.next.date, page.next.createdKey, page.next.lineId],
          });

    // The universe is the UNFILTERED period. Using the matched count would let
    // the envelope certify a filtered extract as complete — rowsTotal equal to
    // universeTotal, nothing excluded — and the general ledger is the base
    // document of an audit file, where that is the one claim it must never
    // make. The excluded rows are not enumerated (they can be hundreds of
    // thousands and the caller chose to exclude them), so `excludedTotal`
    // carries the count and `truncatedExcludedRows` says the list is shorter.
    const excludedTotal = Math.max(page.universeLineCount - page.lineCount, 0);

    const envelope = buildEnvelope({
      rows: isSummary ? [] : page.lines,
      rowsTotal: page.lineCount,
      detail,
      as_at: periodEnd,
      posted_through: page.postedThrough ?? NO_LEDGER_READ,
      next_cursor: nextCursor,
      universeTotal: page.universeLineCount,
      // Always present, zero included. An absent count and a count of zero are
      // indistinguishable to a reader checking whether they hold the whole
      // ledger, and on an audit document that question must have an answer.
      excludedTotal,
    });

    return ok({
      ...envelope,
      period_start: periodStart,
      period_end: periodEnd,
      totalDebit: page.totalDebit,
      totalCredit: page.totalCredit,
      accountCount: page.accountCount,
      // From the service. Never recomputed from the rows on this page.
      balanced: page.balanced,
      runningBalanceSuppressed: page.runningBalanceSuppressed,
      openingBalances: page.openingBalances,
    });
  },
};
