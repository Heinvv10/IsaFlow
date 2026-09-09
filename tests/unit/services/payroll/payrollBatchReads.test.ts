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
