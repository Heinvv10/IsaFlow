/**
 * Seeds a Golden Paths slot with the transactions the suite's read-only specs need (x-contrast-sweep, p-type-money,
 * n-a11y-main-screens), THROUGH THE APP: the same routes and services a user's clicks reach, so every gate, trigger,
 * numbering rule and posting path runs and the subledgers and the GL stay in step. Nothing is written to a table
 * directly and no period is touched: dates fall in the last 10 complete months, none before 2026-01 (the slot's
 * earlier periods are closed, as Demo's are).
 *
 * Idempotent per slot: every record carries a GSEED marker (invoice number, journal description, bank description)
 * and a run creates only what its search does not find, so a re-run, or one that crashed half way, tops up and stops.
 *
 *   80 supplier invoices, created and approved (the ap-aging and supplier-invoices pages, and AP/VAT postings)
 *   10 posted journals, one per month (the income statement has revenue as well as the invoices' expenses)
 *   200 bank statement rows, imported as one CSV (the bank-transactions table)
 *   1 migration session (the migration landing page's Sage state)
 */
export interface SeedApi {
  get<T = unknown>(path: string): Promise<T>;
  post<T = unknown>(path: string, body?: unknown): Promise<T>;
}

export const SEED = { suppliers: 8, invoices: 80, journals: 10, bankRows: 200 } as const;
export const MIGRATION_SOURCE = 'sage_cloud';

export interface SeedReport { suppliers: number; invoicesCreated: number; invoicesApproved: number; journalsCreated: number; journalsPosted: number; bankRowsImported: number; migrationSession: 'created' | 'kept' }

const pad = (n: number): string => String(n).padStart(2, '0');
/** The slots' first open period: Demo's periods before 2026 are closed, and a slot never unlocks one. */
const FIRST_OPEN_MONTH = '2026-01';

/**
 * The last 10 complete calendar months before `now` (UTC), none earlier than the first open period, so the seed
 * always lands in the recent past (date-window specs read it) and never in a closed period or the future.
 */
export function seedMonths(now: Date): string[] {
  const here = now.getUTCFullYear() * 12 + now.getUTCMonth();
  const months: string[] = [];
  for (let back = 10; back >= 1; back--) {
    const at = here - back;
    months.push(`${Math.floor(at / 12)}-${pad((at % 12) + 1)}`);
  }
  const open = months.filter((m) => m >= FIRST_OPEN_MONTH);
  if (open.length === 0) throw new Error(`no complete month since the first open period (${FIRST_OPEN_MONTH}) to seed into yet`);
  return open;
}

/** Item i (1-based) on day 3..20 of one of `months`, round robin. */
const seedDate = (months: string[], i: number): string => `${months[(i - 1) % months.length]}-${pad(3 + ((i * 7) % 18))}`;
const addDays = (iso: string, days: number): string => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
/**
 * The rows of a list response: a bare array, or the first of `keys` that holds one. A shape it does not know is an
 * error, not an empty list: read as empty, a list that merely changed shape would make the seeder re-create what exists.
 */
function rowsOf<T>(body: unknown, ...keys: string[]): T[] {
  if (Array.isArray(body)) return body as T[];
  const object = (body ?? {}) as Record<string, unknown>;
  for (const k of keys) {
    const rows = object[k];
    if (Array.isArray(rows)) return rows as T[];
  }
  throw new Error(`unexpected list response (wanted an array${keys.length ? ` or one of ${keys.join(', ')}` : ''}): ${(JSON.stringify(body) ?? 'undefined').slice(0, 200)}`);
}

async function ensureSuppliers(api: SeedApi): Promise<string[]> {
  const found = rowsOf<{ id: string; name: string }>(await api.get('/api/accounting/suppliers-list?q=GSEED%20Supplier'), 'suppliers');
  const ids = new Map(found.filter((s) => /^GSEED Supplier \d+$/.test(s.name)).map((s) => [s.name, s.id]));
  for (let k = 1; k <= SEED.suppliers; k++) {
    const name = `GSEED Supplier ${k}`;
    if (ids.has(name)) continue;
    const created = await api.post<{ id: string }>('/api/accounting/suppliers-list', { name, email: `gseed-supplier-${k}@example.test`, payment_terms: 30 });
    ids.set(name, created.id);
  }
  return [...ids.values()];
}

async function seedInvoices(api: SeedApi, supplierIds: string[], months: string[]): Promise<{ created: number; approved: number }> {
  const existing = rowsOf<{ id: string; invoiceNumber: string; status: string }>(
    await api.get('/api/accounting/supplier-invoices?search=GSEED-AP&limit=500'), 'invoices', 'items', 'data');
  const byNumber = new Map(existing.map((r) => [r.invoiceNumber, r]));
  let created = 0;
  let approved = 0;
  for (let i = 1; i <= SEED.invoices; i++) {
    const invoiceNumber = `GSEED-AP-${i}`;
    let row = byNumber.get(invoiceNumber);
    if (!row) {
      const date = seedDate(months, i);
      const made = await api.post<{ id: string; status: string }>('/api/accounting/supplier-invoices', {
        invoiceNumber,
        supplierId: supplierIds[i % supplierIds.length],
        invoiceDate: date,
        dueDate: addDays(date, [14, 30, 45][i % 3]!),
        taxRate: 15,
        items: [
          { description: `GSEED AP line ${i}a`, quantity: 1 + (i % 3), unitPrice: 100 + ((i * 37) % 900) },
          ...(i % 2 === 0 ? [{ description: `GSEED AP line ${i}b`, quantity: 1, unitPrice: 50 + ((i * 11) % 200) }] : []),
        ],
      });
      row = { id: made.id, invoiceNumber, status: made.status };
      created++;
    }
    if (row.status === 'draft' || row.status === 'pending_approval') {
      await api.post('/api/accounting/supplier-invoices-action', { action: 'approve', invoiceId: row.id });
      approved++;
    }
  }
  return { created, approved };
}

