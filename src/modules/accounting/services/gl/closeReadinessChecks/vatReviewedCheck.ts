/**
 * VAT reviewed close-readiness check.
 *
 * A VAT return is considered reviewed when a VAT201 filing (vatPeriodFilings: a finalised or filed version, or a
 * legacy vat_returns record for a period before the lifecycle) has a period that overlaps this fiscal period.
 * Missing = warn (not fail) because some periods may be VAT-exempt.
 */

import { vatPeriodFilings } from '../../returns/vatPeriodFilings';
import type { ChecklistItem } from '../periodCloseReadinessService';

export async function vatReviewedCheck(
  companyId: string,
  period: { startDate: string; endDate: string },
): Promise<ChecklistItem> {
  const count = (await vatPeriodFilings([companyId], { from: period.startDate, to: period.endDate })).length;

  if (count > 0) {
    return {
      key: 'vat_reviewed',
      label: 'VAT reviewed',
      status: 'pass',
      reason: 'A VAT201 covering this period has been finalised or submitted.',
      fixHref: '/accounting/sars/vat201',
    };
  }

  return {
    key: 'vat_reviewed',
    label: 'VAT reviewed',
    status: 'warn',
    reason: 'No VAT return has been submitted for this period yet.',
    fixHref: '/accounting/sars/vat201',
  };
}
