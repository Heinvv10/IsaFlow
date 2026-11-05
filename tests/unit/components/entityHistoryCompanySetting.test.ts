/** The history of the company's default payment terms reads in words: "30 days from invoice date -> 2 months after statement". */
import { describe, expect, it } from 'vitest';
import { displayValue, visibleFields } from '@/components/accounting/entity-history/entityHistoryFormat';
import { entityLabel } from '@/modules/accounting/services/core/entityChanges/entityChangeQuery';
import { mayReadType } from '@/modules/accounting/services/core/entityChanges/entityChangeTypes';

describe('company_setting history (the default payment terms)', () => {
  it('words the stored JSON', () => {
    expect(displayValue('company_setting', 'value', '{"days":30,"type":"invoice_days"}')).toBe('30 days from invoice date');
    expect(displayValue('company_setting', 'value', '{"days":2,"type":"statement_months"}')).toBe('2 months after statement');
    expect(displayValue('company_setting', 'value', '{"days":0,"type":"invoice_days"}')).toBe('Immediate');
  });

  it('leaves other types\' values, and this type\'s other fields, alone', () => {
    expect(displayValue('supplier', 'value', '{"days":2,"type":"statement_months"}')).toBe('{"days":2,"type":"statement_months"}');
    expect(displayValue('company_setting', 'key', 'default_payment_terms')).toBe('default_payment_terms');
  });

  it('hides the company id, and names the entity by its key', () => {
    const fields = [{ key: 'company_id', before: null, after: 'c', masked: false }, { key: 'value', before: null, after: 'v', masked: false }];
    expect(visibleFields('company_setting', fields).map((f) => f.key)).toEqual(['value']);
    expect(entityLabel('company_setting', { before: null, after: { key: 'default_payment_terms' }, subject_name: null })).toBe('Default payment terms');
  });

  it('is readable by owner and admin only', () => {
    for (const role of ['owner', 'admin']) expect(mayReadType(role, 'company_setting')).toBe(true);
    for (const role of ['manager', 'accountant', 'viewer', undefined]) expect(mayReadType(role, 'company_setting')).toBe(false);
  });
});
