/**
 * Response shapes of the South African Sage Business Cloud Accounting API
 * (https://accounting.sageone.co.za/api/2.0.0). Only the fields the take-on
 * reads are declared; Sage returns many more.
 *
 * Shapes were checked against a live company on 2026-10-21: account IDs of
 * Sage's own system accounts are NEGATIVE (-7 Trade Receivables, -8 Trade
 * Payables, …), category IDs are per-installation and must not be trusted for
 * meaning (descriptions are), and system accounts report Balance 0 in the
 * account list — their balances only exist on the trial balance.
 */

export interface SagePaged<T> {
  TotalResults: number;
  ReturnedResults: number;
  Results: T[];
}

export interface SageCompanySummary {
  ID: number;
  Name: string;
  Active?: boolean;
  TaxNumber?: string;
  RegistrationNumber?: string;
  CurrencySymbol?: string;
}

export interface SageFinancialYear {
  ID: number;
  YearStart: string;
  YearEnd: string;
  IsCurrentYear: boolean;
}

export interface SageAccountCategory {
  ID: number;
  Description: string;
  Order?: number;
}

export interface SageAccount {
  ID: number;
  Name: string;
  Category?: SageAccountCategory | null;
  Active: boolean;
  Balance?: number;
  Description?: string;
  /** 1 = user account, 2 = Sage system account, 3 = bank. */
  AccountType: number;
}

export interface SageBankAccount {
  ID: number;
  Name: string;
  BankName?: string;
  AccountNumber?: string;
  Active?: boolean;
  Balance?: number;
}

export interface SageTrialBalanceLine {
  AccountId: number;
  Name: string;
  AccountNumber?: string;
  Debit: number;
  Credit: number;
  AccountTypeId?: number;
}

interface SageContactBase {
  ID: number;
  Name: string;
  Active: boolean;
  Balance: number;
  TaxReference?: string;
  ContactName?: string;
  Telephone?: string;
  Mobile?: string;
  Email?: string;
  BusinessRegistrationNumber?: string;
  PostalAddress01?: string;
  PostalAddress02?: string;
  PostalAddress03?: string;
  PostalAddress04?: string;
  PostalAddress05?: string;
}

export interface SageCustomer extends SageContactBase {
  CreditLimit?: number;
}

export type SageSupplier = SageContactBase;

/** One row of OutstandingCustomerDocument/Get or OutstandingSupplierDocument/Get. */
export interface SageOutstandingDocument {
  ID: number;
  DocumentTypeId?: number;
  DocumentNumber: string;
  Reference?: string;
  Date: string;
  DueDate?: string;
  Exclusive?: number;
  Tax?: number;
  Total: number;
  AmountDue: number;
}

/** Everything the take-on needs, as pulled from one Sage company. */
export interface SagePull {
  company: { id: number; name: string };
  asAtDate: string;
  financialYearStart: string;
  accounts: SageAccount[];
  bankAccounts: SageBankAccount[];
  trialBalance: SageTrialBalanceLine[];
  customers: SageCustomer[];
  suppliers: SageSupplier[];
  /** Keyed by Sage customer / supplier ID; only contacts with a non-zero balance are fetched. */
  customerDocuments: Record<number, SageOutstandingDocument[]>;
  supplierDocuments: Record<number, SageOutstandingDocument[]>;
}
