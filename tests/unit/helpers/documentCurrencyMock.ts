/**
 * FX PR0: `shared/documentCurrency` reads the company row and splices SQL
 * fragments, which a test that scripts `sql` call by call does not expect.
 * Unit tests of OTHER behaviour mock it with this: every company is ZAR with
 * foreign documents off, and every document passes. The currency rule itself
 * is tested in tests/unit/accounting/documentCurrency.test.ts and the
 * fx-pr0-* integration suites.
 */
type DocumentCurrencyModule = typeof import('@/modules/accounting/services/shared/documentCurrency');

export function documentCurrencyMock(original: DocumentCurrencyModule): DocumentCurrencyModule {
  return {
    ...original,
    loadCompanyCurrency: async () => ({ functionalCurrency: 'ZAR', fxDocumentsEnabled: false }),
    assertDocumentPostable: async () => undefined,
    assertStoredDocumentPostable: async () => undefined,
    invoiceForeignCurrencySql: (() => 'false') as unknown as DocumentCurrencyModule['invoiceForeignCurrencySql'],
    billForeignCurrencySql: (() => 'false') as unknown as DocumentCurrencyModule['billForeignCurrencySql'],
  };
}
