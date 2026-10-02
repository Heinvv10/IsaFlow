/**
 * create_draft_journal: a vat_type on a line is an unattended VAT claim, so it
 * goes through the MCP allocation funnel (allocationVatGuard → resolveRuleVatCode)
 * and is REFUSED — not silently relabelled — when the funnel would drop it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/neon', () => ({ sql: vi.fn().mockResolvedValue([]), withTransaction: vi.fn() }));
vi.mock('@/modules/accounting/services/gl/journalEntryCrudService', () => ({
  createJournalEntry: vi.fn(), getJournalEntryById: vi.fn(),
}));
vi.mock('@/modules/accounting/services/gl/journalEntryPostingService', () => ({ postJournalEntry: vi.fn() }));
vi.mock('@/modules/accounting/services/capture/capturedVatEvidence', () => ({ journalVatRefusal: vi.fn() }));
vi.mock('@/modules/accounting/services/gl/chartOfAccountsService', () => ({
  accountsBelongToCompany: vi.fn().mockResolvedValue(true),
}));
vi.mock('@/lib/mcp/tools/allocationVatGuard', () => ({ resolveLineVatCode: vi.fn() }));

import { createJournalEntry } from '@/modules/accounting/services/gl/journalEntryCrudService';
import { resolveLineVatCode } from '@/lib/mcp/tools/allocationVatGuard';
import { createDraftJournalTool } from '@/lib/mcp/tools/writeJournals';

const ctx = {
  companyId: 'c0000000-0000-0000-0000-000000000001', userId: 'u0000000-0000-0000-0000-000000000002',
  tokenJti: 'jti-1', scopes: ['write:journals'],
} as never;
const SALARIES = 'a75990ab-7ebf-48a9-86bd-35b744c781c2';
const BANK = 'cf9df9b9-9fc0-424b-8137-47e9ba144c73';

beforeEach(() => {
  vi.mocked(createJournalEntry).mockReset();
  vi.mocked(resolveLineVatCode).mockReset();
});

describe('create_draft_journal vat_type guard', () => {
  it('refuses a coded line the funnel would drop, and creates nothing', async () => {
    vi.mocked(resolveLineVatCode).mockResolvedValue({
      effectiveVatCode: 'none', vatCoerced: { from: 'standard', to: 'none', reason: 'no_supply' },
    } as never);
    const res = await createDraftJournalTool.handler({
      date: '2025-11-26',
      lines: [
        { account_id: SALARIES, debit: 100, credit: 0, vat_type: 'standard' },
        { account_id: BANK, debit: 0, credit: 100 },
      ],
      idempotency_key: 'k1',
    }, ctx);
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/lines\[0\]\.vat_type standard is not claimable.*no_supply/);
    expect(createJournalEntry).not.toHaveBeenCalled();
  });

  it('judges only coded lines, and creates the journal when the funnel keeps the code', async () => {
    vi.mocked(resolveLineVatCode).mockResolvedValue({ effectiveVatCode: 'standard' } as never);
    vi.mocked(createJournalEntry).mockResolvedValue({ id: 'j1', status: 'draft' } as never);
    const res = await createDraftJournalTool.handler({
      date: '2025-04-30',
      lines: [
        { account_id: BANK, debit: 115, credit: 0 },
        { account_id: SALARIES, debit: 0, credit: 115, vat_type: 'standard' },
      ],
      idempotency_key: 'k2',
    }, ctx);
    expect(res.isError).toBeFalsy();
    expect(resolveLineVatCode).toHaveBeenCalledTimes(1);
    expect(vi.mocked(resolveLineVatCode).mock.calls[0]![2]).toEqual({
      allocType: 'account', contraAccountId: SALARIES, vatCode: 'standard',
    });
    expect(createJournalEntry).toHaveBeenCalledTimes(1);
  });
});
