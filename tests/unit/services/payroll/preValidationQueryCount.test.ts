/**
 * Wave 6 PV (review M2): the number of queries does not grow with the employees. 200 employees, each paid three
 * codes, cost the same reads as one: the scope, the final lines, the directives and one SARS code list for the
 * year (sarsCodesService caches it per year, so the engine's per-code lookups are map reads).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const st = vi.hoisted(() => ({ queries: [] as string[], employees: 0 }));

vi.mock('@/lib/neon', () => ({
  sql: vi.fn(async (strings: TemplateStringsArray) => {
    const text = strings.join('?');
    st.queries.push(text.replace(/\s+/g, ' ').trim().slice(0, 60));
    if (text.includes('FROM sars_source_codes')) {
      return ['3601', '3810', '4001'].map((code) => ({ code, effective_year: 2027, category: code === '4001' ? 'deduction' : 'income', status: 'active' }));
    }
    if (text.includes('WITH lines')) {
      return Array.from({ length: st.employees }, (_, i) => ({
        employee_id: `e${i}`, employee_number: `E${i}`, first_name: 'Emp', last_name: String(i), tax_number: null, id_number: null,
        gross: '1000', paye: '100', uif: '20', sdl: '10', non_cash: '0', unflagged_3801: '0', codes: ['3601', '3810', '4001'],
      }));
    }
    return [];
  }),
}));

import { preValidateTaxYear } from '@/modules/accounting/services/payroll/preValidationService';
import { refreshCache } from '@/modules/accounting/services/payroll/sarsCodesService';

beforeEach(() => { st.queries = []; refreshCache(); });

describe('pre-validation query count', () => {
  it.each([1, 200])('%i employee(s): three queries, whatever the count', async (n) => {
    st.employees = n;
    const out = await preValidateTaxYear('c1', { taxYear: 2027 });
    expect(out!.employeesChecked).toBe(n);
    // Every employee lacks a tax and an ID number: the engine really ran for each.
    expect(out!.errors).toBe(2 * n);
    expect(st.queries).toHaveLength(3);
  });
});
