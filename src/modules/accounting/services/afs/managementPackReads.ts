// src/modules/accounting/services/afs/managementPackReads.ts
// How the generator reads a report for a pack section. A read that fails leaves its section saying so and
// does not stop the pack (the budget path's rule: a refusal is a warning, any other fault is also reported to
// Bugsink). The savepoint keeps a failed query from aborting the request's transaction, so each read runs
// alone and the reads of one section run one after another: none can land after a ROLLBACK TO.
import { log } from '@/lib/logger';
import { withSavepoint } from '@/lib/neon';
import { MissingSystemAccountError } from '../gl/systemAccountKeys';
import { getARAging } from '../ar/arAgingService';
import { getAPAging } from '../ap/apAgingService';
import { getUnappliedByEntity } from '../shared/agedNetting';
import { getReconciliations } from '../bank/bankReconciliationService';
import { getBankAccountsStatus } from '../bank/bankAccountStatusService';
import { capturePackFault } from './managementPackComparison';
import type { AgeingData, ReconciliationData } from './managementPackReportSections';

/** The generator's logger component, which the log assertions and the log search both know. */
const COMPONENT = 'managementPackGeneratorService';

export async function readSafely<T>(
  ctx: { companyId: string; period: string },
  name: string,
  read: () => Promise<T>,
): Promise<T | null> {
  try {
    return await withSavepoint(`mgmt_pack_${name}`, read);
  } catch (err) {
    const fields = { ...ctx, statement: name, errorClass: err instanceof Error ? err.name : typeof err, error: err instanceof Error ? err.message : String(err) };
    if (err instanceof MissingSystemAccountError) {
      log.warn(`management pack: the ${name} report could not be read (no system account); its section says so`, fields, COMPONENT);
    } else {
      log.error(`management pack: the ${name} report read failed; its section says so`, fields, COMPONENT);
      capturePackFault(err, ctx.companyId);
    }
    return null;
  }
}

type Ctx = { companyId: string; period: string };

/** The Aged Debtors / Aged Creditors services' rows as at the month end, and the credit that sits unapplied against them. */
export function readAgeing(ctx: Ctx, side: 'ar' | 'ap', asAt: string): Promise<AgeingData | null> {
  return readSafely(ctx, side === 'ar' ? 'debtors_ageing' : 'creditors_ageing', async () => {
    const buckets = side === 'ar' ? await getARAging(ctx.companyId, asAt) : await getAPAging(ctx.companyId, asAt);
    const unapplied = [...(await getUnappliedByEntity(ctx.companyId, side, asAt)).values()].reduce((sum, u) => sum + u.total, 0);
    return { asAt, buckets, unapplied: Math.round(unapplied * 100) / 100 };
  });
}

/** Every reconciliation session, beside the company's bank accounts (so one never reconciled is not silently absent). */
export function readReconciliations(ctx: Ctx): Promise<ReconciliationData | null> {
  return readSafely(ctx, 'bank_reconciliation', async () => ({
    sessions: await getReconciliations(ctx.companyId),
    accounts: (await getBankAccountsStatus(ctx.companyId)).map((a) => ({ id: a.id, name: a.accountName })),
  }));
}
