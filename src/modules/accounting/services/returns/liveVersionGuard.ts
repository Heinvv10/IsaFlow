/**
 * A VAT lock that a live return version names is released by an amend, never directly (wave 5 L1b).
 * Called by unlockVatPeriod after it holds the lock row FOR UPDATE and before it writes: a finalise
 * inserting a version waits on that row (the same-company trigger takes it FOR SHARE), and amendReturn
 * supersedes the version first, so a lock released through the lifecycle passes.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { VatPeriodLockRefusal } from '@/modules/accounting/services/reports/vatPeriodLockBounds';

/** Maps to 409 in the unlock route: the caller must amend the return instead. */
export class VatPeriodAmendRequired extends VatPeriodLockRefusal {
  constructor() {
    super('This period has a final VAT201. Amend the return instead of unlocking the period.');
    this.name = 'VatPeriodAmendRequired';
  }
}

export async function assertLockNotInLiveVersion(companyId: string, lockId: string): Promise<void> {
  const rows = (await sql`
    SELECT 1 FROM tax_return_versions
    WHERE company_id = ${companyId}::UUID AND vat_period_lock_id = ${lockId}::UUID AND status <> 'superseded'
    LIMIT 1
  `) as DbRow[];
  if (rows.length > 0) throw new VatPeriodAmendRequired();
}
