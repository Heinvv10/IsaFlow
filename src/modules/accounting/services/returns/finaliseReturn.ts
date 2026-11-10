/** finaliseReturn: the entry point for L1a's route (wave 5). Judges everything before the first write. */
import { withSavepoint } from '@/lib/neon';
import { assertNotImpersonating } from '@/lib/auth/impersonationGuard';
import { reportWindowProblem } from '@/lib/validation';
import { takeDraftPeriodLock } from '@/modules/accounting/services/reports/sarsComplianceService';
import { periodSendUncertain } from '@/modules/accounting/services/reports/sarsEfilingRepo';
import { finaliseVatReturn } from './finaliseVatReturn';
import { finaliseEmpReturn } from './finaliseEmpReturn';
import { assertNoLiveOverlap } from './returnVersionStore';
import { assertEmpPeriod, assertVatPeriodShape } from './returnPeriod';
import {
  ReturnRefusal, type FinaliseOptions, type ReturnActor, type ReturnForm, type ReturnVersion, type VatReturnRecord,
} from './returnVersionTypes';

export { ReturnRefusal } from './returnVersionTypes';

const PG_UNIQUE_VIOLATION = '23505';

export interface FinaliseResult {
  version: ReturnVersion;
  /** VAT201 only: the older vat_returns record for the period, with its mismatch flag. */
  vatReturn: VatReturnRecord | null;
}

export async function finaliseReturn(
  companyId: string, form: ReturnForm, periodStart: string, periodEnd: string,
  actor: ReturnActor, opts: FinaliseOptions = {},
): Promise<FinaliseResult> {
  await assertNotImpersonating(); // R-032: a filing control is refused to a Login-as session
  const problem = reportWindowProblem(periodStart, periodEnd);
  if (problem) throw new ReturnRefusal(400, problem);
  if (form === 'EMP201') assertEmpPeriod(periodStart, periodEnd);
  else await assertVatPeriodShape(companyId, periodStart, periodEnd);
  // The draft-period key a filing, a draft save and an ISV send of this period hold: a finalise cannot interleave with
  // a send in flight. Taken before the VAT key (computeVatLockFigures) and before any version row.
  await takeDraftPeriodLock(companyId, form, periodStart, periodEnd);
  // Not while a send to SARS may have reached it: finalising locks the period, and the send's verdict would land in a lifecycle period.
  const doubt = await periodSendUncertain(companyId, form, periodStart, periodEnd);
  if (doubt) {
    throw new ReturnRefusal(409, 'A send to SARS for this period may have reached it'
      + `${doubt.correlationId ? ` (correlation id ${doubt.correlationId})` : ''}: poll or reconcile it before finalising.`, 'SEND_UNCERTAIN');
  }
  await assertNoLiveOverlap(companyId, form, periodStart, periodEnd);

  try {
    // One savepoint around the whole finalise: a refusal after a write (a lost race on the unique
    // index, a lock that was not ours) leaves no lock, no override row and no version, even though
    // withAuth commits a 4xx. lockVatPeriod's auto-snapshot is scheduled after its insert and may
    // still fire for a lock that then rolls back.
    return await withSavepoint('finalise_return', async () => (form === 'VAT201'
      ? finaliseVatReturn(companyId, periodStart, periodEnd, actor, opts)
      : { version: await finaliseEmpReturn(companyId, periodStart, periodEnd, actor), vatReturn: null }));
  } catch (err) {
    if ((err as { code?: string }).code === PG_UNIQUE_VIOLATION) {
      throw new ReturnRefusal(409, `Another finalise of this ${form} just landed. Reload to see it.`);
    }
    throw err;
  }
}
