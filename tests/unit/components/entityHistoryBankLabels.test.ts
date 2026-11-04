import { describe, it, expect } from 'vitest';
import { fieldLabel } from '@/components/accounting/entity-history/entityHistoryFormat';

describe('labels for the new bank-detail keys (K2): the four that humanising alone would get wrong or leave unclear', () => {
  it.each([
    ['account_number', 'Account number'], ['branch_code', 'Branch code'], ['account_holder', 'Account holder'], ['is_active', 'Active'],
  ])('%s reads %s', (key, label) => expect(fieldLabel(key)).toBe(label));
});
