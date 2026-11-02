/**
 * What an Approve sends about the invoice on screen (PR S): its total, currency and exchange rate. The server refuses
 * the approval (409 STALE_VIEW) when anything stored differs (customerInvoiceStaleView.ts). Pure.
 */
export interface ShownForApproval { total: number; currencyCode: string; exchangeRate: number }

export const approvalShown = ({ total, currencyCode, exchangeRate }: ShownForApproval) => ({
  expectedTotal: total,
  expectedCurrency: currencyCode || 'ZAR',
  expectedExchangeRate: Number(exchangeRate) > 0 ? Number(exchangeRate) : 1,
});
