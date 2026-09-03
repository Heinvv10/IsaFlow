/**
 * Canonical status vocabulary for `payroll_run_headers`.
 *
 * Source of truth: the `payroll_run_headers_status_check` CHECK constraint,
 * which admits exactly five values. Keep this list in step with that constraint —
 * a migration that widens the constraint must widen this list too.
 *
 * Lifecycle:
 *   draft      → created, figures not yet computed.
 *   calculated → figures computed, NOT yet approved and NO GL journal posted.
 *   approved   → approved by a user; `payrollApprovalService` posts the payroll
 *                journal at this transition. This is the first state in which the
 *                run exists in the general ledger.
 *   paid       → approved and settled.
 *   cancelled  → withdrawn; never declarable.
 */
export const PAYROLL_RUN_STATUSES = [
  'draft',
  'calculated',
  'approved',
  'paid',
  'cancelled',
] as const;

export type PayrollRunStatus = (typeof PAYROLL_RUN_STATUSES)[number];

/**
 * Statuses that represent a real, finalised payroll run and are therefore
 * declarable to SARS on an EMP201.
 *
 * 'calculated' is deliberately EXCLUDED. A calculated run has not been approved,
 * so `payrollApprovalService` has not posted its journal — declaring it would put
 * PAYE on the EMP201 that the general ledger does not carry, and the EMP201 would
 * no longer reconcile to the PAYE control account. 'draft' has no figures and
 * 'cancelled' was withdrawn.
 */
export const EMP201_DECLARABLE_STATUSES = ['approved', 'paid'] as const;

export type Emp201DeclarableStatus = (typeof EMP201_DECLARABLE_STATUSES)[number];

/**
 * Statuses declarable on a UI-19 (monthly UIF declaration to the UIF fund).
 *
 * Identical to the EMP201 set, for the same ledger reason rather than by
 * analogy: `payrollJournalPostingService` credits 2150 UIF Payable with the
 * run's full `total_uif`, and that journal is posted only by
 * `payrollApprovalService` at the APPROVE transition. A 'calculated' run has no
 * UIF liability in the general ledger, so declaring it would put UIF on the
 * UI-19 that the ledger does not carry — and `markUifDeclarationPaid` then
 * DEBITS 2150 for the declared total, driving the control account negative by
 * exactly the unposted amount.
 *
 * Aliased rather than re-declared so the two declarations cannot drift apart.
 */
export const UI19_DECLARABLE_STATUSES = EMP201_DECLARABLE_STATUSES;

export type Ui19DeclarableStatus = Emp201DeclarableStatus;
