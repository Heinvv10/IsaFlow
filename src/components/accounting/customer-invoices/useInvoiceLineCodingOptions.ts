/**
 * What an invoice line may be coded to (migration 870): the company's ACTIVE,
 * LEAF revenue accounts, its projects that are not cancelled, and its active
 * cost centres — the same population ar/invoiceLineCodingGuard accepts, so a
 * picker never offers a choice the save would refuse.
 *
 * `known` labels every id the document already names, including a project
 * past the 200-row list or one since cancelled (fetched by id), so an existing
 * line shows what it is coded to instead of reading "unavailable". `status`
 * tells a picker whether an id it cannot label is still loading, failed to
 * load, or really is not available any more.
 */
import { useEffect, useState } from 'react';
import { apiErrorMessage, apiJson } from '@/lib/apiFetch';

export interface CodingOption { id: string; label: string }

export interface InvoiceLineCodingOptions {
  accounts: CodingOption[];
  projects: CodingOption[];
  centres: CodingOption[];
  known: Readonly<Record<string, string>>;
  status: 'loading' | 'ready' | 'failed';
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

const projectLabel = (p: Rec) => `${str(p.project_number)} ${str(p.name)}${p.status === 'cancelled' ? ' (cancelled)' : ''}`;

export function projectOptions(projects: unknown): CodingOption[] {
  return records(projects)
    .filter((p) => p.status !== 'cancelled')
    .map((p) => ({ id: str(p.id), label: projectLabel(p) }));
}

export function centreOptions(body: unknown): CodingOption[] {
  const items = typeof body === 'object' && body !== null ? (body as Rec).items : undefined;
  return records(items).map((c) => ({ id: str(c.id), label: `${str(c.code)} ${str(c.name)}` }));
}

const EMPTY: InvoiceLineCodingOptions = { accounts: [], projects: [], centres: [], known: {}, status: 'loading', error: '' };

/** @param referencedProjectIds projects the document already names — labelled even when not offered. */
export function useInvoiceLineCodingOptions(referencedProjectIds: readonly string[] = []): InvoiceLineCodingOptions {
  const [options, setOptions] = useState<InvoiceLineCodingOptions>(EMPTY);
  useEffect(() => {
    let live = true;
    Promise.all([
      apiJson('/api/accounting/chart-of-accounts', undefined, 'Could not load the revenue accounts - try again'),
      apiJson('/api/accounting/projects', undefined, 'Could not load the projects - try again'),
      apiJson('/api/accounting/cost-centres?active=true', undefined, 'Could not load the cost centres - try again'),
    ]).then(([accounts, projects, centres]) => {
      if (!live) return;
      const all = [...revenueAccountOptions(accounts), ...records(projects).map((p) => ({ id: str(p.id), label: projectLabel(p) })),
        ...centreOptions(centres)];
      setOptions({
        accounts: revenueAccountOptions(accounts), projects: projectOptions(projects), centres: centreOptions(centres),
        known: Object.fromEntries(all.map((o) => [o.id, o.label])), status: 'ready', error: '',
      });
    }).catch((err: unknown) => {
      if (live) setOptions({ ...EMPTY, status: 'failed', error: apiErrorMessage(err, 'Could not load the line account options - try again') });
    });
    return () => { live = false; };
  }, []);

  const missing = options.status === 'ready'
    ? [...new Set(referencedProjectIds.filter((id) => id !== '' && !(id in options.known)))].sort().join(',')
    : '';
  useEffect(() => {
    if (missing === '') return undefined;
    let live = true;
    apiJson(`/api/accounting/projects?ids=${missing}`, undefined, 'Could not load the invoice\'s projects - try again')
      .then((rows) => {
        if (live) setOptions((o) => ({ ...o, known: { ...o.known, ...Object.fromEntries(records(rows).map((p) => [str(p.id), projectLabel(p)])) } }));
      })
      .catch((err: unknown) => {
        if (live) setOptions((o) => ({ ...o, error: apiErrorMessage(err, 'Could not load the invoice\'s projects - try again') }));
      });
    return () => { live = false; };
  }, [missing]);

  return options;
}
