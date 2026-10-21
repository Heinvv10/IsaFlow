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
 */
import { SageApiError, type SageApiClient } from './sageApiClient';
import type {
  SageAccount, SageBankAccount, SageCompanySummary, SageCustomer, SageFinancialYear,
  SageOutstandingDocument, SagePaged, SagePull, SageSupplier, SageTrialBalanceLine,
} from './sageApiTypes';

export const MAX_CONTACTS_WITH_BALANCES = 600;

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

export async function pullSageCompany(
  api: SageApiClient,
  sageCompanyId: number,
  asAtDate: string,
  onProgress: (step: PullStep) => void = () => {},
): Promise<SagePull> {
  const client = api.forCompany(sageCompanyId);

  onProgress('company');
  const company = await client.get<SageCompanySummary>(`Company/Get/${sageCompanyId}`);
  const year = await client.get<SageFinancialYear>('FinancialYear/GetCurrent');
  const financialYearStart = day(year.YearStart);

  onProgress('accounts');
  const accounts = await accountsOf(client);
  const bankAccounts = await client.getAll<SageBankAccount>('BankAccount/Get');

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
    throw new Error(`This Sage company has ${owing.length} customers and suppliers with open balances — more than one connection can read within Sage's limits. Use the file upload for this company, or ask IsaFlow support to run it for you.`);
  }

  onProgress('documents');
  const customerDocuments: Record<number, SageOutstandingDocument[]> = {};
  for (const c of customers.filter((x) => x.Balance > 0.005)) {
    customerDocuments[c.ID] = rows(await client.post<SagePaged<SageOutstandingDocument> | SageOutstandingDocument[]>(
      'OutstandingCustomerDocument/Get', { CustomerId: c.ID, IncludePaidInvoices: false }));
  }
  const supplierDocuments: Record<number, SageOutstandingDocument[]> = {};
  for (const s of suppliers.filter((x) => x.Balance > 0.005)) {
    supplierDocuments[s.ID] = rows(await client.post<SagePaged<SageOutstandingDocument> | SageOutstandingDocument[]>(
      'OutstandingSupplierDocument/Get', { SupplierId: s.ID, IncludePaidInvoices: false }));
  }

  return {
    company: { id: company?.ID ?? sageCompanyId, name: company?.Name ?? `Sage company ${sageCompanyId}` },
    asAtDate,
    financialYearStart,
    accounts,
    bankAccounts,
    trialBalance,
    customers,
    suppliers,
    customerDocuments,
    supplierDocuments,
  };
}
