import { createHash } from 'node:crypto';
import { canonicalJson } from './canonical';
import type { ControlTx } from './contracts';
import type { PayrollRow } from './payrollSourceMaterial';
type Sources = Record<string, unknown> & { header: PayrollRow; lines: readonly PayrollRow[] };
// SA payroll engines apply rand-denominated SARS/UIF thresholds; there is no payroll FX model.
export const PAYROLL_CALCULATION_CURRENCY = 'ZAR';
export interface PayrollCalculationHashes { input_hash:string;output_hash:string }
const inputKeys=['employees','components','assignments','allocations','mappings','centres','loans','loanSchedules','loanPayments','leaveTypes','leaveBalances','bankDetails'] as const;
const outputKeys=['period_month','period_year','total_gross','total_taxable','total_paye','total_uif','total_sdl','total_eti','total_net','employee_count'] as const;
const digest=(value:unknown)=>createHash('sha256').update(canonicalJson(value)).digest('hex');
/** Workflow timestamps/status/journal linkage are not calculation outputs. */
export function payrollCalculationHashes(sources:Sources):PayrollCalculationHashes {
  return {input_hash:digest({calculationCurrency:PAYROLL_CALCULATION_CURRENCY,inputs:Object.fromEntries(inputKeys.map(key=>[key,sources[key] ?? []]))}),
    output_hash:digest({header:Object.fromEntries(outputKeys.filter(key=>sources.header[key]!==undefined).map(key=>[key,sources.header[key]])),lines:sources.lines})};
}
export function assertPayrollCalculationReceipt(sources:Sources,receipt:PayrollCalculationHashes|null):void {
  const hashes=payrollCalculationHashes(sources);
  if(!receipt || receipt.input_hash!==hashes.input_hash || receipt.output_hash!==hashes.output_hash) {
    throw new Error('Payroll calculation is unknown or stale; recalculate before approval or posting');
  }
}
export async function readPayrollCalculationReceipt(ctx:ControlTx,runId:string):Promise<PayrollCalculationHashes|null> {
  const rows=await ctx.sql`SELECT input_hash,output_hash FROM control_payroll_calculations
    WHERE company_id=${ctx.principal.companyId}::uuid AND run_id=${runId}::uuid
    ORDER BY calculation_version DESC LIMIT 1` as PayrollCalculationHashes[];
  return rows[0] ?? null;
}
