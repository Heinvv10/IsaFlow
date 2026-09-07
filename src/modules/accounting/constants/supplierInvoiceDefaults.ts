/**
 * Defaults a supplier invoice takes when the caller names none.
 *
 * ── WHY THIS IS NOT INSIDE supplierInvoiceService ───────────────────────────
 *
 * Two readers need it and only one of them writes. `createSupplierInvoice`
 * applies it; `bulkInvoiceDuplicateSkip` needs it to decide whether two batch
 * elements are the SAME bill, because an omitted `tax_rate` and an explicit 15
 * produce identical invoices — comparing the raw parsed elements refused a pair
 * that really was a duplicate.
 *
 * Putting it in the service would make a pure, parse-time helper import a
 * module that opens database connections, which every test of that helper then
 * has to mock. Restating the number in the helper instead is the drift this
 * codebase keeps paying for. So it lives here, where both can import it and
 * neither owns it.
 */

/**
 * Standard SA VAT rate, as a percentage.
 *
 * Update alongside a statutory change — and note the other copies of 15 in this
 * module (`bankAllocationService`, `bankRuleAutoPostLine`,
 * `provisionalPostingService`) are NOT yet reading from here. Folding them in
 * is a separate change; this file is the place for it when someone does.
 */
export const DEFAULT_SUPPLIER_TAX_RATE = 15;
