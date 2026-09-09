import { expect, it } from 'vitest';
import { operationRequiresPosting } from '@/modules/accounting/services/controls/operationPermissions';
import { operationBindingHash } from '@/modules/accounting/services/controls/canonical';
import type { OperationBinding } from '@/modules/accounting/services/controls/contracts';
const binding: OperationBinding = { companyId: 'company', entityType: 'fiscal_year', entityId: '2025',
  entityVersion: 1, operation: 'year.close', accountingDate: '2025-12-31', amount: null, currency: null,
  beneficiaries: [], sourceVersions: [], policies: [] };
it('requires posting authority for financial year close as well as lock authority', () => {
  expect(operationRequiresPosting('year.close')).toBe(true);
  expect(operationRequiresPosting('year.periods_close')).toBe(false);
});
it('requires actual closing money and currency even for an empty financial year', () => {
  expect(() => operationBindingHash(binding)).toThrow('Missing operation amount');
  expect(operationBindingHash({ ...binding, amount: '0', currency: 'ZAR' })).toMatch(/^[a-f0-9]{64}$/);
  expect(operationBindingHash({ ...binding, operation: 'year.periods_close' })).toMatch(/^[a-f0-9]{64}$/);
});
