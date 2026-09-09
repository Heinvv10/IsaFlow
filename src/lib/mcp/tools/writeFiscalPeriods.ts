/**
 * Period control as write tools: close a period, reopen one, close a year.
 *
 * 56 prior periods stand open on one production company while its whole 2027 is
 * closed. Anyone — a person or an agent — can post into 2022 today. No MCP
 * client could observe that, and none could fix it.
 *
 * `close_fiscal_period` does NOT mirror the app's advisory close. The Month-End
 * Workbench shows the readiness checks to a person, who may reasonably close
 * over them; a caller that is not a person gets a refusal naming every failing
 * check. That is the difference between a lock and a suggestion.
 */
import type { McpTool } from '../types';
import {
  closePeriodWithReadiness,
  PeriodCloseBlockedError,
  PeriodNotCloseableError,
} from '@/modules/accounting/services/gl/fiscalPeriodCloseService';
import { getFiscalPeriodById, reopenPeriod } from '@/modules/accounting/services/gl/fiscalPeriodService';
import { closeFiscalYear } from '@/modules/accounting/services/gl/yearEndService';
import { MUTATION_ARG_SCHEMA } from '../contracts';
import { NOT_FOUND, guardCastableArgs, ok, strArg, toolError } from './toolHelpers';
import { yearEndCloseRefusal } from './yearEndCloseRefusal';

const DRY = { wroteNothing: true, billable: false } as const;

