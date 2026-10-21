/**
 * The shape a Sage pull is turned into: exactly the rows the migration
 * wizard's take-on steps accept, plus what the review screen shows.
 */
import type { GLAccountType } from '@/modules/accounting/types/gl.types';
import type { AccountImportRow, SystemAccountMap } from '../core/migrationCoaService';
import type { CustomerImportRow, SupplierImportRow } from '../core/migrationContactService';
import type { ARInvoiceRow } from '../core/migrationImportService';
import type { OpeningBalanceRow } from '../core/migrationWizardOpeningBalanceService';
import type { APInvoiceRow } from '../ap/migrationApService';

export type SystemRole = keyof SystemAccountMap;

/** What the target company already has, read just before building. */
export interface TakeOnContext {
  /** Every account code already on the company's chart. */
  takenCodes: readonly string[];
  /** The current holder of each system role, if any. */
  existingRoles: Partial<Record<SystemRole, { code: string; name: string; type: GLAccountType }>>;
}

export type TakeOnIssueArea =
  | 'accounts' | 'trial_balance' | 'customers' | 'suppliers' | 'receivables' | 'payables';

export interface TakeOnIssue {
  /** An error blocks the import; a warning is shown and the import may go ahead. */
  severity: 'error' | 'warning';
  area: TakeOnIssueArea;
  message: string;
}

export interface TakeOnTotals {
  trialBalanceDebit: number;
  trialBalanceCredit: number;
  receivableControl: number;
  receivableDocuments: number;
  payableControl: number;
  payableDocuments: number;
}

export interface SageTakeOn {
  sageCompany: { id: number; name: string };
  asAtDate: string;
  accounts: AccountImportRow[];
  systemAccountMap: SystemAccountMap;
  /** Sage account id → the IsaFlow code it was given. */
  sageAccountCodes: Record<number, string>;
  /** The trial balance without the receivable and payable control lines. */
  openingBalances: OpeningBalanceRow[];
  /**
   * The line that balances `openingBalances`; posted to the company's Opening
   * Balance Equity account at import time, when its code is known. The AR and
   * AP documents post the opposite, so the account nets to zero.
   */
  openingBalanceClearing: { debit: number; credit: number };
  customers: CustomerImportRow[];
  suppliers: SupplierImportRow[];
  arInvoices: ARInvoiceRow[];
  apInvoices: APInvoiceRow[];
  issues: TakeOnIssue[];
  totals: TakeOnTotals;
}

export const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

export const formatRand = (n: number): string =>
  `R${n.toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
