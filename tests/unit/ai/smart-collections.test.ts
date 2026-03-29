import { describe, it, expect } from 'vitest';
import {
  generateReminderMessage,
  selectReminderTone,
  calculateEscalationLevel,
  buildCollectionPlan,
  type DebtorProfile,
  type ReminderTone,
  type EscalationLevel,
  type CollectionStep,
} from '@/modules/accounting/services/smartCollectionsService';

describe('Reminder Tone Selection', () => {
  it('friendly for first reminder', () => { expect(selectReminderTone(1, 5)).toBe('friendly'); });
  it('firm for second reminder', () => { expect(selectReminderTone(2, 15)).toBe('firm'); });
  it('urgent for third+', () => { expect(selectReminderTone(3, 30)).toBe('urgent'); });
  it('final for 60+ days', () => { expect(selectReminderTone(4, 60)).toBe('final'); });
});

describe('Escalation Level', () => {
  it('level 1 for 1-14 days', () => { expect(calculateEscalationLevel(10, 5000).level).toBe(1); });
  it('level 2 for 15-29 days', () => { expect(calculateEscalationLevel(20, 5000).level).toBe(2); });
  it('level 3 for 30-59 days', () => { expect(calculateEscalationLevel(45, 5000).level).toBe(3); });
  it('level 4 for 60+ days', () => { expect(calculateEscalationLevel(90, 5000).level).toBe(4); });
  it('escalates faster for large amounts', () => {
    const small = calculateEscalationLevel(20, 1000);
    const large = calculateEscalationLevel(20, 100000);
    expect(large.level).toBeGreaterThanOrEqual(small.level);
  });
  it('includes recommended action', () => {
    const e = calculateEscalationLevel(30, 10000);
    expect(e.action.length).toBeGreaterThan(0);
  });
});

describe('Reminder Message Generation', () => {
  const debtor: DebtorProfile = {
    name: 'ABC Corp', contactPerson: 'John', email: 'john@abc.co.za',
    outstandingAmount: 25000, oldestInvoiceDays: 30, invoiceCount: 3,
    companyName: 'IsaFlow Pty Ltd',
  };

  it('generates friendly message', () => {
    const msg = generateReminderMessage(debtor, 'friendly');
    expect(msg).toContain('ABC Corp');
    expect(msg).toContain('25');
    expect(msg.toLowerCase()).not.toContain('legal');
  });

  it('generates firm message', () => {
    const msg = generateReminderMessage(debtor, 'firm');
    expect(msg).toContain('outstanding');
  });

  it('generates urgent message', () => {
    const msg = generateReminderMessage(debtor, 'urgent');
    expect(msg).toContain('immediate');
  });

  it('generates final demand', () => {
    const msg = generateReminderMessage(debtor, 'final');
    expect(msg.toLowerCase()).toContain('legal');
  });

  it('includes invoice count', () => {
    const msg = generateReminderMessage(debtor, 'friendly');
    expect(msg).toContain('3');
  });
});

describe('Collection Plan', () => {
  it('builds multi-step plan', () => {
    const plan = buildCollectionPlan(50000, 45);
    expect(plan.steps.length).toBeGreaterThan(0);
    expect(plan.steps[0]!.day).toBeDefined();
    expect(plan.steps[0]!.action).toBeDefined();
  });

  it('escalates over time', () => {
    const plan = buildCollectionPlan(50000, 60);
    const severities = plan.steps.map(s => s.severity);
    // Should escalate: info → warning → critical
    expect(severities[severities.length - 1]).not.toBe('info');
  });

  it('includes payment plan suggestion for large amounts', () => {
    const plan = buildCollectionPlan(100000, 30);
    expect(plan.suggestPaymentPlan).toBe(true);
  });

  it('no payment plan for small amounts', () => {
    const plan = buildCollectionPlan(500, 30);
    expect(plan.suggestPaymentPlan).toBe(false);
  });
});
