/**
 * Shared display vocabulary for the approvals page and its Rules tab: the rule
 * shape the rules API returns, document-type and operator labels, and the rand
 * format. Pure; split out of pages/accounting/approvals/index.tsx so the Rules
 * tab components can share it (300-line ceiling).
 */
import { isRuleAmount } from '@/modules/accounting/services/gl/approvalRuleOptions';
import { formatMoney } from '@/lib/money/formatMoney';

export interface ApprovalRuleRow {
  id: string;
  name: string;
  documentType: string;
  conditionField: string;
  conditionOperator: string;
  conditionValue: number;
  approverRole: string;
  isActive: boolean;
}

export const DOC_TYPE_LABELS: Record<string, string> = {
  customer_invoice: 'Customer Invoice',
  supplier_invoice: 'Supplier Invoice',
  payment: 'Payment',
  journal_entry: 'Journal Entry',
  credit_note: 'Credit Note',
  customer_credit_note: 'Customer Credit Note',
  supplier_credit_note: 'Supplier Credit Note',
  supplier_payment: 'Supplier Payment',
  payment_batch: 'Payment Batch',
  manual_journal: 'Manual Journal',
};

export const docTypeLabel = (documentType: string): string => DOC_TYPE_LABELS[documentType] || documentType;

export const OPERATOR_LABELS: Record<string, string> = {
  any: 'Every document',
  greater_than: 'Amount greater than',
  greater_equal: 'Amount at least',
};

export function formatCurrency(amount: number): string {
  return formatMoney(Math.abs(amount));
}

/** MAX_RULE_AMOUNT (approval_rules.condition_value is NUMERIC(15,2)) as a person reads it. */
export const AMOUNT_RANGE = 'from 0 to 9,999,999,999,999.99, in rand and cents';

/** A form's amount field as a number, or null when it is not one a rule may hold (isRuleAmount). */
export function parseAmount(text: string): number | null {
  if (text.trim() === '') return null;
  const value = Number(text);
  return isRuleAmount(value) ? value : null;
}
