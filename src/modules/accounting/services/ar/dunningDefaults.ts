/**
 * SA-default dunning templates seeded per-company on first use.
 *
 * Four tones mapped to the escalation ladder (days_overdue_min/max):
 *   - polite  : 7–14  days overdue  (friendly nudge)
 *   - firm    : 15–30 days overdue  (formal follow-up)
 *   - final   : 31–60 days overdue  (final notice before escalation)
 *   - legal   : 61+   days overdue  (intent to pursue legal action)
 *
 * Token substitution is handled by renderTemplate() in dunningService.ts.
 * Supported tokens: {{customer_name}}, {{invoice_number}}, {{invoice_date}},
 * {{due_date}}, {{days_overdue}}, {{amount_outstanding}}, {{company_name}},
 * {{portal_link}}, {{reference_note}}.
 */

import type { DunningTone } from './dunningService';

export interface DefaultTemplateSpec {
  name: string;
  tone: DunningTone;
  escalation_order: number;
  days_overdue_min: number;
  days_overdue_max: number | null;
  subject_template: string;
  body_template: string;
}

export const SA_DEFAULT_TEMPLATES: DefaultTemplateSpec[] = [
  {
    name: 'Polite reminder',
    tone: 'polite',
    escalation_order: 1,
    days_overdue_min: 7,
    days_overdue_max: 14,
    subject_template:
      'Friendly reminder: invoice {{invoice_number}} — {{amount_outstanding}} outstanding',
    body_template:
      'Dear {{customer_name}},\n\n' +
      'This is a friendly reminder that invoice {{invoice_number}} dated {{invoice_date}} ' +
      'is now {{days_overdue}} days past its due date of {{due_date}}. The outstanding ' +
      'balance is {{amount_outstanding}}.\n\n' +
      'You can view the invoice and pay online at {{portal_link}}.\n\n' +
      'If you have already made payment, please disregard this notice.\n\n' +
      'Kind regards,\n{{company_name}}\n\n{{reference_note}}',
  },
  {
    name: 'Firm follow-up',
    tone: 'firm',
    escalation_order: 2,
    days_overdue_min: 15,
    days_overdue_max: 30,
    subject_template:
      'Second notice: invoice {{invoice_number}} overdue — {{amount_outstanding}}',
    body_template:
      'Dear {{customer_name}},\n\n' +
      'Despite our earlier reminder, invoice {{invoice_number}} dated {{invoice_date}} ' +
      'remains unpaid {{days_overdue}} days after its due date ({{due_date}}). The ' +
      'outstanding balance is {{amount_outstanding}}.\n\n' +
      'We require settlement within seven (7) days. If there is a reason why payment ' +
      'cannot be made, please contact us so we can arrange alternative terms.\n\n' +
      'View and pay the invoice: {{portal_link}}\n\n' +
      'Regards,\n{{company_name}}\n\n{{reference_note}}',
  },
  {
    name: 'Final notice',
    tone: 'final',
    escalation_order: 3,
    days_overdue_min: 31,
    days_overdue_max: 60,
    subject_template:
      'FINAL NOTICE — invoice {{invoice_number}} — {{amount_outstanding}}',
    body_template:
      'Dear {{customer_name}},\n\n' +
      'Invoice {{invoice_number}} for {{amount_outstanding}} is {{days_overdue}} days ' +
      'overdue. Despite previous reminders, the account remains unsettled.\n\n' +
      'This is our final notice before the matter is escalated. We require full ' +
      'payment within seven (7) days of this communication, failing which the matter ' +
      'may be handed over for collection, and further costs may be incurred by you.\n\n' +
      'Pay now: {{portal_link}}\n\n' +
      'If the amount is disputed, please raise a dispute via the portal or reply to ' +
      'this email immediately.\n\n' +
      'Regards,\n{{company_name}}\n\n{{reference_note}}',
  },
  {
    name: 'Letter of demand',
    tone: 'legal',
    escalation_order: 4,
    days_overdue_min: 61,
    days_overdue_max: null,
    subject_template:
      'Letter of demand — invoice {{invoice_number}} — {{amount_outstanding}}',
    body_template:
      'Dear {{customer_name}},\n\n' +
      'Despite repeated requests, invoice {{invoice_number}} dated {{invoice_date}} ' +
      'in the amount of {{amount_outstanding}} remains unpaid {{days_overdue}} days ' +
      'past its due date.\n\n' +
      'This communication constitutes a formal letter of demand. Unless full payment ' +
      'is received within seven (7) days of the date hereof, {{company_name}} reserves ' +
      'the right to proceed without further notice, including handing the matter to ' +
      'attorneys or a registered debt-collection agency. All costs, including legal ' +
      'fees and interest, will be for your account.\n\n' +
      'Settle the account online: {{portal_link}}\n\n' +
      'Yours faithfully,\n{{company_name}}\n\n{{reference_note}}',
  },
];
