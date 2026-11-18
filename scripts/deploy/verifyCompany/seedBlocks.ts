/**
 * The blocks of data the post-deploy golden specs need in the Deploy Verification company, and how each reports what a
 * stopped run left. Every block finds its records by the seeders' own markers (scripts/ci/golden-hosted/seedMarkers.ts),
 * through bound parameters, scoped to this company, and is RESUMABLE: it makes only what is absent and finishes what was
 * made and not completed (an invoice not yet approved, a journal not yet posted), because a posted ledger row cannot be
 * deleted and a rerun must never double it.
 */
import type { ClientBase } from 'pg';
import {
  Client, EMPLOYEE, seedBankRows, seedCustomers, seedDate, seedEmployee, seedJournals, seedSuppliersAndInvoices,
  type EmployeeState, type SeedCounts,
} from '../../ci/golden-hosted/seed-demo-app';
import { CUSTOMER_INVOICES, FIXTURE_SUPPLIER, seedCustomerInvoices, seedFixtureSupplier } from '../../ci/golden-hosted/seed-golden-fixtures';
import { MARK, complete, type Marker, type Progress } from '../../ci/golden-hosted/seedMarkers';
import { sandboxSetupBody } from '../../../tests/e2e/golden-paths/helpers/sandboxSetup';
import { PRECREATED_SANDBOXES, type PrecreatedSandbox } from './sandboxes';
import { fyLabel, midFy } from './provisionDb';

/** Small on purpose; the hosted Demo's 8 / 80 / 10 / 200 / 4 is for specs that measure volume. */
export const VERIFY_COUNTS: SeedCounts = { suppliers: 4, invoices: 12, journals: 6, bankRows: 40, customers: 4 };

/** The cost-of-sales account the default chart lacks and z-budget-drivers' precheck needs. */
export const COST_OF_SALES = { accountCode: '5150', accountName: 'Cost of Sales', accountType: 'expense', accountSubtype: 'cost_of_sales', normalBalance: 'debit' } as const;
export const PRIOR_YEAR_JOURNAL = 'DEMO-JNL-PY';
export const budgetVersionName = (fy: number): string => `Deploy Verification original FY${fy}`;

export interface PlanContext { db: ClientBase; companyId: string; verifyUserId: string; now: Date }
export interface RunContext extends PlanContext { api: Client; months: string[] }
export interface BlockPlan { complete: boolean; run: (ctx: RunContext) => Promise<void> }
export interface Block { name: string; plan: (ctx: PlanContext) => Promise<BlockPlan> }

type Row = { n: number | null; id: string; done: boolean };

/** Progress of a marked record kind: `table.column` matched by the marker's pattern; `doneSql` says which rows are complete. */
async function progress(db: ClientBase, companyId: string, table: string, column: string, m: Marker, doneSql = 'true'): Promise<Progress> {
  const r = await db.query<Row>(
    `SELECT (regexp_match(${column}, $2))[1]::int AS n, id::text AS id, (${doneSql}) AS done FROM ${table} WHERE company_id = $1::uuid AND ${column} ~ $2`,
    [companyId, m.pattern]);
  return {
    ids: new Map(r.rows.map((x) => [x.n!, x.id])),
    done: new Set(r.rows.filter((x) => x.done).map((x) => x.n!)),
  };
}

const APPROVED = `status NOT IN ('draft', 'pending_approval')`;

const customersBlock = (c: SeedCounts): Block => ({
  name: 'customers',
  plan: async ({ db, companyId }) => {
    const have = await progress(db, companyId, 'customers', 'name', MARK.customer);
    return { complete: complete(c.customers, have), run: ({ api }) => seedCustomers(api, c, have).then(() => undefined) };
  },
});

