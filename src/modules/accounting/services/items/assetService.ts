/**
 * Asset Service — Fixed Asset Register & Depreciation
 * Provides depreciation calculations, validation, and SARS wear-and-tear rates.
 * Pure business logic — no database dependencies (testable without DB).
 */

import { annualPolicyCharge, type DepreciationMethod } from './depreciationMethods';

export type { DepreciationMethod };
export type AssetStatus = 'available' | 'assigned' | 'in_maintenance' | 'disposed' | 'written_off';
export type DisposalMethod = 'sale' | 'scrap' | 'write_off' | 'donation' | 'theft' | 'insurance_claim';
export type SarsCategory = keyof typeof SARS_WEAR_AND_TEAR;

export interface DepreciationInput {
  cost: number;
  salvageValue: number;
  usefulLifeYears: number;
  monthsElapsed: number;
  method: DepreciationMethod | string;
  accumulatedDepreciation?: number;
  sarsCategory?: string;
}

export interface DepreciationResult {
  monthlyAmount: number;
  annualAmount: number;
  annualRate: number;
  method: DepreciationMethod;
  remainingMonths: number;
}

export interface AssetInput {
  name: string;
  category: string;
  purchaseDate: string;
  cost: number;
  salvageValue: number;
  usefulLifeYears: number;
  depreciationMethod: DepreciationMethod | string;
  location?: string;
  status?: AssetStatus | string;
  description?: string;
  serialNumber?: string;
  sarsCategory?: string;
}

export interface DisposalInput {
  assetId: string;
  disposalDate: string;
  disposalMethod: DisposalMethod | string;
  disposalAmount: number;
  reason: string;
}

export interface ValidationResult {
  success: boolean;
  errors?: Array<{ field: string; message: string }>;
}

export const SARS_WEAR_AND_TEAR = {
  computers: { rate: 33.33, years: 3, description: 'Computers, laptops, tablets, and peripheral devices' },
  motor_vehicles: { rate: 20, years: 5, description: 'Motor vehicles used for business purposes' },
  furniture: { rate: 16.67, years: 6, description: 'Office furniture, desks, chairs, shelving' },
  office_equipment: { rate: 20, years: 5, description: 'Printers, copiers, telephones, fax machines' },
  buildings: { rate: 5, years: 20, description: 'Commercial buildings and improvements' },
  machinery: { rate: 12.5, years: 8, description: 'General machinery and plant equipment' },
  manufacturing_equipment: { rate: 25, years: 4, description: 'Manufacturing plant and equipment (Section 12C)' },
  small_tools: { rate: 50, years: 2, description: 'Small tools, implements, and utensils' },
  aircraft: { rate: 25, years: 4, description: 'Aircraft used for business purposes' },
  electronic_equipment: { rate: 25, years: 4, description: 'Electronic equipment, servers, networking gear' },
  signage: { rate: 10, years: 10, description: 'Business signage, billboards, displays' },
  leasehold_improvements: { rate: 20, years: 5, description: 'Leasehold improvements (or lease term if shorter)' },
} as const;

const CATEGORY_PREFIXES: Record<string, string> = {
  computers: 'COMP', motor_vehicles: 'VEHI', furniture: 'FURN', office_equipment: 'OFEQ',
  buildings: 'BLDG', machinery: 'MACH', manufacturing_equipment: 'MFEQ', small_tools: 'TOOL',
  aircraft: 'AIRC', electronic_equipment: 'ELEC', signage: 'SIGN', leasehold_improvements: 'LSIM',
};

export function generateAssetNumber(category: string, existingCount: number): string {
  const prefix = CATEGORY_PREFIXES[category] || 'ASST';
  return `${prefix}-${String(existingCount + 1).padStart(4, '0')}`;
}

interface CalcInput {
  cost: number;
  salvageValue: number;
  usefulLifeYears: number;
  monthsElapsed: number;
  accumulatedDepreciation?: number;
}

/**
 * One implementation, three methods. `annualPolicyCharge` in
 * `depreciationMethods.ts` is the single schedule the monthly run, the dry-run
 * preview, the CSV export and the asset detail page all read, so no two of them
 * can quote a different number for the same asset. These wrappers keep this
 * module's (cost, salvageValue, monthsElapsed) shape for its existing callers.
 */
