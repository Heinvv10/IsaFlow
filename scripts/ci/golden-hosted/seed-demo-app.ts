/**
 * seed-demo-app — fills the hosted Golden Paths Demo company with the master
 * data and transactions the suite's read-only specs expect, THROUGH THE APP:
 * the routes a user's clicks reach, so every gate, trigger, numbering rule and
 * posting path runs and the subledgers and the GL stay in step. Nothing is
 * written to a table directly. up.sh + seed-demo.sql made the company; this
 * runs against the booted dev server, logged in as the run's E2E admin.
 *
 *   BASE_URL=http://localhost:<port> E2E_ADMIN_EMAIL=.. E2E_ADMIN_PASSWORD=.. \
 *     bun scripts/ci/golden-hosted/seed-demo-app.ts
 *
 * Why this much: velo's Demo holds years of data and several specs measure
 * volume (x-contrast-sweep floors: 500 texts on ap-aging, 150 on
 * supplier-invoices; p-type-money's income statement; n-a11y's bank list;
 * payroll needs an employee with pay). The volume mirrors what a fresh
 * company needs to clear those floors, not what velo holds.
 *
 *   8 suppliers, 80 supplier invoices created and approved, 10 posted
 *   journals (one a month), 200 bank statement rows imported as one CSV,
 *   4 customers, 1 employee on a basic salary, 1 Sage migration session.
 */
import { randomUUID } from 'node:crypto';

const COUNTS = { suppliers: 8, invoices: 80, journals: 10, bankRows: 200, customers: 4 } as const;

const pad = (n: number): string => String(n).padStart(2, '0');

/** The last 10 complete calendar months before `now` (UTC), 'YYYY-MM', oldest first. */
export function seedMonths(now: Date): string[] {
  const here = now.getUTCFullYear() * 12 + now.getUTCMonth();
  const months: string[] = [];
  for (let back = 10; back >= 1; back--) {
    const at = here - back;
    months.push(`${Math.floor(at / 12)}-${pad((at % 12) + 1)}`);
  }
  return months;
}

/** Item i (1-based) on day 3..20 of one of `months`, round robin. */
export const seedDate = (months: string[], i: number): string => `${months[(i - 1) % months.length]}-${pad(3 + ((i * 7) % 18))}`;

const addDays = (iso: string, days: number): string => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);

interface Envelope { success?: boolean; data?: unknown }

function parseEnvelope(text: string): Envelope | null {
  try {
    return JSON.parse(text) as Envelope;
  } catch {
    return null; // not JSON: the caller reports the status and the text
  }
}

/** A logged-in client of the dev server: cookie jar, CSRF double-submit, {success,data} unwrapping. */
class Client {
  private readonly jar = new Map<string, string>();
  constructor(private readonly base: string) {}

  private absorb(res: Response): void {
    for (const c of res.headers.getSetCookie()) {
      const kv = c.split(';')[0] ?? '';
      const i = kv.indexOf('=');
      if (i > 0) this.jar.set(kv.slice(0, i), kv.slice(i + 1));
    }
  }

