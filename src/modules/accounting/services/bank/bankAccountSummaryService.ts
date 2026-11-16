/**
 * One summary per bank account (WP1 "Truthful numbers", PR-B): the figures the bank-transactions cards, tiles and
 * statement panel show, from ONE statement (./bankAccountSummarySql, which documents every definition). This file
 * holds the wire types and the mapper only.
 *
 * Money is integer cents (JSON numbers). int8 arrives from pg as a string, so every cents column goes through
 * `safeInt()`, which refuses anything that is not a safe integer rather than round it.
 *
 * Invariants (pinned by tests/integration/bank-account-summary-partition.int.test.ts):
 *   allocated + suggested + unallocated + excluded === posted; toCode === suggested + unallocated;
 *   provisional <= allocated.
 *
 * Not the MCP list summary: that is ./bankTxSummaryService (`list_bank_transactions` detail=summary).
 */
import type { DbRow } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import type { BalanceSource } from '../../types/bank.types';
import { statementSourceLabel } from './bankStatementBalances';
import { bankAccountSummaryQuery } from './bankAccountSummarySql';

export type { BalanceSource };

export interface StatementRef {
  batchId: string;
  statementDate: string;
  /** The format chip's text (statementSourceLabel). */
  sourceLabel: string;
  /** Where the balances came from, or why there are none; null for a batch imported before migration 998. */
  balanceSource: BalanceSource | null;
  openingCents: number | null;
  closingCents: number | null;
  /** Lines naming the batch now, removed ones excluded. */
  lineCount: number;
  importedAt: string;
}

export interface BankAccountSummaryCounts {
  posted: number;
  allocated: number;
  /** Of `allocated`, the provisional lines. */
  provisional: number;
  suggested: number;
  unallocated: number;
  excluded: number;
  /** suggested + unallocated. */
  toCode: number;
  /** Posted lines on the New tab (NEW_TAB_SQL), whatever the page's filters. */
  awaitingReview: number;
  /** Lines still pending at the bank (feed). */
  pendingAtBank: number;
}

export interface BankAccountSummary {
  id: string;
  accountCode: string;
  accountName: string;
  accountType: string;
  bankAccountNumber: string | null;
  isActive: boolean;
  groupId: string | null;
  groupName: string | null;
  groupCode: string | null;
  /** The newest posted line's date. */
  lastDate: string | null;
  ledgerAsAt: string;
  ledgerCents: number;
  counts: BankAccountSummaryCounts;
  /** Sum of the to-code lines' money in (>= 0) and out (<= 0). */
  toCodeInCents: number;
  toCodeOutCents: number;
  statement: {
    latest: StatementRef | null;
    lastWithBalance: StatementRef | null;
    /** The ledger as at lastWithBalance's statement date. */
    ledgerAtStatementCents: number | null;
    /** lastWithBalance.closingCents − ledgerAtStatementCents; null without a statement balance. */
    differenceCents: number | null;
  };
}

export interface BankAccountSummaries {
  asAt: string;
  accounts: BankAccountSummary[];
}

function safeInt(v: unknown, column: string): number {
  const n = Number(v);
  if (v === null || v === undefined || typeof v === 'boolean' || !Number.isSafeInteger(n)) {
    throw new Error(`bank account summary: ${column} is not a safe integer (${String(v)})`);
  }
  return n;
}

const centsOrNull = (v: unknown, column: string): number | null => (v === null || v === undefined ? null : safeInt(v, column));
const strOrNull = (v: unknown): string | null => (v === null || v === undefined || v === '' ? null : String(v));
const isoOf = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));

function statementRef(r: DbRow, prefix: 'lt' | 'lb'): StatementRef | null {
  const id = r[`${prefix}_id`];
  if (id === null || id === undefined) return null;
  const format = strOrNull(r[`${prefix}_bank_format`]);
  const channel = strOrNull(r[`${prefix}_import_channel`]);
  return {
    batchId: String(id),
    statementDate: fmtDate(r[`${prefix}_statement_date`]),
    sourceLabel: statementSourceLabel(format, channel),
    balanceSource: strOrNull(r[`${prefix}_balance_source`]) as BalanceSource | null,
    openingCents: centsOrNull(r[`${prefix}_opening_cents`], `${prefix}_opening_cents`),
    closingCents: centsOrNull(r[`${prefix}_closing_cents`], `${prefix}_closing_cents`),
    lineCount: safeInt(r[`${prefix}_line_count`], `${prefix}_line_count`),
    importedAt: isoOf(r[`${prefix}_created_at`]),
  };
}

export function mapSummaryRow(r: DbRow): BankAccountSummary {
  const count = (column: string) => safeInt(r[column], column);
  const suggested = count('suggested');
  const unallocated = count('unallocated');
  const lastWithBalance = statementRef(r, 'lb');
  const ledgerAtStatementCents = lastWithBalance
    ? safeInt(r.ledger_at_statement_cents, 'ledger_at_statement_cents') : null;
  const differenceCents = lastWithBalance && lastWithBalance.closingCents !== null && ledgerAtStatementCents !== null
    ? lastWithBalance.closingCents - ledgerAtStatementCents : null;
  return {
    id: String(r.id),
    accountCode: String(r.account_code),
    accountName: String(r.account_name),
    accountType: String(r.account_type),
    bankAccountNumber: strOrNull(r.bank_account_number),
    isActive: r.is_active === true,
    groupId: strOrNull(r.group_id),
    groupName: strOrNull(r.group_name),
    groupCode: strOrNull(r.group_code),
    lastDate: r.last_date ? fmtDate(r.last_date) : null,
    ledgerAsAt: fmtDate(r.as_at),
    ledgerCents: safeInt(r.ledger_cents, 'ledger_cents'),
    counts: {
      posted: count('posted'),
      allocated: count('allocated'),
      provisional: count('provisional'),
      suggested,
      unallocated,
      excluded: count('excluded'),
      toCode: suggested + unallocated,
      awaitingReview: count('awaiting_review'),
      pendingAtBank: count('pending_at_bank'),
    },
    toCodeInCents: safeInt(r.to_code_in_cents, 'to_code_in_cents'),
    toCodeOutCents: safeInt(r.to_code_out_cents, 'to_code_out_cents'),
    statement: {
      latest: statementRef(r, 'lt'),
      lastWithBalance,
      ledgerAtStatementCents,
      differenceCents,
    },
  };
}

/** `opts.asAt` (YYYY-MM-DD) pins the ledger date for tests; the route never passes it (today in SAST). */
export async function getBankAccountSummaries(
  companyId: string,
  opts: { asAt?: string } = {},
): Promise<BankAccountSummaries> {
  const rows = (await bankAccountSummaryQuery(companyId, opts.asAt ?? null)) as DbRow[];
  const asAt = fmtDate(rows[0]?.as_at);
  return { asAt, accounts: rows.filter((r) => r.id !== null && r.id !== undefined).map(mapSummaryRow) };
}
