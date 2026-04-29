/**
 * Pure functions that translate ABSA RPC responses into IsaFlow's
 * canonical bank shapes. Deliberately framework-free so the same module
 * can be exercised by Vitest unit tests (using saved fixtures) and by
 * the Chrome extension content script (which inlines the same logic
 * in chrome-extension/bank-connector/content/absa.js).
 *
 * If the extension copy and this module ever drift, the unit tests
 * here are the source of truth — fix the extension JS to match.
 */
import type { ParsedBankTransaction } from '@/modules/accounting/types/bank.types';

export interface AbsaAccountListResponse {
  accountList: AbsaAccount[];
}

export interface AbsaAccount {
  number: string | number;
  name?: string;
  uncleared?: string;
  available?: string;
  balance?: string;
  accountType?: string;
}

export interface AbsaTransactionHistoryResponse {
  transactionHistory: {
    accountHistoryLines: AbsaTransactionLine[];
  };
}

export interface AbsaTransactionLine {
  balanceAmount: string | null;
  transactionAmount: string | number;
  transactionDate: string;
  transactionDescription: string;
  descriptionLine1?: string;
  descriptionLine2?: string;
  descriptionLine3?: string;
  transactionFee?: string;
}

export interface BankAccountSummary {
  externalAccountId: string;
  accountNumber: string;
  displayName: string;
  type: 'cheque' | 'savings' | 'credit_card' | 'loan' | 'other';
  currency: 'ZAR';
  available: number | null;
  balance: number | null;
}

export function mapAbsaAccount(a: AbsaAccount): BankAccountSummary {
  const accountType = (a.accountType ?? '').toLowerCase();
  let type: BankAccountSummary['type'] = 'other';
  if (accountType === 'current') type = 'cheque';
  else if (accountType === 'savings') type = 'savings';
  else if (accountType.includes('credit')) type = 'credit_card';
  else if (accountType.includes('loan')) type = 'loan';

  return {
    externalAccountId: String(a.number),
    accountNumber: String(a.number),
    displayName: a.name ?? `Account ${a.number}`,
    type,
    currency: 'ZAR',
    available: a.available != null ? Number(a.available) : null,
    balance: a.balance != null ? Number(a.balance) : null,
  };
}

export function mapAbsaAccountList(resp: AbsaAccountListResponse): BankAccountSummary[] {
  return (resp.accountList ?? []).map(mapAbsaAccount);
}

export function mapAbsaTransactionLine(line: AbsaTransactionLine): ParsedBankTransaction {
  const desc = String(line.transactionDescription ?? '').replace(/\s+/g, ' ').trim();
  const out: ParsedBankTransaction = {
    transactionDate: String(line.transactionDate),
    amount: Number(line.transactionAmount),
    description: desc.length > 0 ? desc : '(no description)',
  };
  const ref = line.descriptionLine2 ? String(line.descriptionLine2).replace(/\s+/g, ' ').trim() : '';
  if (ref.length > 0) out.reference = ref;
  if (line.balanceAmount != null) out.balance = Number(line.balanceAmount);
  return out;
}

export function mapAbsaTransactionHistory(resp: AbsaTransactionHistoryResponse): ParsedBankTransaction[] {
  return (resp.transactionHistory?.accountHistoryLines ?? []).map(mapAbsaTransactionLine);
}
