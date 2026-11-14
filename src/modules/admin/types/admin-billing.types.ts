/**
 * Admin Billing & Analytics Types
 * Split from admin.types.ts to keep both files ≤300 lines.
 */

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
  /** This subscription's monthly amount after discount, whatever its status. */
  monthly_amount_cents: number;
  /** Whether it is in MRR now (active, company not deleted/suspended/internal). */
  counts_toward_mrr: boolean;
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
  /** Companies with an active subscription worth more than R0 (metrics module). */
  paying_companies: number;
  /** Company churn of this SAST month so far (Revenue Intelligence's latest month); null when nobody paid at its start. */
  churn_rate_percent: number | null;
  /** First day (YYYY-MM-01) of the month churn_rate_percent covers. */
  churn_period: string;
  /** MRR / paying companies; null when no company pays. */
  arpu_cents: number | null;
  /** Manual admin invoices only (admin_invoices), VAT-inclusive. */
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
  /** feature_flags.id — sent back as `feature_id` when setting/clearing an override. */
  id: string;
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

export interface PlatformHealth {
  active_users_24h: number;
  active_users_7d: number;
  active_users_30d: number;
  total_api_calls_24h: number;
  error_count_24h: number;
  /** Error rows / admin audit rows in 24h; null when there were none. */
  error_rate_percent: number | null;
  db_size_mb: number;
  top_companies_by_size: Array<{ company_id: string; company_name: string; size_mb: number }>;
}

export interface UsageAnalytics {
  dau: number;
  wau: number;
  mau: number;
  /** DAU / MAU; null when MAU is 0. */
  stickiness_percent: number | null;
  top_pages: Array<{ path: string; views: number }>;
  /** user_count = companies with effective access (override > global > plan); percent null with no companies. */
  feature_adoption: Array<{ feature: string; adoption_percent: number | null; user_count: number }>;
  revenue_by_plan: Array<{ plan_name: string; mrr_cents: number; company_count: number }>;
  churn_signals: Array<{ company_id: string; company_name: string; days_inactive: number; last_login: string | null }>;
}

export interface MrrTrendPoint {
  date: string;
  mrr_cents: number;
  company_count: number;
}

export interface EngagementTrendPoint {
  date: string;
  dau: number;
  wau: number;
  mau: number;
}

export interface SignupTrendPoint {
  date: string;
  new_companies: number;
  new_users: number;
}

export interface AnalyticsTrends {
  mrr_trend: MrrTrendPoint[];
  engagement_trend: EngagementTrendPoint[];
  signup_trend: SignupTrendPoint[];
}

export interface PlatformSettings {
  smtp_configured: boolean;
}

// ── Revenue Intelligence ──────────────────────────────────────────────────────

export interface PlanBreakdownRow {
  plan_name: string;
  billing_cycle: string;
  company_count: number;
  mrr_cents: number;
  arr_cents: number;
  /** null when total MRR is 0. */
  pct_of_total: number | null;
}

export interface ChurnTrendPoint {
  month: string;
  churned_companies: number;
  /** null when no company was active at the start of the month. */
  churn_rate_pct: number | null;
}

export interface CohortRetentionRow {
  /** First day of the SAST signup month, YYYY-MM-01. */
  cohort_month: string;
  cohort_size: number;
  /** % of the cohort with a live subscription at the end of month N after signup; null until that month has ended. */
  m0_pct: number | null;
  m1_pct: number | null;
  m2_pct: number | null;
  m3_pct: number | null;
}

export interface RevenueIntelligence {
  plan_breakdown: PlanBreakdownRow[];
  churn_trend: ChurnTrendPoint[];
  /** null when no company paid at the start of last month. */
  nrr: number | null;
  arpu_cents: number | null;
  ltv_estimate_cents: number | null;
  cohort_retention: CohortRetentionRow[];
}
