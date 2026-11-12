/** Whether a return version of ANY status covers (overlaps) a period: such a period is filed through the lifecycle. */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';

export async function periodHasReturnVersion(
  companyId: string, form: string, periodStart: string, periodEnd: string,
): Promise<boolean> {
  const rows = (await sql`
    SELECT 1 FROM tax_return_versions
    WHERE company_id = ${companyId}::UUID AND form_type = ${form}
      AND period_start <= ${periodEnd}::DATE AND period_end >= ${periodStart}::DATE
    LIMIT 1
  `) as DbRow[];
  return rows.length > 0;
}
