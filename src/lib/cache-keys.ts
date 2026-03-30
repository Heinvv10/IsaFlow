/**
 * WS-5.1: Cache Key Constants
 * Centralised TTL values and key generators.
 * All keys are prefixed with companyId to enforce tenant isolation.
 */

// TTL values in milliseconds
export const CACHE_TTL = {
  REFERENCE_DATA: 5 * 60 * 1000,   // 5 min — GL accounts, customers, suppliers, items
  REPORT_RESULTS: 2 * 60 * 1000,   // 2 min — report query results
  PERMISSIONS: 10 * 60 * 1000,     // 10 min — user permissions
  SETTINGS: 15 * 60 * 1000,        // 15 min — company settings
} as const;

// Key generators — all scoped to companyId
export const CACHE_KEYS = {
  glAccounts: (companyId: string) => `${companyId}:gl-accounts`,
  glAccountsInactive: (companyId: string) => `${companyId}:gl-accounts:all`,
  customers: (companyId: string) => `${companyId}:customers`,
  suppliers: (companyId: string) => `${companyId}:suppliers`,
  items: (companyId: string) => `${companyId}:items`,
  report: (companyId: string, type: string, paramsHash: string) =>
    `${companyId}:report:${type}:${paramsHash}`,
  permissions: (companyId: string, userId: string) =>
    `${companyId}:perms:${userId}`,
  settings: (companyId: string) => `${companyId}:settings`,
} as const;
