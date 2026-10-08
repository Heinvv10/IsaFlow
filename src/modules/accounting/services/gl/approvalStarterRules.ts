/**
 * The recommended starter set (R-035 follow-up, PR A; Hein 2026-10-08).
 *
 * Production holds 38 seeded `approval_rules` templates with a NULL company_id:
 * they govern no company (checkApproval matches `company_id = $1`) and RLS hides
 * them from app_user. They are NOT read here — behaviour must not key on seed
 * data — and they are left untouched. This constant is the template set mapped
 * onto the types that govern documents today:
 *   credit_note   → customer_credit_note and supplier_credit_note
 *   payment       → supplier_payment and payment_batch
 *   journal_entry → manual_journal
 * Where templates of one type differed (supplier invoices had an admin and a
 * manager template), the value that occurs most often was taken (goal §3 table).
 *
 * "Start from recommended rules" creates a confirmed subset of these as the
 * company's own rules, each through createRule (approvalStarterService.ts).
 */
import type { DocumentType } from './approvalService';
import type { ConditionOperator } from './approvalRuleOptions';

export interface StarterRule {
  documentType: DocumentType;
  name: string;
  conditionOperator: ConditionOperator;
  conditionValue: number;
  approverRole: string;
}

export const STARTER_RULES: readonly StarterRule[] = [
  { documentType: 'supplier_invoice', name: 'Large supplier invoices', conditionOperator: 'greater_than', conditionValue: 50000, approverRole: 'manager' },
  { documentType: 'customer_invoice', name: 'Large customer invoices', conditionOperator: 'greater_than', conditionValue: 50000, approverRole: 'manager' },
  { documentType: 'customer_credit_note', name: 'Credit notes over R10k', conditionOperator: 'greater_than', conditionValue: 10000, approverRole: 'manager' },
  { documentType: 'supplier_credit_note', name: 'Credit notes over R10k', conditionOperator: 'greater_than', conditionValue: 10000, approverRole: 'manager' },
  { documentType: 'supplier_payment', name: 'Large payments', conditionOperator: 'greater_than', conditionValue: 100000, approverRole: 'admin' },
  { documentType: 'payment_batch', name: 'Large payments', conditionOperator: 'greater_than', conditionValue: 100000, approverRole: 'admin' },
  { documentType: 'manual_journal', name: 'All journal entries', conditionOperator: 'any', conditionValue: 0, approverRole: 'accountant' },
];
