/**
 * Review round 1, items 4 and 5. The FOR SHARE read of an invoice's line
 * accounts can lose a lock race against a GL account merge (approve and draft
 * edit lock the invoice then the accounts; the merge the reverse): a forced
 * 40P01 or 55P03 there surfaces as InvoiceLineAccountLockError, whose
 * `_LOCK_TIMEOUT` code every surface already answers as retryable — REST 503 +
 * Retry-After, the MCP registry its own message, bulk finalize a skip. A
 * coding refusal is ONE class with ONE code on every surface.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { NextApiResponse } from 'next';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/neon', () => {
  const sqlMock = Object.assign(vi.fn(), { transaction: vi.fn(), unsafe: vi.fn() });
  return { sql: sqlMock, withSavepoint: vi.fn(async (_n: string, fn: () => unknown) => fn()) };
});

import { sql } from '@/lib/neon';
import { invoiceLineCodingRefusal } from '@/modules/accounting/services/ar/invoiceLineCodingGuard';
import { InvoiceLineAccountLockError, InvoiceLineCodingRefusal } from '@/modules/accounting/services/ar/invoiceLineCoding';
import { respondIfLockTimeout } from '@/lib/apiDocumentLock';
import { isRefusalCoded, safeErrorText } from '@/lib/mcp/tools/toolHelpers';
import { postPartitionedDocuments } from '@/lib/mcp/tools/bulkApprovePost';
import { racedReason } from '@/lib/mcp/tools/writeBulkFinalizeInvoices';

const mockSql = sql as unknown as ReturnType<typeof vi.fn>;
const ACCOUNT = 'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa';
const pgError = (code: string) => Object.assign(new Error(`pg ${code}`), { code });
const coding = { glAccountId: ACCOUNT, projectId: null, costCenterId: null };

beforeEach(() => { vi.clearAllMocks(); mockSql.mockResolvedValue([]); });

describe('the line-account FOR SHARE read under a lock race', () => {
  it.each(['40P01', '55P03'])('turns a forced %s into InvoiceLineAccountLockError, cause kept', async (code) => {
    const cause = pgError(code);
    mockSql.mockRejectedValueOnce(cause);
    const err = await invoiceLineCodingRefusal('company', [coding]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvoiceLineAccountLockError);
    expect((err as InvoiceLineAccountLockError).code).toBe('INVOICE_LINE_ACCOUNT_LOCK_TIMEOUT');
    expect((err as Error).cause).toBe(cause);
  });

  it('lets any other database error through unchanged', async () => {
    const other = pgError('23505');
    mockSql.mockRejectedValueOnce(other);
    await expect(invoiceLineCodingRefusal('company', [coding])).rejects.toBe(other);
  });

  it('the read-only pass (bulk finalize pre-read) takes no lock, so it cannot race', async () => {
    mockSql.mockResolvedValueOnce([{ account_code: '4100', account_name: 'Sales', account_type: 'revenue', is_active: true, has_children: false }]);
    await invoiceLineCodingRefusal('company', [coding], { lock: false });
    expect(String((mockSql.mock.calls[0]![0] as readonly string[]).join(''))).not.toMatch(/FOR SHARE/);
  });
});

describe('every surface answers the lock race as retryable', () => {
  it('REST: 503 with Retry-After and the code', () => {
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis(), setHeader: vi.fn() } as unknown as NextApiResponse;
    expect(respondIfLockTimeout(res, new InvoiceLineAccountLockError())).toBe(true);
    expect((res.status as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toBe(503);
    expect(JSON.stringify((res.json as ReturnType<typeof vi.fn>).mock.calls[0]![0])).toContain('INVOICE_LINE_ACCOUNT_LOCK_TIMEOUT');
  });

  it('MCP: a registered code, so the agent reads "retry in a moment"', () => {
    expect(isRefusalCoded(new InvoiceLineAccountLockError())).toBe(true);
    expect(safeErrorText(new InvoiceLineAccountLockError(), 'failed')).toMatch(/retry in a moment/);
  });

  it('bulk finalize: the element is a retryable skip, the rest of the batch posts', async () => {
    const adapter = {
      savepointPrefix: 'fin_',
      postOne: vi.fn(async (_ctx: unknown, id: string) => {
        if (id === 'b') throw new InvoiceLineAccountLockError({ cause: pgError('40P01') });
        return { id };
      }),
    };
    const out = await postPartitionedDocuments({ companyId: 'c', userId: 'u' } as never,
      [{ index: 0, id: 'a' }, { index: 1, id: 'b' }, { index: 2, id: 'c' }], adapter as never, racedReason);
    expect(out.posted).toEqual([{ id: 'a' }, { id: 'c' }]);
    expect(out.raced).toEqual([{ index: 1, document_id: 'b', reason: 'locked by another request — retry' }]);
  });
});

describe('one refusal code for line coding', () => {
  it('is registered for MCP, and its message reaches the agent', () => {
    expect(isRefusalCoded(new InvoiceLineCodingRefusal('x'))).toBe(true);
    expect(safeErrorText(new InvoiceLineCodingRefusal('An invoice line cannot be coded to 6100 Crew: it is not a revenue account (it is expense).'), 'x'))
      .toMatch(/6100 Crew/);
  });

  it('bulk finalize skips an approve that refused a line before writing, with its reason', () => {
    expect(racedReason(new InvoiceLineCodingRefusal('Invoice INV-2: lines refused'))).toBe('Invoice INV-2: lines refused');
  });
});
