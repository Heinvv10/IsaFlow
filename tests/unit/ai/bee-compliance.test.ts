import { describe, it, expect } from 'vitest';
import {
  calculateBEEScorecard,
  validateBEECertificate,
  calculateETIClaim,
  checkSBCQualification,
  type BEEScorecardInput,
  type ETIEmployee,
} from '@/modules/accounting/services/beeComplianceService';

describe('BEE Scorecard Calculation', () => {
  it('calculates total score', () => {
    const result = calculateBEEScorecard({ ownership: 20, managementControl: 15, skillsDevelopment: 18, enterpriseDev: 10, supplierDev: 20, socioEconomicDev: 5 });
    expect(result.totalScore).toBe(88);
    expect(result.level).toBeDefined();
  });
  it('determines BEE level from score', () => {
    expect(calculateBEEScorecard({ ownership: 25, managementControl: 19, skillsDevelopment: 20, enterpriseDev: 15, supplierDev: 25, socioEconomicDev: 12 }).level).toBe(1);
    expect(calculateBEEScorecard({ ownership: 10, managementControl: 5, skillsDevelopment: 5, enterpriseDev: 3, supplierDev: 5, socioEconomicDev: 2 }).level).toBeGreaterThan(4);
  });
  it('level 1 = 100+ points', () => { expect(calculateBEEScorecard({ ownership: 25, managementControl: 19, skillsDevelopment: 25, enterpriseDev: 15, supplierDev: 25, socioEconomicDev: 12 }).level).toBe(1); });
});

describe('BEE Certificate Validation', () => {
  it('valid certificate', () => { expect(validateBEECertificate({ level: 2, expiryDate: '2027-01-01', issueDate: '2026-01-01' }).valid).toBe(true); });
  it('expired certificate', () => { expect(validateBEECertificate({ level: 2, expiryDate: '2025-01-01', issueDate: '2024-01-01' }).valid).toBe(false); });
  it('warns for expiring soon', () => {
    const soon = new Date(); soon.setDate(soon.getDate() + 20);
    const r = validateBEECertificate({ level: 2, expiryDate: soon.toISOString().split('T')[0]!, issueDate: '2025-01-01' });
    expect(r.valid).toBe(true);
    expect(r.warnings!.length).toBeGreaterThan(0);
  });
});

describe('ETI Claim Calculation', () => {
  it('calculates ETI for qualifying employee', () => {
    const result = calculateETIClaim({ monthlyWage: 4500, ageAtHire: 22, monthsEmployed: 3, isFirstJob: true });
    expect(result.eligible).toBe(true);
    expect(result.monthlyAmount).toBeGreaterThan(0);
  });
  it('ineligible if wage too high', () => {
    expect(calculateETIClaim({ monthlyWage: 8000, ageAtHire: 22, monthsEmployed: 1, isFirstJob: true }).eligible).toBe(false);
  });
  it('ineligible if age > 29', () => {
    expect(calculateETIClaim({ monthlyWage: 4000, ageAtHire: 35, monthsEmployed: 1, isFirstJob: true }).eligible).toBe(false);
  });
  it('reduces after 12 months', () => {
    const first12 = calculateETIClaim({ monthlyWage: 4000, ageAtHire: 22, monthsEmployed: 6, isFirstJob: true });
    const after12 = calculateETIClaim({ monthlyWage: 4000, ageAtHire: 22, monthsEmployed: 18, isFirstJob: true });
    expect(after12.monthlyAmount).toBeLessThan(first12.monthlyAmount);
  });
});

describe('SBC Qualification', () => {
  it('qualifies under R20m turnover', () => {
    expect(checkSBCQualification({ annualTurnover: 15000000, shareholding: [{ name: 'A', percentage: 100, isNatural: true }] }).qualifies).toBe(true);
  });
  it('disqualifies over R20m', () => {
    expect(checkSBCQualification({ annualTurnover: 25000000, shareholding: [{ name: 'A', percentage: 100, isNatural: true }] }).qualifies).toBe(false);
  });
  it('disqualifies if corporate shareholder', () => {
    expect(checkSBCQualification({ annualTurnover: 10000000, shareholding: [{ name: 'Corp', percentage: 100, isNatural: false }] }).qualifies).toBe(false);
  });
});
