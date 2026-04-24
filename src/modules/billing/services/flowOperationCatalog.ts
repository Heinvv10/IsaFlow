/**
 * PAYG Flow operation catalog.
 *
 * Single source of truth for "how many Flows does operation X cost?".
 * Wrapped metered routes MUST call `getFlowCost(code)` rather than hard-coding
 * the integer — that way a price change is a one-line diff here.
 *
 * Categories follow the spec (docs/superpowers/specs/2026-04-19-payg-flows-pricing-design.md §4):
 *   basic    = 1  Flow  (bank import / view / match / recon tick)
 *   standard = 3  Flows (create invoice / capture bill / record payment / manual JE)
 *   advanced = 10 Flows (TB / P&L / BS / age analysis / VAT return / year-end close)
 *   premium  = 50 Flows (AFS pack / statutory compliance / audit trail export)
 */

export type FlowCategory = 'basic' | 'standard' | 'advanced' | 'premium';

export interface FlowOperation {
  cost: number;
  category: FlowCategory;
}

export const FLOW_OPERATIONS = {
  'bank.import':          { cost: 1,  category: 'basic' },
  'bank.allocate':        { cost: 1,  category: 'basic' },
  'invoice.create':       { cost: 3,  category: 'standard' },
  'supplier.bill.create': { cost: 3,  category: 'standard' },
  'payment.record':       { cost: 3,  category: 'standard' },
  'journal.create':       { cost: 3,  category: 'standard' },
  'report.tb':            { cost: 10, category: 'advanced' },
  'report.pnl':           { cost: 10, category: 'advanced' },
  'report.bs':            { cost: 10, category: 'advanced' },
  'report.age':           { cost: 10, category: 'advanced' },
  'vat.return':           { cost: 10, category: 'advanced' },
  'yearend.close':        { cost: 10, category: 'advanced' },
  'afs.generate':         { cost: 50, category: 'premium' },
  'compliance.export':    { cost: 50, category: 'premium' },
  'audit.export':         { cost: 50, category: 'premium' },
} as const satisfies Record<string, FlowOperation>;

export type FlowOperationCode = keyof typeof FLOW_OPERATIONS;

export function getFlowCost(code: FlowOperationCode): number {
  return FLOW_OPERATIONS[code].cost;
}

export function getFlowCategory(code: FlowOperationCode): FlowCategory {
  return FLOW_OPERATIONS[code].category;
}

export function isFlowOperation(code: string): code is FlowOperationCode {
  return code in FLOW_OPERATIONS;
}
