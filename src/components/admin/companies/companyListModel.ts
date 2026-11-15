/**
 * Company list (pages/admin/companies/index.tsx): a row of GET /api/admin/companies and the columns it sorts by.
 */
export interface Company {
  id: string;
  name: string;
  trading_name: string | null;
  plan_name: string;
  plan_code: string;
  status: 'trial' | 'active' | 'suspended' | 'cancelled' | 'deleted';
  user_count: number;
  mrr_cents: number;
  created_at: string;
  last_active: string | null;
}

export interface PagedResponse {
  items: Company[];
  total: number;
  page: number;
  limit: number;
}

export type SortField = 'name' | 'plan_name' | 'status' | 'user_count' | 'mrr_cents' | 'created_at' | 'last_active';
