import { describe, expect, it } from 'vitest';
import type { TxSql } from '@/lib/neon';
import { supersedeForPackage } from '@/modules/accounting/services/payroll/payPackageSupersede';

describe('supersedeForPackage', () => {
  it('refuses to cut an earning used only as a paid leaver termination base', async () => {
    const tx = (async (strings: TemplateStringsArray) => {
      const query = strings.join('?');
      if (query.includes('FROM payroll_employee_components')) {
        return [{
          id: '10000000-0000-0000-0000-000000000001',
          effective_from: '2025-01-01',
          effective_to: '2026-03-10',
          is_recurring: true,
          superseded_at: null,
          supersede_inferred: false,
          employee_end: '2026-03-10',
        }];
      }
      return [];
    }) as unknown as TxSql;

    await expect(supersedeForPackage(tx, {
      companyId: '20000000-0000-0000-0000-000000000001',
      packageId: '30000000-0000-0000-0000-000000000001',
      employeeId: '40000000-0000-0000-0000-000000000001',
      componentId: '50000000-0000-0000-0000-000000000001',
      componentType: 'earning',
      effectiveFrom: '2026-03-05',
      paid: [{ year: 2026, month: 3, calculatedAt: Date.parse('2026-03-31T12:00:00Z') }],
      actor: { userId: '60000000-0000-0000-0000-000000000001', channel: 'rest' },
    })).rejects.toThrow(/2026-03 .*already paid/i);
  });
});
