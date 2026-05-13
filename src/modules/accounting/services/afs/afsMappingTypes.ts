// src/modules/accounting/services/afs/afsMappingTypes.ts
// Shared types for the AFS mapping subsystem. Lives in its own module so
// `afsMappingService`, `afsMappingQueries`, and `afsAutoMapper` can import
// types without re-introducing the circular dependency that existed when
// types were exported from `afsMappingService`.

export type AfsLineSection = 'balance_sheet' | 'income_statement';

export interface AfsStatementLine {
  id: string;
  companyId: string;
  code: string;
  section: AfsLineSection;
  label: string;
  parentCode: string | null;
  noteNumber: number | null;
  sortOrder: number;
  combineGroup: string | null;
  isHeader: boolean;
  isTotal: boolean;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface AfsAccountMapping {
  id: string;
  companyId: string;
  glAccountId: string;
  afsLineCode: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface MappedAccount extends AfsAccountMapping {
  accountCode: string;
  accountName: string;
  accountType: string;
  accountSubtype: string | null;
}

export interface MappedTrialBalanceLine {
  code: string;
  label: string;
  section: AfsLineSection;
  noteNumber: number | null;
  combineGroup: string | null;
  isHeader: boolean;
  isTotal: boolean;
  parentCode: string | null;
  sortOrder: number;
  currentAmount: number;
  priorAmount: number;
  accounts: Array<{
    glAccountId: string;
    accountCode: string;
    accountName: string;
    currentBalance: number;
    priorBalance: number;
  }>;
}

export interface AutoMapResult {
  mapped: number;
  skipped: number;
  suggestions: Array<{
    glAccountId: string;
    accountCode: string;
    accountName: string;
    suggestedCode: string;
    suggestedLabel: string;
    confidence: 'high' | 'medium' | 'low';
  }>;
}
