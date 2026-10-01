/**
 * MCP write tools: costing and approving a pay run.
 *
 * ── THE MISSING MIDDLE ──────────────────────────────────────────────────────
 *
 * `create_pay_run` opens a period and `post_payroll_journal` puts it in the
 * ledger, but the two steps BETWEEN them were reachable only through the
 * browser: costing the run (applying the PAYE, UIF, SDL and ETI engines to
 * every employee) and approving it. A run that is opened and never costed
 * carries no lines and no totals, so an agent working through the connector
 * could open twelve months of empty runs and post nothing.
 *
 * ── COSTING IS RE-RUNNABLE, APPROVING IS NOT ────────────────────────────────
 *
 * `calculatePayrollRun` deletes and rebuilds the run's lines from the current
 * employees and components, so it is safe to call again after fixing a salary —
 * and that is the expected way to correct a run. It refuses once the run is
 * locked (`PayrollRunLockedError`), which is what stops a costed-and-approved
 * run being silently recomputed underneath a posted journal.
 *
 * `approvePayrollRun` APPROVES AND POSTS in one call — it is not just a status
 * flip. That is why this tool is `requiresPost` while the costing one is not,
 * and why its dry run reports the totals that are about to hit the ledger
 * rather than a count.
 */
import type { McpTool } from '../types';
import {
  calculatePayrollRun,
  getPayrollRun,
  type PayrollRunSummary,
} from '@/modules/accounting/services/payroll/payrollRunService';
import {
  approvePayrollRun,
  previewPayrollApproval,
} from '@/modules/accounting/services/payroll/payrollApprovalService';
import { PayrollApprovalRefusedError } from '@/modules/accounting/services/payroll/payrollApprovalRefusal';
import { PayrollRunLockedError } from '@/modules/accounting/services/payroll/payrollRunLock';
import {
  PayrollLoanLockTimeoutError,
  PayrollRunJournalPostedError,
  runHasLoanWork,
} from '@/modules/accounting/services/payroll/payrollRunLoanApplication';
import { MUTATION_ARG_SCHEMA } from '../contracts';
import { NOT_FOUND, guardCastableArgs, ok, strArg, toolError } from './toolHelpers';

/**
 * The stamp that puts this journal in `list_agent_postings`. Without it
 * `createJournalEntry` falls back to `defaultHumanMeta(userId)` and every
 * payroll journal an agent posts is indistinguishable from a human's.
 */
const APPROVE_TOOL_AGENT = 'mcp:approve_pay_run:v1';

/** The run, as every tool here reports it. */
function runPayload(run: PayrollRunSummary): Record<string, unknown> {
  return {
    id: run.id,
    period: `${String(run.periodMonth).padStart(2, '0')}/${run.periodYear}`,
    status: run.status,
    employee_count: run.employeeCount,
    total_gross: run.totalGross,
    total_paye: run.totalPaye,
    total_uif: run.totalUif,
    total_sdl: run.totalSdl,
    total_eti: run.totalEti,
    total_net: run.totalNet,
  };
}

