/**
 * Reads everything a take-on needs from one Sage company, read-only:
 * company, current financial year, accounts (+ Sage's system accounts and
 * banks), the trial balance as at the cut-over date, customers, suppliers,
 * and the outstanding documents of every contact that carries a balance.
 *
 * Call budget: about 8 calls plus one per contact owing / owed money; at the
 * client's 700 ms spacing a company with 300 open balances takes ~4 minutes.
 * Above MAX_CONTACTS_WITH_BALANCES the pull refuses up front rather than run
 * into Sage's daily limit half-way. A contact on the wrong side (customer in
 * credit, supplier overpaid) needs no documents: the builder reports it.
 *
 * Which outstanding documents are INVOICES is read from Sage's own invoice
 * lists (TaxInvoice/Get, SupplierInvoice/Get, filtered to AmountDue > 0, a few
 * paged calls): the outstanding lists carry a DocumentTypeId whose values Sage
 * does not document, and a credit note taken on as an invoice would be wrong.
 */
import { SageApiError, type SageApiClient, type SageCallGuard } from './sageApiClient';
import type {
  SageAccount, SageBankAccount, SageCompanySummary, SageCurrency, SageCustomer, SageFinancialYear, SageInvoiceRef,
  SageOutstandingDocument, SagePaged, SagePull, SageSupplier, SageTrialBalanceLine,
} from './sageApiTypes';

/**
 * What one import can take on inside one request (Cloudflare cuts it at 100 s):
 * the take-on posts one wizard document + journal per unpaid invoice and one
 * balance-brought-forward per contact short of documents, so the worst case is
 * MAX_OUTSTANDING_INVOICES + MAX_CONTACTS_WITH_BALANCES = 600 documents. Measured
 * on the one-cluster integration harness, 2026-10-21, box load 15-25 (uptime):
 * 600 documents / 300 contacts ~10 s, 900 ~25 s, 1 200 ~58 s, 2 400 ~73 s,
 * 5 000 did not finish in 900 s. The growth is faster than linear, so the caps
 * sit where the worst case has ~7x headroom. A bigger company uses the file
 * upload (Migration Wizard), which takes documents in batches.
 */
export const MAX_CONTACTS_WITH_BALANCES = 300;
/** Unpaid customer invoices and supplier bills together. */
export const MAX_OUTSTANDING_INVOICES = 300;

export type PullStep = 'company' | 'accounts' | 'trial_balance' | 'customers' | 'suppliers' | 'documents';

const rows = <T>(answer: SagePaged<T> | T[] | null | undefined): T[] =>
  Array.isArray(answer) ? answer : answer?.Results ?? [];

const day = (iso: string): string => iso.slice(0, 10);

async function accountsOf(client: ReturnType<SageApiClient['forCompany']>): Promise<SageAccount[]> {
  const plain = await client.getAll<SageAccount>('Account/Get');
  let withSystem: SageAccount[] = [];
  try {
    withSystem = await client.getAll<SageAccount>('Account/GetWithSystemAccounts');
  } catch (err) {
    // Older API builds lack the system-account list; the trial balance still
    // names those accounts and the builder reports any it cannot place.
    if (!(err instanceof SageApiError) || err.kind !== 'bad_response') throw err;
  }
  const byId = new Map<number, SageAccount>();
  for (const a of [...withSystem, ...plain]) if (!byId.has(a.ID)) byId.set(a.ID, a);
  return [...byId.values()];
}

/** The company is too big for one connection; the message is for the client. */
export class SagePullTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SagePullTooLargeError';
  }
}

const TOO_BIG = (what: string, n: number) => new SagePullTooLargeError(`This Sage company has more than ${n} ${what} — more than Import from Sage takes on in one go. Use the Migration Wizard's file upload (Accounting → Migration) for this company: it takes Sage's reports in batches.`);

/** Currency/Get, or null on an API build that does not answer it (any CurrencyId then blocks: sageCurrency). */
async function currenciesOf(client: ReturnType<SageApiClient['forCompany']>): Promise<SageCurrency[] | null> {
  try {
    return (await client.getAll<SageCurrency>('Currency/Get')).map((c) => ({ ID: c.ID, Code: c.Code, Symbol: c.Symbol }));
  } catch (err) {
    if (err instanceof SageApiError && err.kind === 'bad_response') return null;
    throw err;
  }
}

