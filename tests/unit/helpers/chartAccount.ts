import type { GLAccount } from '@/modules/accounting/types/gl.types';

/** One row as GET /api/accounting/chart-of-accounts answers it (typed against the API's GLAccount). */
export function chartAccount(id: string, accountCode: string, accountName: string, over: Partial<GLAccount> = {}): GLAccount {
  return {
    id, accountCode, accountName, accountType: 'expense', isActive: true, isSystemAccount: false,
    normalBalance: 'debit', level: 3, displayOrder: 0, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', ...over,
  };
}
