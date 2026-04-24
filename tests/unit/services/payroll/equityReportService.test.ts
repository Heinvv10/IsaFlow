import { describe, it, expect, vi, beforeEach } from 'vitest';

const sqlCalls: Array<{ sql: string; values: unknown[] }> = [];
let mockImpl: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]> =
  () => Promise.resolve([]);

vi.mock('@/lib/neon', () => ({
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => {
    sqlCalls.push({ sql: strings.join('?'), values });
    return mockImpl(strings, ...values);
  },
}));

import {
  listOccupationalLevels,
  assignEmployeeOccupationalLevel,
  eea2Report,
} from '@/modules/accounting/services/payroll/equityReportService';

const COMPANY_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const EMP_ID = 'e0000001-0000-0000-0000-000000000001';
const LVL_TOP = 'l0000001-0000-0000-0000-000000000001';
const USER_ID = 'user-1';

beforeEach(() => {
  sqlCalls.length = 0;
  mockImpl = () => Promise.resolve([]);
});

describe('listOccupationalLevels', () => {
  it('returns global master ordered by display_order', async () => {
    mockImpl = (strings) => {
      const q = strings.join('?');
      if (q.includes('FROM occupational_levels')) {
        return Promise.resolve([
          { id: LVL_TOP, code: 'top_management', name: 'Top management', display_order: 1 },
        ]);
      }
      return Promise.resolve([]);
    };
    const rows = await listOccupationalLevels();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.code).toBe('top_management');
    const call = sqlCalls.find(c => c.sql.includes('FROM occupational_levels'));
    expect(call!.sql).toMatch(/ORDER BY.*display_order/);
  });
});

describe('assignEmployeeOccupationalLevel', () => {
  it('updates FK and writes history', async () => {
    mockImpl = (strings) => {
      const q = strings.join('?');
      if (q.includes('FROM payroll_employees')) return Promise.resolve([{ id: EMP_ID, occupational_level_id: null }]);
      if (q.includes('FROM occupational_levels')) return Promise.resolve([{ id: LVL_TOP }]);
      return Promise.resolve([]);
    };
    await assignEmployeeOccupationalLevel(COMPANY_ID, EMP_ID, LVL_TOP, USER_ID);
    expect(sqlCalls.some(c => c.sql.includes('UPDATE payroll_employees'))).toBe(true);
    expect(sqlCalls.some(c => c.sql.includes('INSERT INTO payroll_employee_history'))).toBe(true);
  });

  it('allows null to clear', async () => {
    mockImpl = (strings) => {
      const q = strings.join('?');
      if (q.includes('FROM payroll_employees')) return Promise.resolve([{ id: EMP_ID, occupational_level_id: LVL_TOP }]);
      return Promise.resolve([]);
    };
    await assignEmployeeOccupationalLevel(COMPANY_ID, EMP_ID, null);
    const update = sqlCalls.find(c => c.sql.includes('UPDATE payroll_employees'));
    expect(update!.values).toContain(null);
  });
});

describe('eea2Report', () => {
  it('builds a level × race × gender matrix with totals', async () => {
    mockImpl = (strings) => {
      const q = strings.join('?');
      if (q.includes('FROM payroll_employees')) {
        return Promise.resolve([
          { level_code: 'top_management', level_name: 'Top management', display_order: 1,
            race: 'african', gender: 'male', disability: false, foreign: false, headcount: 3 },
          { level_code: 'top_management', level_name: 'Top management', display_order: 1,
            race: 'white', gender: 'female', disability: false, foreign: false, headcount: 2 },
          { level_code: 'top_management', level_name: 'Top management', display_order: 1,
            race: 'white', gender: 'female', disability: true, foreign: false, headcount: 1 },
          { level_code: 'skilled_technical', level_name: 'Skilled technical', display_order: 4,
            race: 'african', gender: 'female', disability: false, foreign: true, headcount: 4 },
          { level_code: null, level_name: null, display_order: null,
            race: null, gender: null, disability: false, foreign: false, headcount: 1 },
        ]);
      }
      return Promise.resolve([]);
    };
    const rep = await eea2Report(COMPANY_ID, '2026-04-24');
    expect(rep.levels).toHaveLength(3);
    expect(rep.levels[0]!.levelCode).toBe('top_management');
    expect(rep.levels[0]!.total).toBe(6);
    expect(rep.levels[0]!.cells.find((c: { race: string; gender: string }) => c.race === 'african' && c.gender === 'male')?.count).toBe(3);
    expect(rep.levels[0]!.disabilityCount).toBe(1);
    expect(rep.totals.grandTotal).toBe(11);
    expect(rep.totals.foreignCount).toBe(4);
    const unspec = rep.levels.find((l: { levelCode: string | null }) => l.levelCode === null);
    expect(unspec).toBeDefined();
    expect(unspec!.total).toBe(1);
  });

  it('returns empty shape when no employees', async () => {
    mockImpl = () => Promise.resolve([]);
    const rep = await eea2Report(COMPANY_ID, '2026-04-24');
    expect(rep.levels).toEqual([]);
    expect(rep.totals.grandTotal).toBe(0);
  });
});
