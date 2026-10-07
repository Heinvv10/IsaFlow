/**
 * What an invoice line may be coded to (migration 870): the company's ACTIVE,
 * LEAF revenue accounts, its projects that are not cancelled, and its active
 * cost centres — the same population ar/invoiceLineCodingGuard accepts, so a
 * picker never offers a choice the save would refuse.
 */
import { useEffect, useState } from 'react';
import { apiErrorMessage, apiJson } from '@/lib/apiFetch';

export interface CodingOption { id: string; label: string }

export interface InvoiceLineCodingOptions {
  accounts: CodingOption[];
  projects: CodingOption[];
  centres: CodingOption[];
  error: string;
}

type Rec = Record<string, unknown>;
const records = (v: unknown): Rec[] => (Array.isArray(v) ? v.filter((r): r is Rec => typeof r === 'object' && r !== null) : []);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Revenue accounts a line may credit: active, and no other account names it as parent. */
export function revenueAccountOptions(accounts: unknown): CodingOption[] {
  const rows = records(accounts);
  const parents = new Set(rows.map((a) => str(a.parentAccountId)).filter(Boolean));
  return rows
    .filter((a) => a.accountType === 'revenue' && a.isActive === true && !parents.has(str(a.id)))
    .map((a) => ({ id: str(a.id), label: `${str(a.accountCode)} ${str(a.accountName)}` }))
    .sort((x, y) => x.label.localeCompare(y.label));
}

export function projectOptions(projects: unknown): CodingOption[] {
  return records(projects)
    .filter((p) => p.status !== 'cancelled')
    .map((p) => ({ id: str(p.id), label: `${str(p.project_number)} ${str(p.name)}` }));
}

export function centreOptions(body: unknown): CodingOption[] {
  const items = typeof body === 'object' && body !== null ? (body as Rec).items : undefined;
  return records(items).map((c) => ({ id: str(c.id), label: `${str(c.code)} ${str(c.name)}` }));
}

export function useInvoiceLineCodingOptions(): InvoiceLineCodingOptions {
  const [options, setOptions] = useState<InvoiceLineCodingOptions>({ accounts: [], projects: [], centres: [], error: '' });
  useEffect(() => {
    let live = true;
    Promise.all([
      apiJson('/api/accounting/chart-of-accounts', undefined, 'Could not load the revenue accounts - try again'),
      apiJson('/api/accounting/projects', undefined, 'Could not load the projects - try again'),
      apiJson('/api/accounting/cost-centres?active=true', undefined, 'Could not load the cost centres - try again'),
    ]).then(([accounts, projects, centres]) => {
      if (live) {
        setOptions({
          accounts: revenueAccountOptions(accounts), projects: projectOptions(projects),
          centres: centreOptions(centres), error: '',
        });
      }
    }).catch((err: unknown) => {
      if (live) {
        setOptions({ accounts: [], projects: [], centres: [], error: apiErrorMessage(err, 'Could not load the line account options - try again') });
      }
    });
    return () => { live = false; };
  }, []);
  return options;
}
