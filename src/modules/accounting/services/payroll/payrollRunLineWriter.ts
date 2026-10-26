/**
 * A payroll run's lines, replaced as one unit when the run is calculated.
 * Extracted from payrollRunService (300-line cap).
 */

import { withTransaction } from '@/lib/neon';

export interface LineInsert {
  employeeId: string;
  grossPay: number; taxableIncome: number;
  /** taxableIncome split for the next period's year-to-date (migration 913, payrollYearToDate). */
  periodicTaxable: number; annualTaxable: number;
  paye: number;
  /** The medical scheme fees tax credit the PAYE took into account (migration 926, payeCumulative). */
  medicalCredit: number;
  /** The 65+ additional medical expenses tax credit the PAYE took into account (migration 926). */
  additionalMedicalCredit: number;
  /** Deductions coded 4005 on the line (migration 926). */
  medicalSchemeFees: number;
  /** Retirement fund contributions (4001/4003/4006) and the deduction the PAYE took into account (migration 948, payeCumulative). */
  retirementContributions: number; retirementDeduction: number;
  uifEmployee: number; uifEmployer: number;
  sdl: number; sdlLeviable: number;
  eti: number; netPay: number;
  componentBreakdown: string; validationResults: string;
}

export async function replaceRunLines(runId: string, companyId: string, lineInserts: LineInsert[]): Promise<void> {
  // All DB mutations in one transaction so a partial failure cannot corrupt
  // state — but via `withTransaction`, NEVER raw BEGIN/COMMIT.
  //
  // This used to issue `sql`BEGIN``/`sql`COMMIT`` directly. Those route onto
  // the ALS request client (`neon/query.ts` LazyQuery.run), which is the transaction
  // `withAuth` opens for every request — so the COMMIT committed the WHOLE
  // request, not this block: every earlier write in the request was made
  // durable, and any enclosing savepoint ceased to exist. On the MCP path that
  // destroyed the registry's per-tool savepoint, so a later failure could not
  // roll this back and the RELEASE SAVEPOINT afterwards errored into a generic
  // failure over lines that were already committed.
  //
  // `withTransaction` nests a SAVEPOINT when a request transaction is in
  // flight and opens a real transaction only when there is none, which is
  // correct under both callers.
  await withTransaction(async (tx) => {
    await tx`DELETE FROM payroll_run_lines WHERE run_id = ${runId}::uuid AND run_id IN (
      SELECT id FROM payroll_run_headers WHERE company_id = ${companyId}::uuid
    )`;

    for (const ins of lineInserts) {
      await tx`
        INSERT INTO payroll_run_lines (
          run_id, employee_id, gross_pay, taxable_income, periodic_taxable, annual_taxable, paye, medical_credit, additional_medical_credit, medical_scheme_fees,
          retirement_contributions, retirement_deduction, uif_employee, uif_employer, sdl, eti, net_pay,
          component_breakdown, validation_results, created_at
        ) VALUES (
          ${runId}::uuid, ${ins.employeeId}::uuid,
          ${ins.grossPay}, ${ins.taxableIncome}, ${ins.periodicTaxable}, ${ins.annualTaxable}, ${ins.paye}, ${ins.medicalCredit}, ${ins.additionalMedicalCredit}, ${ins.medicalSchemeFees},
          ${ins.retirementContributions}, ${ins.retirementDeduction}, ${ins.uifEmployee}, ${ins.uifEmployer},
          ${ins.sdl}, ${ins.eti}, ${ins.netPay},
          ${ins.componentBreakdown},
          ${ins.validationResults}, clock_timestamp()
        )
      `;
    }
  });
}
