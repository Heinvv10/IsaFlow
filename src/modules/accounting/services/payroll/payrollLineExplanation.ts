/**
 * One run line's stored explanation (wave 5 EX-core, migration 973), for GET /api/payroll/runs/[id]/explanation.
 *
 * Read as stored: nothing is recomputed. A line costed before the column has none: the reader says whether the run is
 * final (isPayRunFinal, as the payslips decide it), so the UI can say "recalculate" for a draft and "not recorded for
 * runs costed before <date>" for a final run, the date being the one migration 973 wrote into the column's comment.
 * Another company's run, a cancelled run, or an employee not on the run is not found.
 */
import { sql } from '@/lib/neon';
import { isPayRunFinal } from './payslipFinal';
import type { LineExplanations } from './payrollExplainTypes';

export class LineExplanationNotFound extends Error {
  constructor() {
    super('Pay run line not found');
    this.name = 'LineExplanationNotFound';
  }
}

export type LineExplanationRead =
  | { state: 'recorded'; final: boolean; explanations: LineExplanations }
  | { state: 'not_recorded'; final: boolean; recordedFrom: string | null };

interface Row { explanation: unknown }

const isExplanations = (v: unknown): v is LineExplanations =>
  typeof v === 'object' && v !== null && (v as { schema?: unknown }).schema === 1
  && ['paye', 'uif', 'sdl', 'eti'].every(f => typeof (v as Record<string, unknown>)[f] === 'object');

/** The date migration 973 added the column, from its comment ("Recorded from YYYY-MM-DD."), or null if unreadable. */
export async function explanationRecordedFrom(): Promise<string | null> {
  const rows = (await sql`
    SELECT col_description(a.attrelid, a.attnum) AS comment
      FROM pg_attribute a
     WHERE a.attrelid = 'public.payroll_run_lines'::regclass AND a.attname = 'explanation' AND NOT a.attisdropped
  `) as Array<{ comment: string | null }>;
  const m = /Recorded from (\d{4}-\d{2}-\d{2})/.exec(rows[0]?.comment ?? '');
  return m ? m[1]! : null;
}

export async function getLineExplanation(companyId: string, runId: string, employeeId: string): Promise<LineExplanationRead> {
  const rows = (await sql`
    SELECT l.explanation
      FROM payroll_run_lines l
      JOIN payroll_run_headers h ON h.id = l.run_id
     WHERE l.run_id = ${runId}::uuid AND l.employee_id = ${employeeId}::uuid
       AND h.company_id = ${companyId}::uuid AND h.status <> 'cancelled'
  `) as Row[];
  if (rows.length === 0) throw new LineExplanationNotFound();
  const final = await isPayRunFinal(companyId, runId);
  const stored = rows[0]!.explanation;
  if (isExplanations(stored)) return { state: 'recorded', final, explanations: stored };
  return { state: 'not_recorded', final, recordedFrom: await explanationRecordedFrom() };
}
