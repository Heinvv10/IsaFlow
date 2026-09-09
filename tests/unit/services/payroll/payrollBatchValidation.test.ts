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

describe('postBatch',()=>{
 // Actual approved component batch and invalid travel recheck are covered by payrollCompensationControl.int.test.ts.
 it('refuses posting without issued compensation authority before SQL',async()=>{
  await expect(postBatch(COMPANY_ID,BATCH_ID,USER_ID)).rejects.toThrow(/context|transaction/i);
  expect(sqlCalls).toHaveLength(0);
 });
});

