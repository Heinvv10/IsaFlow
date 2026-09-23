/**
 * Return context for invoice drill-downs.
 *
 * A source view links to an invoice with `?from=<source>` plus whatever it
 * needs to restore itself (the expanded customer/supplier row, the as-at
 * date). The detail page turns that back into a breadcrumb trail and its Back
 * link. Every href is built from the constant paths below and URLSearchParams,
 * never from a query value, so a hostile `from` cannot produce an off-site
 * link — an unknown one simply falls back to the invoice list.
 */

import type { BreadcrumbItem } from '@/components/ui/Breadcrumb';

export type InvoiceSource =
  | 'debtors'
  | 'ap-aging'
  | 'ar-aging'
  | 'customer-invoices'
  | 'supplier-invoices';

export type InvoiceKind = 'customer' | 'supplier';

export interface InvoiceLinkContext {
  from: InvoiceSource;
  /** Customer or supplier whose row the source view should re-expand. */
  entityId?: string;
  /** As-at date (YYYY-MM-DD) the source view should restore. */
  asAtDate?: string;
}

export interface ReturnContext {
  label: string;
  href: string;
}

export interface InvoiceTrail {
  items: BreadcrumbItem[];
  /** Always equal to the href of the crumb before the invoice number. */
  back: ReturnContext;
}

type QueryValue = string | string[] | undefined;

interface SourceDef {
  kind: InvoiceKind;
  label: string;
  path: string;
  entityParam?: 'customer' | 'supplier';
  keepsAsAt: boolean;
}

const SOURCES: Record<InvoiceSource, SourceDef> = {
  debtors: { kind: 'customer', label: 'Debtors Manager', path: '/accounting/debtors-manager', entityParam: 'customer', keepsAsAt: false },
  'ar-aging': { kind: 'customer', label: 'AR Aging', path: '/accounting/ar-aging', entityParam: 'customer', keepsAsAt: true },
  'ap-aging': { kind: 'supplier', label: 'AP Aging', path: '/accounting/ap-aging', entityParam: 'supplier', keepsAsAt: true },
  'customer-invoices': { kind: 'customer', label: 'Invoices', path: '/accounting/customer-invoices', keepsAsAt: false },
  'supplier-invoices': { kind: 'supplier', label: 'Supplier Invoices', path: '/accounting/supplier-invoices', keepsAsAt: false },
};

const LIST_SOURCE: Record<InvoiceKind, InvoiceSource> = {
  customer: 'customer-invoices',
  supplier: 'supplier-invoices',
};

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isSource(value: QueryValue): value is InvoiceSource {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(SOURCES, value);
}

function single(value: QueryValue): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** The params that put the source view back where it was; invalid values are dropped. */
function restoreParams(src: SourceDef, entityId: string | undefined, asAtDate: string | undefined): URLSearchParams {
  const params = new URLSearchParams();
  if (src.entityParam && entityId && UUID.test(entityId)) params.set(src.entityParam, entityId);
  if (src.keepsAsAt && asAtDate && ISO_DATE.test(asAtDate)) params.set('as_at_date', asAtDate);
  return params;
}

function withQuery(path: string, params: URLSearchParams): string {
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

export function buildInvoiceHref(invoiceId: string, ctx: InvoiceLinkContext): string {
  const src = SOURCES[ctx.from];
  const params = new URLSearchParams({ from: ctx.from });
  restoreParams(src, ctx.entityId, ctx.asAtDate).forEach((v, k) => params.set(k, v));
  return withQuery(`${SOURCES[LIST_SOURCE[src.kind]].path}/${encodeURIComponent(invoiceId)}`, params);
}

function resolveSource(query: Record<string, QueryValue>, kind: InvoiceKind): InvoiceSource | null {
  const from = query.from;
  return isSource(from) && SOURCES[from].kind === kind ? from : null;
}

function returnFor(source: InvoiceSource, query: Record<string, QueryValue>): ReturnContext {
  const src = SOURCES[source];
  const entityId = src.entityParam ? single(query[src.entityParam]) : undefined;
  return { label: src.label, href: withQuery(src.path, restoreParams(src, entityId, single(query.as_at_date))) };
}

/**
 * Where the detail page should send the user back to, or null when `from` is
 * absent, unknown, or belongs to the other ledger (a supplier source on a
 * customer invoice).
 */
export function parseReturnContext(query: Record<string, QueryValue>, kind: InvoiceKind): ReturnContext | null {
  const source = resolveSource(query, kind);
  return source ? returnFor(source, query) : null;
}

/**
 * Breadcrumb trail and Back link for an invoice detail page. Both come from one
 * ReturnContext, so the Back link and the crumb before the invoice number can
 * never disagree.
 */
export function buildInvoiceTrail(
  kind: InvoiceKind,
  query: Record<string, QueryValue>,
  entityName: string | undefined,
  invoiceNumber: string,
): InvoiceTrail {
  const source = resolveSource(query, kind) ?? LIST_SOURCE[kind];
  const back = returnFor(source, query);
  const items: BreadcrumbItem[] = [
    { label: 'Accounting', href: '/accounting' },
    { label: back.label, href: back.href },
  ];
  if (SOURCES[source].entityParam && entityName) items.push({ label: entityName, href: back.href });
  items.push({ label: invoiceNumber });
  return { items, back };
}
