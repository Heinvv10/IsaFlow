/** What `editDraftCustomerInvoice` answers: the route turns each refusal into its own status (customer-invoices-detail). */
export type CustomerInvoiceDraftEditResult =
  | { kind: 'ok' } | { kind: 'not_found' } | { kind: 'not_draft' } | { kind: 'bad_client' } | { kind: 'rate_required' }
  | { kind: 'bad_line'; message: string } | { kind: 'wip_link_refused'; message: string; code: string } | { kind: 'stale_view' }
  | { kind: 'bad_amount'; message: string }
  | { kind: 'currency_refused'; message: string }
  | { kind: 'bad_dimensions'; message: string };