/** The journals route caps `limit` at 200 (pages/api/accounting/journal-entries.ts). */
const JOURNAL_PAGE = 200;

/**
 * The slot's GSEED journals by description, posted ones winning over a draft of the same description. The list has no
 * description search and sorts newest first, so the seed journals (dated months back) sit behind every journal later
 * golden runs add: the lists are paged until exhausted, drafts included (a post that failed leaves a draft behind).
 */
async function findSeedJournals(api: SeedApi): Promise<Map<string, { id: string; status: 'posted' | 'draft' }>> {
  const found = new Map<string, { id: string; status: 'posted' | 'draft' }>();
  for (const status of ['posted', 'draft'] as const) {
    for (let offset = 0; ; offset += JOURNAL_PAGE) {
      const page = await api.get<{ entries?: unknown[]; total?: number }>(`/api/accounting/journal-entries?status=${status}&limit=${JOURNAL_PAGE}&offset=${offset}`);
      const entries = rowsOf<{ id: string; description?: string }>(page, 'entries');
      for (const e of entries) {
        if (e.description && /^GSEED-JNL-\d+$/.test(e.description) && !found.has(e.description)) found.set(e.description, { id: e.id, status });
      }
      if (entries.length === 0 || (page.total !== undefined && offset + entries.length >= Number(page.total))) break;
    }
  }
  return found;
}

async function seedJournals(api: SeedApi, months: string[]): Promise<{ created: number; posted: number }> {
  const have = await findSeedJournals(api);
  const revenue = rowsOf<{ id: string; isSystemAccount?: boolean }>(await api.get('/api/accounting/chart-of-accounts?subtype=default_revenue')).find((a) => a.isSystemAccount === true);
  const bank = rowsOf<{ id: string }>(await api.get('/api/accounting/bank-accounts'))[0];
  if (!revenue || !bank) throw new Error('the slot needs a default revenue account and a bank account to seed journals');
  let created = 0;
  let posted = 0;
  for (let m = 1; m <= SEED.journals; m++) {
    const description = `GSEED-JNL-${m}`;
    const existing = have.get(description);
    if (existing?.status === 'posted') continue;
    let id = existing?.id;
    if (!id) {
      const amount = 1000 + m * 250;
      id = (await api.post<{ id: string }>('/api/accounting/journal-entries', {
        entryDate: `${months[(m - 1) % months.length]}-15`,
        description,
        lines: [
          { glAccountId: bank.id, debit: amount, credit: 0, description: `${description} dr` },
          { glAccountId: revenue.id, debit: 0, credit: amount, description: `${description} cr` },
        ],
      })).id;
      created++;
    }
    await api.post('/api/accounting/journal-entries-action', { id, action: 'post' });
    posted++;
  }
  return { created, posted };
}

async function seedBankRows(api: SeedApi, makeId: () => string, months: string[], statementDate: string): Promise<number> {
  const bank = rowsOf<{ id: string }>(await api.get('/api/accounting/bank-accounts'))[0];
  if (!bank) throw new Error('the slot needs a bank account to import a statement into');
  const found = await api.get<{ total?: number }>(`/api/accounting/bank-transactions?bank_account_id=${bank.id}&search=GSEED-BNK&limit=1`);
  if (Number(found.total ?? 0) > 0) return 0;
  let balance = 10000;
  const lines = ['Date,Description,Amount,Balance,Reference'];
  for (let i = 1; i <= SEED.bankRows; i++) {
    const amount = i % 3 === 0 ? 400 + i : -(25 + ((i * 13) % 300));
    balance += amount;
    const date = seedDate(months, i).replace(/-/g, '/');
    lines.push(`${date},GSEED-BNK ${i} ${amount > 0 ? 'customer deposit' : 'supplies'},${amount.toFixed(2)},${balance.toFixed(2)},GSEED-BNK-${i}`);
  }
  await api.post('/api/accounting/bank-transactions-bulk-commit', {
    bankAccountId: bank.id, bulkImportId: makeId(), bulkSequence: 1, filename: 'gseed-statement.csv', fileType: 'csv',
    statementDate, csvContent: lines.join('\n'), bankFormat: 'fnb', applyBankRules: false,
  });
  return SEED.bankRows;
}

async function ensureMigrationSession(api: SeedApi): Promise<'created' | 'kept'> {
  const current = await api.get<{ session: unknown }>('/api/accounting/migration/session');
  if (current.session) return 'kept';
  await api.post('/api/accounting/migration/session', { sourceSystem: MIGRATION_SOURCE });
  return 'created';
}

/**
 * @param makeId a uuid source for the statement's import id (injected so a test can pin it)
 * @param now the run's date, from which the seed's months are taken (injected so a test can pin it)
 */
export async function seedSlot(api: SeedApi, makeId: () => string, now: Date = new Date()): Promise<SeedReport> {
  const months = seedMonths(now);
  const suppliers = await ensureSuppliers(api);
  const invoices = await seedInvoices(api, suppliers, months);
  const journals = await seedJournals(api, months);
  return {
    suppliers: suppliers.length,
    invoicesCreated: invoices.created,
    invoicesApproved: invoices.approved,
    journalsCreated: journals.created,
    journalsPosted: journals.posted,
    bankRowsImported: await seedBankRows(api, makeId, months, now.toISOString().slice(0, 10)),
    migrationSession: await ensureMigrationSession(api),
  };
}