function calcByMethod(input: CalcInput, method: DepreciationMethod): DepreciationResult {
  const { cost, salvageValue, usefulLifeYears, monthsElapsed, accumulatedDepreciation } = input;
  if (usefulLifeYears <= 0 || cost <= salvageValue) {
    return { monthlyAmount: 0, annualAmount: 0, annualRate: 0, method, remainingMonths: 0 };
  }
  const totalMonths = usefulLifeYears * 12;
  const remainingMonths = Math.max(0, totalMonths - monthsElapsed);
  const annualDep = annualPolicyCharge({
    method, cost, residual: salvageValue, usefulLifeYears, monthsElapsed,
  });
  const annualRate = Math.round((annualDep / cost) * 100 * 100) / 100;
  if (remainingMonths <= 0 || annualDep <= 0) {
    return { monthlyAmount: 0, annualAmount: 0, annualRate, method, remainingMonths: 0 };
  }
  let monthlyDep = Math.round((annualDep / 12) * 100) / 100;
  if (accumulatedDepreciation !== undefined) {
    const remaining = Math.round((cost - salvageValue - accumulatedDepreciation) * 100) / 100;
    if (remaining <= 0) {
      return { monthlyAmount: 0, annualAmount: 0, annualRate, method, remainingMonths: 0 };
    }
    // Same final-month true-up the run applies, so this returns the figure the
    // GL will actually carry rather than one cent-fraction short of it.
    if (monthsElapsed === Math.round(totalMonths) - 1) monthlyDep = remaining;
    monthlyDep = Math.min(monthlyDep, remaining);
  }
  return {
    monthlyAmount: monthlyDep,
    annualAmount: Math.round(annualDep * 100) / 100,
    annualRate,
    method,
    remainingMonths,
  };
}

export function calculateStraightLine(input: CalcInput): DepreciationResult {
  return calcByMethod(input, 'straight_line');
}

export function calculateReducingBalance(input: CalcInput): DepreciationResult {
  return calcByMethod(input, 'reducing_balance');
}

export function calculateSumOfYears(input: CalcInput): DepreciationResult {
  return calcByMethod(input, 'sum_of_years');
}

export function calculateDepreciation(input: DepreciationInput): DepreciationResult {
  const calcInput: CalcInput = { cost: input.cost, salvageValue: input.salvageValue, usefulLifeYears: input.usefulLifeYears, monthsElapsed: input.monthsElapsed, accumulatedDepreciation: input.accumulatedDepreciation };
  switch (input.method) {
    case 'reducing_balance': return calculateReducingBalance(calcInput);
    case 'sum_of_years': return calculateSumOfYears(calcInput);
    case 'straight_line':
    default: return calculateStraightLine(calcInput);
  }
}

const VALID_DEPRECIATION_METHODS: DepreciationMethod[] = ['straight_line', 'reducing_balance', 'sum_of_years'];
const VALID_STATUSES: AssetStatus[] = ['available', 'assigned', 'in_maintenance', 'disposed', 'written_off'];
const VALID_DISPOSAL_METHODS: DisposalMethod[] = ['sale', 'scrap', 'write_off', 'donation', 'theft', 'insurance_claim'];

export function validateAsset(input: AssetInput): ValidationResult {
  const errors: Array<{ field: string; message: string }> = [];
  if (!input.name || input.name.trim() === '') errors.push({ field: 'name', message: 'Asset name is required' });
  if (input.cost === undefined || input.cost === null || input.cost <= 0) errors.push({ field: 'cost', message: 'Cost must be greater than zero' });
  if (input.salvageValue !== undefined && input.salvageValue > input.cost) errors.push({ field: 'salvageValue', message: 'Salvage value cannot exceed cost' });
  if (!input.usefulLifeYears || input.usefulLifeYears <= 0) errors.push({ field: 'usefulLifeYears', message: 'Useful life must be greater than zero' });
  if (input.depreciationMethod && !VALID_DEPRECIATION_METHODS.includes(input.depreciationMethod as DepreciationMethod)) errors.push({ field: 'depreciationMethod', message: 'Invalid depreciation method' });
  if (input.status && !VALID_STATUSES.includes(input.status as AssetStatus)) errors.push({ field: 'status', message: 'Invalid asset status' });
  if (input.purchaseDate) {
    const parsed = new Date(input.purchaseDate);
    if (isNaN(parsed.getTime())) { errors.push({ field: 'purchaseDate', message: 'Invalid date format' }); }
    else { const today = new Date(); today.setHours(23, 59, 59, 999); if (parsed > today) errors.push({ field: 'purchaseDate', message: 'Purchase date cannot be in the future' }); }
  }
  return { success: errors.length === 0, ...(errors.length > 0 ? { errors } : {}) };
}

export function validateDisposal(input: DisposalInput): ValidationResult {
  const errors: Array<{ field: string; message: string }> = [];
  if (!input.assetId || input.assetId.trim() === '') errors.push({ field: 'assetId', message: 'Asset ID is required' });
  if (input.disposalAmount < 0) errors.push({ field: 'disposalAmount', message: 'Disposal amount cannot be negative' });
  if (!input.reason || input.reason.trim() === '') errors.push({ field: 'reason', message: 'Disposal reason is required' });
  if (input.disposalMethod && !VALID_DISPOSAL_METHODS.includes(input.disposalMethod as DisposalMethod)) errors.push({ field: 'disposalMethod', message: 'Invalid disposal method' });
  if (input.disposalDate) { const parsed = new Date(input.disposalDate); if (isNaN(parsed.getTime())) errors.push({ field: 'disposalDate', message: 'Invalid date format' }); }
  return { success: errors.length === 0, ...(errors.length > 0 ? { errors } : {}) };
}
