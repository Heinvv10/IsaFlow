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
  createTrainingEvent,
  listTrainingEvents,
  updateTrainingEvent,
  deleteTrainingEvent,
  wspAtrReport,
  TrainingEventNotFoundError,
} from '@/modules/accounting/services/payroll/trainingEventService';

const COMPANY_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const EMP_ID = 'e0000001-0000-0000-0000-000000000001';
const EVT_ID = 't0000001-0000-0000-0000-000000000001';
const USER_ID = 'user-1';

beforeEach(() => {
  sqlCalls.length = 0;
  mockImpl = () => Promise.resolve([]);
});

describe('createTrainingEvent', () => {
  it('inserts scoped to company + employee', async () => {
    mockImpl = (strings) => {
      const q = strings.join('?');
      if (q.includes('FROM payroll_employees')) return Promise.resolve([{ id: EMP_ID }]);
      if (q.includes('INSERT INTO training_events')) return Promise.resolve([{
        id: EVT_ID, company_id: COMPANY_ID, employee_id: EMP_ID,
        category: 'short_course', description: 'Excel', provider: 'Acme',
        nqf_level: 4, planned_start: '2026-06-01', planned_end: '2026-06-05',
        actual_start: null, actual_end: null,
        cost_planned: '1500', cost_actual: '0', status: 'planned',
        notes: null, created_by: USER_ID,
        created_at: new Date(), updated_at: new Date(),
      }]);
      return Promise.resolve([]);
    };
    const evt = await createTrainingEvent({
      companyId: COMPANY_ID, employeeId: EMP_ID,
      category: 'short_course', description: 'Excel', provider: 'Acme',
      nqfLevel: 4, plannedStart: '2026-06-01', plannedEnd: '2026-06-05',
      costPlanned: 1500, userId: USER_ID,
    });
    expect(evt.id).toBe(EVT_ID);
    expect(evt.status).toBe('planned');
  });

  it('rejects employee not in company', async () => {
    mockImpl = () => Promise.resolve([]);
    await expect(createTrainingEvent({
      companyId: COMPANY_ID, employeeId: EMP_ID,
      category: 'short_course', description: 'x', costPlanned: 0, userId: USER_ID,
    })).rejects.toThrow(/not in company/i);
  });
});

describe('listTrainingEvents', () => {
  it('scopes by company, optionally by year of planned_start', async () => {
    mockImpl = (strings) => {
      const q = strings.join('?');
      if (q.includes('FROM training_events')) {
        return Promise.resolve([]);
      }
      return Promise.resolve([]);
    };
    await listTrainingEvents(COMPANY_ID, { year: 2026 });
    const call = sqlCalls.find(c => c.sql.includes('FROM training_events'));
    expect(call!.values).toContain(COMPANY_ID);
    expect(call!.values).toContain(2026);
  });
});

describe('updateTrainingEvent', () => {
  it('throws when event not in company', async () => {
    mockImpl = () => Promise.resolve([]);
    await expect(updateTrainingEvent(COMPANY_ID, EVT_ID, { status: 'completed' }))
      .rejects.toBeInstanceOf(TrainingEventNotFoundError);
  });

  it('updates when present', async () => {
    mockImpl = (strings) => {
      const q = strings.join('?');
      if (q.includes('FROM training_events')) return Promise.resolve([{ id: EVT_ID }]);
      return Promise.resolve([]);
    };
    await updateTrainingEvent(COMPANY_ID, EVT_ID, { status: 'completed', costActual: 1800 });
    expect(sqlCalls.some(c => c.sql.includes('UPDATE training_events'))).toBe(true);
  });
});

describe('deleteTrainingEvent', () => {
  it('deletes scoped by company', async () => {
    mockImpl = (strings) => {
      const q = strings.join('?');
      if (q.includes('FROM training_events')) return Promise.resolve([{ id: EVT_ID }]);
      return Promise.resolve([]);
    };
    await deleteTrainingEvent(COMPANY_ID, EVT_ID);
    expect(sqlCalls.some(c => c.sql.includes('DELETE FROM training_events'))).toBe(true);
  });
});

describe('wspAtrReport', () => {
  it('groups by category with planned/actual cost rollup + status counts', async () => {
    mockImpl = (strings) => {
      const q = strings.join('?');
      if (q.includes('FROM training_events')) {
        return Promise.resolve([
          { category: 'short_course', status: 'completed', count: 5,
            total_planned: '15000', total_actual: '14500' },
          { category: 'short_course', status: 'planned', count: 2,
            total_planned: '6000', total_actual: '0' },
          { category: 'learnership', status: 'in_progress', count: 1,
            total_planned: '50000', total_actual: '20000' },
        ]);
      }
      return Promise.resolve([]);
    };
    const rep = await wspAtrReport(COMPANY_ID, 2026);
    expect(rep.categories.find(c => c.category === 'short_course')?.count).toBe(7);
    expect(rep.categories.find(c => c.category === 'short_course')?.totalPlanned).toBe(21000);
    expect(rep.categories.find(c => c.category === 'short_course')?.totalActual).toBe(14500);
    expect(rep.totals.totalPlanned).toBe(71000);
    expect(rep.totals.totalActual).toBe(34500);
    expect(rep.totals.count).toBe(8);
  });
});