/** The still-owed rows of an invoice list, as references. */
async function outstandingInvoices(client: ReturnType<SageApiClient['forCompany']>, path: string): Promise<SageInvoiceRef[]> {
  const rows = await client.getAll<SageInvoiceRef>(path, { $filter: 'AmountDue gt 0' }, MAX_OUTSTANDING_INVOICES);
  if (rows.length > MAX_OUTSTANDING_INVOICES) throw TOO_BIG('unpaid invoices and bills', MAX_OUTSTANDING_INVOICES);
  return rows.map((r) => ({ ID: r.ID, DocumentNumber: r.DocumentNumber }));
}

export async function pullSageCompany(
  api: SageApiClient,
  sageCompanyId: number,
  asAtDate: string,
  onProgress: (step: PullStep) => void = () => {},
  /** Asked before every Sage call (page, retry): the job stops a read whose row was discarded. */
  guard?: SageCallGuard,
): Promise<SagePull> {
  const client = api.forCompany(sageCompanyId, guard);

  onProgress('company');
  const company = await client.get<SageCompanySummary>(`Company/Get/${sageCompanyId}`);
  const year = await client.get<SageFinancialYear>('FinancialYear/GetCurrent');
  const financialYearStart = day(year.YearStart);

  onProgress('accounts');
  const accounts = await accountsOf(client);
  const bankAccounts = await client.getAll<SageBankAccount>('BankAccount/Get');
  const currencies = await currenciesOf(client);

  onProgress('trial_balance');
  const trialBalance = rows(await client.post<SagePaged<SageTrialBalanceLine> | SageTrialBalanceLine[]>('TrialBalance/Export', {
    FromDate: financialYearStart, ToDate: asAtDate,
    ShowMovement: false, DisplayReportingGroupDetail: false, Comparative: false,
  }));

  onProgress('customers');
  const customers = await client.getAll<SageCustomer>('Customer/Get');
  onProgress('suppliers');
  const suppliers = await client.getAll<SageSupplier>('Supplier/Get');

  const owing = [...customers, ...suppliers].filter((c) => c.Balance > 0.005);
  if (owing.length > MAX_CONTACTS_WITH_BALANCES) {
    throw new SagePullTooLargeError(`This Sage company has ${owing.length} customers and suppliers with open balances, more than the ${MAX_CONTACTS_WITH_BALANCES} Import from Sage takes on in one go. Use the Migration Wizard's file upload (Accounting → Migration) for this company: it takes Sage's reports in batches.`);
  }

  onProgress('documents');
  const customersOwing = customers.filter((x) => x.Balance > 0.005);
  const suppliersOwed = suppliers.filter((x) => x.Balance > 0.005);
  const customerInvoices = customersOwing.length > 0 ? await outstandingInvoices(client, 'TaxInvoice/Get') : [];
  const supplierInvoices = suppliersOwed.length > 0 ? await outstandingInvoices(client, 'SupplierInvoice/Get') : [];
  if (customerInvoices.length + supplierInvoices.length > MAX_OUTSTANDING_INVOICES) {
    throw TOO_BIG('unpaid invoices and bills', MAX_OUTSTANDING_INVOICES);
  }
  const customerDocuments: Record<number, SageOutstandingDocument[]> = {};
  for (const c of customersOwing) {
    customerDocuments[c.ID] = rows(await client.post<SagePaged<SageOutstandingDocument> | SageOutstandingDocument[]>(
      'OutstandingCustomerDocument/Get', { CustomerId: c.ID, IncludePaidInvoices: false }));
  }
  const supplierDocuments: Record<number, SageOutstandingDocument[]> = {};
  for (const s of suppliersOwed) {
    supplierDocuments[s.ID] = rows(await client.post<SagePaged<SageOutstandingDocument> | SageOutstandingDocument[]>(
      'OutstandingSupplierDocument/Get', { SupplierId: s.ID, IncludePaidInvoices: false }));
  }

  return {
    company: {
      id: company?.ID ?? sageCompanyId,
      name: company?.Name ?? `Sage company ${sageCompanyId}`,
      ...(company?.CurrencySymbol ? { currencySymbol: company.CurrencySymbol } : {}),
    },
    asAtDate,
    financialYearStart,
    accounts,
    bankAccounts,
    trialBalance,
    customers,
    suppliers,
    customerDocuments,
    supplierDocuments,
    customerInvoices,
    supplierInvoices,
    currencies,
  };
}
