/**
 * The EMP201's UIF split from the stored lines (wave 6 EF). Each line stores `uif_employee` (withheld from the
 * employee) and `uif_employer` (the employer's own contribution); the header stores only their sum (`total_uif`).
 * The EMP201 used to halve `total_uif`, which is wrong for any line whose two parts differ (a legacy import, a
 * contractor or exempt line with only one part). The split is now the lines' own sums, per run.
 *
 * `payroll_run_lines` has no company_id: the INNER join to the header and the header's company predicate are the
 * tenant boundary. A run whose line sums differ from its header's `total_uif` is named (the header is what the
 * journal posted to 2150 UIF Payable, so it stays the EMP201 total).
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';

export interface RunLineUif {
  employee: number;
  employer: number;
}

export async function loadRunLineUif(companyId: string, runIds: string[]): Promise<Map<string, RunLineUif>> {
  const out = new Map<string, RunLineUif>();
  if (runIds.length === 0) return out;
  const rows = (await sql`
    SELECT prh.id::text AS run_id,
           COALESCE(SUM(prl.uif_employee), 0)::numeric AS uif_employee,
           COALESCE(SUM(prl.uif_employer), 0)::numeric AS uif_employer
      FROM payroll_run_headers prh
      JOIN payroll_run_lines prl ON prl.run_id = prh.id
     WHERE prh.company_id = ${companyId}::uuid
       AND prh.id = ANY(${runIds}::uuid[])
     GROUP BY prh.id
  `) as DbRow[];
  for (const r of rows) out.set(String(r.run_id), { employee: Number(r.uif_employee) || 0, employer: Number(r.uif_employer) || 0 });
  return out;
}

/** Named when a run's line split does not add up to the header total the journal posted. */
export function uifSplitMismatchWarning(month: string, headerTotal: number, lines: RunLineUif): string | null {
  const sum = Math.round((lines.employee + lines.employer) * 100) / 100;
  if (Math.abs(sum - Math.round(headerTotal * 100) / 100) < 0.005) return null;
  return `The pay run for ${month} stores UIF of R${headerTotal.toFixed(2)} on its header but R${sum.toFixed(2)} on its `
    + `lines (employee R${lines.employee.toFixed(2)}, employer R${lines.employer.toFixed(2)}); the EMP201 total is the header's.`;
}
