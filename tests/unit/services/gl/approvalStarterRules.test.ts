/**
 * R-035 follow-up, PR A: the recommended starter set (goal §3, Hein 2026-10-08 §2a.2).
 *
 * The 38 NULL-company template rows govern no company and RLS hides them from
 * app_user, so the set is a TS constant, never read from them. Its values are
 * fixed by the goal's table: the legacy template types are mapped onto the types
 * that govern documents today (credit_note → both credit-note types, payment →
 * supplier_payment and payment_batch, journal_entry → manual_journal).
 */
import { describe, expect, it } from 'vitest';
import { STARTER_RULES } from '@/modules/accounting/services/gl/approvalStarterRules';
import {
  CONDITION_OPERATORS, ENFORCEABLE_DOCUMENT_TYPES, RULE_FORM_DOCUMENT_TYPES,
} from '@/modules/accounting/services/gl/approvalRuleOptions';
import { CONDITION_OPERATORS as MATCHING_OPERATORS } from '@/modules/accounting/services/gl/approvalMatching';
import { ENFORCEABLE_DOCUMENT_TYPES as ENFORCEMENT_TYPES } from '@/modules/accounting/services/gl/approvalEnforcement';
import { isApproverRole } from '@/modules/accounting/services/gl/approvalAuthority';
import { assertRuleDocumentTypeCreatable } from '@/modules/accounting/services/gl/approvalDocumentTypes';

describe('STARTER_RULES', () => {
  it('is exactly the goal §3 table', () => {
    expect(STARTER_RULES).toEqual([
      { documentType: 'supplier_invoice', name: 'Large supplier invoices', conditionOperator: 'greater_than', conditionValue: 50000, approverRole: 'manager' },
      { documentType: 'customer_invoice', name: 'Large customer invoices', conditionOperator: 'greater_than', conditionValue: 50000, approverRole: 'manager' },
      { documentType: 'customer_credit_note', name: 'Credit notes over R10k', conditionOperator: 'greater_than', conditionValue: 10000, approverRole: 'manager' },
      { documentType: 'supplier_credit_note', name: 'Credit notes over R10k', conditionOperator: 'greater_than', conditionValue: 10000, approverRole: 'manager' },
      { documentType: 'supplier_payment', name: 'Large payments', conditionOperator: 'greater_than', conditionValue: 100000, approverRole: 'admin' },
      { documentType: 'payment_batch', name: 'Large payments', conditionOperator: 'greater_than', conditionValue: 100000, approverRole: 'admin' },
      { documentType: 'manual_journal', name: 'All journal entries', conditionOperator: 'any', conditionValue: 0, approverRole: 'accountant' },
    ]);
  });

  it('names each document type once, never a legacy one, and only types a rule may be created for', () => {
    const types = STARTER_RULES.map((r) => r.documentType);
    expect(new Set(types).size).toBe(types.length);
    for (const r of STARTER_RULES) {
      expect(() => assertRuleDocumentTypeCreatable(r.documentType)).not.toThrow();
      expect(RULE_FORM_DOCUMENT_TYPES).toContain(r.documentType);
      expect(CONDITION_OPERATORS).toContain(r.conditionOperator);
      expect(isApproverRole(r.approverRole)).toBe(true);
    }
  });
});

describe('the client-safe rule vocabulary', () => {
  it('is the same list the server validates and gates with', () => {
    expect(CONDITION_OPERATORS).toBe(MATCHING_OPERATORS);
    expect(ENFORCEABLE_DOCUMENT_TYPES).toBe(ENFORCEMENT_TYPES);
  });

  it('offers the enforceable types, supplier invoices included, and no legacy type', () => {
    expect(RULE_FORM_DOCUMENT_TYPES).toContain('supplier_invoice');
    for (const t of ENFORCEABLE_DOCUMENT_TYPES) expect(RULE_FORM_DOCUMENT_TYPES).toContain(t);
    for (const legacy of ['credit_note', 'payment', 'journal_entry']) expect(RULE_FORM_DOCUMENT_TYPES).not.toContain(legacy);
  });
});
