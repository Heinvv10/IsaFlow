/**
 * MCP write tools: payroll — create a pay run, and post its journal.
 *
 * `post_payroll_journal` is the point of the whole payroll surface. The finding
 * it was specified against is that net pay is auto-coded to Salaries & Wages
 * and no employer contribution ever reaches the ledger, so employment cost is
 * understated by every one of them. Its DRY RUN therefore returns the FULL
 * journal — labour debit including employer UIF and SDL, and a separate credit
 * for PAYE, UIF, SDL, voluntary deductions and net pay — because a count would
 * not let anybody see the gap it exists to close.
 *
 * The journal is built by `payrollJournalBuilder#buildPayrollJournalPlan`,
 * which the POSTER also consumes. A preview that derived it separately would be
 * free to disagree with what actually posts; sharing the builder makes that
 * impossible, and it is why every guard the live path runs is already in the
 * plan by the time the dry run reads it.
 */
import type { McpTool } from '../types';
import { createPayrollRun } from '@/modules/accounting/services/payroll/payrollRunService';
import { buildPayrollJournalPlan } from '@/modules/accounting/services/payroll/payrollJournalBuilder';
import { postPayrollRunJournal } from '@/modules/accounting/services/payroll/payrollJournalPostingService';
import { listPayRunsPage } from '@/modules/accounting/services/payroll/payrollRunQueryService';
import { payrollPreviewRefusal } from './payrollPreviewApproval';
import { MUTATION_ARG_SCHEMA } from '../contracts';
import type { DryRunResult } from '../contracts';
import { guardCastableArgs, NOT_FOUND, ok, toolError } from './toolHelpers';

const POST_TOOL_AGENT = 'mcp:post_payroll_journal:v1';

