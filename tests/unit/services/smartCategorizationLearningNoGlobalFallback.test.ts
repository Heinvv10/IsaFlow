/**
 * K-244: learnFromAllocation used to retry a failed pattern INSERT without
 * company_id. categorization_patterns.company_id is NOT NULL (migration 220),
 * so the retry could never succeed; on any schema where it could, it would
 * mint a NULL-company pattern carrying one tenant's gl_account_id. The fix
 * removes the retry: one INSERT, always tenant-scoped, and the real error is
 * logged.
 */

import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

vi.mock('@/lib/neon', () => {
  const sqlMock = Object.assign(vi.fn(), { transaction: vi.fn(), unsafe: vi.fn() });
  return { sql: sqlMock, withTransaction: vi.fn(), fmtDate: (d: unknown) => String(d) };
});

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/modules/accounting/services/gl/inputVatDenial', () => ({
  resolveVatCodeForAccount: vi.fn().mockResolvedValue({ vatCode: 'none' }),
}));

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
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

    await expect(learnFromAllocation(COMPANY_ID, TX_ID, GL_ID, 'Electricity')).resolves.toBeUndefined();

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

    await learnFromAllocation(COMPANY_ID, TX_ID, GL_ID, 'Telephone');

    const call = mockSql.mock.calls.find(c => /INSERT INTO categorization_patterns/.test(sqlText(c)));
    expect(call).toBeDefined();
    expect(call!.slice(1)).toContain(COMPANY_ID);
  });
});
