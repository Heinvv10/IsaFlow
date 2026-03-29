/**
 * Smart Collections & Payment Reminders Service
 * Tone-calibrated reminders, escalation, collection plans.
 */

export type ReminderTone = 'friendly' | 'firm' | 'urgent' | 'final';

export interface DebtorProfile {
  name: string;
  contactPerson: string;
  email: string;
  outstandingAmount: number;
  oldestInvoiceDays: number;
  invoiceCount: number;
  companyName: string;
}

export interface EscalationLevel {
  level: 1 | 2 | 3 | 4;
  action: string;
}

export interface CollectionStep {
  day: number;
  action: string;
  channel: 'email' | 'sms' | 'phone' | 'letter';
  severity: 'info' | 'warning' | 'critical';
}

export interface CollectionPlan {
  steps: CollectionStep[];
  suggestPaymentPlan: boolean;
}

const fmt = (n: number) => `R${Math.abs(n).toLocaleString('en-ZA', { minimumFractionDigits: 0 })}`;

export function selectReminderTone(reminderNumber: number, daysOverdue: number): ReminderTone {
  if (daysOverdue >= 60 || reminderNumber >= 4) return 'final';
  if (daysOverdue >= 30 || reminderNumber >= 3) return 'urgent';
  if (daysOverdue >= 14 || reminderNumber >= 2) return 'firm';
  return 'friendly';
}

export function calculateEscalationLevel(daysOverdue: number, amount: number): EscalationLevel {
  const amountFactor = amount > 50000 ? 1 : 0;
  const effectiveDays = daysOverdue + amountFactor * 10;

  if (effectiveDays >= 60) return { level: 4, action: 'Final demand — consider legal action or debt collection agency' };
  if (effectiveDays >= 30) return { level: 3, action: 'Formal letter of demand — suspend credit terms' };
  if (effectiveDays >= 15) return { level: 2, action: 'Firm follow-up — phone call and written reminder' };
  return { level: 1, action: 'Friendly email reminder' };
}

export function generateReminderMessage(debtor: DebtorProfile, tone: ReminderTone): string {
  const amount = fmt(debtor.outstandingAmount);

  switch (tone) {
    case 'friendly':
      return `Dear ${debtor.contactPerson},\n\nThis is a gentle reminder that ${debtor.name} has ${debtor.invoiceCount} outstanding invoice(s) totalling ${amount} with ${debtor.companyName}.\n\nWe would appreciate payment at your earliest convenience.\n\nKind regards,\n${debtor.companyName}`;
    case 'firm':
      return `Dear ${debtor.contactPerson},\n\nWe note that ${debtor.name} has an outstanding balance of ${amount} across ${debtor.invoiceCount} invoice(s) which remain unpaid.\n\nPlease arrange payment within 7 days to avoid further action.\n\nRegards,\n${debtor.companyName}`;
    case 'urgent':
      return `Dear ${debtor.contactPerson},\n\nURGENT: ${debtor.name} has an overdue balance of ${amount} (${debtor.invoiceCount} invoice(s)). This requires your immediate attention.\n\nPlease make payment within 48 hours or contact us to discuss.\n\nRegards,\n${debtor.companyName}`;
    case 'final':
      return `Dear ${debtor.contactPerson},\n\nFINAL DEMAND: ${debtor.name} owes ${amount} which is significantly overdue. Despite previous reminders, payment has not been received.\n\nIf payment is not received within 7 days, we will be compelled to pursue legal action to recover this debt.\n\nRegards,\n${debtor.companyName}`;
  }
}

export function buildCollectionPlan(amount: number, daysOverdue: number): CollectionPlan {
  const steps: CollectionStep[] = [];
  const suggestPaymentPlan = amount >= 20000;

  steps.push({ day: 0, action: 'Send friendly email reminder', channel: 'email', severity: 'info' });
  steps.push({ day: 7, action: 'Follow-up email + SMS', channel: 'sms', severity: 'info' });
  steps.push({ day: 14, action: 'Phone call to accounts department', channel: 'phone', severity: 'warning' });
  steps.push({ day: 21, action: 'Firm written reminder — suspend new orders', channel: 'email', severity: 'warning' });
  steps.push({ day: 30, action: 'Formal letter of demand', channel: 'letter', severity: 'critical' });

  if (daysOverdue >= 45 || amount >= 50000) {
    steps.push({ day: 45, action: 'Final demand — 7 day notice', channel: 'letter', severity: 'critical' });
    steps.push({ day: 60, action: 'Hand over to debt collection / legal', channel: 'letter', severity: 'critical' });
  }

  return { steps, suggestPaymentPlan };
}
