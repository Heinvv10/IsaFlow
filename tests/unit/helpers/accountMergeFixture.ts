/**
 * Fixture for the DB-gated GL account merge tests.
 *
 * Everything here is created INSIDE the caller's transaction and rolled back,
 * so the rows never commit. It still refuses to run against production: dev and
 * production differ only in the database NAME on the same host and port.
 *
 * **Each fixture creates its OWN COMPANY**, rather than borrowing the demo
 * company the way most DB-gated tests in this repo borrow "the first company
 * with an open period". Sharing one tenant across files that run in parallel
 * couples them: the reclassification workstream traced nine varying failures to
 * exactly that, racing for the next journal number on
 * `uq_gl_je_company_entry_number`. This fixture was never exposed to that
 * particular race — it supplies its own `MF-…` entry numbers, and
 * `trg_gl_je_entry_number` fires only `WHEN new.entry_number IS NULL` — but it
 * did hold `FOR UPDATE` locks on shared demo-company rows for up to five
 * seconds, which is the same coupling wearing a different failure. An own
 * company also means the fiscal periods are known rather than found, so a
 * period-close on the demo company cannot change what these tests exercise.
 *
 * The shape is deliberate. A merge of two control accounts is only interesting
 * where the ledger is awkward — a line in a closed period, a line posted into
 * no period at all, a child account hanging off the source — so the fixture
 * builds exactly those states rather than a happy path.
 */
import type { PoolClient } from 'pg';
import { assertNotProductionDb } from '../../helpers/assertNotProductionDb';

const CREATED_BY = '00000000-0000-0000-0000-0000000000aa';

export interface MergeFixture {
  /** Created by this fixture, and rolled back with it. Never a shared tenant. */
  companyId: string;
  /** asset, 2 posted lines in an open period, 1 closed-period line, 1 no-period line. */
  sourceId: string;
  /** asset, the merge target. Carries a posted line of its own. */
  targetId: string;
  /** asset child of source — must be reparented onto the target. */
  childId: string;
  /** asset grandchild of source — proves the level cascade reaches the subtree. */
  grandchildId: string;
  /** liability — the contra leg, and the account_type mismatch case. */
  contraId: string;
  /** asset, is_system_account = true — merging it away breaks auto-posting. */
  systemId: string;
  /** asset with only open-period lines: the one case that may actually merge. */
  cleanSourceId: string;
  /** A child the TARGET already had. Its level must not move. */
  targetChildId: string;
  /** asset, subtype `vat_input`, NOT a system account — the VAT201 attack target. */
  vatInputId: string;
  /** liability, subtype `tax`, NOT a system account — Brightsphere really has two of these. */
  taxSourceId: string;
  /** asset, subtype `bank`, with a bank_transactions row pointing at it. */
  bankSourceId: string;
  /** asset, subtype `bank`, no statement rows — same reporting class as the source. */
  bankTargetId: string;
  /** liability, NULL subtype, only open-period lines — the NULL -> payable case. */
  cleanLiabilitySourceId: string;
  /** asset, active, NULL subtype, and never posted to. */
  emptyTargetId: string;
  /** asset, deactivated — merging into it hides the balance from every picker. */
  inactiveTargetId: string;
  /** asset with only open-period lines, second one, for tests that consume cleanSource. */
  cleanSourceTwoId: string;
  openPeriodId: string;
  closedPeriodId: string;
}

export function assertMergeTestDb(): void {
  assertNotProductionDb('This test creates GL accounts and journal lines.');
}

async function insertAccount(
  client: PoolClient,
  companyId: string,
  code: string,
  type: 'asset' | 'liability',
  opts: {
    parent?: string; system?: boolean; level?: number;
    subtype?: string | null; active?: boolean;
  } = {},
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO gl_accounts
       (company_id, account_code, account_name, account_type, account_subtype,
        normal_balance, parent_account_id, is_system_account, is_active, level)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id`,
    [
      companyId, code, `Merge fixture ${code}`, type, opts.subtype ?? null,
      type === 'asset' ? 'debit' : 'credit', opts.parent ?? null,
      opts.system ?? false, opts.active ?? true, opts.level ?? 1,
    ],
  );
  return rows[0]!.id;
}

async function insertEntry(
  client: PoolClient,
  companyId: string,
  periodId: string | null,
  status: 'posted' | 'draft',
  debitAccount: string,
  creditAccount: string,
  amount: number,
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO gl_journal_entries
       (company_id, entry_number, entry_date, fiscal_period_id, description, status, created_by)
     VALUES ($1, $2, CURRENT_DATE, $3, 'merge fixture', $4, $5)
     RETURNING id`,
    [companyId, `MF-${Math.random().toString(36).slice(2, 10)}`, periodId, status, CREATED_BY],
  );
  const entryId = rows[0]!.id;
  // `trg_gl_je_fiscal_period` fills a NULL period in on INSERT, so the only way
  // to build the "posted into no period at all" state is to clear it after the
  // fact — and before the lines go in, so the balance-cache trigger sees the
  // same NULL a production row in that state would.
  if (periodId === null) {
    await client.query('UPDATE gl_journal_entries SET fiscal_period_id = NULL WHERE id = $1', [entryId]);
  }
  await client.query(
    `INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit)
     VALUES ($1, $2, $3, $4, 0), ($1, $2, $5, 0, $4)`,
    [companyId, entryId, debitAccount, amount, creditAccount],
  );
  return entryId;
}

/**
 * The company this fixture owns, and the two fiscal periods it needs — one open,
 * one closed. Created rather than found: a period-close on a shared tenant used
 * to be able to change what these tests exercise, or stop them running at all.
 */
