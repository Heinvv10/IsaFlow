/**
 * K-244: learnFromAllocation used to retry a failed pattern INSERT without
 * company_id. categorization_patterns.company_id is NOT NULL (migration 220),
 * so the retry could never succeed; on any schema where it could, it would
 * mint a NULL-company pattern carrying one tenant's gl_account_id. The fix
 * removes the retry: one INSERT, always tenant-scoped, and the real error is
 * logged. The write runs in its own savepoint so a failed statement does not
 * abort the caller's request transaction, and the function reports whether it
 * learned, so the route does not claim success it did not have.
 */

import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

vi.mock('@/lib/neon', () => {
  const sqlMock = Object.assign(vi.fn(), { transaction: vi.fn(), unsafe: vi.fn() });
  // Records which statements ran inside the savepoint.
  const inSavepoint: string[] = [];
  const withSavepoint = vi.fn(async (name: string, fn: () => Promise<unknown>) => {
    inSavepoint.push(`begin:${name}`);
    try { return await fn(); } finally { inSavepoint.push(`end:${name}`); }
  });
  return { sql: sqlMock, withTransaction: vi.fn(), withSavepoint, inSavepoint, fmtDate: (d: unknown) => String(d) };
});

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/modules/accounting/services/gl/inputVatDenial', () => ({
  resolveVatCodeForAccount: vi.fn().mockResolvedValue({ vatCode: 'none' }),
}));

import { sql, withSavepoint } from '@/lib/neon';
import { log } from '@/lib/logger';
import { resolveVatCodeForAccount } from '@/modules/accounting/services/gl/inputVatDenial';
import { learnFromAllocation } from '@/modules/accounting/services/core/smartCategorizationLearningService';

const mockSql = sql as unknown as MockedFunction<(...args: unknown[]) => Promise<unknown[]>>;

const COMPANY_ID = 'cccccccc-0000-4000-8000-cccccccccccc';
const TX_ID = 'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa';
const GL_ID = 'bbbbbbbb-0000-4000-8000-bbbbbbbbbbbb';

function sqlText(call: unknown[]): string {
  const strings = call[0] as TemplateStringsArray;
  return Array.from(strings).join('?');
}

function insertCalls(): string[] {
  return mockSql.mock.calls.map(sqlText).filter(t => /INSERT INTO categorization_patterns/.test(t));
}

describe('learnFromAllocation — no global-pattern fallback (K-244)', () => {
  beforeEach(() => {
    mockSql.mockReset();
    vi.mocked(log.error).mockClear();
    vi.mocked(withSavepoint).mockClear();
  });

  it('never retries the INSERT without company_id when the first INSERT fails', async () => {
    const insertError = new Error('null value in column "company_id" violates not-null constraint');
    mockSql.mockImplementation(async (...args: unknown[]) => {
      const text = sqlText(args);
      if (/FROM bank_transactions/.test(text)) return [{ description: 'ESKOM PREPAID 123456' }];
      if (/SELECT id, usage_count FROM categorization_patterns/.test(text)) return [];
      if (/INSERT INTO categorization_patterns/.test(text)) throw insertError;
      return [];
    });

    await expect(learnFromAllocation(COMPANY_ID, TX_ID, GL_ID, 'Electricity')).resolves.toBe(false);

    const inserts = insertCalls();
    expect(inserts).toHaveLength(1);
    for (const text of inserts) expect(text).toMatch(/company_id/);
    expect(log.error).toHaveBeenCalledWith(
      'Failed to learn from allocation',
      expect.objectContaining({ txId: TX_ID, companyId: COMPANY_ID, error: insertError }),
      'accounting',
    );
  });

  it('binds the caller company on the INSERT it does make', async () => {
    mockSql.mockImplementation(async (...args: unknown[]) => {
      const text = sqlText(args);
      if (/FROM bank_transactions/.test(text)) return [{ description: 'VODACOM DEBIT ORDER' }];
      return [];
    });

    await expect(learnFromAllocation(COMPANY_ID, TX_ID, GL_ID, 'Telephone')).resolves.toBe(true);

    const call = mockSql.mock.calls.find(c => /INSERT INTO categorization_patterns/.test(sqlText(c)));
    expect(call).toBeDefined();
    // company_id is the last column, and its placeholder binds the caller's company
    const strings = Array.from(call![0] as TemplateStringsArray);
    expect(strings[0]).toMatch(/source, company_id\)\s*VALUES/);
    expect(call!.at(-1)).toBe(COMPANY_ID);
  });

  it('runs every statement, the first read included, inside the savepoint', async () => {
    const outside: string[] = [];
    mockSql.mockImplementation(async (...args: unknown[]) => {
      const marks = (await import('@/lib/neon') as unknown as { inSavepoint: string[] }).inSavepoint;
      if (!marks.at(-1)?.startsWith('begin:')) outside.push(sqlText(args));
      const text = sqlText(args);
      if (/FROM bank_transactions/.test(text)) throw new Error('read failed');
      return [];
    });

    await expect(learnFromAllocation(COMPANY_ID, TX_ID, GL_ID, 'Telephone')).resolves.toBe(false);
    expect(mockSql).toHaveBeenCalledTimes(1);
    expect(outside).toEqual([]);
  });

  it('resolves the VAT code inside the savepoint', async () => {
    let vatOutside = false;
    vi.mocked(resolveVatCodeForAccount).mockImplementationOnce(async () => {
      const marks = (await import('@/lib/neon') as unknown as { inSavepoint: string[] }).inSavepoint;
      vatOutside = !marks.at(-1)?.startsWith('begin:');
      throw new Error('vat lookup failed');
    });
    mockSql.mockImplementation(async (...args: unknown[]) =>
      (/FROM bank_transactions/.test(sqlText(args)) ? [{ description: 'VODACOM DEBIT ORDER' }] : []));

    await expect(learnFromAllocation(COMPANY_ID, TX_ID, GL_ID, 'Telephone')).resolves.toBe(false);
    expect(resolveVatCodeForAccount).toHaveBeenCalled();
    expect(vatOutside).toBe(false);
  });

  it('writes the pattern inside its own savepoint, so a failure cannot abort the request transaction', async () => {
    let insertRanInSavepoint = false;
    mockSql.mockImplementation(async (...args: unknown[]) => {
      const text = sqlText(args);
      if (/FROM bank_transactions/.test(text)) return [{ description: 'VODACOM DEBIT ORDER' }];
      if (/INSERT INTO categorization_patterns/.test(text)) {
        const open = vi.mocked(withSavepoint).mock.calls.length > 0;
        const marks = (await import('@/lib/neon') as unknown as { inSavepoint: string[] }).inSavepoint;
        insertRanInSavepoint = open && marks.at(-1)?.startsWith('begin:') === true;
        throw new Error('boom');
      }
      return [];
    });

    await expect(learnFromAllocation(COMPANY_ID, TX_ID, GL_ID, 'Telephone')).resolves.toBe(false);
    expect(withSavepoint).toHaveBeenCalledTimes(1);
    expect(insertRanInSavepoint).toBe(true);
  });

  it('reports false, without writing, when there is nothing to learn', async () => {
    mockSql.mockImplementation(async () => []);
    await expect(learnFromAllocation(COMPANY_ID, TX_ID, GL_ID, 'Telephone')).resolves.toBe(false);
    expect(insertCalls()).toHaveLength(0);
  });
});
