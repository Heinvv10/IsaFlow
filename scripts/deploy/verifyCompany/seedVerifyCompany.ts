/**
 * The data the post-deploy golden specs need in the Deploy Verification company, made THROUGH THE RUNNING APP as the verify
 * user (so every gate, trigger, numbering rule and posting path runs, as scripts/ci/golden-hosted/seed-demo-app.ts does for
 * the hosted CI Demo, whose seeders this reuses). Only what the 24 specs that run in production read: customers and an
 * employee on a basic salary, approved customer and supplier invoices, the 0GP-Golden-Supplier, some posted journals,
 * bank statement rows and an original budget version (the two budget specs skip a company without one). Smaller than
 * the CI Demo: no spec that runs in production measures volume.
 *
 * Idempotent per block: a block whose records are all there is skipped, one with none is made, and one with some is a
 * refusal (running it again would duplicate what is there). The records are found in the database by the seeders' own
 * markers (Demo Customer, DEMO-AR-, ...), scoped to this company.
 */
import type { ClientBase } from 'pg';
import {
  Client, seedBankRows, seedDate, seedJournals, seedMonths, seedPeople, seedSuppliersAndInvoices, type SeedCounts,
} from '../../ci/golden-hosted/seed-demo-app';
import { CUSTOMER_INVOICES, FIXTURE_SUPPLIER, seedCustomerInvoices, seedFixtureSupplier } from '../../ci/golden-hosted/seed-golden-fixtures';

/** Small on purpose; the hosted Demo's 8 / 80 / 10 / 200 / 4 is for specs that measure volume. */
export const VERIFY_COUNTS: SeedCounts = { suppliers: 4, invoices: 12, journals: 6, bankRows: 40, customers: 4 };

const BUDGET_VERSION_NAME = 'Deploy Verification original';

export interface Block {
  name: string;
  /** How many of the block's marker records exist now. */
  have: (db: ClientBase, companyId: string) => Promise<number>;
  /** How many a complete block leaves. */
  expected: number;
  run: (ctx: RunContext) => Promise<void>;
}

export interface RunContext { api: Client; db: ClientBase; companyId: string; months: string[]; now: Date }

const count = (sql: string) => async (db: ClientBase, companyId: string): Promise<number> =>
  Number((await db.query<{ n: string }>(sql, [companyId])).rows[0]!.n);