export const createPayRunTool: McpTool = {
  name: 'create_pay_run',
  description:
    'Open a payroll run for one calendar month. The run starts in draft with no employees costed and no journal — creating it posts NOTHING to the general ledger. ' +
    'A company may have only one run per month; asking for a month that already has one is refused rather than duplicated. ' +
    'Costing the run (which applies the PAYE, UIF, SDL and ETI engines to each employee) and approving it are separate steps in the app; this tool only opens the period. Once a run is approved, post_payroll_journal puts it in the ledger. ' +
    'Run it with dry_run: true first — the preview reports whether the month is already taken without writing anything.',
  scope: 'write:payroll',
  write: true,
  inputSchema: {
    type: 'object',
    properties: {
      month: { type: 'number', description: 'Calendar month, 1-12.' },
      year: { type: 'number', description: 'Calendar year, e.g. 2026.' },
      ...MUTATION_ARG_SCHEMA,
    },
    required: ['month', 'year', 'idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const month = Number(args.month);
    const year = Number(args.year);
    if (!Number.isInteger(month) || month < 1 || month > 12) {
      return toolError('month must be a whole number from 1 to 12');
    }
    if (!Number.isInteger(year) || year < 1900 || year > 9999) {
      return toolError('year must be a four-digit year');
    }

    // The duplicate guard the live path enforces via a unique constraint. Run
    // it on BOTH paths: a dry run that passed where the real call refuses is
    // worse than no dry run.
    const existing = await listPayRunsPage(ctx.companyId, { year, limit: 200 });
    const clash = existing.rows.find((r) => r.periodMonth === month);

    if (args.dry_run === true) {
      const preview: DryRunResult = {
        dryRun: true,
        journals: [],
        skipped: clash
          ? [{
              id: clash.id,
              reason: 'period_already_exists',
              detail: `A payroll run for ${month}/${year} already exists in status '${clash.status}'.`,
            }]
          : [],
        effects: [],
        journalsTotal: 0,
        truncated: false,
      };
      return { ...ok(preview), wroteNothing: true };
    }

    if (clash) {
      return toolError(`A payroll run for ${month}/${year} already exists (status '${clash.status}').`);
    }

    // Past this point a service that can write has been called, so any failure
    // must RETHROW — a returned toolError releases the savepoint and commits.
    const run = await createPayrollRun(ctx.companyId, { month, year }, ctx.userId);
    return ok({
      run_id: run.id,
      period_month: run.periodMonth,
      period_year: run.periodYear,
      status: run.status,
      note: 'The run is open and empty. Cost and approve it before post_payroll_journal can put it in the ledger.',
    });
  },
};

export const postPayrollJournalTool: McpTool = {
  name: 'post_payroll_journal',
  description:
    'Post the general-ledger journal for an APPROVED payroll run: debit labour cost with gross pay plus the employer UIF and SDL the company owes on top of it, and credit PAYE payable, UIF payable (both halves), SDL payable, any voluntary deductions, and net pay. ' +
    'This is the entry that is missing from these books. Today net pay alone is coded to Salaries & Wages, so employment cost is understated by every employer contribution and no PAYE, UIF or SDL liability is ever raised. ' +
    'ALWAYS call it with dry_run: true first. The preview returns the complete journal — every line, both totals, the fiscal period the date falls in, and the run totals it was derived from — and it applies every check the live call applies: the run must be approved, it must not already carry a journal, the five required GL accounts (5200 labour, 2140 PAYE, 2150 UIF, 2160 SDL, 1110 bank) must exist, and account 2175 must exist if there are voluntary deductions. If any of those fails, BOTH the preview and the live call refuse and name the reason. ' +
    'It reports rather than repairs. An advisory of inactive_target_account means the journal posts into deactivated accounts — is_active is only a picker flag, so the money does land there, but no one can select those accounts in the UI and any report that filters on is_active will drop the balance. It does not activate them. ' +
    'It also does not calculate or approve the run, does not pay anyone, and does not file an EMP201. A run with ETI will report an unbalanced blocker: ETI is currently subtracted from the labour debit and credited nowhere, so the journal will not balance and cannot post until that is corrected by a human. ' +
    'Reverse a posted payroll journal in the app; this tool will refuse a run that already has one rather than post a second.',
  scope: 'write:payroll',
  write: true,
  requiresPost: true,
  inputSchema: {
    type: 'object',
    properties: {
      run_id: { type: 'string', description: 'Payroll run UUID from list_pay_runs.' },
      ...MUTATION_ARG_SCHEMA,
    },
    required: ['run_id', 'idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const guard = guardCastableArgs(args, { uuid: ['run_id'] });
    if (guard) return guard;
    const runId = String(args.run_id);

    // Ownership is the handler's job: the plan builder is company-scoped and
    // returns null for a run in another tenant, which must read identically to
    // a genuine miss.
    const plan = await buildPayrollJournalPlan(ctx.companyId, runId);
    if (!plan) return toolError(NOT_FOUND);

    if (plan.blockers.length > 0) {
      const detail = plan.blockers.map((b) => `${b.code}: ${b.detail}`).join(' ');
      return toolError(`This payroll run cannot post. ${detail}`);
    }

    if (args.dry_run === true) {
      const refusal = await payrollPreviewRefusal(ctx.companyId, runId);
      if (refusal) return toolError(refusal);
      const preview: DryRunResult & {
        advisories: typeof plan.advisories;
        employment_cost: Record<string, number>;
      } = {
        dryRun: true,
        journals: [{
          date: plan.entryDate,
          description: plan.description,
          // The plan does not resolve the period; createJournalEntry does, and
          // will create the fiscal year if it is missing. Reported as unknown
          // rather than guessed.
          fiscalPeriodId: null,
          lines: plan.lines.map((l) => ({
            accountId: l.glAccountId ?? '',
            accountCode: l.accountCode,
            accountName: l.accountName,
            debit: l.debit,
            credit: l.credit,
          })),
          totalDebit: plan.totalDebit,
          totalCredit: plan.totalCredit,
        }],
        skipped: [],
        effects: [],
        journalsTotal: 1,
        truncated: false,
        advisories: plan.advisories,
        employment_cost: {
          gross_pay: plan.totals.gross,
          employer_uif: plan.totals.employerUif,
          sdl: plan.totals.sdl,
          eti: plan.totals.eti,
          net_pay: plan.totals.net,
          paye: plan.totals.paye,
          other_deductions: plan.totals.otherDeductions,
        },
      };
      return { ...ok(preview), wroteNothing: true };
    }

    // Past this point the poster may have written. Every failure RETHROWS — a
    // returned toolError releases the savepoint, commits the partial write AND
    // frees the key for a retry that writes a second time.
    const journalId = await postPayrollRunJournal(ctx.companyId, runId, ctx.userId, {
      postingAgent: POST_TOOL_AGENT,
    });

    return ok({
      run_id: runId,
      journal_entry_id: journalId,
      entry_date: plan.entryDate,
      total_debit: plan.totalDebit,
      total_credit: plan.totalCredit,
      advisories: plan.advisories,
    });
  },
};
