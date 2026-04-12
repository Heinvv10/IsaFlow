/**
 * Admin Platform Types
 * ISAFlow Admin Platform — Phase 1 MVP
 * Covers: Dashboard, Company Management, User Management, Audit Log
 * Billing/analytics types split to admin-billing.types.ts
 */

export interface AdminCompanyListItem {
  id: string;
  name: string;
  trading_name: string | null;
  status: string;
  plan_name: string | null;
  plan_code: string | null;
  user_count: number;
  mrr_cents: number;
  created_at: string;
  last_active: string | null;
}

export interface AdminCompanyDetail extends AdminCompanyListItem {
  registration_number: string | null;
  vat_number: string | null;
  tax_number: string | null;
  address_line1: string | null;
  city: string | null;
  province: string | null;
  postal_code: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  billing_email: string | null;
  billing_contact: string | null;
  stripe_customer_id: string | null;
  trial_ends_at: string | null;
  suspended_at: string | null;
  suspended_reason: string | null;
  metadata: Record<string, unknown>;
}

export interface AdminUserListItem {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  role: string;
  status: string;
  company_count: number;
  company_names: string[];
  primary_company: string | null;
  last_login: string | null;
  login_count: number;
  created_at: string;
}

export interface AdminUserDetail extends AdminUserListItem {
  phone: string | null;
  department: string | null;
  last_login_ip: string | null;
  suspended_at: string | null;
  suspended_reason: string | null;
  companies: AdminUserCompany[];
}

export interface AdminUserCompany {
  company_id: string;
  company_name: string;
  role: string;
  is_default: boolean;
}

export interface DashboardStats {
  total_companies: number;
  active_companies: number;
  total_users: number;
  active_users_30d: number;
  mrr_cents: number;
  arr_cents: number;
  new_signups_30d: number;
  recent_activity: ActivityEvent[];
}

export interface ActivityEvent {
  id: string;
  type: string;
  description: string;
  user_name: string | null;
  company_name: string | null;
  created_at: string;
}

export interface AuditLogEntry {
  id: string;
  admin_user_id: string;
  admin_name: string;
  action: string;
  target_type: string;
  target_id: string | null;
  details: Record<string, unknown>;
  ip_address: string | null;
  created_at: string;
}

export interface AdminListFilters {
  search?: string;
  status?: string;
  company?: string;
  page?: number;
  limit?: number;
  sort_by?: string;
  sort_dir?: 'asc' | 'desc';
}

export interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
  total_pages: number;
}

// Billing/analytics types re-exported from split file for backward compat
export type {
  Plan,
  SubscriptionListItem,
  InvoiceListItem,
  BillingOverview,
  FeatureFlag,
  CompanyFeatureOverride,
  CompanyEffectiveFeature,
  Announcement,
  PlatformHealth,
  UsageAnalytics,
  MrrTrendPoint,
  EngagementTrendPoint,
  SignupTrendPoint,
  AnalyticsTrends,
  PlatformSettings,
  PlanBreakdownRow,
  ChurnTrendPoint,
  CohortRetentionRow,
  RevenueIntelligence,
} from './admin-billing.types';
