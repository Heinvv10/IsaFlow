/**
 * Route catalog for the API contract sweep.
 * Covers representative routes across all API modules.
 * Dynamic segments (e.g. [id]) are replaced with a nil UUID placeholder.
 *
 * scripts/audit/sweep-routes.ts
 */

export interface RouteSpec {
  /** URL path, relative to base. Dynamic [id] replaced with NIL_UUID. */
  path: string;
  /** HTTP verbs to exercise on this path */
  methods: string[];
  /** Optional hint about which module owns this route */
  module?: string;
  /** Skip POST/PATCH/DELETE mutation scenarios for read-only routes */
  readOnly?: boolean;
}

export const NIL_UUID = '00000000-0000-0000-0000-000000000000';

/** Routes selected for the sweep — one representative per major sub-module. */
export const ROUTES: RouteSpec[] = [
  // ── Auth ─────────────────────────────────────────────────────────────────
  { path: '/api/auth/me', methods: ['GET'], module: 'auth', readOnly: true },
  { path: '/api/auth/profile', methods: ['GET', 'PATCH'], module: 'auth' },
  { path: '/api/auth/preferences', methods: ['GET', 'PATCH'], module: 'auth' },

  // ── Health ────────────────────────────────────────────────────────────────
  { path: '/api/health/index', methods: ['GET'], module: 'health', readOnly: true },
  { path: '/api/health/deep', methods: ['GET'], module: 'health', readOnly: true },

  // ── Accounting core ───────────────────────────────────────────────────────
  { path: '/api/accounting/dashboard-stats', methods: ['GET'], module: 'dashboard', readOnly: true },
  { path: '/api/accounting/chart-of-accounts', methods: ['GET', 'POST'], module: 'coa' },
  { path: '/api/accounting/customers', methods: ['GET', 'POST'], module: 'customers' },
  { path: '/api/accounting/suppliers-list', methods: ['GET'], module: 'suppliers', readOnly: true },
  { path: '/api/accounting/bank-accounts', methods: ['GET', 'POST'], module: 'banking' },
  { path: '/api/accounting/bank-transactions', methods: ['GET'], module: 'banking', readOnly: true },
  { path: '/api/accounting/customer-invoices-list', methods: ['GET'], module: 'ar', readOnly: true },
  { path: '/api/accounting/supplier-invoices', methods: ['GET', 'POST'], module: 'ap' },
  { path: '/api/accounting/customer-payments', methods: ['GET', 'POST'], module: 'ar' },
  { path: '/api/accounting/supplier-payments', methods: ['GET'], module: 'ap', readOnly: true },

  // ── Reports ───────────────────────────────────────────────────────────────
  { path: '/api/accounting/reports-trial-balance', methods: ['GET'], module: 'reports', readOnly: true },
  { path: '/api/accounting/reports-balance-sheet', methods: ['GET'], module: 'reports', readOnly: true },
  { path: '/api/accounting/reports-income-statement', methods: ['GET'], module: 'reports', readOnly: true },
  { path: '/api/accounting/ar-aging', methods: ['GET'], module: 'reports', readOnly: true },
  { path: '/api/accounting/ap-aging', methods: ['GET'], module: 'reports', readOnly: true },

  // ── VAT ───────────────────────────────────────────────────────────────────
  { path: '/api/accounting/vat-returns/index', methods: ['GET'], module: 'vat', readOnly: true },

  // ── Journals ─────────────────────────────────────────────────────────────
  { path: '/api/accounting/adjustments', methods: ['GET', 'POST'], module: 'journals' },
  { path: '/api/accounting/fiscal-periods', methods: ['GET'], module: 'journals', readOnly: true },

  // ── Assets ────────────────────────────────────────────────────────────────
  { path: '/api/accounting/assets-register', methods: ['GET'], module: 'far', readOnly: true },
  { path: '/api/accounting/assets-categories', methods: ['GET'], module: 'far', readOnly: true },

  // ── Banking ───────────────────────────────────────────────────────────────
  { path: '/api/accounting/bank-rules', methods: ['GET'], module: 'banking', readOnly: true },
  { path: '/api/accounting/bank-reconciliations', methods: ['GET'], module: 'banking', readOnly: true },

  // ── AFS ───────────────────────────────────────────────────────────────────
  { path: '/api/accounting/afs/index', methods: ['GET'], module: 'afs', readOnly: true },
  { path: '/api/accounting/afs-mapping/stats', methods: ['GET'], module: 'afs', readOnly: true },

  // ── Practice ─────────────────────────────────────────────────────────────
  { path: '/api/accounting/practice/work-items', methods: ['GET', 'POST'], module: 'practice' },
  { path: '/api/accounting/practice/time-entries', methods: ['GET', 'POST'], module: 'practice' },
  { path: '/api/accounting/practice/users', methods: ['GET'], module: 'practice', readOnly: true },

  // ── Payroll ───────────────────────────────────────────────────────────────
  { path: '/api/payroll/employees/index', methods: ['GET'], module: 'payroll', readOnly: true },
  { path: '/api/payroll/runs/index', methods: ['GET'], module: 'payroll', readOnly: true },
  { path: '/api/payroll/leave/index', methods: ['GET'], module: 'payroll', readOnly: true },
  { path: '/api/payroll/components/index', methods: ['GET'], module: 'payroll', readOnly: true },
  { path: '/api/payroll/cost-centres/index', methods: ['GET'], module: 'payroll', readOnly: true },
  { path: '/api/payroll/leave/types', methods: ['GET'], module: 'payroll', readOnly: true },
  { path: '/api/payroll/period-context', methods: ['GET'], module: 'payroll', readOnly: true },

  // ── Admin ─────────────────────────────────────────────────────────────────
  { path: '/api/admin/companies', methods: ['GET'], module: 'admin', readOnly: true },
  { path: '/api/admin/users', methods: ['GET'], module: 'admin', readOnly: true },
  { path: '/api/admin/billing/plans', methods: ['GET'], module: 'admin', readOnly: true },
  { path: '/api/admin/billing/subscriptions', methods: ['GET'], module: 'admin', readOnly: true },
  { path: '/api/admin/billing/invoices', methods: ['GET'], module: 'admin', readOnly: true },
  { path: '/api/admin/webhooks', methods: ['GET'], module: 'admin', readOnly: true },
  { path: '/api/admin/analytics/web/summary', methods: ['GET'], module: 'admin', readOnly: true },
  { path: '/api/admin/dashboard-stats', methods: ['GET'], module: 'admin', readOnly: true },
  { path: '/api/admin/features', methods: ['GET'], module: 'admin', readOnly: true },
  { path: '/api/admin/health', methods: ['GET'], module: 'admin', readOnly: true },

  // ── Company settings ──────────────────────────────────────────────────────
  { path: '/api/accounting/company-settings', methods: ['GET', 'PATCH'], module: 'settings' },
  { path: '/api/accounting/company-users', methods: ['GET'], module: 'settings', readOnly: true },
  { path: '/api/accounting/accounting-settings', methods: ['GET', 'PATCH'], module: 'settings' },

  // ── Products / stock ──────────────────────────────────────────────────────
  { path: '/api/accounting/products', methods: ['GET'], module: 'inventory', readOnly: true },
  { path: '/api/accounting/stock-levels', methods: ['GET'], module: 'inventory', readOnly: true },

  // ── Webhooks/announcements ────────────────────────────────────────────────
  { path: '/api/accounting/webhooks', methods: ['GET'], module: 'webhooks', readOnly: true },
  { path: '/api/announcements/active', methods: ['GET'], module: 'announcements', readOnly: true },
];
