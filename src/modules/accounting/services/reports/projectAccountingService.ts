/**
 * Project Accounting & Job Costing Service
 * Profitability, WIP, time billing, validation.
 * Pure business logic — no database dependencies.
 */

export type BillingMethod = 'time_and_materials' | 'fixed_price' | 'milestone' | 'retainer';

export interface ProjectFinancials {
  totalRevenue: number;
  totalLabourCost: number;
  totalExpenses: number;
  totalMaterialCost: number;
}

export interface ProfitabilityResult {
  totalCost: number;
  grossProfit: number;
  profitMargin: number;
  labourPercent: number;
  expensePercent: number;
  materialPercent: number;
}

export interface WIPInput {
  totalCostsIncurred: number;
  totalBilled: number;
  budgetTotal: number;
  percentComplete: number;
}

export interface WIPResult {
  wipBalance: number;
  earnedRevenue: number;
  status: 'under_billed' | 'over_billed' | 'fully_billed';
}

export interface ProjectInput {
  name: string;
  clientId: string;
  startDate: string;
  endDate?: string;
  budgetAmount: number;
  billingMethod: BillingMethod | string;
  description?: string;
}

export interface TimeEntryInput {
  employeeId: string;
  projectId: string;
  taskId?: string;
  date: string;
  hours: number;
  description: string;
  billable: boolean;
  hourlyRate?: number;
}

export interface ValidationResult {
  success: boolean;
  errors?: Array<{ field: string; message: string }>;
}

const VALID_BILLING_METHODS: BillingMethod[] = ['time_and_materials', 'fixed_price', 'milestone', 'retainer'];

// ═══════════════════════════════════════════════════════════════════════════
// PROFITABILITY
// ═══════════════════════════════════════════════════════════════════════════

export function calculateProjectProfitability(input: ProjectFinancials): ProfitabilityResult {
  const totalCost = Math.round((input.totalLabourCost + input.totalExpenses + input.totalMaterialCost) * 100) / 100;
  const grossProfit = Math.round((input.totalRevenue - totalCost) * 100) / 100;
  const profitMargin = input.totalRevenue > 0 ? Math.round((grossProfit / input.totalRevenue) * 10000) / 100 : 0;

  const labourPercent = totalCost > 0 ? Math.round((input.totalLabourCost / totalCost) * 10000) / 100 : 0;
  const expensePercent = totalCost > 0 ? Math.round((input.totalExpenses / totalCost) * 10000) / 100 : 0;
  const materialPercent = totalCost > 0 ? Math.round((input.totalMaterialCost / totalCost) * 10000) / 100 : 0;

  return { totalCost, grossProfit, profitMargin, labourPercent, expensePercent, materialPercent };
}

// ═══════════════════════════════════════════════════════════════════════════
// WIP
// ═══════════════════════════════════════════════════════════════════════════

export function calculateWIP(input: WIPInput): WIPResult {
  const earnedRevenue = Math.round((input.budgetTotal * input.percentComplete / 100) * 100) / 100;
  const wipBalance = Math.round((input.totalCostsIncurred - input.totalBilled) * 100) / 100;

  let status: WIPResult['status'] = 'under_billed';
  if (wipBalance < 0) status = 'over_billed';
  else if (wipBalance === 0) status = 'fully_billed';

  return { wipBalance, earnedRevenue, status };
}

// ═══════════════════════════════════════════════════════════════════════════
// BILLING
// ═══════════════════════════════════════════════════════════════════════════

export function calculateBillableAmount(hours: number, hourlyRate: number): number {
  return Math.round(hours * hourlyRate * 100) / 100;
}

// ═══════════════════════════════════════════════════════════════════════════
// VALIDATION
// ═══════════════════════════════════════════════════════════════════════════

export function validateProject(input: ProjectInput): ValidationResult {
  const errors: Array<{ field: string; message: string }> = [];
  if (!input.name || input.name.trim() === '') errors.push({ field: 'name', message: 'Project name is required' });
  if (!input.clientId || input.clientId.trim() === '') errors.push({ field: 'clientId', message: 'Client is required' });
  if (input.budgetAmount < 0) errors.push({ field: 'budgetAmount', message: 'Budget cannot be negative' });
  if (input.billingMethod && !VALID_BILLING_METHODS.includes(input.billingMethod as BillingMethod)) errors.push({ field: 'billingMethod', message: 'Invalid billing method' });
  return { success: errors.length === 0, ...(errors.length > 0 ? { errors } : {}) };
}

export function validateTimeEntry(input: TimeEntryInput): ValidationResult {
  const errors: Array<{ field: string; message: string }> = [];
  if (!input.employeeId || input.employeeId.trim() === '') errors.push({ field: 'employeeId', message: 'Employee is required' });
  if (!input.projectId || input.projectId.trim() === '') errors.push({ field: 'projectId', message: 'Project is required' });
  if (!input.hours || input.hours <= 0) errors.push({ field: 'hours', message: 'Hours must be greater than zero' });
  if (input.hours > 24) errors.push({ field: 'hours', message: 'Hours cannot exceed 24 per day' });
  if (!input.description || input.description.trim() === '') errors.push({ field: 'description', message: 'Description is required' });
  return { success: errors.length === 0, ...(errors.length > 0 ? { errors } : {}) };
}
