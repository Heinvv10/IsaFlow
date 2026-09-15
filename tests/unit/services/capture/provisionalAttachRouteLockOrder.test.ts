/**
 * POST /api/accounting/provisional/[jeId]/attach takes the BANK LINE before the
 * PRE-EXISTING journal — the canonical lock order in
 * `src/modules/accounting/services/bank/.claude.md`.
 *
 * This route is the twin of `capture/evidenceAttachmentService`: both write
 * `bank_transactions` and then `gl_journal_entries`, and both took them the
 * other way round until round 9. Reversed, they are the inverse of every
 * settlement path that holds a bank line and later reaches a journal
 * (`reverseReconciledTransaction`, `voidPaymentDocument`), and the 40P01 that
 * cycle produces reaches the user as a 500 on a money path.
 *
 * The service half is pinned by `evidenceAttachmentService.test.ts`; this file
 * is the route half, which was pinned by nothing. Only the SQL layer is mocked,
 * so the assertion reads the statements the real handler issues.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiResponse } from 'next';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/auth', () => ({
  withAuth: (fn: unknown) => fn,
  withWriteAccess: (fn: unknown) => fn,
}));
vi.mock('@/lib/auth/withCsrf', () => ({ withCsrf: (fn: unknown) => fn }));
vi.mock('@/lib/api-error-handler', () => ({ withErrorHandler: (fn: unknown) => fn }));
vi.mock('@/lib/apiResponse', () => ({
  apiResponse: {
    success: vi.fn((_res: unknown, data: unknown) => ({ kind: 'success', data })),
    badRequest: vi.fn((_res: unknown, message: string) => ({ kind: 'badRequest', message })),
    notFound: vi.fn(() => ({ kind: 'notFound' })),
    methodNotAllowed: vi.fn(() => ({ kind: 'methodNotAllowed' })),
  },
}));
vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));

import { sql } from '@/lib/neon';
import handler from '../../../../pages/api/accounting/provisional/[jeId]/attach';

const mockSql = sql as unknown as ReturnType<typeof vi.fn>;
const COMPANY_ID = '00000000-0000-0000-0000-000000000001';
const JE_ID      = '00000000-0000-0000-0000-000000000002';
const DOC_ID     = '00000000-0000-0000-0000-000000000003';
const BANK_TX_ID = '00000000-0000-0000-0000-000000000004';

function req() {
  return {
    method: 'POST',
    query: { jeId: JE_ID },
    body: { capturedDocumentId: DOC_ID },
    companyId: COMPANY_ID,
    user: { id: '00000000-0000-0000-0000-000000000005' },
  } as never;
}

/**
 * The template STRINGS, joined — the first argument of a tagged-template call.
 * `.mock.calls[n][0]` alone is the array, and `String()` on it hides which
 * statement it is behind the commas the interpolations leave.
 */
function statementAt(n: number): string {
  return (mockSql.mock.calls[n]![0] as unknown as string[]).join(' ');
}

beforeEach(() => vi.clearAllMocks());

describe('POST /api/accounting/provisional/[jeId]/attach — canonical lock order', () => {
  it('UPDATEs bank_transactions before gl_journal_entries', async () => {
    mockSql.mockResolvedValueOnce([{ id: JE_ID, needs_evidence: true }]);            // JE lookup
    mockSql.mockResolvedValueOnce([{ id: DOC_ID, source_document_hash: 'h', extraction_confidence: 0.9 }]);
    mockSql.mockResolvedValueOnce([{ id: BANK_TX_ID }]);                             // UPDATE #1
    mockSql.mockResolvedValueOnce([]);                                               // UPDATE #2

    const out = await handler(req(), {} as NextApiResponse) as { kind: string };

    expect(out.kind).toBe('success');
    expect(mockSql).toHaveBeenCalledTimes(4);
    expect(statementAt(2)).toMatch(/UPDATE\s+bank_transactions/);
    expect(statementAt(3)).toMatch(/UPDATE\s+gl_journal_entries/);
  });
});
