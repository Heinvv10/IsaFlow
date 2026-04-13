/**
 * BEE Compliance & SA-Specific Features
 */

export interface BEEScorecardInput {
  ownership: number; managementControl: number; skillsDevelopment: number;
  enterpriseDev: number; supplierDev: number; socioEconomicDev: number;
}

export interface BEEScorecardResult { totalScore: number; level: number; }
export interface ETIEmployee { monthlyWage: number; ageAtHire: number; monthsEmployed: number; isFirstJob: boolean; }
export interface ETIResult { eligible: boolean; monthlyAmount: number; reason?: string; }

const BEE_LEVELS = [
  { min: 100, level: 1 }, { min: 95, level: 2 }, { min: 90, level: 3 }, { min: 80, level: 4 },
  { min: 75, level: 5 }, { min: 70, level: 6 }, { min: 55, level: 7 }, { min: 40, level: 8 },
];

export function calculateBEEScorecard(input: BEEScorecardInput): BEEScorecardResult {
  const totalScore = input.ownership + input.managementControl + input.skillsDevelopment + input.enterpriseDev + input.supplierDev + input.socioEconomicDev;
  const entry = BEE_LEVELS.find(l => totalScore >= l.min);
  return { totalScore, level: entry?.level ?? 8 };
}

export function validateBEECertificate(input: { level: number; expiryDate: string; issueDate: string }): { valid: boolean; warnings?: string[] } {
  const warnings: string[] = [];
  const expiry = new Date(input.expiryDate);
  const now = new Date();
  if (expiry < now) return { valid: false, warnings: ['Certificate has expired'] };
  const daysUntil = Math.floor((expiry.getTime() - now.getTime()) / 86400000);
  if (daysUntil < 30) warnings.push(`Certificate expires in ${daysUntil} days`);
  return { valid: true, ...(warnings.length ? { warnings } : {}) };
}

export function calculateETIClaim(emp: ETIEmployee): ETIResult {
  if (emp.ageAtHire < 18 || emp.ageAtHire > 29) return { eligible: false, monthlyAmount: 0, reason: 'Age must be 18-29 at hire' };
  if (emp.monthlyWage > 6500) return { eligible: false, monthlyAmount: 0, reason: 'Monthly wage exceeds R6,500 threshold' };
  if (emp.monthlyWage < 2000) return { eligible: true, monthlyAmount: emp.monthsEmployed <= 12 ? 500 : 250 };

  // Formula: 50% of (R6,500 - wage) for first 12 months, 25% thereafter
  const base = 6500 - emp.monthlyWage;
  const rate = emp.monthsEmployed <= 12 ? 0.5 : 0.25;
  return { eligible: true, monthlyAmount: Math.round(base * rate * 100) / 100 };
}

export function checkSBCQualification(input: {
  annualTurnover: number;
  shareholding: Array<{ name: string; percentage: number; isNatural: boolean }>;
}): { qualifies: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (input.annualTurnover > 20000000) reasons.push('Turnover exceeds R20 million');
  if (input.shareholding.some(s => !s.isNatural)) reasons.push('Has corporate shareholders (must be natural persons only)');
  return { qualifies: reasons.length === 0, reasons };
}
