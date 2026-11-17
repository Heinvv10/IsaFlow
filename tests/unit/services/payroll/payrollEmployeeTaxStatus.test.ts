/**
 * The PSP entity type on an employee's terms (wave 6 PSP, migration 999r): a personal service provider is a company or a
 * trust (SARS PAYE-GEN-01-G01-A06 row 6 taxes them at different rates), and nobody else carries one. Judged before any
 * write, as the database's payroll_employees_psp_entity_pair CHECK would refuse it.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TERMS, PRICED_KEYS, TERM_KEYS, judgeTerms, movedTerms, termsFromRow, termsOfCreate, termsOfPatch,
} from '@/modules/accounting/services/payroll/payrollEmployeeTerms';

const refuse = (m: string) => new Error(m);

describe('creating an employee', () => {
  it('a PSP needs its entity type', () => {
    expect(termsOfCreate({ taxStatus: 'personal_service_provider', pspEntityType: 'trust' }, refuse))
      .toMatchObject({ taxStatus: 'personal_service_provider', pspEntityType: 'trust' });
    expect(() => termsOfCreate({ taxStatus: 'personal_service_provider' }, refuse)).toThrow(/company or a trust/);
  });

  it('an entity type on anyone else is refused; an unknown one is refused', () => {
    expect(() => termsOfCreate({ taxStatus: 'employee', pspEntityType: 'company' }, refuse)).toThrow(/only a personal service provider/i);
    expect(() => termsOfCreate({ taxStatus: 'personal_service_provider', pspEntityType: 'partnership' }, refuse)).toThrow(/pspEntityType must be one of/);
  });

  it('the default is no entity type', () => {
    expect(termsOfCreate({}, refuse).pspEntityType).toBeNull();
    expect(DEFAULT_TERMS.pspEntityType).toBeNull();
  });
});

describe('patching', () => {
  const psp = { ...DEFAULT_TERMS, taxStatus: 'personal_service_provider' as const, pspEntityType: 'company' as const };

  it('company to trust alone is judged against the stored status', () => {
    expect(termsOfPatch({ pspEntityType: 'trust' }, refuse, psp)).toEqual({ pspEntityType: 'trust' });
    expect(() => termsOfPatch({ pspEntityType: 'trust' }, refuse, DEFAULT_TERMS)).toThrow(/only a personal service provider/i);
  });

  it('moving off PSP clears the entity type; a blank entity type on a PSP is refused', () => {
    expect(termsOfPatch({ taxStatus: 'employee' }, refuse, psp)).toEqual({ taxStatus: 'employee', pspEntityType: null });
    expect(() => termsOfPatch({ pspEntityType: '' }, refuse, psp)).toThrow(/company or a trust/);
  });

  it('becoming a PSP needs the entity type in the same patch', () => {
    expect(() => termsOfPatch({ taxStatus: 'personal_service_provider' }, refuse, DEFAULT_TERMS)).toThrow(/company or a trust/);
    expect(termsOfPatch({ taxStatus: 'personal_service_provider', pspEntityType: 'company' }, refuse, DEFAULT_TERMS))
      .toEqual({ taxStatus: 'personal_service_provider', pspEntityType: 'company' });
  });
});

describe('the term is priced, logged and read back', () => {
  it('is a priced term (owner/admin only) and a logged term', () => {
    expect(PRICED_KEYS).toContain('pspEntityType');
    expect(TERM_KEYS).toContain('pspEntityType');
  });

  it('reads from the row; a stored pair the CHECK forbids throws', () => {
    expect(termsFromRow({ tax_status: 'personal_service_provider', psp_entity_type: 'trust' }).pspEntityType).toBe('trust');
    expect(termsFromRow({ tax_status: 'employee' }).pspEntityType).toBeNull();
    expect(() => termsFromRow({ tax_status: 'personal_service_provider', psp_entity_type: 'llc' })).toThrow(/Stored/);
  });

  it('a change is a history row on psp_entity_type', () => {
    const before = { ...DEFAULT_TERMS, taxStatus: 'personal_service_provider' as const, pspEntityType: 'company' as const };
    expect(movedTerms(before, { ...before, pspEntityType: 'trust' })).toEqual([{ field: 'psp_entity_type', oldValue: 'company', newValue: 'trust' }]);
  });

  it('judgeTerms refuses the forbidden pair', () => {
    expect(() => judgeTerms({ ...DEFAULT_TERMS, taxStatus: 'personal_service_provider' }, refuse)).toThrow(/company or a trust/);
  });
});
