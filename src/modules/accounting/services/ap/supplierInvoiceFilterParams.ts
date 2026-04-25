/**
 * Shared query-param parser for the supplier-invoices list and export routes.
 *
 * Single source of truth for: status enum validation, sort whitelist, numeric
 * coercion. Both `pages/api/accounting/supplier-invoices.ts` and
 * `supplier-invoices-export.ts` import this — adding a new filter goes in
 * exactly one place.
 */

import type { SupplierInvoiceStatus, InvoiceMatchStatus } from '../../types/ap.types';
import {
  type SupplierInvoiceSort,
  SUPPLIER_INVOICE_SORT_KEYS,
} from './supplierInvoiceService';

const STATUS_VALUES: readonly SupplierInvoiceStatus[] = [
  'draft', 'pending_approval', 'approved', 'partially_paid', 'paid',
  'disputed', 'cancelled',
] as const;

const MATCH_STATUS_VALUES: readonly InvoiceMatchStatus[] = [
  'unmatched', 'po_matched', 'grn_matched', 'fully_matched',
] as const;

export interface ParsedSupplierInvoiceFilters {
  status?: SupplierInvoiceStatus;
  supplierId?: string;
  matchStatus?: InvoiceMatchStatus;
  search?: string;
  fromDate?: string;
  toDate?: string;
  fromAmount?: number;
  toAmount?: number;
  fromBalance?: number;
  toBalance?: number;
  sort?: SupplierInvoiceSort;
  sortOrder?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

export type FilterParseResult =
  | { ok: true; filters: ParsedSupplierInvoiceFilters }
  | { ok: false; error: string };

function pickStr(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function parseNumeric(v: unknown): number | undefined {
  const s = pickStr(v);
  if (s === undefined) return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
function parseIsoDate(v: unknown): string | undefined {
  const s = pickStr(v);
  return s && ISO_DATE.test(s) ? s : undefined;
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseSupplierInvoiceFilters(query: Record<string, unknown>): FilterParseResult {
  const status = pickStr(query.status);
  if (status && !(STATUS_VALUES as readonly string[]).includes(status)) {
    return { ok: false, error: `Invalid status: ${status}` };
  }

  const matchStatus = pickStr(query.match_status);
  if (matchStatus && !(MATCH_STATUS_VALUES as readonly string[]).includes(matchStatus)) {
    return { ok: false, error: `Invalid match_status: ${matchStatus}` };
  }

  const sort = pickStr(query.sort);
  if (sort && !(SUPPLIER_INVOICE_SORT_KEYS as readonly string[]).includes(sort)) {
    return { ok: false, error: `Invalid sort: ${sort}` };
  }

  const supplierIdRaw = pickStr(query.supplier_id);
  if (supplierIdRaw && !UUID_REGEX.test(supplierIdRaw)) {
    return { ok: false, error: 'Invalid supplier_id (must be UUID)' };
  }

  const sortOrderRaw = pickStr(query.sort_order);
  const sortOrder = sortOrderRaw === 'asc' || sortOrderRaw === 'desc' ? sortOrderRaw : undefined;

  const limit = parseNumeric(query.limit);
  const offset = parseNumeric(query.offset);

  return {
    ok: true,
    filters: {
      status: status as SupplierInvoiceStatus | undefined,
      supplierId: supplierIdRaw,
      matchStatus: matchStatus as InvoiceMatchStatus | undefined,
      search: pickStr(query.search),
      fromDate: parseIsoDate(query.from_date),
      toDate: parseIsoDate(query.to_date),
      fromAmount: parseNumeric(query.from_amount),
      toAmount: parseNumeric(query.to_amount),
      fromBalance: parseNumeric(query.from_balance),
      toBalance: parseNumeric(query.to_balance),
      sort: sort as SupplierInvoiceSort | undefined,
      sortOrder,
      limit: typeof limit === 'number' ? Math.min(limit, 200) : undefined,
      offset: typeof offset === 'number' && offset >= 0 ? offset : undefined,
    },
  };
}
