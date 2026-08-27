/**
 * PRD-11 §2 — bank_accounts_status.allocated_count must equal the number of
 * transactions with a posted journal line (matched_journal_line_id IS NOT NULL).
 * An AI suggestion alone is NOT an allocation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));

import { sql } from '@/lib/neon';
import { getBankAccountsStatus } from '@/modules/accounting/services/bank/bankAccountStatusService';

const COMPANY_ID = 'aaaaaaaa-0000-0000-0000-aaaaaaaaaaaa';

function sqlText(): string {
  const [strings] = vi.mocked(sql).mock.calls[0] as unknown as [TemplateStringsArray];
  return strings.join('?');
}

/** Extract the CASE predicate feeding a named aggregate. */
function predicateOf(alias: string): string {
  const t = sqlText();
  const lateral = t.indexOf('LEFT JOIN LATERAL');
  const end = t.indexOf(`AS ${alias}`, lateral);
  if (end < 0) throw new Error(`no ${alias}`);
  const start = t.lastIndexOf('COUNT(CASE WHEN', end);
  return t.slice(start, end);
}

describe('getBankAccountsStatus — allocated_count predicate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(sql).mockResolvedValueOnce([] as never);
  });

  it('allocated_count = rows with matched_journal_line_id IS NOT NULL, nothing else', async () => {
    await getBankAccountsStatus(COMPANY_ID);
    const p = predicateOf('allocated_count');
    expect(p).toContain('bt.matched_journal_line_id IS NOT NULL');
    expect(p).not.toContain('suggested_');
    expect(p).not.toContain('allocation_type');
  });

  it('unallocated_count = no journal line, no suggestion, not excluded', async () => {
    await getBankAccountsStatus(COMPANY_ID);
    const p = predicateOf('unallocated_count');
    expect(p).toContain('bt.matched_journal_line_id IS NULL');
    expect(p).toContain('bt.suggested_gl_account_id IS NULL');
    expect(p).toContain("bt.status != 'excluded'");
  });

  it('exposes suggested_count for the middle state', async () => {
    await getBankAccountsStatus(COMPANY_ID);
    const p = predicateOf('suggested_count');
    expect(p).toContain('bt.matched_journal_line_id IS NULL');
    expect(p).toContain('bt.suggested_gl_account_id IS NOT NULL');
    expect(p).toContain("bt.status != 'excluded'");
  });
});