export const closeFiscalPeriodTool: McpTool = {
  name: 'close_fiscal_period',
  description:
    'Close a fiscal period so nothing further can post into it. '
    + 'REFUSES on any failing readiness check and names every one of them with its reason — '
    + 'unreconciled banks, unposted draft journals, an AR or AP subledger that does not tie to its '
    + 'control account, an unbalanced trial balance, or a POSTED journal that belongs to no fiscal '
    + 'period at all — that last one is invisible to every period report while sitting in the '
    + 'ledger, so no close can honestly assert completeness over it. This is stricter than the app: the '
    + 'Month-End Workbench shows the same checks to a person who may close over them. '
    + 'A check that could not be COMPUTED also blocks — "the AP tie could not be checked" is '
    + 'exactly the state in which closing unattended is unsafe. Warnings (a period with no VAT '
    + 'return, uncleared opening-balance equity) do NOT block and come back in `warnings`. '
    + 'Also refuses a period that is locked, already closed, or has an open period before it. '
    + 'Run period_close_checklist or dry_run first: a dry run applies every one of these guards and '
    + 'writes nothing. Requires the write:post permission.',
  scope: 'write:journals',
  write: true,
  requiresPost: true,
  inputSchema: {
    type: 'object',
    properties: {
      fiscal_period_id: { type: 'string', description: 'Id from list_fiscal_periods.' },
      ...MUTATION_ARG_SCHEMA,
    },
    required: ['fiscal_period_id', 'idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const periodId = strArg(args, 'fiscal_period_id');
    if (!periodId) return toolError('fiscal_period_id is required');
    const bad = guardCastableArgs(args, { uuid: ['fiscal_period_id'] });
    if (bad) return bad;
    const dryRun = args.dry_run === true;

    try {
      const result = await closePeriodWithReadiness(ctx.companyId, periodId, ctx.userId, { dryRun });
      return {
        ...ok({
          fiscal_period_id: periodId,
          period_name: result.period.periodName,
          status: result.period.status,
          closed: result.closed,
          dry_run: result.dryRun,
          checklist: result.checklist.map((i) => ({ key: i.key, status: i.status, reason: i.reason })),
          warnings: result.warnings.map((w) => ({ key: w.key, status: w.status, reason: w.reason })),
        }),
        // A dry run wrote nothing, so it must not consume the key: the real
        // call carries the same intent and would be served this preview.
        ...(dryRun ? DRY : {}),
      };
    } catch (err) {
      // Both refusals are raised BEFORE closePeriod runs, so nothing is
      // half-applied and a tool error is safe. Anything else rethrows — the
      // registry's savepoint unwinds on a throw and not on a returned error.
      if (err instanceof PeriodCloseBlockedError) {
        return toolError(
          `${err.message}. Nothing was closed. Fix these and retry, or call `
          + `period_close_checklist for the fix links.`,
        );
      }
      if (err instanceof PeriodNotCloseableError) return toolError(err.message);
      throw err;
    }
  },
};

export const reopenFiscalPeriodTool: McpTool = {
  name: 'reopen_fiscal_period',
  description:
    'Reopen a closed fiscal period so journals can post into it again. '
    + 'A LOCKED period cannot be reopened — locking is what year_end_close does, and undoing it '
    + 'would leave the year-end journal standing over a period that can still move. An already-open '
    + 'period is refused rather than reported as a change that did not happen. '
    + 'This weakens a control: everything dated inside the period becomes writable again, including '
    + 'by other agents. Reopen for a specific correction and close again. Requires write:post.',
  scope: 'write:journals',
  write: true,
  requiresPost: true,
  inputSchema: {
    type: 'object',
    properties: {
      fiscal_period_id: { type: 'string', description: 'Id from list_fiscal_periods.' },
      ...MUTATION_ARG_SCHEMA,
    },
    required: ['fiscal_period_id', 'idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const periodId = strArg(args, 'fiscal_period_id');
    if (!periodId) return toolError('fiscal_period_id is required');
    const bad = guardCastableArgs(args, { uuid: ['fiscal_period_id'] });
    if (bad) return bad;
    const dryRun = args.dry_run === true;

    // Every refusal is answered from a READ, so the service call can rethrow.
    const period = await getFiscalPeriodById(ctx.companyId, periodId);
    if (!period) return toolError(NOT_FOUND);
    if (period.status === 'locked') {
      return toolError(`${period.periodName} is locked and cannot be reopened`);
    }
    if (period.status === 'open') return toolError(`${period.periodName} is already open`);

    if (dryRun) {
      return {
        ...ok({
          fiscal_period_id: periodId, period_name: period.periodName,
          status: period.status, reopened: false, dry_run: true,
        }),
        ...DRY,
      };
    }

    const reopened = await reopenPeriod(ctx.companyId, periodId);
    return ok({
      fiscal_period_id: periodId,
      period_name: reopened.periodName,
      status: reopened.status,
      reopened: true,
      dry_run: false,
    });
  },
};

export const yearEndCloseTool: McpTool = {
  name: 'year_end_close',
  description:
    'Close a fiscal year: post a journal that zeroes every revenue and expense account into '
    + 'retained earnings, then LOCK every period in that year. '
    + 'Refuses while any period in the year is still open, and NAMES those periods so you know '
    + 'what to close first. Refuses when no retained-earnings account can be resolved. '
    + 'ALWAYS dry_run first. The dry run returns the whole journal — every line, the account codes, '
    + 'both totals and the net income — and writes nothing. This is not a routine posting: it moves '
    + 'a full year of trading into equity and then locks the periods, and locked periods cannot be '
    + 'reopened by any tool here. One production company has four unclosed years and R8.46m of '
    + 'retained earnings with no journal lines behind it, so equity is a computed residual; running '
    + 'this is how that stops being true, and it is worth reading the preview first. '
    + 'Requires the write:post permission.',
  scope: 'write:journals',
  write: true,
  requiresPost: true,
  inputSchema: {
    type: 'object',
    properties: {
      fiscal_year: {
        type: 'number',
        description: 'The fiscal_year label from list_fiscal_periods, e.g. 2027.',
      },
      ...MUTATION_ARG_SCHEMA,
    },
    required: ['fiscal_year', 'idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const year = args.fiscal_year;
    if (typeof year !== 'number' || !Number.isInteger(year)) {
      return toolError('fiscal_year must be a whole number');
    }
    const dryRun = args.dry_run === true;

    // No try/catch: every refusal this service can raise comes back as a typed
    // result BEFORE it writes, and anything it THROWS comes from inside its
    // write transaction. Catching that and returning a tool error would commit
    // a half-posted year-end and free the key for a second attempt.
    const result = await closeFiscalYear(ctx.companyId, String(year), ctx.userId, { dryRun });

    if ('error' in result) return yearEndCloseRefusal(year, result);

    if ('dryRun' in result) {
      return {
        ...ok({
          fiscal_year: year,
          dry_run: true,
          net_income: result.netIncome,
          // NULL when the year is ALREADY closed, because the live call would
          // post nothing. The preview is non-empty in exactly one such case —
          // P&L that landed in the year AFTER its close — and it is a residual,
          // not an offer: the entry number is taken, so no close can ever sweep
          // it up. Returning it under `would_post` promised an agent a balanced
          // journal the live call refuses to write. `unclosed_net_income` below
          // is that money, as a number.
          would_post: result.alreadyClosed ? null : {
            entry_number: result.preview.entryNumber,
            entry_date: result.preview.entryDate,
            description: result.preview.description,
            total_debit: result.preview.totalDebit,
            total_credit: result.preview.totalCredit,
            lines: result.preview.lines.map((l) => ({
              account_id: l.accountId,
              account_code: l.accountCode,
              account_name: l.accountName,
              debit: l.debit,
              credit: l.credit,
            })),
          },
          // A year that is ALREADY closed would lock nothing and post nothing:
          // its aggregates are flat because its own closing journal flattened
          // them, so the preview above is empty for the same reason a dormant
          // year's is. Saying so is the point — this is the read the agent is
          // told to make before authorising the irreversible half.
          already_closed: result.alreadyClosed,
          existing_entry_number: result.existingEntry
            ? String(result.existingEntry.entry_number) : null,
          would_lock_every_period_in_year: !result.alreadyClosed,
          unclosed_net_income: result.unclosedNetIncome,
        }),
        ...DRY,
      };
    }

    return ok({
      fiscal_year: year,
      dry_run: false,
      net_income: result.netIncome,
      // NULL for a dormant year: nothing was posted to any P&L account, so
      // there is no closing journal to write. The year still closes and the
      // periods still lock, which is what the caller acts on.
      journal_entry_id: result.closingEntry ? String(result.closingEntry.id) : null,
      entry_number: result.closingEntry ? String(result.closingEntry.entry_number) : null,
      // A COUNT, not a boolean, and the two counts are NOT the same number.
      // `periods_locked` is what THIS call locked — zero on an already-closed
      // re-run, which locks nothing — while the service's count is how many
      // periods in the year are locked now, which on a re-run is the twelve an
      // earlier close locked. Reporting the latter as the former told an agent
      // its no-op call had locked twelve periods.
      periods_locked: result.alreadyClosed ? 0 : result.periodsLockedInYear,
      periods_locked_in_year: result.periodsLockedInYear,
      already_closed: result.alreadyClosed,
      // Non-zero ONLY on an already-closed year that gained posted P&L after
      // its close: that movement is in no closing journal and in no equity
      // account, and this tool can never sweep it up. Surfaced as a number so
      // an agent can act on it rather than parsing the sentence.
      unclosed_net_income: result.unclosedNetIncome,
      message: result.message,
    });
  },
};