  private cookie(): string {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  async login(email: string, password: string): Promise<void> {
    const res = await fetch(`${this.base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    this.absorb(res);
    if (res.status !== 200) throw new Error(`seed login failed: ${res.status}`);
    // The middleware issues the CSRF cookie on any routed request.
    this.absorb(await fetch(`${this.base}/accounting`, { headers: { cookie: this.cookie() }, redirect: 'manual' }));
    if (!this.jar.get('isaflow_csrf')) throw new Error('seed: no isaflow_csrf cookie after login');
  }

  async call<T = unknown>(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: { cookie: this.cookie(), 'content-type': 'application/json', 'x-csrf-token': this.jar.get('isaflow_csrf') ?? '' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const json = parseEnvelope(text);
    if (res.status < 200 || res.status >= 300 || json?.success === false) {
      throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
    }
    return (json?.data ?? json) as T;
  }

  get<T = unknown>(path: string): Promise<T> { return this.call<T>('GET', path); }
  post<T = unknown>(path: string, body?: unknown): Promise<T> { return this.call<T>('POST', path, body); }
  put<T = unknown>(path: string, body?: unknown): Promise<T> { return this.call<T>('PUT', path, body); }
}

function say(msg: string): void {
  process.stdout.write(`[golden-seed] ${msg}\n`);
}

async function seedPeople(api: Client): Promise<void> {
  for (let k = 1; k <= COUNTS.customers; k++) {
    await api.post('/api/accounting/customers', { name: `Demo Customer ${k}`, email: `demo-customer-${k}@example.test` });
  }
  const component = await api.post<{ id: string }>('/api/payroll/components', { name: 'Basic Salary', sarsSourceCode: '3601', componentType: 'earning' });
  const employee = await api.post<{ id: string }>('/api/payroll/employees', {
    firstName: 'Thandi', lastName: 'Nkosi', employeeNumber: 'E001', employmentType: 'permanent', startDate: '2025-03-01',
    idNumber: '9001015800086', taxNumber: '1234567890', dateOfBirth: '1990-01-01',
  });
  await api.post(`/api/payroll/employees/${employee.id}/components`, { componentId: component.id, amount: 25000, effectiveFrom: '2025-03-01' });
  say(`${COUNTS.customers} customers, 1 employee`);
}

async function seedSuppliersAndInvoices(api: Client, months: string[]): Promise<void> {
  const suppliers: string[] = [];
  for (let k = 1; k <= COUNTS.suppliers; k++) {
    const made = await api.post<{ id: string }>('/api/accounting/suppliers-list', {
      name: `Demo Supplier ${k}`, email: `demo-supplier-${k}@example.test`, payment_terms: 30,
    });
    suppliers.push(made.id);
  }
  for (let i = 1; i <= COUNTS.invoices; i++) {
    const date = seedDate(months, i);
    const made = await api.post<{ id: string }>('/api/accounting/supplier-invoices', {
      invoiceNumber: `DEMO-AP-${i}`,
      supplierId: suppliers[i % suppliers.length],
      invoiceDate: date,
      dueDate: addDays(date, [14, 30, 45][i % 3]!),
      taxRate: 15,
      items: [
        { description: `Demo AP line ${i}a`, quantity: 1 + (i % 3), unitPrice: 100 + ((i * 37) % 900) },
        ...(i % 2 === 0 ? [{ description: `Demo AP line ${i}b`, quantity: 1, unitPrice: 50 + ((i * 11) % 200) }] : []),
      ],
    });
    await api.post('/api/accounting/supplier-invoices-action', { action: 'approve', invoiceId: made.id });
  }
  say(`${COUNTS.suppliers} suppliers, ${COUNTS.invoices} approved supplier invoices`);
}

async function seedJournals(api: Client, months: string[]): Promise<void> {
  const accounts = await api.get<Array<{ id: string; isSystemAccount?: boolean }>>('/api/accounting/chart-of-accounts?subtype=default_revenue');
  const revenue = accounts.find((a) => a.isSystemAccount === true);
  const bank = (await api.get<Array<{ id: string }>>('/api/accounting/bank-accounts'))[0];
  if (!revenue || !bank) throw new Error('seed: the company needs a default revenue account and a bank account');
  for (let m = 1; m <= COUNTS.journals; m++) {
    const description = `DEMO-JNL-${m}`;
    const amount = 1000 + m * 250;
    const entry = await api.post<{ id: string }>('/api/accounting/journal-entries', {
      entryDate: `${months[(m - 1) % months.length]}-15`,
      description,
      lines: [
        { glAccountId: bank.id, debit: amount, credit: 0, description: `${description} dr` },
        { glAccountId: revenue.id, debit: 0, credit: amount, description: `${description} cr` },
      ],
    });
    await api.post('/api/accounting/journal-entries-action', { id: entry.id, action: 'post' });
  }
  say(`${COUNTS.journals} posted journals`);
}

async function seedBankRows(api: Client, months: string[], today: string): Promise<void> {
  const bank = (await api.get<Array<{ id: string }>>('/api/accounting/bank-accounts'))[0];
  if (!bank) throw new Error('seed: the company needs a bank account');
  let balance = 10000;
  const lines = ['Date,Description,Amount,Balance,Reference'];
  for (let i = 1; i <= COUNTS.bankRows; i++) {
    const amount = i % 3 === 0 ? 400 + i : -(25 + ((i * 13) % 300));
    balance += amount;
    const date = seedDate(months, i).replace(/-/g, '/');
    lines.push(`${date},DEMO-BNK ${i} ${amount > 0 ? 'customer deposit' : 'supplies'},${amount.toFixed(2)},${balance.toFixed(2)},DEMO-BNK-${i}`);
  }
  await api.post('/api/accounting/bank-transactions-bulk-commit', {
    bankAccountId: bank.id, bulkImportId: randomUUID(), bulkSequence: 1, filename: 'demo-statement.csv', fileType: 'csv',
    statementDate: today, csvContent: lines.join('\n'), bankFormat: 'fnb', applyBankRules: false,
  });
  say(`${COUNTS.bankRows} bank rows imported`);
}

/**
 * The admin is a long-standing user, as velo's golden user is. Two things differ for a user this run just made, and
 * both get in the specs' way:
 *   - the setup guide pulses (an `animate-pulse` badge that settle() waits out forever) for a user first seen in the
 *     last 3 days while any task is open, and this run's company has open tasks: back-date the first-seen preference
 *     (what the app itself records on a first visit) by 30 days;
 *   - the first-visit tour (AccountingTour) puts a full-screen overlay over /accounting that intercepts clicks:
 *     record it as completed, as finishing it does.
 */
async function seedLongStandingUser(api: Client, now: Date): Promise<void> {
  const firstSeen = new Date(now.getTime() - 30 * 86400000).toISOString();
  await api.put('/api/auth/preferences', {
    preferences: { 'setup-guide-first-seen': firstSeen, onboarding_tour_completed: 'true' },
  });
  say('admin marked as a long-standing user (setup guide first seen 30 days ago, tour completed)');
}

async function main(): Promise<void> {
  const base = process.env.BASE_URL;
  const email = process.env.E2E_ADMIN_EMAIL;
  const password = process.env.E2E_ADMIN_PASSWORD;
  if (!base || !email || !password) throw new Error('BASE_URL, E2E_ADMIN_EMAIL and E2E_ADMIN_PASSWORD must be set');
  const api = new Client(base);
  await api.login(email, password);
  const now = new Date();
  const months = seedMonths(now);
  await seedLongStandingUser(api, now);
  await seedPeople(api);
  await seedSuppliersAndInvoices(api, months);
  await seedJournals(api, months);
  await seedBankRows(api, months, now.toISOString().slice(0, 10));
  await api.post('/api/accounting/migration/session', { sourceSystem: 'sage_cloud' });
  say('migration session created');
}

if ((import.meta as { main?: boolean }).main) {
  main().then(() => process.exit(0), (err: unknown) => {
    process.stderr.write(`[golden-seed] FAILED: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
