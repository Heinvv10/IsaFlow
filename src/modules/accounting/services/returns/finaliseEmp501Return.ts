/**
 * Finalise an EMP501 (wave 6 EFb): the interim (March to August) or annual (March to February) reconciliation of a
 * PAYE tax year. Refused (409 EMP501_NOT_READY) while IRP5 pre-validation reports an error or a month with a pay run
 * has no filed EMP201, and (409) when no e@syFile file could be built. The version stores the file's whole input
 * (emp501Figures), so the filing file is built from what was finalised. The payroll approval lock is taken first, as
 * an EMP201 filing takes it: no approval or reopen lands between the checks and the insert. Nothing is written before
 * every check passes; finaliseReturn wraps the insert in its savepoint.
 */
import { fmtDate } from '@/lib/fmtDate';
import { lockCompanyPayrollApprovals } from '@/modules/accounting/services/payroll/payrollRunLock';
import { emp501PeriodOf, type Emp501Period } from '@/modules/accounting/services/payroll/emp501Period';
import { assertEmp501MatchesFiledEmp201s, assertEmp501Ready } from './emp501Readiness';
import { buildEmp501Figures } from './emp501Figures';
import { insertVersion, listVersionRows, nextVersion } from './returnVersionStore';
import { ReturnRefusal, type ReturnActor, type ReturnVersion } from './returnVersionTypes';

/** The EMP501 period of these dates, once it has ended; a 400 otherwise. */
export function assertEmp501Period(periodStart: string, periodEnd: string): Emp501Period {
  const p = emp501PeriodOf(periodStart, periodEnd);
  if (!p) {
    throw new ReturnRefusal(400, 'An EMP501 is the interim reconciliation (1 March to 31 August) or the annual one '
      + '(1 March to the end of February) of one tax year.');
  }
  if (periodEnd >= fmtDate(new Date())) throw new ReturnRefusal(400, 'An EMP501 can be finalised once its period has ended.');
  return p;
}

export async function finaliseEmp501Return(
  companyId: string, periodStart: string, periodEnd: string, actor: ReturnActor,
): Promise<ReturnVersion> {
  const p = assertEmp501Period(periodStart, periodEnd);
  await lockCompanyPayrollApprovals(null, companyId);
  const ready = await assertEmp501Ready(companyId, p);
  const figures = await buildEmp501Figures(companyId, p);
  // Only when every month's EMP201 has figures; an uncompared legacy month is a warning on the readiness instead.
  if (ready.crossChecked) await assertEmp501MatchesFiledEmp201s(companyId, p, figures.totals);
  const approved = figures.runs.map((r) => r.approvedAt).filter((a): a is string => a !== null).sort();
  const next = nextVersion(await listVersionRows(companyId, 'EMP501', periodStart, periodEnd));
  return insertVersion({
    companyId, form: 'EMP501', periodStart, periodEnd, ...next,
    figures: figures as unknown as Record<string, unknown>,
    postedThrough: approved[approved.length - 1] ?? new Date().toISOString(),
    vatPeriodLockId: null,
    finalisedBy: actor.userId,
  });
}
