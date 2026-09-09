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

describe('validateBatch', () => {
  it('returns line errors for zero or negative values', async () => {
    routeMock([
      {
        match: 'FROM payroll_batches',
        rows: [
          {
            id: BATCH_ID,
            company_id: COMPANY_ID,
            batch_type: 'component_values',
            component_id: COMPONENT_ID,
            status: 'draft',
          },
        ],
      },
      {
        match: 'FROM payroll_batch_lines',
        rows: [
          { id: 'l1', employee_id: EMP_A, value: '0', km: null, rate_per_km: null, employee_status: 'active' },
          { id: 'l2', employee_id: EMP_B, value: '-50', km: null, rate_per_km: null, employee_status: 'active' },
        ],
      },
      { match: 'UPDATE payroll_batch_lines', rows: [] },
      { match: 'UPDATE payroll_batches', rows: [] },
    ]);

    const result = await validateBatch(COMPANY_ID, BATCH_ID);

    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(2);
  });

  it('flags lines for terminated employees', async () => {
    routeMock([
      {
        match: 'FROM payroll_batches',
        rows: [
          {
            id: BATCH_ID,
            company_id: COMPANY_ID,
            batch_type: 'component_values',
            component_id: COMPONENT_ID,
            status: 'draft',
          },
        ],
      },
      {
        match: 'FROM payroll_batch_lines',
        rows: [
          { id: 'l1', employee_id: EMP_A, value: '1000', km: null, rate_per_km: null, employee_status: 'terminated' },
        ],
      },
      { match: 'UPDATE payroll_batch_lines', rows: [] },
      { match: 'UPDATE payroll_batches', rows: [] },
    ]);

    const result = await validateBatch(COMPANY_ID, BATCH_ID);
    expect(result.ok).toBe(false);
    expect(result.errors[0]?.error).toMatch(/terminated/i);
  });

  it('passes a clean batch and marks status=validated', async () => {
    routeMock([
      {
        match: 'FROM payroll_batches',
        rows: [
          {
            id: BATCH_ID,
            company_id: COMPANY_ID,
            batch_type: 'component_values',
            component_id: COMPONENT_ID,
            status: 'draft',
          },
        ],
      },
      {
        match: 'FROM payroll_batch_lines',
        rows: [
          { id: 'l1', employee_id: EMP_A, value: '1000', km: null, rate_per_km: null, employee_status: 'active' },
        ],
      },
      { match: 'UPDATE payroll_batch_lines', rows: [] },
      { match: 'UPDATE payroll_batches', rows: [] },
    ]);

    const result = await validateBatch(COMPANY_ID, BATCH_ID);
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(sqlCalls.some(c =>
      c.sql.includes('UPDATE payroll_batches') && c.values.includes('validated'),
    )).toBe(true);
  });
});

describe('postBatch', () => {
  it('inserts a payroll_employee_components row per line for component_values batch', async () => {
    routeMock([
      {
        match: 'FROM payroll_batches',
        rows: [
          {
            id: BATCH_ID,
            company_id: COMPANY_ID,
            batch_type: 'component_values',
            component_id: COMPONENT_ID,
            status: 'validated',
            period_year: 2026,
            period_month: 4,
            is_recurring: false,
          },
        ],
      },
      {
        match: 'FROM payroll_batch_lines',
        rows: [
          { id: 'l1', employee_id: EMP_A, value: '1000', km: null, rate_per_km: null,
            taxable_portion: null, non_taxable_portion: null,
            effective_from: new Date('2026-04-15'), effective_to: null },
        ],
      },
      { match: 'INSERT INTO payroll_employee_components', rows: [{ id: 'assign-1' }] },
      { match: 'UPDATE payroll_batches', rows: [] },
    ]);

    const result = await postBatch(COMPANY_ID, BATCH_ID, USER_ID);

    expect(result.inserted).toBe(1);
    const componentInserts = sqlCalls.filter(c =>
      c.sql.includes('INSERT INTO payroll_employee_components'),
    );
    expect(componentInserts).toHaveLength(1);
  });

  it('splits reimbursive_travel into taxable (3702) and non-taxable (3703) component rows', async () => {
    const comp3702 = 'c3702000-0000-0000-0000-000000000000';
    const comp3703 = 'c3703000-0000-0000-0000-000000000000';

    mockImpl = (strings, ...values) => {
      const q = strings.join('?');
      if (q.includes('FROM payroll_batches')) {
        return Promise.resolve([
          {
            id: BATCH_ID,
            company_id: COMPANY_ID,
            batch_type: 'reimbursive_travel',
            component_id: null,
            status: 'validated',
            period_year: 2026,
            period_month: 4,
            is_recurring: false,
          },
        ]);
      }
      if (q.includes('FROM payroll_batch_lines')) {
        return Promise.resolve([
          {
            id: 'l1',
            employee_id: EMP_A,
            value: '2500',
            km: '500',
            rate_per_km: '5.00',
            taxable_portion: '500',
            non_taxable_portion: '2000',
            effective_from: new Date('2026-04-15'),
            effective_to: null,
          },
        ]);
      }
      if (q.includes('sars_source_code')) {
        if (values.includes('3702')) return Promise.resolve([{ id: comp3702 }]);
        if (values.includes('3703')) return Promise.resolve([{ id: comp3703 }]);
      }
      if (q.includes('INSERT INTO payroll_employee_components')) {
        return Promise.resolve([{ id: 'assign-x' }]);
      }
      return Promise.resolve([]);
    };

    const result = await postBatch(COMPANY_ID, BATCH_ID, USER_ID);

    expect(result.inserted).toBe(2);
    const inserts = sqlCalls.filter(c =>
      c.sql.includes('INSERT INTO payroll_employee_components'),
    );
    expect(inserts).toHaveLength(2);
  });

  it('refuses to post when batch is already posted', async () => {
    routeMock([
      {
        match: 'FROM payroll_batches',
        rows: [
          {
            id: BATCH_ID,
            company_id: COMPANY_ID,
            batch_type: 'component_values',
            component_id: COMPONENT_ID,
            status: 'posted',
            is_recurring: false,
          },
        ],
      },
    ]);

    await expect(postBatch(COMPANY_ID, BATCH_ID, USER_ID)).rejects.toBeInstanceOf(BatchNotEditableError);
  });

  it('refuses to post a batch that has not been validated', async () => {
    routeMock([
      {
        match: 'FROM payroll_batches',
        rows: [
          {
            id: BATCH_ID,
            company_id: COMPANY_ID,
            batch_type: 'component_values',
            component_id: COMPONENT_ID,
            status: 'draft',
            is_recurring: false,
          },
        ],
      },
    ]);

    await expect(postBatch(COMPANY_ID, BATCH_ID, USER_ID)).rejects.toThrow(/validate/i);
  });
});

