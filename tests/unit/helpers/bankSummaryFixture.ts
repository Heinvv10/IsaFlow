/** A BankAccountSummary (GET /api/accounting/bank-account-summaries) with every field defaulted; override what a test cares about. */
import type { BankAccountSummary } from '@/modules/accounting/services/bank/bankAccountSummaryService';

type Overrides = Partial<Omit<BankAccountSummary, 'counts' | 'statement'>> & {
  counts?: Partial<BankAccountSummary['counts']>;
  statement?: Partial<BankAccountSummary['statement']>;
};

export function summaryAcct(id: string, o: Overrides = {}): BankAccountSummary {
  const { counts, statement, ...rest } = o;
  const c = { posted: 0, allocated: 0, provisional: 0, suggested: 0, unallocated: 0, excluded: 0, toCode: 0, awaitingReview: 0, pendingAtBank: 0, ...counts };
  c.toCode = counts?.toCode ?? c.suggested + c.unallocated;
  return {
    id, accountCode: id, accountName: `Account ${id}`, accountType: 'asset', bankAccountNumber: null, isActive: true,
    groupId: null, groupName: null, groupCode: null, lastDate: '2026-10-20', ledgerAsAt: '2026-11-16', ledgerCents: 0,
    counts: c, toCodeInCents: 0, toCodeOutCents: 0,
    statement: { latest: null, lastWithBalance: null, ledgerAtStatementCents: null, differenceCents: null, ...statement },
    ...rest,
  };
}
