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
import { approvePayrollRun } from '@/modules/accounting/services/payroll/payrollApprovalService';
import { PayrollRunLockedError } from '@/modules/accounting/services/payroll/payrollRunLock';
import { MUTATION_ARG_SCHEMA } from '../contracts';
import { NOT_FOUND, guardCastableArgs, ok, strArg, toolError } from './toolHelpers';

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
      return ok({
        dryRun: true,
        journals: [],
        effects: [`Recost run ${run.periodMonth}/${run.periodYear} (status '${run.status}') and rebuild its lines.`],
        skipped: [],
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
    + 'Run calculate_pay_run first and check the totals — approving an uncosted run posts nothing '
    + 'but marks the month done. Reversal is by a reversing journal, not by re-approving.',
  scope: 'write:payroll',
  write: true,
  requiresPost: true,
  inputSchema: {
    type: 'object',
    properties: {
      run_id: { type: 'string' },
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

    const run = await getPayrollRun(runId, ctx.companyId);
    if (!run) return toolError(NOT_FOUND);

    // The status rule the service enforces, answered here from the read so the
    // refusal lands before the write. Mirrors approvePayrollRun's own list.
    const APPROVABLE = ['draft', 'calculated', 'processed', 'approved'];
    if (!APPROVABLE.includes(run.status)) {
      return toolError(`Cannot approve a pay run with status '${run.status}'.`);
    }

    if (args.dry_run === true) {
      return ok({
        dryRun: true,
        journals: [],
        effects: [
          `Approve run ${run.periodMonth}/${run.periodYear} and POST its journal: `
          + `${run.employeeCount} employees, gross ${run.totalGross}, PAYE ${run.totalPaye}, `
          + `UIF ${run.totalUif}, SDL ${run.totalSdl}, net ${run.totalNet}.`,
        ],
        skipped: run.employeeCount === 0
          ? [{ id: run.id, reason: 'run_not_costed', detail: 'No lines — run calculate_pay_run first.' }]
          : [],
        current: runPayload(run),
      });
    }

    // No catch. The status refusal above is the only one answerable from a
    // read; a failure during approve-and-post must reach the registry's
    // savepoint, because a returned error there would RELEASE it and commit a
    // run marked approved against a journal that did not post.
    const approved = await approvePayrollRun(ctx.companyId, runId, ctx.userId);
    return ok({
      ...runPayload(approved),
      journal_entry_id: approved.journalEntryId,
    });
  },
};
