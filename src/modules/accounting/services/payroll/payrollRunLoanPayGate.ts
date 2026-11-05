import type { TxSql } from '@/lib/neon';
import { applyLoanToRun, type ApplyLoanResult } from './payrollLoanService';
import { previewLoanToRun } from './payrollLoanPreview';
import { withholdingFor, type LoanComponentsPresent, type WithheldLoan } from './payrollLoanWithholding';
import { fringeOnlyLoanApplications } from './payrollRunLoanComponents';

export interface RunLoanPayInput {
  companyId: string; runId: string; periodYear: number; periodMonth: number; officialRate: number;
  employeeIds: ReadonlySet<string>;
  components: LoanComponentsPresent;
  onWithheld?: (withheld: WithheldLoan) => void;
  judgePay?: (employeeId: string, applications: ApplyLoanResult[]) => { allowed: boolean; rawNet: number };
  onPayBlocked?: (employeeId: string, applications: ApplyLoanResult[], rawNet: number) => void;
}

export async function applyPayableLoanCandidates(
  input: RunLoanPayInput,
  active: Array<{ loanId: string; employeeId: string }>,
  tx: TxSql,
): Promise<{ byEmployee: Map<string, ApplyLoanResult[]>; blocked: Set<string>; withheld: Map<string, WithheldLoan> }> {
  const candidates = new Map<string, ApplyLoanResult[]>();
  const withheld = new Map<string, WithheldLoan>();
  for (const row of active) {
    if (!input.employeeIds.has(row.employeeId)) continue;
    const loan = {
      loanId: row.loanId, companyId: input.companyId, runId: input.runId,
      periodYear: input.periodYear, periodMonth: input.periodMonth, officialRate: input.officialRate,
    };
    const held = await withholdingFor(loan, input.components, tx);
    if (held) {
      withheld.set(held.loanId, held);
      input.onWithheld?.(held);
      continue;
    }
    const candidate = await previewLoanToRun(loan, tx);
    if (candidate) candidates.set(candidate.employeeId, [...(candidates.get(candidate.employeeId) ?? []), candidate]);
  }

  const byEmployee = new Map<string, ApplyLoanResult[]>();
  const blocked = new Set<string>();
  for (const [employeeId, applications] of candidates) {
    const decision = input.judgePay?.(employeeId, applications) ?? { allowed: true, rawNet: 0 };
    if (!decision.allowed) {
      blocked.add(employeeId);
      input.onPayBlocked?.(employeeId, applications, decision.rawNet);
      byEmployee.set(employeeId, fringeOnlyLoanApplications(applications));
      continue;
    }
    for (const candidate of applications) {
      const applied = await applyLoanToRun({
        loanId: candidate.loanId, companyId: input.companyId, runId: input.runId,
        periodYear: input.periodYear, periodMonth: input.periodMonth, officialRate: input.officialRate,
      }, tx);
      if (applied) byEmployee.set(employeeId, [...(byEmployee.get(employeeId) ?? []), applied]);
    }
  }
  return { byEmployee, blocked, withheld };
}
