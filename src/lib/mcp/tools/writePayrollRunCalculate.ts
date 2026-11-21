/**
 * MCP write tool calculate_pay_run (costing a pay run). Split out of writePayrollRun.ts (which re-exports it, and
 * whose header explains why costing is re-runnable and approving is not) to keep that file under the 300-line cap.
 */
import { sql } from '@/lib/neon';
import { ErrorCode } from '@/lib/apiResponse.types';
import type { DbRow } from '@/lib/neon';
import type { McpTool } from '../types';
import {
  calculatePayrollRun,
  getPayrollRun,
  type PayrollRunSummary,
} from '@/modules/accounting/services/payroll/payrollRunService';
import { previewPayrollApproval } from '@/modules/accounting/services/payroll/payrollApprovalService';
import { isPayrollRunLocked, PayrollRunLockedError, PayrollRunNotFoundError } from '@/modules/accounting/services/payroll/payrollRunLock';
import {
  PayrollLoanLockTimeoutError,
  PayrollRunJournalPostedError,
  runHasLoanWork,
} from '@/modules/accounting/services/payroll/payrollRunLoanApplication';
import { payrollJournalInForce } from '@/modules/accounting/services/payroll/payrollJournalChain';
import { UnsupportedTaxYearError, unloadedTaxYearMessage } from '@/modules/accounting/services/payroll/taxTables';
import { withheldLoansReport as withheldLoans } from '@/modules/accounting/services/payroll/payrollLoanWithholding';
import { MUTATION_ARG_SCHEMA } from '../contracts';
import { NOT_FOUND, guardCastableArgs, ok, strArg, toolError } from './toolHelpers';
import { EtiLaterMonthPostedError } from '@/modules/accounting/services/payroll/etiPeriodGuard';
import { assertPreparerSupported, PreparerIdNotSupportedError } from '@/modules/accounting/services/payroll/payrollPreparerGuard';
import { assertRunKindSupported, isRunKindUnsupported } from '@/modules/accounting/services/payroll/payrollRunKindGuard';
import { PspComponentRefused, PspStatusChangedSinceApproval } from '@/modules/accounting/services/payroll/pspLineRules';
import { assertFrequencyCostable, frequencyRunOf, isPayFrequencyRefused } from '@/modules/accounting/services/payroll/payrollFrequencyGuard';
import { runKindOf, runPeriodOf } from '@/modules/accounting/services/payroll/payrollFrequency';
import { listOffCycleEmployees } from '@/modules/accounting/services/payroll/payrollOffCyclePopulation';
import { listPayrollRunEmployees } from '@/modules/accounting/services/payroll/payrollEmployeeService';
import { assertOffCycleBeforeClose, OffCycleRunRefusedError } from '@/modules/accounting/services/payroll/payrollOffCycleRun';