export const BLOCKS: Block[] = [
  {
    name: 'customers and one employee',
    have: count(`SELECT (SELECT count(*) FROM customers WHERE company_id = $1::uuid AND name LIKE 'Demo Customer %')
                      + (SELECT count(*) FROM payroll_employees WHERE company_id = $1::uuid AND employee_number = 'E001') AS n`),
    expected: VERIFY_COUNTS.customers + 1,
    run: async ({ api }) => { await seedPeople(api, VERIFY_COUNTS); },
  },
  {
    name: 'approved customer invoices',
    have: count(`SELECT count(*) AS n FROM customer_invoices WHERE company_id = $1::uuid AND notes LIKE 'DEMO-AR-%'`),
    expected: CUSTOMER_INVOICES,
    run: async ({ api, db, companyId, months }) => {
      const found = await db.query<{ id: string }>(`SELECT id::text AS id FROM customers WHERE company_id = $1::uuid AND name LIKE 'Demo Customer %' ORDER BY name`, [companyId]);
      await seedCustomerInvoices(api, (i) => seedDate(months, i), found.rows.map((r) => r.id));
    },
  },
  {
    name: 'fixture supplier',
    have: count(`SELECT count(*) AS n FROM suppliers WHERE company_id = $1::uuid AND name = '${FIXTURE_SUPPLIER}'`),
    expected: 1,
    run: ({ api }) => seedFixtureSupplier(api),
  },
  {
    name: 'suppliers and approved supplier invoices',
    have: count(`SELECT (SELECT count(*) FROM suppliers WHERE company_id = $1::uuid AND name LIKE 'Demo Supplier %')
                      + (SELECT count(*) FROM supplier_invoices WHERE company_id = $1::uuid AND invoice_number LIKE 'DEMO-AP-%') AS n`),
    expected: VERIFY_COUNTS.suppliers + VERIFY_COUNTS.invoices,
    run: ({ api, months }) => seedSuppliersAndInvoices(api, months, VERIFY_COUNTS),
  },
  {
    name: 'posted journals',
    have: count(`SELECT count(*) AS n FROM gl_journal_entries WHERE company_id = $1::uuid AND description LIKE 'DEMO-JNL-%' AND status = 'posted'`),
    expected: VERIFY_COUNTS.journals,
    run: ({ api, months }) => seedJournals(api, months, VERIFY_COUNTS),
  },
  {
    name: 'bank statement rows',
    have: count(`SELECT count(*) AS n FROM bank_transactions WHERE company_id = $1::uuid AND description LIKE 'DEMO-BNK %'`),
    expected: VERIFY_COUNTS.bankRows,
    run: ({ api, months, now }) => seedBankRows(api, months, now.toISOString().slice(0, 10), VERIFY_COUNTS),
  },
  {
    // v-budget-workspace and z-budget-drivers skip (not fail) a company whose year has no budget version; the year with
    // prior-year actuals is the current one, which GET /api/accounting/budgets names.
    name: 'budget original version',
    have: count(`SELECT count(*) AS n FROM budget_versions WHERE company_id = $1::uuid AND name = '${BUDGET_VERSION_NAME}'`),
    expected: 1,
    run: async ({ api }) => {
      const years = await api.get<{ fiscalYear: number }>('/api/accounting/budgets');
      await api.post('/api/accounting/budget-versions', { fiscalYear: years.fiscalYear, name: BUDGET_VERSION_NAME, kind: 'original' });
    },
  },
];

export type BlockState = 'make' | 'skip';

/** none -> make, all -> skip; anything between is a refusal, not a top-up. */
export function blockState(b: Pick<Block, 'name' | 'expected'>, have: number): BlockState {
  if (have === 0) return 'make';
  if (have === b.expected) return 'skip';
  throw new Error(`the verify company holds ${have} of the ${b.expected} records of "${b.name}": a half-made block. Re-running would duplicate them; remove the strays (or finish the block) by hand`);
}

/** What a run would do, per block, without writing: for --dry-run and the plan line. */
export async function planBlocks(db: ClientBase, companyId: string | null): Promise<Array<{ name: string; state: BlockState }>> {
  const plan: Array<{ name: string; state: BlockState }> = [];
  for (const b of BLOCKS) plan.push({ name: b.name, state: companyId ? blockState(b, await b.have(db, companyId)) : 'make' });
  return plan;
}

/** Logs in as the verify user, proves the app is on the company this run provisioned, then makes the blocks that are missing. */
export async function seedVerifyCompany(
  db: ClientBase, opts: { baseUrl: string; email: string; password: string; companyId: string; now?: Date },
): Promise<string[]> {
  const now = opts.now ?? new Date();
  const api = new Client(opts.baseUrl);
  await api.login(opts.email, opts.password);
  const mine = await api.get<{ activeCompanyId?: string }>('/api/accounting/companies?action=user-companies');
  if (mine.activeCompanyId !== opts.companyId) {
    throw new Error(`the app at ${opts.baseUrl} puts the verify user in company ${mine.activeCompanyId ?? 'none'}, not ${opts.companyId}: it is not backed by the database that was provisioned; nothing was seeded`);
  }
  const months = seedMonths(now);
  const made: string[] = [];
  for (const b of BLOCKS) {
    if (blockState(b, await b.have(db, opts.companyId)) === 'skip') continue;
    await b.run({ api, db, companyId: opts.companyId, months, now });
    made.push(b.name);
  }
  return made;
}
