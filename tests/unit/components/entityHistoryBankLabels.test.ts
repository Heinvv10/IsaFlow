import { describe, it, expect } from 'vitest';
import { fieldLabel } from '@/components/accounting/entity-history/entityHistoryFormat';

describe('labels for an employee bank-details change (K2)', () => {
  it.each([
    ['bank_name', 'Bank name'], ['account_number', 'Account number'], ['branch_code', 'Branch code'],
    ['account_type', 'Account type'], ['account_holder', 'Account holder'], ['is_active', 'Active'],
    ['effective_from', 'Effective from'], ['employee_id', 'Employee'],
  ])('%s reads %s', (key, label) => expect(fieldLabel(key)).toBe(label));
});