export const calculatePayRunTool: McpTool = {
  name: 'calculate_pay_run',
  description:
    'Cost an open pay run: apply the PAYE, UIF, SDL and ETI engines to every active employee '
    + 'and write the run lines. Posts NOTHING to the ledger — approve_pay_run does that. '
    + 'Re-runnable: it rebuilds the lines from the CURRENT employees and components, so after '
    + 'fixing a salary you call it again. It is refused once the run is locked. '
    + 'An employee with no pay components costs to ZERO without erroring, so check '
    + 'employee_count and total_gross against what you expect before approving.',
  scope: 'write:payroll',
  write: true,
  inputSchema: {
    type: 'object',
    properties: {
      run_id: { type: 'string', description: 'From list_pay_runs or create_pay_run' },
      ...MUTATION_ARG_SCHEMA,
    },
    required: ['run_id', 'idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const runId = strArg(args, 'run_id');
    if (!runId) return toolError('run_id is required');
    const bad = guardCastableArgs(args, { uuid: ['run_id'] });
    if (bad) return bad;

    // Every refusal is answered from a READ, before the first write. A refusal
    // is audited with a NULL idempotency key, so one returned AFTER the lines
    // were rebuilt would free the key for a retry that rebuilds them again.
    const run = await getPayrollRun(runId, ctx.companyId);
    if (!run) return toolError(NOT_FOUND);

    if (args.dry_run === true) {
      // dry_run must run the row-state guards the live path runs. Without this
      // a reopened run whose GL journal is still posted was promised a recost
      // that calculatePayrollRun then refuses.
      const blocked = run.journalEntryId != null
        && await runHasLoanWork(ctx.companyId, runId, run.periodYear, run.periodMonth);
      return ok({
        dryRun: true,
        wroteNothing: true,
        journals: [],
        effects: blocked
          ? []
          : [`Recost run ${run.periodMonth}/${run.periodYear} (status '${run.status}') and rebuild its lines.`],
        skipped: blocked ? [new PayrollRunJournalPostedError(runId).message] : [],
        current: runPayload(run),
      });
    }

    try {
      const costed = await calculatePayrollRun(runId, ctx.companyId);
      return ok({
        ...runPayload(costed),
        next_step: costed.employeeCount === 0
          ? 'No employees were costed — create_employee and assign_employee_component first.'
          : 'approve_pay_run posts this to the ledger.',
      });
    } catch (err) {
      // The locked case is a genuine refusal the agent can act on, and it is
      // raised BEFORE any line is touched. Everything else propagates to the
      // registry's savepoint rather than being flattened into a tool error
      // that would leave the lines half-rebuilt and the key freed.
      if (err instanceof PayrollRunLockedError) return toolError(err.message);
      // Same shape: raised before any line is touched, and the message names
      // the action the agent must take instead.
      if (err instanceof PayrollRunJournalPostedError
        || err instanceof PayrollLoanLockTimeoutError) {
        return toolError(err.message);
      }
      throw err;
    }
  },
};

export const approvePayRunTool: McpTool = {
  name: 'approve_pay_run',
  description:
    'Approve a costed pay run AND POST its journal to the ledger — DR employment cost '
    + '(including employer UIF and SDL) / CR PAYE, UIF, SDL, deductions and net pay. '
    + 'This is not a status flip: it writes to the general ledger, and it requires the '
    + 'write:post permission. Approvable from draft, calculated or processed. '
    + 'Run calculate_pay_run first and check the totals — an uncosted run, or one whose journal '
    + 'cannot post (closed period, deactivated account, missing account), is refused before it is '
    + 'approved. Reversal is by a reversing journal, not by re-approving. '
    + 'Two calls: dry_run: true returns plan_hash for the journal it previews; the live call must '
    + 'send that value as expected_plan_hash, and is refused if the run has changed since.',
  scope: 'write:payroll',
  write: true,
  requiresPost: true,
  inputSchema: {
    type: 'object',
    properties: {
      run_id: { type: 'string' },
      expected_plan_hash: {
        type: 'string',
        description: 'plan_hash from this tool\'s dry run. Required on the live call.',
      },
      ...MUTATION_ARG_SCHEMA,
    },
    required: ['run_id', 'idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const runId = strArg(args, 'run_id');
    if (!runId) return toolError('run_id is required');
    const bad = guardCastableArgs(args, { uuid: ['run_id'] });
    if (bad) return bad;

    // Enforced HERE: inputSchema is not validated at runtime, so `required`
    // would not stop a live call that carries no hash — and without one the
    // agent approves whatever the run holds now, not what its dry run showed.
    const expectedPlanHash = args.expected_plan_hash;
    if (args.dry_run !== true && (typeof expectedPlanHash !== 'string' || expectedPlanHash === '')) {
      return toolError(
        'expected_plan_hash is required: call approve_pay_run with dry_run: true first '
        + 'and send the plan_hash it returns.',
      );
    }

    const run = await getPayrollRun(runId, ctx.companyId);
    if (!run) return toolError(NOT_FOUND);

    // EXACTLY the service's list (`payrollApprovalService`), not a superset.
    // It admits 'approved' only when the journal did not post, which is a
    // condition this summary cannot see — so an already-approved run is
    // refused here and recovered with post_payroll_journal, rather than being
    // waved through to a service throw that the registry flattens into "try
    // again", advice for a state that can never succeed.
    const APPROVABLE = ['draft', 'calculated', 'processed'];
    if (!APPROVABLE.includes(run.status)) {
      return toolError(
        `Cannot approve a pay run with status '${run.status}' `
        + `(approvable from: ${APPROVABLE.join(', ')}). `
        + 'An approved run whose journal did not post is completed with post_payroll_journal.',
      );
    }

    const preview = (
      skipped: Array<{ id: string; reason: string; detail: string }>,
      gate?: { planHash: string; posted: { journalEntryId: string } | null; replaces: { journalEntryId: string } | null },
    ) => ok({
      dryRun: true,
      wroteNothing: true,
      journals: [],
      effects: [
        // A reopened run keeps its LIVE journal; the live call posts nothing and
        // returns it. A reversed one is replaced: the live call posts afresh.
        gate?.posted
          ? `Approve run ${run.periodMonth}/${run.periodYear}. It already carries journal `
            + `${gate.posted.journalEntryId}, which is returned — nothing new is posted.`
          : `Approve run ${run.periodMonth}/${run.periodYear} and POST its journal: `
            + `${run.employeeCount} employees, gross ${run.totalGross}, PAYE ${run.totalPaye}, `
            + `UIF ${run.totalUif}, SDL ${run.totalSdl}, net ${run.totalNet}.`
            + (gate?.replaces
              ? ` The journal it posted before (${gate.replaces.journalEntryId}) was reversed, so a new one is posted in its place.`
              : ''),
      ],
      skipped,
      current: runPayload(run),
      ...(gate ? { plan_hash: gate.planHash } : {}),
    });

    // An uncosted run is answered first, by name: its plan would otherwise be
    // refused as `nothing_to_post`, which does not say what to do. The preview
    // still previews (flagged skipped); the LIVE call is refused, not warned.
    // Approving sets status 'approved', which is a LOCKED status:
    // `calculate_pay_run` is refused permanently thereafter and there is no MCP
    // tool to reopen a run. An agent that approved a run costing nobody would
    // lock the month with an empty journal and have no connector path back out.
    if (run.employeeCount === 0) {
      if (args.dry_run === true) {
        return preview([{ id: run.id, reason: 'run_not_costed', detail: 'No lines — run calculate_pay_run first.' }]);
      }
      return toolError(
        'This run has costed nobody — approving it would lock the month with an empty journal '
        + 'and there is no connector tool to reopen a locked run. '
        + 'Assign pay components and run calculate_pay_run first.',
      );
    }

    // The service refuses a run whose journal cannot post BEFORE it approves
    // it (K-079). The dry run asks the same question, so it refuses what the
    // live call refuses.
    if (args.dry_run === true) {
      const gate = await previewPayrollApproval(ctx.companyId, runId);
      if (!gate) return toolError(NOT_FOUND);
      if (gate.blocker) return toolError(`The journal for this run cannot post, so it was not approved: ${gate.blocker.detail}`);
      return preview([], gate);
    }

    // Only the service's own pre-write refusal is returned: nothing has been
    // written, so releasing the savepoint commits nothing. Everything else is
    // rethrown — a failure during approve-and-post must reach the registry's
    // savepoint, because a returned error there would RELEASE it and commit a
    // run marked approved against a journal that did not post.
    let approved;
    try {
      approved = await approvePayrollRun(ctx.companyId, runId, ctx.userId, {
        postingAgent: APPROVE_TOOL_AGENT,
        expectedPlanHash: expectedPlanHash as string,
      });
    } catch (err) {
      if (err instanceof PayrollApprovalRefusedError) return toolError(`Not approved: ${err.message}`);
      // The bounded wait for the run or its journal ran out — before any write.
      if (err instanceof PayrollLoanLockTimeoutError) return toolError(err.message);
      throw err;
    }
    return ok({
      ...runPayload(approved),
      journal_entry_id: approved.journalEntryId,
      advisories: approved.advisories,
    });
  },
};
