/**
 * One definition of an unreconciled bank line (#1308 follow-up): a posted statement line that is neither reconciled
 * (completion, or the Sage import) nor excluded. The bank-account card, the workbench / attention count and the
 * bureau cockpit all splice it. What each population actually returns is proved against a real database in
 * tests/integration/bank-unreconciled-counts.int.test.ts; this pins the wiring.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const UNSAFE = vi.hoisted(() => (s: string) => ({ unsafe: s }));
vi.mock('@/lib/neon', () => ({ sql: Object.assign(vi.fn(), { transaction: vi.fn(), unsafe: vi.fn(UNSAFE) }) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

import { sql } from '@/lib/neon';
import { UNRECONCILED_LINE_SQL } from '@/modules/accounting/services/bank/unreconciledLineSql';
import { getBankAccountsStatus } from '@/modules/accounting/services/bank/bankAccountStatusService';
import { getUnreconciledBankTxns } from '@/modules/accounting/services/dashboard/workbenchService';
import { aggregateBureauWork, type CompanyMeta } from '@/modules/bureau/services/bureauWorkAggregatorService';

const COMPANY = 'aaaaaaaa-0000-4000-8000-aaaaaaaaaaaa';
type Call = [TemplateStringsArray, ...unknown[]];
const calls = () => vi.mocked(sql).mock.calls as unknown as Call[];
const text = (c: Call) => c[0].join('?');
/** The template calls whose text reads bank_transactions, with their spliced fragments. */
const bankTxCalls = () => calls().filter((c) => /FROM bank_transactions/.test(text(c)));
const splices = (c: Call) => c.slice(1).some((v) => JSON.stringify(v) === JSON.stringify(UNSAFE(UNRECONCILED_LINE_SQL)));

describe('UNRECONCILED_LINE_SQL', () => {
  it('is a posted line that is neither reconciled (Sage included: same status) nor excluded', () => {
    expect(UNRECONCILED_LINE_SQL).toBe("(bt.feed_state = 'posted' AND bt.status NOT IN ('reconciled', 'excluded'))");
  });
});

describe('every unreconciled count splices the one definition', () => {
  beforeEach(() => {
    vi.mocked(sql).mockReset();
    vi.mocked(sql).mockResolvedValue([] as never);
  });

  it('the bank-account card (bank_accounts_status, the bank_accounts export): unreconciled_count', async () => {
    await getBankAccountsStatus(COMPANY);
    const [c] = calls();
    const t = text(c!);
    // The fragment is the CASE predicate of unreconciled_count, nothing else around it.
    expect(t).toMatch(/COUNT\(CASE WHEN \? THEN 1 END\)::INT AS unreconciled_count/);
    expect(splices(c!)).toBe(true);
    expect(t).not.toMatch(/status IN \('imported', 'allocated'\)/);
  });

  it('the workbench and the attention panel: getUnreconciledBankTxns', async () => {
    vi.mocked(sql).mockResolvedValueOnce([{ cnt: 4 }] as never);
    expect(await getUnreconciledBankTxns(COMPANY)).toBe(4);
    const [c] = bankTxCalls();
    expect(splices(c!)).toBe(true);
    expect(text(c!)).not.toMatch(/'matched'/);
    expect(c!.slice(1)).toContain(COMPANY);
  });

  it('the bureau cockpit: the Bank reconciliation signal', async () => {
    const meta = new Map<string, CompanyMeta>([
      [COMPANY, { bureau_id: 'b1', bureau_name: 'Bureau', company_id: COMPANY, company_name: 'Client' }],
    ]);
    await aggregateBureauWork([COMPANY], meta, new Date('2026-11-15T10:00:00Z'));
    const recon = bankTxCalls().filter((c) => /GROUP BY bt\.company_id/.test(text(c)));
    expect(recon).toHaveLength(1);
    expect(splices(recon[0]!)).toBe(true);
    expect(text(recon[0]!)).not.toMatch(/'matched'/);
  });
});
