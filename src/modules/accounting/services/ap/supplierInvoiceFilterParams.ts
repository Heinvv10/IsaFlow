/**
 * Shared query-param parser for the supplier-invoices list and export routes.
 *
 * Single source of truth for: status enum validation, sort whitelist, numeric
 * coercion, strict from_date/to_date (invoiceDateRangeParams). Both `pages/api/accounting/supplier-invoices.ts` and
 * `supplier-invoices-export.ts` import this — adding a new filter goes in
 * exactly one place.
 */

import type { SupplierInvoiceStatus, InvoiceMatchStatus } from '../../types/ap.types';
import {
  type SupplierInvoiceSort,
  SUPPLIER_INVOICE_SORT_KEYS,
} from './supplierInvoiceService';
import { parseInvoiceDateRange } from '../core/invoiceDateRangeParams';

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
  // Accountant signal filters
  missingDocument?: boolean;
  possibleDuplicate?: boolean;
  dueThisWeek?: boolean;
  payRunReady?: boolean;
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

  // A malformed date is an error, not a dropped filter: silently widening the
  // range hands back invoices the user did not ask for.
  const range = parseInvoiceDateRange(query);
  if (!range.ok) return range;

  const sortOrderRaw = pickStr(query.sort_order);
  const sortOrder = sortOrderRaw === 'asc' || sortOrderRaw === 'desc' ? sortOrderRaw : undefined;

  const limit = parseNumeric(query.limit);
  const offset = parseNumeric(query.offset);

  // Boolean signal filters: accept '1' or 'true' → true; absent / undefined → false.
  // Any other value is rejected so callers get feedback rather than silent false.
  const BOOL_PARAMS = [
    ['missing_document', 'missingDocument'],
    ['possible_duplicate', 'possibleDuplicate'],
    ['due_this_week', 'dueThisWeek'],
    ['pay_run_ready', 'payRunReady'],
  ] as const;

  const boolValues: Record<string, boolean> = {};
  for (const [queryKey, fieldKey] of BOOL_PARAMS) {
    const raw = query[queryKey];
    if (raw === undefined || raw === null || raw === '') {
      boolValues[fieldKey] = false;
    } else if (raw === '1' || raw === 'true') {
      boolValues[fieldKey] = true;
    } else if (raw === '0' || raw === 'false') {
      boolValues[fieldKey] = false;
    } else {
      return { ok: false, error: `Invalid ${queryKey}: expected '1', 'true', '0', or 'false'` };
    }
  }

  return {
    ok: true,
    filters: {
      status: status as SupplierInvoiceStatus | undefined,
      supplierId: supplierIdRaw,
      matchStatus: matchStatus as InvoiceMatchStatus | undefined,
      search: pickStr(query.search),
      fromDate: range.fromDate,
      toDate: range.toDate,
      fromAmount: parseNumeric(query.from_amount),
      toAmount: parseNumeric(query.to_amount),
      fromBalance: parseNumeric(query.from_balance),
      toBalance: parseNumeric(query.to_balance),
      sort: sort as SupplierInvoiceSort | undefined,
      sortOrder,
      limit: typeof limit === 'number' ? Math.min(limit, 200) : undefined,
      offset: typeof offset === 'number' && offset >= 0 ? offset : undefined,
      missingDocument: boolValues.missingDocument,
      possibleDuplicate: boolValues.possibleDuplicate,
      dueThisWeek: boolValues.dueThisWeek,
      payRunReady: boolValues.payRunReady,
    },
  };
}