async function createTenant(
  client: PoolClient,
): Promise<{ companyId: string; open: string; closed: string }> {
  const { rows } = await client.query<{ id: string }>(
    "INSERT INTO companies (name) VALUES ('ZZ merge fixture tenant') RETURNING id",
  );
  const companyId = rows[0]!.id;

  // The OPEN period covers today, so an entry dated CURRENT_DATE falls inside
  // it; the CLOSED one is the month before. `fiscal_periods` has an exclusion
  // constraint on overlapping ranges per company, which a fresh tenant cannot
  // trip.
  const insertPeriod = async (name: string, num: number, monthsBack: number, status: string) =>
    (await client.query<{ id: string }>(
      `INSERT INTO fiscal_periods
         (company_id, period_name, period_number, fiscal_year, start_date, end_date, status)
       VALUES (
         $1, $2, $3,
         EXTRACT(YEAR FROM CURRENT_DATE)::INT,
         (date_trunc('month', CURRENT_DATE) - make_interval(months => $4::INT))::DATE,
         (date_trunc('month', CURRENT_DATE) - make_interval(months => $4::INT)
            + INTERVAL '1 month' - INTERVAL '1 day')::DATE,
         $5
       ) RETURNING id`,
      [companyId, name, num, monthsBack, status],
    )).rows[0]!.id;

  const open = await insertPeriod('Merge fixture open', 2, 0, 'open');
  const closed = await insertPeriod('Merge fixture closed', 1, 1, 'closed');
  return { companyId, open, closed };
}

/** Build the whole fixture on a company of its own. */
export async function createMergeFixture(client: PoolClient): Promise<MergeFixture> {
  const { companyId, ...periods } = await createTenant(client);

  const suffix = Math.random().toString(36).slice(2, 8).toUpperCase();
  const contraId = await insertAccount(client, companyId, `ZC-${suffix}`, 'liability');
  const sourceId = await insertAccount(client, companyId, `ZS-${suffix}`, 'asset', { level: 1 });
  // A level-3 account remains report-visible when it carries children. This
  // general merge fixture must exercise a valid target; dedicated guard tests
  // own the level-2 header refusal.
  const targetId = await insertAccount(client, companyId, `ZT-${suffix}`, 'asset', { level: 3 });
  const childId = await insertAccount(client, companyId, `ZH-${suffix}`, 'asset', { parent: sourceId, level: 2 });
  const grandchildId = await insertAccount(client, companyId, `ZG-${suffix}`, 'asset', { parent: childId, level: 3 });
  const systemId = await insertAccount(client, companyId, `ZY-${suffix}`, 'asset', { system: true });
  const cleanSourceId = await insertAccount(client, companyId, `ZK-${suffix}`, 'asset', { level: 1 });
  const targetChildId = await insertAccount(client, companyId, `ZX-${suffix}`, 'asset', { parent: targetId, level: 4 });
  const vatInputId = await insertAccount(client, companyId, `ZV-${suffix}`, 'asset', { subtype: 'vat_input' });
  const taxSourceId = await insertAccount(client, companyId, `ZP-${suffix}`, 'liability', { subtype: 'tax' });
  const bankSourceId = await insertAccount(client, companyId, `ZB-${suffix}`, 'asset', { subtype: 'bank' });
  const bankTargetId = await insertAccount(client, companyId, `ZW-${suffix}`, 'asset', { subtype: 'bank' });
  const cleanLiabilitySourceId = await insertAccount(client, companyId, `ZQ-${suffix}`, 'liability');
  const emptyTargetId = await insertAccount(client, companyId, `ZE-${suffix}`, 'asset');
  const inactiveTargetId = await insertAccount(client, companyId, `ZI-${suffix}`, 'asset', { active: false });
  const cleanSourceTwoId = await insertAccount(client, companyId, `ZL-${suffix}`, 'asset', { level: 1 });

  // A statement row reaching the bank account through its FK — the state that
  // makes deactivating it leave those rows reachable from nothing.
  await client.query(
    `INSERT INTO bank_transactions (company_id, bank_account_id, transaction_date, amount, description, status)
     VALUES ($1, $2, CURRENT_DATE, -11.00, 'merge fixture bank tx', 'imported')`,
    [companyId, bankSourceId],
  );

  // Source: 100 + 200 open, 50 closed, 25 in no period at all.
  await insertEntry(client, companyId, periods.open, 'posted', sourceId, contraId, 100);
  await insertEntry(client, companyId, periods.open, 'posted', sourceId, contraId, 200);
  await insertEntry(client, companyId, periods.closed, 'posted', sourceId, contraId, 50);
  await insertEntry(client, companyId, null, 'posted', sourceId, contraId, 25);
  // Target's own history, so its "before" figure is not zero.
  await insertEntry(client, companyId, periods.open, 'posted', targetId, contraId, 40);
  // The clean source: nothing but open-period postings.
  await insertEntry(client, companyId, periods.open, 'posted', cleanSourceId, contraId, 700);
  await insertEntry(client, companyId, periods.open, 'posted', cleanSourceTwoId, contraId, 900);
  await insertEntry(client, companyId, periods.open, 'posted', cleanLiabilitySourceId, contraId, 300);

  return {
    companyId,
    sourceId, targetId, childId, grandchildId, contraId, systemId, cleanSourceId, targetChildId,
    vatInputId, taxSourceId, bankSourceId, bankTargetId, inactiveTargetId, cleanSourceTwoId,
    cleanLiabilitySourceId, emptyTargetId,
    openPeriodId: periods.open, closedPeriodId: periods.closed,
  };
}