const employeeBlock: Block = {
  name: 'employee on a basic salary',
  plan: async ({ db, companyId }) => {
    const emp = await db.query<{ id: string; attached: boolean }>(
      `SELECT e.id::text AS id, EXISTS (SELECT 1 FROM payroll_employee_components pc WHERE pc.employee_id = e.id) AS attached
         FROM payroll_employees e WHERE e.company_id = $1::uuid AND e.employee_number = $2`, [companyId, EMPLOYEE.number]);
    const comp = await db.query<{ id: string }>(`SELECT id::text AS id FROM payroll_components WHERE company_id = $1::uuid AND name = $2 ORDER BY created_at LIMIT 1`, [companyId, EMPLOYEE.component]);
    const have: EmployeeState = { componentId: comp.rows[0]?.id ?? null, employeeId: emp.rows[0]?.id ?? null, attached: emp.rows[0]?.attached ?? false };
    return { complete: have.employeeId !== null && have.attached, run: ({ api }) => seedEmployee(api, have) };
  },
};

const customerInvoicesBlock: Block = {
  name: 'approved customer invoices',
  plan: async ({ db, companyId }) => {
    const have = await progress(db, companyId, 'customer_invoices', 'notes', MARK.arNote, APPROVED);
    return {
      complete: complete(CUSTOMER_INVOICES, have),
      run: async ({ api, db: d, companyId: id, months }) => {
        const found = await progress(d, id, 'customers', 'name', MARK.customer);
        const ids = [...found.ids.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
        await seedCustomerInvoices(api, (i) => seedDate(months, i), ids, have);
      },
    };
  },
};

const fixtureSupplierBlock: Block = {
  name: 'fixture supplier',
  plan: async ({ db, companyId }) => {
    const r = await db.query(`SELECT 1 FROM suppliers WHERE company_id = $1::uuid AND name = $2`, [companyId, FIXTURE_SUPPLIER]);
    return { complete: (r.rowCount ?? 0) > 0, run: ({ api }) => seedFixtureSupplier(api) };
  },
};

const purchasesBlock = (c: SeedCounts): Block => ({
  name: 'suppliers and approved supplier invoices',
  plan: async ({ db, companyId }) => {
    const suppliers = await progress(db, companyId, 'suppliers', 'name', MARK.supplier);
    const invoices = await progress(db, companyId, 'supplier_invoices', 'invoice_number', MARK.apInvoice, APPROVED);
    return {
      complete: complete(c.suppliers, suppliers) && complete(c.invoices, invoices),
      run: ({ api, months }) => seedSuppliersAndInvoices(api, months, c, { suppliers, invoices }),
    };
  },
});

const journalsBlock = (c: SeedCounts): Block => ({
  name: 'posted journals',
  plan: async ({ db, companyId }) => {
    const have = await progress(db, companyId, 'gl_journal_entries', 'description', MARK.journal, `status = 'posted'`);
    return { complete: complete(c.journals, have), run: ({ api, months }) => seedJournals(api, months, c, have) };
  },
});

/**
 * One posted journal in the PREVIOUS financial year of the run's date, whatever month that is: the budget specs need
 * prior-year actuals for the current year, and the seeded months alone fall short of the previous year when the run is
 * in January or February.
 */
const priorYearJournalBlock: Block = {
  name: 'prior-year actuals journal',
  plan: async ({ db, companyId, now }) => {
    const r = await db.query<{ id: string; posted: boolean }>(
      `SELECT id::text AS id, status = 'posted' AS posted FROM gl_journal_entries WHERE company_id = $1::uuid AND description = $2`, [companyId, PRIOR_YEAR_JOURNAL]);
    const have = r.rows[0];
    return {
      complete: have?.posted === true,
      run: async ({ api }) => {
        let id = have?.id;
        if (id === undefined) {
          const accounts = await api.get<Array<{ id: string; isSystemAccount?: boolean }>>('/api/accounting/chart-of-accounts?subtype=default_revenue');
          const revenue = accounts.find((a) => a.isSystemAccount === true);
          const bank = (await api.get<Array<{ id: string }>>('/api/accounting/bank-accounts'))[0];
          if (!revenue || !bank) throw new Error('seed: the company needs a default revenue account and a bank account');
          id = (await api.post<{ id: string }>('/api/accounting/journal-entries', {
            entryDate: midFy(now, -1), description: PRIOR_YEAR_JOURNAL,
            lines: [
              { glAccountId: bank.id, debit: 5000, credit: 0, description: `${PRIOR_YEAR_JOURNAL} dr` },
              { glAccountId: revenue.id, debit: 0, credit: 5000, description: `${PRIOR_YEAR_JOURNAL} cr` },
            ],
          })).id;
        }
        await api.post('/api/accounting/journal-entries-action', { id, action: 'post' });
      },
    };
  },
};

const bankRowsBlock = (c: SeedCounts): Block => ({
  name: 'bank statement rows',
  plan: async ({ db, companyId }) => {
    const have = await progress(db, companyId, 'bank_transactions', 'description', MARK.bank);
    return { complete: complete(c.bankRows, have), run: ({ api, months, now }) => seedBankRows(api, months, now.toISOString().slice(0, 10), c, have.done) };
  },
});

const costOfSalesBlock: Block = {
  name: 'cost of sales account',
  plan: async ({ db, companyId }) => {
    const r = await db.query(`SELECT 1 FROM gl_accounts WHERE company_id = $1::uuid AND account_code = $2`, [companyId, COST_OF_SALES.accountCode]);
    return { complete: (r.rowCount ?? 0) > 0, run: async ({ api }) => { await api.post('/api/accounting/chart-of-accounts', COST_OF_SALES); } };
  },
};

/**
 * An original budget version for the current financial year and the next: the budget specs skip a year with none, and the
 * year rolls over on 1 March. Keyed by the year (not the name), so a yearly re-run tops up exactly the new year.
 */
const budgetBlock = (offset: 0 | 1): Block => ({
  name: offset === 0 ? 'budget original version, current year' : 'budget original version, next year',
  plan: async ({ db, companyId, now }) => {
    const fy = fyLabel(now) + offset;
    const r = await db.query(`SELECT 1 FROM budget_versions WHERE company_id = $1::uuid AND fiscal_year = $2 AND kind = 'original'`, [companyId, fy]);
    return {
      complete: (r.rowCount ?? 0) > 0,
      run: async ({ api }) => {
        const years = await api.get<{ fiscalYear: number }>('/api/accounting/budgets?years_only=1');
        if (years.fiscalYear !== fyLabel(now)) throw new Error(`the app's current budget year is ${years.fiscalYear}, this run computed ${fyLabel(now)}: the clock or the year-end setting differs; nothing was seeded for it`);
        await api.post('/api/accounting/budget-versions', { fiscalYear: fy, name: budgetVersionName(fy), kind: 'original' });
      },
    };
  },
});

/**
 * A spec's sandbox company (sandboxes.ts), made here through the SAME request the spec sends (sandboxSetupBody, fixed key) and
 * flagged is_demo, so the spec finds it and the suite never owns a company outside the demo flag (global setup refuses that).
 */
const sandboxBlock = (sb: PrecreatedSandbox): Block => ({
  name: `sandbox company "${sb.name}"`,
  plan: async ({ db, verifyUserId }) => {
    const find = async (d: ClientBase) => (await d.query<{ id: string; is_demo: boolean }>(
      `SELECT c.id::text AS id, c.is_demo FROM companies c JOIN company_users cu ON cu.company_id = c.id AND cu.user_id = $2 WHERE c.name = $1`,
      [sb.name, verifyUserId])).rows;
    const have = await find(db);
    return {
      complete: have.length === 1 && have[0]!.is_demo,
      run: async ({ api, db: d }) => {
        if (have.length === 0) await api.post('/api/onboarding/complete-setup', sandboxSetupBody(sb));
        const now = await find(d);
        if (now.length !== 1) throw new Error(`expected one "${sb.name}" for the verify user, found ${now.length}`);
        await d.query(`UPDATE companies SET is_demo = true WHERE id = $1::uuid AND is_demo = false`, [now[0]!.id]);
      },
    };
  },
});

/** Dependency order: a block may read what the ones before it made. */
export function buildBlocks(c: SeedCounts = VERIFY_COUNTS): Block[] {
  return [
    customersBlock(c), employeeBlock, customerInvoicesBlock, fixtureSupplierBlock, purchasesBlock(c), journalsBlock(c),
    priorYearJournalBlock, bankRowsBlock(c), costOfSalesBlock, budgetBlock(0), budgetBlock(1), ...PRECREATED_SANDBOXES.map(sandboxBlock),
  ];
}