describe('deleteBatch', () => {
  it('deletes a draft batch', async () => {
    routeMock([
      {
        match: 'FROM payroll_batches',
        rows: [{ id: BATCH_ID, company_id: COMPANY_ID, status: 'draft' }],
      },
      { match: 'DELETE FROM payroll_batches', rows: [] },
    ]);

    await deleteBatch(COMPANY_ID, BATCH_ID);
    expect(sqlCalls.some(c => c.sql.includes('DELETE FROM payroll_batches'))).toBe(true);
  });

  it('refuses to delete a posted batch', async () => {
    routeMock([
      {
        match: 'FROM payroll_batches',
        rows: [{ id: BATCH_ID, company_id: COMPANY_ID, status: 'posted' }],
      },
    ]);

    await expect(deleteBatch(COMPANY_ID, BATCH_ID)).rejects.toBeInstanceOf(BatchNotEditableError);
  });

  it('throws BatchNotFoundError when company mismatches', async () => {
    routeMock([{ match: 'FROM payroll_batches', rows: [] }]);
    await expect(deleteBatch(OTHER_COMPANY, BATCH_ID)).rejects.toBeInstanceOf(BatchNotFoundError);
  });
});

describe('listBatches', () => {
  it('filters by company and status', async () => {
    routeMock([
      {
        match: 'FROM payroll_batches',
        rows: [
          {
            id: BATCH_ID,
            company_id: COMPANY_ID,
            batch_type: 'component_values',
            component_id: COMPONENT_ID,
            description: 'x',
            period_year: 2026,
            period_month: 4,
            is_recurring: false,
            status: 'draft',
            line_count: 2,
            total_amount: '2500',
            notes: null,
            created_by: USER_ID,
            created_at: new Date(),
            updated_at: new Date(),
            posted_at: null,
            posted_by: null,
          },
        ],
      },
    ]);

    const results = await listBatches(COMPANY_ID, { status: 'draft' });
    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe(BATCH_ID);
    expect(results[0]?.totalAmount).toBe(2500);

    const listCall = sqlCalls.find(c => c.sql.includes('FROM payroll_batches'));
    expect(listCall).toBeDefined();
    expect(listCall!.values).toContain(COMPANY_ID);
  });
});

describe('getBatch', () => {
  it('returns batch + lines', async () => {
    routeMock([
      {
        match: 'FROM payroll_batches',
        rows: [
          {
            id: BATCH_ID,
            company_id: COMPANY_ID,
            batch_type: 'component_values',
            component_id: COMPONENT_ID,
            description: 'x',
            period_year: 2026,
            period_month: 4,
            is_recurring: false,
            status: 'draft',
            line_count: 1,
            total_amount: '1000',
            notes: null,
            created_by: USER_ID,
            created_at: new Date(),
            updated_at: new Date(),
            posted_at: null,
            posted_by: null,
          },
        ],
      },
      {
        match: 'FROM payroll_batch_lines',
        rows: [
          {
            id: 'l1',
            batch_id: BATCH_ID,
            employee_id: EMP_A,
            employee_name: 'Alice A',
            employee_number: 'E001',
            value: '1000',
            km: null,
            rate_per_km: null,
            taxable_portion: null,
            non_taxable_portion: null,
            effective_from: new Date('2026-04-15'),
            effective_to: null,
            notes: null,
            error: null,
            created_at: new Date(),
          },
        ],
      },
    ]);

    const result = await getBatch(COMPANY_ID, BATCH_ID);
    expect(result.batch.id).toBe(BATCH_ID);
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]?.employeeId).toBe(EMP_A);
    expect(result.lines[0]?.value).toBe(1000);
  });

  it('throws BatchNotFoundError when company mismatches', async () => {
    routeMock([{ match: 'FROM payroll_batches', rows: [] }]);
    await expect(getBatch(OTHER_COMPANY, BATCH_ID)).rejects.toBeInstanceOf(BatchNotFoundError);
  });
});
