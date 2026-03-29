/**
 * TDD: Contract Term Extraction → Recurring Entries
 */

import { describe, it, expect } from 'vitest';
import {
  parseContractExtractionResponse,
  mapContractToRecurringInput,
  validateContractExtraction,
  calculateEscalationSchedule,
  type ExtractedContract,
} from '@/modules/accounting/services/contractExtractionService';

describe('Contract Response Parsing', () => {
  it('parses party names', () => {
    const r = parseContractExtractionResponse('{"partyA":"ISAFlow","partyB":"Telkom SA","paymentAmount":5000,"paymentFrequency":"monthly","startDate":"2026-01-01","endDate":"2027-12-31"}');
    expect(r!.partyA).toBe('ISAFlow');
    expect(r!.partyB).toBe('Telkom SA');
  });

  it('parses payment amount and frequency', () => {
    const r = parseContractExtractionResponse('{"partyA":"A","partyB":"B","paymentAmount":7500,"paymentFrequency":"monthly","startDate":"2026-01-01"}');
    expect(r!.paymentAmount).toBe(7500);
    expect(r!.paymentFrequency).toBe('monthly');
  });

  it('parses escalation percentage', () => {
    const r = parseContractExtractionResponse('{"partyA":"A","partyB":"B","paymentAmount":5000,"paymentFrequency":"monthly","escalationPercent":8,"startDate":"2026-01-01"}');
    expect(r!.escalationPercent).toBe(8);
  });

  it('parses contract dates', () => {
    const r = parseContractExtractionResponse('{"partyA":"A","partyB":"B","paymentAmount":5000,"paymentFrequency":"monthly","startDate":"2026-04-01","endDate":"2028-03-31","renewalDate":"2028-03-01"}');
    expect(r!.startDate).toBe('2026-04-01');
    expect(r!.endDate).toBe('2028-03-31');
  });

  it('handles null fields gracefully', () => {
    const r = parseContractExtractionResponse('{"partyA":"A","partyB":"B","paymentAmount":5000,"paymentFrequency":"monthly"}');
    expect(r!.escalationPercent).toBeNull();
    expect(r!.endDate).toBeNull();
  });

  it('handles malformed JSON', () => {
    expect(parseContractExtractionResponse('not json at all')).toBeNull();
  });
});

describe('Contract to Recurring Invoice Mapping', () => {
  const contract: ExtractedContract = {
    partyA: 'ISAFlow', partyB: 'Telkom SA', contractDate: '2026-01-01',
    startDate: '2026-01-01', endDate: '2027-12-31',
    paymentAmount: 5000, paymentFrequency: 'monthly', paymentDay: 1,
    escalationPercent: 8, escalationDate: '2027-01-01',
    renewalType: 'auto', renewalDate: '2027-12-01',
    noticePeriod: '30 days', description: 'Monthly telecoms', confidence: 0.9,
  };

  it('maps monthly contract to monthly recurring', () => {
    const r = mapContractToRecurringInput(contract, 'sup-003');
    expect(r.frequency).toBe('monthly');
  });

  it('sets nextRunDate from startDate', () => {
    const r = mapContractToRecurringInput(contract, 'sup-003');
    expect(r.nextRunDate).toBe('2026-01-01');
  });

  it('sets endDate from contract endDate', () => {
    const r = mapContractToRecurringInput(contract, 'sup-003');
    expect(r.endDate).toBe('2027-12-31');
  });

  it('includes payment amount as line item', () => {
    const r = mapContractToRecurringInput(contract, 'sup-003');
    expect(r.amount).toBe(5000);
  });

  it('uses supplier name as template name', () => {
    const r = mapContractToRecurringInput(contract, 'sup-003');
    expect(r.templateName).toContain('Telkom');
  });
});

describe('Contract Validation', () => {
  it('rejects contract with no paymentAmount', () => {
    const c: ExtractedContract = { partyA: 'A', partyB: 'B', contractDate: null, startDate: '2026-01-01', endDate: null, paymentAmount: null, paymentFrequency: 'monthly', paymentDay: null, escalationPercent: null, escalationDate: null, renewalType: null, renewalDate: null, noticePeriod: null, description: null, confidence: 0.5 };
    expect(validateContractExtraction(c).valid).toBe(false);
  });

  it('rejects contract with no paymentFrequency', () => {
    const c: ExtractedContract = { partyA: 'A', partyB: 'B', contractDate: null, startDate: '2026-01-01', endDate: null, paymentAmount: 5000, paymentFrequency: null, paymentDay: null, escalationPercent: null, escalationDate: null, renewalType: null, renewalDate: null, noticePeriod: null, description: null, confidence: 0.5 };
    expect(validateContractExtraction(c).valid).toBe(false);
  });

  it('accepts contract with amount and frequency', () => {
    const c: ExtractedContract = { partyA: 'A', partyB: 'B', contractDate: null, startDate: '2026-01-01', endDate: null, paymentAmount: 5000, paymentFrequency: 'monthly', paymentDay: null, escalationPercent: null, escalationDate: null, renewalType: null, renewalDate: null, noticePeriod: null, description: null, confidence: 0.8 };
    expect(validateContractExtraction(c).valid).toBe(true);
  });

  it('warns when endDate is missing', () => {
    const c: ExtractedContract = { partyA: 'A', partyB: 'B', contractDate: null, startDate: '2026-01-01', endDate: null, paymentAmount: 5000, paymentFrequency: 'monthly', paymentDay: null, escalationPercent: null, escalationDate: null, renewalType: null, renewalDate: null, noticePeriod: null, description: null, confidence: 0.8 };
    const v = validateContractExtraction(c);
    expect(v.warnings.length).toBeGreaterThan(0);
  });
});

describe('Escalation Schedule Calculation', () => {
  it('calculates 3-year escalation at 8%', () => {
    const schedule = calculateEscalationSchedule(5000, 8, '2026-01-01', 3);
    expect(schedule.length).toBe(3);
    expect(schedule[0]!.amount).toBe(5000);
    expect(schedule[1]!.amount).toBeCloseTo(5400, 0);
    expect(schedule[2]!.amount).toBeCloseTo(5832, 0);
  });

  it('compounds annually', () => {
    const schedule = calculateEscalationSchedule(10000, 10, '2026-01-01', 2);
    expect(schedule[1]!.amount).toBeCloseTo(11000, 0);
  });

  it('rounds to 2 decimal places', () => {
    const schedule = calculateEscalationSchedule(1000, 7, '2026-01-01', 2);
    expect(Number.isInteger(schedule[1]!.amount * 100)).toBe(true);
  });

  it('returns base amount for 0% escalation', () => {
    const schedule = calculateEscalationSchedule(5000, 0, '2026-01-01', 3);
    schedule.forEach(s => expect(s.amount).toBe(5000));
  });
});
