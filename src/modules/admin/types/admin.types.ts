/**
 * Admin Platform Types
 * ISAFlow Admin Platform — Phase 1 MVP
 * Covers: Dashboard, Company Management, User Management, Audit Log
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

export interface Plan {
  id: string;
  code: string;
  name: string;
  description: string | null;
  monthly_price_cents: number;
  annual_price_cents: number;
  currency: string;
  features: Record<string, unknown>;
  limits: Record<string, unknown>;
  is_active: boolean;
  display_order: number;
  created_at: string;
  updated_at: string;
}

export interface SubscriptionListItem {
  id: string;
  company_id: string;
  company_name: string;
  plan_id: string;
  plan_name: string;
  plan_code: string;
  status: string;
  billing_cycle: string;
  current_period_start: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  discount_percent: number;
  monthly_amount_cents: number;
  created_at: string;
}

export interface InvoiceListItem {
  id: string;
  company_id: string;
  company_name: string;
  invoice_number: string;
  status: string;
  subtotal_cents: number;
  tax_cents: number;
  total_cents: number;
  currency: string;
  due_date: string | null;
  paid_at: string | null;
  payment_method: string | null;
  created_at: string;
}

export interface BillingOverview {
  mrr_cents: number;
  arr_cents: number;
  total_subscriptions: number;
  active_subscriptions: number;
  past_due_count: number;
  trial_count: number;
  churn_rate_percent: number;
  arpu_cents: number;
  total_revenue_cents: number;
  outstanding_cents: number;
}

export interface FeatureFlag {
  id: string;
  code: string;
  name: string;
  description: string | null;
  is_global: boolean;
  created_at: string;
}

export interface CompanyFeatureOverride {
  company_id: string;
  feature_id: string;
  feature_code: string;
  feature_name: string;
  enabled: boolean;
  reason: string | null;
  set_by: string;
  created_at: string;
}

export interface CompanyEffectiveFeature {
  code: string;
  name: string;
  enabled: boolean;
  source: 'global' | 'plan' | 'override';
}

export interface Announcement {
  id: string;
  title: string;
  message: string;
  type: string;
  target: string;
  target_ids: string[];
  starts_at: string;
  ends_at: string | null;
  is_dismissible: boolean;
  created_by: string;
  created_at: string;
}
