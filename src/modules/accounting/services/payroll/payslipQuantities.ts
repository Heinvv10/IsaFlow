/**
 * Hours and days captured on a pay run line (BCEA s33(1)(g): hours worked and overtime hours).
 *
 * Read from the line's STORED `component_breakdown` only, never from the employee's live component assignments:
 * a FINAL slip must not change because someone edits or ends an assignment afterwards. An item carries
 * `quantity` and `quantityUnit` ('hour' | 'day') when the run costed it with hours (stamped at calculation time;
 * a run without any prints "Not recorded"; an entered 0 prints "0 hours worked").
 *
 * Ordinary hours are summed from SARS 3601 items with one unit, overtime from 3607 items with one unit. Any other
 * code is not read. Hours and days of one code are never summed (that would invent a figure): that code is null.
 */
import { readBreakdown } from './payslipItems';

export interface WorkedQuantity {
  quantity: number;
  unit: 'hour' | 'day';
}

export interface PayslipQuantities {
  ordinary: WorkedQuantity | null;
  overtime: WorkedQuantity | null;
}

const BASIC_PAY = '3601';
const OVERTIME = '3607';

interface Captured { code: string; quantity: number; unit: 'hour' | 'day' }

function captured(breakdown: unknown): Captured[] {
  const out: Captured[] = [];
  for (const item of readBreakdown(breakdown) as unknown as Array<Record<string, unknown>>) {
    const quantity = item.quantity;
    const unit = item.quantityUnit;
    // A JSON number only: true, "8" or null are not a captured quantity. 0 is: an entered nil (HD) was worked as nothing, said on the slip.
    if ((unit === 'hour' || unit === 'day') && typeof quantity === 'number' && Number.isFinite(quantity) && quantity >= 0) {
      out.push({ code: String(item.sarsSourceCode ?? '').trim(), quantity, unit });
    }
  }
  return out;
}

function total(rows: Captured[]): WorkedQuantity | null {
  if (rows.length === 0 || new Set(rows.map((r) => r.unit)).size !== 1) return null;
  const quantity = Math.round(rows.reduce((s, r) => s + r.quantity, 0) * 100) / 100;
  return { quantity, unit: rows[0]!.unit };
}

export function quantitiesFromBreakdown(breakdown: unknown): PayslipQuantities {
  const rows = captured(breakdown);
  return {
    ordinary: total(rows.filter((r) => r.code === BASIC_PAY)),
    overtime: total(rows.filter((r) => r.code === OVERTIME)),
  };
}
