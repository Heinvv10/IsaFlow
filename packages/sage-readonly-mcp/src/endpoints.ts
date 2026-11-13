/**
 * The ONLY Sage resources this server may read, and nothing else.
 *
 * Sage Business Cloud Accounting (ZA) API v2.0.0: `{Resource}/Get` lists (OData $filter/$top/$skip,
 * at most 100 per page, reply `{ TotalResults, ReturnedResults, Results }`) and `{Resource}/Get/{id}`
 * reads one. Every request this server sends is a GET built from this table; there is no code path
 * that can name Save, Delete, Email, Allocate or any other action.
 *
 * `verified` marks the resources seen in Sage's own API help catalogue (21 Oct 2026). The others
 * follow the same documented pattern but have not been called against a live company yet; if Sage
 * answers 404 for one, correct its path here.
 */

export interface SageResource {
  /** Path segment under the API base, e.g. "SupplierInvoice". */
  path: string;
  /** Extra query parameters on list and single reads (e.g. includeDetail). */
  detailQuery: Record<string, string>;
  /** Field used by sage_pull_since. */
  modifiedField: string;
  /** Field holding the document date, for sage_party_balance as_at. */
  dateField?: string;
  verified: boolean;
}

export const RESOURCES = {
  BankTransaction: { path: 'BankTransaction', detailQuery: {}, modifiedField: 'Modified', dateField: 'Date', verified: false },
  SupplierInvoice: {
    path: 'SupplierInvoice', detailQuery: { includeDetail: 'true', includeSupplierDetails: 'false' },
    modifiedField: 'Modified', dateField: 'Date', verified: true,
  },
  TaxInvoice: {
    path: 'TaxInvoice', detailQuery: { includeDetail: 'true', includeCustomerDetails: 'false' },
    modifiedField: 'Modified', dateField: 'Date', verified: true,
  },
  SupplierReturn: { path: 'SupplierReturn', detailQuery: { includeDetail: 'true' }, modifiedField: 'Modified', dateField: 'Date', verified: true },
  CustomerReturn: {
    path: 'CustomerReturn', detailQuery: { includeDetail: 'true', includeCustomerDetails: 'false' },
    modifiedField: 'Modified', dateField: 'Date', verified: true,
  },
  SupplierPayment: { path: 'SupplierPayment', detailQuery: {}, modifiedField: 'Modified', dateField: 'Date', verified: false },
  CustomerReceipt: { path: 'CustomerReceipt', detailQuery: {}, modifiedField: 'Modified', dateField: 'Date', verified: false },
  SupplierAdjustment: { path: 'SupplierAdjustment', detailQuery: {}, modifiedField: 'Modified', dateField: 'Date', verified: false },
  CustomerAdjustment: { path: 'CustomerAdjustment', detailQuery: {}, modifiedField: 'Modified', dateField: 'Date', verified: false },
  Supplier: { path: 'Supplier', detailQuery: {}, modifiedField: 'Modified', verified: false },
  Customer: { path: 'Customer', detailQuery: {}, modifiedField: 'Modified', verified: false },
  Account: { path: 'Account', detailQuery: {}, modifiedField: 'Modified', verified: false },
  BankAccount: { path: 'BankAccount', detailQuery: {}, modifiedField: 'Modified', verified: false },
  Attachment: { path: 'Attachment', detailQuery: {}, modifiedField: 'Modified', verified: false },
} as const satisfies Record<string, SageResource>;

export type SageResourceName = keyof typeof RESOURCES;
export const RESOURCE_NAMES = Object.keys(RESOURCES) as SageResourceName[];

/** The short kinds the sync uses (brief: bank, siv, ti, ret, cret). */
export const PULL_KINDS = {
  bank: 'BankTransaction',
  siv: 'SupplierInvoice',
  ti: 'TaxInvoice',
  ret: 'SupplierReturn',
  cret: 'CustomerReturn',
} as const satisfies Record<string, SageResourceName>;
export type PullKind = keyof typeof PULL_KINDS;

/** Document types sage_get_document accepts: the short kinds plus every resource name. */
export function resolveResource(type: string): SageResourceName | null {
  // Own keys only: `in` would also accept inherited names such as "constructor".
  if (Object.prototype.hasOwnProperty.call(PULL_KINDS, type)) return PULL_KINDS[type as PullKind];
  return (RESOURCE_NAMES as string[]).includes(type) ? (type as SageResourceName) : null;
}

/** Where an attachment's bytes come from (unverified, see header). */
export const ATTACHMENT_DOWNLOAD_PATH = 'Attachment/Download';
