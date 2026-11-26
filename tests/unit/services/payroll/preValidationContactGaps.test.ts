/**
 * Wave 7 EA2 (Hein's ruling 10): IRP5 pre-validation names each employee with no address or no bank account captured,
 * as a warning (never an error: nothing is refused), with a fix link to the profile card. Codes per SARS BRS V25.3.0
 * (3214 / 3285 pp. 35-36, 3279 / 3288 p. 37, 3240 p. 45).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const st = vi.hoisted(() => ({ rows: [] as Array<Record<string, unknown>> }));

vi.mock('@/lib/neon', () => ({
  sql: Object.assign(vi.fn(async (strings: TemplateStringsArray) => {
    const text = strings.join('?');
    if (text.includes('FROM sars_source_codes')) return [{ code: '3601', effective_year: 2027, category: 'income', status: 'active' }];
    if (text.includes('WITH lines')) return st.rows;
    return [];
  }), { unsafe: (text: string) => ({ unsafe: text }) }),
}));

import { contactGaps, fixFor, preValidateTaxYear } from '@/modules/accounting/services/payroll/preValidationService';
import { refreshCache } from '@/modules/accounting/services/payroll/sarsCodesService';

const row = (id: string, o: Record<string, unknown>) => ({
  employee_id: id, employee_number: id.toUpperCase(), first_name: 'Emp', last_name: id, tax_number: '0123456789', id_number: '8001015009087',
  gross: '10000', paye: '1000', uif: '200', sdl: '100', non_cash: '0', unflagged_3801: '0', codes: ['3601'], ...o,
});

beforeEach(() => { refreshCache(); });

describe('contactGaps', () => {
  it('none when both are captured', () => {
    expect(contactGaps({ has_address: true, has_bank: true, has_bank_relationship: true })).toEqual([]);
  });
  it('names the address and the bank account, as warnings, with their codes', () => {
    const out = contactGaps({ has_address: false, has_bank: false, has_bank_relationship: false });
    expect(out.map((m) => [m.code, m.severity, m.field])).toEqual([
      ['IRP5_ADDRESS_MISSING', 'warning', 'address'], ['IRP5_BANK_MISSING', 'warning', 'bank'],
    ]);
    expect(out[0]!.message).toMatch(/3214.*3285/);
    expect(out[1]!.message).toMatch(/3240 = 0/);
    expect(out).toHaveLength(2); // no account: the relationship is not asked for
  });
  it('an account that does not state who holds it: IRP5_BANK_RELATIONSHIP_MISSING (3246), fix link to the bank card', () => {
    const [m] = contactGaps({ has_address: true, has_bank: true, has_bank_relationship: false });
    expect([m!.code, m!.severity, m!.message]).toEqual(['IRP5_BANK_RELATIONSHIP_MISSING', 'warning', expect.stringMatching(/3246/)]);
    expect(fixFor('e1', m!).fixHref).toBe('/payroll/employees/e1#employee-bank');
  });
  it('fix links go to the address and bank cards', () => {
    const [a, b] = contactGaps({ has_address: false, has_bank: false, has_bank_relationship: false });
    expect(fixFor('e1', a!)).toEqual({ fixHref: '/payroll/employees/e1#employee-address', fixLabel: 'Address' });
    expect(fixFor('e1', b!)).toEqual({ fixHref: '/payroll/employees/e1#employee-bank', fixLabel: 'Bank details' });
  });
});

describe('preValidateTaxYear names each employee missing one', () => {
  it('lists only those missing one, with warnings, never errors', async () => {
    st.rows = [
      row('a', { has_address: true, has_bank: true, has_bank_relationship: true }),
      row('b', { has_address: false, has_bank: true, has_bank_relationship: true }),
      row('c', { has_address: true, has_bank: false, has_bank_relationship: false }),
    ];
    const out = (await preValidateTaxYear('c1', { taxYear: 2027 }))!;
    expect(out.employees.map((e) => [e.employeeId, e.issues.map((i) => i.code)])).toEqual([
      ['b', ['IRP5_ADDRESS_MISSING']], ['c', ['IRP5_BANK_MISSING']],
    ]);
    expect([out.errors, out.warnings]).toEqual([0, 2]);
  });
});
