/**
 * Finalise a VAT201 (wave 5 L1a): lock the period and record the version, or write nothing.
 *
 * The same gates as POST /vat-period-locks, in the same order: figures (computeVatLockFigures)
 * -> the 15% check -> assertVatGateClear (owner/admin override with a reason) -> lockVatPeriod.
 * The caller's savepoint (finaliseReturn) covers the override row, the lock and the version, so a
 * refusal leaves none of those rows (lockVatPeriod's auto-snapshot is scheduled after its own
 * insert and may still fire for a lock that then rolls back; that is a forensic copy, not a record).
 * A lock that already exists was not made by this finalise, so `created: false` is a 409; when a
 * version names that lock, the loser of a race is told so. The version row copies the lock row's
 * figures: nothing is computed a second time.
 */
import { computeVatLockFigures } from '@/modules/accounting/services/reports/vatPeriodLockFigures';
import { lockVatPeriod } from '@/modules/accounting/services/reports/vatPeriodLockService';
import { assertVatGateClear } from '@/modules/accounting/services/reports/vatGateOverrideService';
import { assertNoLiveOverlap, insertVersion, listVersionRows, nextVersion } from './returnVersionStore';
import { getVatReturnRecord } from './vatReturnRecord';
import {
  ReturnRefusal, type FinaliseOptions, type ReturnActor, type ReturnVersion, type VatReturnRecord,
} from './returnVersionTypes';

const OUTSIDE = 'This VAT period is already locked outside the return lifecycle. Unlock it first, then finalise.';

export async function finaliseVatReturn(
  companyId: string, periodStart: string, periodEnd: string, actor: ReturnActor, opts: FinaliseOptions,
): Promise<{ version: ReturnVersion; vatReturn: VatReturnRecord | null }> {
  const { figures, report } = await computeVatLockFigures(companyId, periodStart, periodEnd);
  // The exclusive VAT key is held now: a finalise that committed while this one waited is seen here.
  await assertNoLiveOverlap(companyId, 'VAT201', periodStart, periodEnd);
  if (report.rateCheck.ties === false && opts.force !== true) {
    throw new ReturnRefusal(400,
      `This period fails SARS's 15% check: box 1 is out by ${report.rateCheck.outputVariance} and input tax is `
      + `over-claimed by ${report.rateCheck.inputVariance} (summed per journal). Correct it, or finalise with force to record it.`);
  }
  const vatReturn = await getVatReturnRecord(companyId, periodStart, periodEnd, figures);
  const mismatched = vatReturn?.status === 'submitted' && vatReturn.mismatch;
  if (mismatched && !opts.acknowledgeVatReturnMismatch) {
    throw new ReturnRefusal(409,
      'A submitted VAT return on record for this period (the older vat_returns record) has different figures. '
      + 'Reconcile it, or finalise with acknowledgeVatReturnMismatch and a reason.');
  }

  await assertVatGateClear(
    companyId, periodStart, periodEnd, 'vat_period_lock', null,
    { userId: actor.userId, role: actor.role }, opts.overrideReason,
  );
  const { lock, created } = await lockVatPeriod(
    companyId, periodStart, periodEnd, figures, { userId: actor.userId, actorType: 'human' },
  );
  const existing = await listVersionRows(companyId, 'VAT201', periodStart, periodEnd);
  if (!created) {
    throw new ReturnRefusal(409, existing.some((v) => v.vatPeriodLockId === lock.id)
      ? 'This VAT201 was just finalised by another request.' : OUTSIDE);
  }
  const meta = mismatched && opts.acknowledgeVatReturnMismatch
    ? { vatReturnMismatch: { reason: opts.acknowledgeVatReturnMismatch.reason, acknowledgedBy: actor.userId, vatReturn } }
    : undefined;
  const version = await insertVersion({
    companyId, form: 'VAT201', periodStart, periodEnd, ...nextVersion(existing),
    figures: {
      outputTax: lock.outputTax, inputTax: lock.inputTax, netVat: lock.netVat, sarsFields: report.boxes,
      ...(meta ? { meta } : {}),
    },
    postedThrough: lock.postedThrough,
    vatPeriodLockId: lock.id,
    finalisedBy: actor.userId,
  });
  return { version, vatReturn };
}