/** The run, as every tool here reports it. */
export function runPayload(run: PayrollRunSummary): Record<string, unknown> {
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

/**
 * An off-cycle refusal as the calculate route answers it (review L4 of f37f0f15a6, L3 of e8a2d72dbc): a named one
 * (refusal, e.g. TERMINATION_REASON_MISSING) as the route's envelope, CONFLICT (BAD_REQUEST for a 400) with details
 * { code: OFF_CYCLE_RUN_REFUSED, refusal }; the rest as its message.
 */
function offCycleToolError(err: OffCycleRunRefusedError) {
  if (!err.refusal) return toolError(err.message);
  const code = err.status === 400 ? ErrorCode.BAD_REQUEST : ErrorCode.CONFLICT;
  return toolError(JSON.stringify({ success: false, error: { code, message: err.message, details: { code: err.code, refusal: err.refusal } } }));
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
  requiresWriteRole: true,
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
      // Wave 6 HYb: the live call's preparer guard, in its order (right after the lock check).
      if (!isPayrollRunLocked(run.status)) {
        try {
          await assertPreparerSupported(ctx.companyId, ctx.userId);
        } catch (err) {
          if (err instanceof PreparerIdNotSupportedError) return toolError(err.message);
          throw err;
        }
      }
      // dry_run runs the live path's row-state guards, in its order (locked, then tax year): without them a reopened
      // run whose GL journal is still posted was promised a recost that calculatePayrollRun then refuses.
      const refusal = isPayrollRunLocked(run.status) ? new PayrollRunLockedError(run.status).message : unloadedTaxYearMessage(run.periodMonth, run.periodYear);
      // Wave 6 FQa: then the live call's run-kind guard, in its order (after the lock and tax-year checks), on the same
      // population (read-only).
      if (!refusal) {
        try {
          // The run's own period and frequency, read from its row as calculatePayrollRun reads it (wave 6 FQc, review #1575 L2).
          const row = ((await sql`SELECT * FROM payroll_run_headers WHERE id = ${runId}::uuid AND company_id = ${ctx.companyId}::uuid`) as DbRow[])[0] ?? {};
          // An off-cycle run costs its own chosen employees, as calculatePayrollRun does (review #1679 N7).
          const employees = runKindOf(row.run_kind) === 'off_cycle'
            ? await listOffCycleEmployees(ctx.companyId, runId)
            : await listPayrollRunEmployees(ctx.companyId, runPeriodOf(row), run.payFrequency);
          await assertRunKindSupported(ctx.companyId, runId, 'calculate', { employeeIds: employees.map((e) => e.id) });
          // Wave 6 FQc: then the frequency guard, as the live call runs it (a mid-year frequency change refuses a monthly run too).
          const frequencyRun = frequencyRunOf(row);
          if (frequencyRun) await assertFrequencyCostable(ctx.companyId, frequencyRun, employees.map((e) => e.id));
          // Wave 6 OC: then the month's close, as the live call checks it (an off-cycle run paid after its regular run).
          await assertOffCycleBeforeClose(ctx.companyId, row);
        } catch (err) {
          if (err instanceof OffCycleRunRefusedError) return offCycleToolError(err);
          if (isRunKindUnsupported(err) || isPayFrequencyRefused(err)) return toolError(err.message);
          throw err;
        }
      }
      // An off-cycle run pays no loan instalment (calculatePayrollRun skips loans for it, review #1679): neither the
      // posted-journal loan refusal nor the roster's withheld loans apply to it.
      const offCycle = run.runKind === 'off_cycle';
      const blocked = !refusal && !offCycle && run.journalEntryId != null
        && await payrollJournalInForce(ctx.companyId, run.journalEntryId)
        && await runHasLoanWork(ctx.companyId, runId, run.periodYear, run.periodMonth);
      return ok({
        dryRun: true,
        wroteNothing: true,
        journals: [],
        effects: blocked || refusal
          ? []
          : [`Recost run ${run.periodMonth}/${run.periodYear} (status '${run.status}') and rebuild its lines.`],
        skipped: [
          ...(blocked ? [new PayrollRunJournalPostedError(runId).message] : []),
          ...(refusal ? [refusal] : []),
        ],
        withheld_loans: blocked || refusal || offCycle ? [] : await withheldLoans(ctx.companyId, run),
        current: runPayload(run),
      });
    }

    try {
      const costed = await calculatePayrollRun(runId, ctx.companyId, ctx.userId);
      return ok({
        ...runPayload(costed),
        withheld_loans: costed.runKind === 'off_cycle' ? [] : await withheldLoans(ctx.companyId, costed), approval_blocker: (await previewPayrollApproval(ctx.companyId, runId))?.blocker ?? null,
        next_step: costed.employeeCount === 0
          ? 'No employees were costed — create_employee and assign_employee_component first.'
          : 'approve_pay_run posts this to the ledger.',
      });
    } catch (err) {
      // The locked case is a genuine refusal the agent can act on, and it is
      // raised BEFORE any line is touched. Everything else propagates to the
      // registry's savepoint rather than being flattened into a tool error
      // that would leave the lines half-rebuilt and the key freed.
      if (err instanceof OffCycleRunRefusedError) return offCycleToolError(err);
      if (err instanceof PayrollRunLockedError || err instanceof EtiLaterMonthPostedError || err instanceof PreparerIdNotSupportedError
        || isRunKindUnsupported(err) || isPayFrequencyRefused(err)
        || err instanceof PspComponentRefused || err instanceof PspStatusChangedSinceApproval) return toolError(err.message);
      // Same shape: raised before any line is touched, and the message names
      // the action the agent must take instead.
      if (err instanceof PayrollRunJournalPostedError
        || err instanceof PayrollLoanLockTimeoutError
        || err instanceof PayrollRunNotFoundError // a draft deleted while this call waited (wave 6 FQd)
        || err instanceof UnsupportedTaxYearError) {
        return toolError(err.message);
      }
      throw err;
    }
  },
};
