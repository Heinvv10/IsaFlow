/**
 * The one SQL rule for a FINAL pay run (wave 6 EF; spec rule 7). Final = the run is `approved` or `paid` AND carries
 * an approval time: `COALESCE(approved_at, approval_grandfathered_at) IS NOT NULL` (wave 5 FS, `payslipFinal`).
 * `approvePayrollRun` sets `approved_at` in the same UPDATE as the status, reopen clears both stamps
 * (`payrollRunReopen.ts`), and migration 951 grandfathered the older runs. So an `approved` row with neither stamp
 * can only come from a hand edit; it is not final, and the EMP201 and IRP5 name it (`payRunNotFinal.ts`).
 *
 * Every reader that asks "is this run final?" splices this fragment (`${sql.unsafe(payRunFinalSql('prh'))}`) rather
 * than a status string: the payslip, the readiness card, IRP5 pre-validation, the EMP201, the IRP5 and the UI-19.
 * The alias is checked, so the fragment can never carry anything but a column reference.
 */

const ALIAS = /^[a-z_][a-z0-9_]*$/;

/** The statuses a final run may have; the approval time decides which of them are final. */
export const PAY_RUN_FINAL_STATUSES = ['approved', 'paid'] as const;

/** `(<alias>.status IN ('approved','paid') AND COALESCE(<alias>.approved_at, <alias>.approval_grandfathered_at) IS NOT NULL)`. */
export function payRunFinalSql(alias: string): string {
  if (!ALIAS.test(alias)) throw new Error(`payRunFinalSql: not a table alias: ${JSON.stringify(alias)}`);
  const statuses = PAY_RUN_FINAL_STATUSES.map((s) => `'${s}'`).join(', ');
  return `(${alias}.status IN (${statuses}) AND COALESCE(${alias}.approved_at, ${alias}.approval_grandfathered_at) IS NOT NULL)`;
}

/**
 * The same rule in TypeScript (review #1679 codex 6), for a row already read: approved or paid, with an approval time.
 * The run list reports it as `final`, so the off-cycle form offers exactly the regular runs the server accepts.
 */
export function payRunIsFinal(run: { status: string; approvedAt?: unknown; approvalGrandfatheredAt?: unknown }): boolean {
  return (PAY_RUN_FINAL_STATUSES as readonly string[]).includes(run.status)
    && (run.approvedAt ?? run.approvalGrandfatheredAt ?? null) !== null;
}
