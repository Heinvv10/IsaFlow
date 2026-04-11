/**
 * Shared types for the consolidation / intercompany service.
 */

export interface GroupCompany {
  id: string;
  name: string;
  relationshipType: string;
  ownershipPercent: number;
}

export interface ConsolidatedAccount {
  accountCode: string;
  accountName: string;
  accountType: string;
  byEntity: Record<string, { debit: number; credit: number }>;
  totalDebit: number;
  totalCredit: number;
  isEliminated: boolean;
}

export interface ConsolidatedTrialBalance {
  groupName: string;
  periodStart: string;
  periodEnd: string;
  entities: { companyId: string; companyName: string }[];
  accounts: ConsolidatedAccount[];
  totalDebits: number;
  totalCredits: number;
}

export interface IntercompanyBalance {
  fromCompanyId: string;
  fromCompanyName: string;
  toCompanyId: string;
  toCompanyName: string;
  eliminationType: string;
  amount: number;
  description: string | null;
}
