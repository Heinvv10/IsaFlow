/**
 * What the shared Re-apply payment terms screen shows, whichever side it is for: the supplier-bill preview
 * (ap/reapplyTerms) and the customer-invoice preview (ar/reapplyTerms) are mapped to this by their pages.
 */
import type { DueDateSource } from '@/modules/accounting/services/shared/dueDateSource';
import type { ReapplyResult } from '@/modules/accounting/services/shared/reapplyTermsShared';

export type { ReapplyResult };

export interface TermsRow {
  id: string;
  invoiceNumber: string;
  partyName: string;
  invoiceDate: string;
  balance: number;
  /** The document's own currency; absent: the company's (rands). */
  currencyCode?: string;
  terms: string;
  currentDueDate: string | null;
  currentSource: DueDateSource;
  newDueDate: string;
  preselected: boolean;
  note: string | null;
}

export interface TermsPreview {
  rows: TermsRow[];
  unchanged: number;
  truncated: boolean;
  /** Contacts with open documents and no terms set: nothing of theirs is re-dated. */
  skipped: { partyId: string; partyName: string; count: number; balance: number }[];
}

/** The side-specific words, routes and picker of one Re-apply page. */
export interface ReapplyTermsConfig {
  /** 'Supplier' | 'Customer' (a column head); `partyLower` is the same in running text. */
  party: 'Supplier' | 'Customer';
  /** 'bill' | 'invoice'. */
  noun: 'bill' | 'invoice';
  apiPath: string;
  /** The query parameter that narrows the preview to one contact. */
  filterParam: 'supplierId' | 'customerId';
  backHref: string;
  backLabel: string;
  documentHref: (id: string) => string;
  /** Maps the route's preview to the screen's. */
  adapt: (data: unknown) => TermsPreview;
}
