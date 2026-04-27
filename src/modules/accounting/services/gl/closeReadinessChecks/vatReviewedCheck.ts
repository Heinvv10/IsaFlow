/**
 * VAT reviewed close-readiness check.
 *
 * A VAT return is considered reviewed when a vat_returns record exists whose
 * period overlaps with this fiscal period.  Missing = warn (not fail) because
 * some periods may be VAT-exempt.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import type { ChecklistItem } from '../periodCloseReadinessService';

type Row = DbRow;

export async function vatReviewedCheck(
  companyId: string,
  period: { startDate: string; endDate: string },
): Promise<ChecklistItem> {
  const rows = (await sql`
    SELECT COUNT(*) AS vat_count
    FROM vat_returns
    WHERE company_id = ${companyId}::UUID
      AND period_start <= ${period.endDate}::date
      AND period_end >= ${period.startDate}::date
  `) as Row[];

  const count = Number(rows[0]?.vat_count ?? 0);

  if (count > 0) {
    return {
      key: 'vat_reviewed',
      label: 'VAT reviewed',
      status: 'pass',
      reason: 'At least one VAT return has been submitted covering this period.',
      fixHref: '/accounting/reports/vat-return',
    };
  }

  return {
    key: 'vat_reviewed',
    label: 'VAT reviewed',
    status: 'warn',
    reason: 'No VAT return has been submitted for this period yet.',
    fixHref: '/accounting/reports/vat-return',
  };
}
