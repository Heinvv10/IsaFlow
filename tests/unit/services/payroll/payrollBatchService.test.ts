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
  createBatch,
  addBatchLines,
  validateBatch,
  postBatch,
  deleteBatch,
  listBatches,
  getBatch,
  BatchNotFoundError,
  BatchNotEditableError,
} from '@/modules/accounting/services/payroll/payrollBatchService';

const COMPANY_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const OTHER_COMPANY = '11111111-1111-1111-1111-111111111111';
const USER_ID = 'user-1';
const BATCH_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const COMPONENT_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const EMP_A = 'e0000001-0000-0000-0000-000000000001';
const EMP_B = 'e0000002-0000-0000-0000-000000000002';

function routeMock(routes: Array<{ match: string; rows: unknown[] }>) {
  mockImpl = (strings) => {
    const q = strings.join('?');
    const hit = routes.find(r => q.includes(r.match));
    return Promise.resolve(hit ? hit.rows : []);
  };
}

beforeEach(() => {
  sqlCalls.length = 0;
  mockImpl = () => Promise.resolve([]);
});

describe('createBatch', () => {
  it('inserts a component_values batch with required component_id', async () => {
    const row = {
      id: BATCH_ID,
      company_id: COMPANY_ID,
      batch_type: 'component_values',
      component_id: COMPONENT_ID,
      description: 'April overtime',
      period_year: 2026,
      period_month: 4,
      is_recurring: false,
      status: 'draft',
      line_count: 0,
      total_amount: '0',
      notes: null,
      created_by: USER_ID,
      created_at: new Date('2026-04-01'),
      updated_at: new Date('2026-04-01'),
      posted_at: null,
      posted_by: null,
    };
    routeMock([{ match: 'INSERT INTO payroll_batches', rows: [row] }]);

    const batch = await createBatch({
      companyId: COMPANY_ID,
      batchType: 'component_values',
      componentId: COMPONENT_ID,
      description: 'April overtime',
      periodYear: 2026,
      periodMonth: 4,
      isRecurring: false,
      userId: USER_ID,
    });

    expect(batch.id).toBe(BATCH_ID);
    expect(batch.batchType).toBe('component_values');
    expect(batch.componentId).toBe(COMPONENT_ID);
    expect(batch.status).toBe('draft');
    expect(batch.totalAmount).toBe(0);

    const insert = sqlCalls.find(c => c.sql.includes('INSERT INTO payroll_batches'));
    expect(insert).toBeDefined();
  });

  it('rejects component_values batch without componentId', async () => {
    await expect(
      createBatch({
        companyId: COMPANY_ID,
        batchType: 'component_values',
        description: 'April overtime',
        periodYear: 2026,
        periodMonth: 4,
        userId: USER_ID,
      }),
    ).rejects.toThrow(/componentId is required/i);
  });

  it('allows a reimbursive_travel batch without componentId', async () => {
    const row = {
      id: BATCH_ID,
      company_id: COMPANY_ID,
      batch_type: 'reimbursive_travel',
      component_id: null,
      description: 'April travel',
      period_year: 2026,
      period_month: 4,
      is_recurring: false,
      status: 'draft',
      line_count: 0,
      total_amount: '0',
      notes: null,
      created_by: USER_ID,
      created_at: new Date(),
      updated_at: new Date(),
      posted_at: null,
      posted_by: null,
    };
    routeMock([{ match: 'INSERT INTO payroll_batches', rows: [row] }]);

    const batch = await createBatch({
      companyId: COMPANY_ID,
      batchType: 'reimbursive_travel',
      description: 'April travel',
      periodYear: 2026,
      periodMonth: 4,
      userId: USER_ID,
    });

    expect(batch.batchType).toBe('reimbursive_travel');
    expect(batch.componentId).toBeNull();
  });

  it('rejects period_month outside 1..12', async () => {
    await expect(
      createBatch({
        companyId: COMPANY_ID,
        batchType: 'reimbursive_travel',
        description: 'x',
        periodYear: 2026,
        periodMonth: 13,
        userId: USER_ID,
      }),
    ).rejects.toThrow(/period/i);
  });
});

describe('addBatchLines', () => {
  it('asserts batch belongs to company and inserts lines', async () => {
    const batchRow = {
      id: BATCH_ID,
      company_id: COMPANY_ID,
      batch_type: 'component_values',
      component_id: COMPONENT_ID,
      status: 'draft',
      period_year: 2026,
      period_month: 4,
      is_recurring: false,
    };
    routeMock([
      { match: 'FROM payroll_batches', rows: [batchRow] },
      {
        match: 'FROM payroll_employees',
        rows: [{ id: EMP_A }, { id: EMP_B }],
      },
      { match: 'INSERT INTO payroll_batch_lines', rows: [{ id: 'l1' }, { id: 'l2' }] },
      { match: 'UPDATE payroll_batches', rows: [] },
    ]);

    const result = await addBatchLines(COMPANY_ID, BATCH_ID, [
      { employeeId: EMP_A, value: 1000, effectiveFrom: new Date('2026-04-15') },
      { employeeId: EMP_B, value: 1500, effectiveFrom: new Date('2026-04-15') },
    ]);

    expect(result.inserted).toBe(2);
    expect(sqlCalls.some(c => c.sql.includes('INSERT INTO payroll_batch_lines'))).toBe(true);
    expect(sqlCalls.some(c => c.sql.includes('UPDATE payroll_batches'))).toBe(true);
  });

  it('throws BatchNotFoundError when company does not match', async () => {
    routeMock([{ match: 'FROM payroll_batches', rows: [] }]);

    await expect(
      addBatchLines(OTHER_COMPANY, BATCH_ID, [
        { employeeId: EMP_A, value: 100, effectiveFrom: new Date('2026-04-15') },
      ]),
    ).rejects.toBeInstanceOf(BatchNotFoundError);
  });

  it('throws BatchNotEditableError when batch is posted', async () => {
    routeMock([
      {
        match: 'FROM payroll_batches',
        rows: [
          {
            id: BATCH_ID,
            company_id: COMPANY_ID,
            status: 'posted',
            batch_type: 'component_values',
            component_id: COMPONENT_ID,
          },
        ],
      },
    ]);

    await expect(
      addBatchLines(COMPANY_ID, BATCH_ID, [
        { employeeId: EMP_A, value: 100, effectiveFrom: new Date('2026-04-15') },
      ]),
    ).rejects.toBeInstanceOf(BatchNotEditableError);
  });

  it('rejects lines referencing employees outside the company', async () => {
    routeMock([
      {
        match: 'FROM payroll_batches',
        rows: [
          {
            id: BATCH_ID,
            company_id: COMPANY_ID,
            status: 'draft',
            batch_type: 'component_values',
            component_id: COMPONENT_ID,
          },
        ],
      },
      { match: 'FROM payroll_employees', rows: [{ id: EMP_A }] },
    ]);

    await expect(
      addBatchLines(COMPANY_ID, BATCH_ID, [
        { employeeId: EMP_A, value: 100, effectiveFrom: new Date('2026-04-15') },
        { employeeId: EMP_B, value: 200, effectiveFrom: new Date('2026-04-15') },
      ]),
    ).rejects.toThrow(/not in company/i);
  });
});

