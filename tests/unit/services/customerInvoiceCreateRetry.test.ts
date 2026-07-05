/**
 * customer-invoices-create collision retry (PR #201 review MEDIUM).
 *
 * The invoice-number INSERT retries when it clashes with a legacy number.
 * Detection must key on SQLSTATE 23505 — pg localises/rewords messages, so
 * the old msg.includes('unique') check was fragile. This pins the code-based
 * detection: a silent revert to substring matching fails the non-23505 case.
 */

import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

const sqlTexts: string[] = [];

vi.mock('@/lib/neon', () => {
  const sqlMock = Object.assign(
    vi.fn((strings: TemplateStringsArray, ..._v: unknown[]) => {
      sqlTexts.push(strings.join('?'));
      return Promise.resolve([]);
    }),
    { transaction: vi.fn(), unsafe: vi.fn((s: string) => s) },
  );
  return {
    sql: sqlMock,
    withTransaction: vi.fn(),
    withSavepoint: vi.fn((_n: string, fn: () => unknown) => fn()),
    fmtDate: (d: unknown) =>
      d instanceof Date
        ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
        : String(d ?? ''),
  };
});

vi.mock('@/lib/auth', () => ({
  withAuth: (fn: Function) => fn,
  withWriteAccess: (fn: Function) => fn,
}));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (fn: Function) => fn }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (fn: Function) => fn }));
vi.mock('@/lib/billing/withFlowMeter', () => ({
  withFlowMeter: () => (fn: Function) => fn,
}));
vi.mock('@/modules/billing/services/flowOperationCatalog', () => ({ getFlowCost: () => 1 }));

vi.mock('@/lib/apiResponse', () => ({
  apiResponse: {
    created: vi.fn((_res: unknown, data: unknown) => ({ kind: 'created', data })),
    badRequest: vi.fn((_res: unknown, error: string) => ({ kind: 'badRequest', error })),
    methodNotAllowed: vi.fn(() => ({ kind: 'methodNotAllowed' })),
  },
}));

const reserveMock = vi.hoisted(() => vi.fn());
vi.mock('@/modules/accounting/services/core/companyService', () => ({
  reserveNextDocumentNumber: reserveMock,
}));

import { sql } from '@/lib/neon';
import handler from '../../../pages/api/accounting/customer-invoices-create';

const mockSql = sql as unknown as MockedFunction<(...args: unknown[]) => Promise<unknown[]>>;

const COMPANY_ID = 'cccccccc-0000-4000-8000-cccccccccccc';
const CLIENT_ID = 'bbbbbbbb-0000-4000-8000-bbbbbbbbbbbb';

function makeRes(): NextApiResponse {
  const res = {
    status: vi.fn(() => res),
    json: vi.fn((body: unknown) => ({ kind: 'raw500', body })),
  } as unknown as NextApiResponse;
  return res;
}

function makeReq(): NextApiRequest {
  return {
    method: 'POST',
    body: {
      clientId: CLIENT_ID,
      items: [{ description: 'X', quantity: 1, unitPrice: 100 }],
    },
    companyId: COMPANY_ID,
    user: { id: 'ffffffff-0000-4000-8000-ffffffffffff' },
  } as unknown as NextApiRequest;
}

describe('customer-invoices-create number-collision retry (SQLSTATE 23505)', () => {
  beforeEach(() => {
    sqlTexts.length = 0;
    vi.clearAllMocks();
    reserveMock.mockResolvedValueOnce('INV0000010').mockResolvedValueOnce('INV0000011');
  });

  it('retries with a fresh number on code 23505', async () => {
    let invoiceInserts = 0;
    mockSql.mockImplementation((strings: TemplateStringsArray) => {
      const text = strings.join('?');
      sqlTexts.push(text);
      if (/INSERT INTO customer_invoices/i.test(text)) {
        invoiceInserts += 1;
        if (invoiceInserts === 1) {
          return Promise.reject(
            Object.assign(new Error('duplicate key value'), { code: '23505' }),
          );
        }
        return Promise.resolve([{ id: 'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa' }]);
      }
      return Promise.resolve([]);
    });

    const result = (await (handler as Function)(makeReq(), makeRes())) as {
      kind: string;
    };

    expect(result.kind).toBe('created');
    expect(invoiceInserts).toBe(2);
    expect(reserveMock).toHaveBeenCalledTimes(2);
    expect(reserveMock).toHaveBeenCalledWith(COMPANY_ID, 'customer_invoice');
  });

  it('does NOT retry when the error is not a unique violation (even if the message says unique)', async () => {
    mockSql.mockImplementation((strings: TemplateStringsArray) => {
      const text = strings.join('?');
      sqlTexts.push(text);
      if (/INSERT INTO customer_invoices/i.test(text)) {
        // message mentions 'unique' but SQLSTATE is a FK violation — the old
        // substring detection would wrongly retry this.
        return Promise.reject(
          Object.assign(new Error('not a unique thing at all: fk_unique_client'), {
            code: '23503',
          }),
        );
      }
      return Promise.resolve([]);
    });

    const result = (await (handler as Function)(makeReq(), makeRes())) as {
      kind?: string;
    };

    // handler's outer catch responds 500 via res.status().json() — our res is
    // a bare object, so reaching it throws; either way it must NOT be 'created'
    // and must NOT have re-reserved.
    expect(result?.kind).not.toBe('created');
    expect(reserveMock).toHaveBeenCalledTimes(1);
  }, 10_000);
});
