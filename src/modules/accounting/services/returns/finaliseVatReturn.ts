/**
 * Finalise a VAT201 (wave 5 L1a): lock the period and record the version, or write nothing.
 *
 * The same gates as POST /vat-period-locks, in the same order: figures
 * (computeVatLockFigures) -> the 15% check -> assertVatGateClear (owner/admin override with a
 * reason) -> lockVatPeriod. The caller's savepoint (finaliseReturn) covers the override row, the lock and the version. A lock that already exists was not made by this finalise (a version
 * would have refused first), so `created: false` is a 409 and rolls the override row back with it.
 * The version row copies the lock row's figures: nothing is computed a second time.
 */
import { computeVatLockFigures } from '@/modules/accounting/services/reports/vatPeriodLockFigures';
import { lockVatPeriod } from '@/modules/accounting/services/reports/vatPeriodLockService';
import { assertVatGateClear } from '@/modules/accounting/services/reports/vatGateOverrideService';
import { insertVersion, nextVersion } from './returnVersionStore';
import {
  ReturnRefusal, type FinaliseOptions, type ReturnActor, type ReturnVersion,
} from './returnVersionTypes';

const OUTSIDE = 'This VAT period is already locked outside the return lifecycle. Unlock it first, then finalise.';

export async function finaliseVatReturn(
  companyId: string, periodStart: string, periodEnd: string,
  actor: ReturnActor, existing: ReturnVersion[], opts: FinaliseOptions,
): Promise<ReturnVersion> {
  const { figures, report } = await computeVatLockFigures(companyId, periodStart, periodEnd);
  if (report.rateCheck.ties === false && opts.force !== true) {
    throw new ReturnRefusal(400,
      `This period fails SARS's 15% check: box 1 is out by ${report.rateCheck.outputVariance} and input tax is `
      + `over-claimed by ${report.rateCheck.inputVariance} (summed per journal). Correct it, or finalise with force to record it.`);
  }

  await assertVatGateClear(
    companyId, periodStart, periodEnd, 'vat_period_lock', null,
    { userId: actor.userId, role: actor.role }, opts.overrideReason,
  );
  const { lock, created } = await lockVatPeriod(
    companyId, periodStart, periodEnd, figures, { userId: actor.userId, actorType: 'human' },
  );
  if (!created) throw new ReturnRefusal(409, OUTSIDE);
  const next = nextVersion(existing);
  return insertVersion({
    companyId, form: 'VAT201', periodStart, periodEnd, ...next,
    figures: {
      outputTax: lock.outputTax, inputTax: lock.inputTax, netVat: lock.netVat, sarsFields: report.boxes,
    },
    postedThrough: lock.postedThrough,
    vatPeriodLockId: lock.id,
    finalisedBy: actor.userId,
  });
}
