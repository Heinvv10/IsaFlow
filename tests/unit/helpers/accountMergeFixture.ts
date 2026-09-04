/**
 * Fixture for the DB-gated GL account merge tests.
 *
 * Everything here is created INSIDE the caller's transaction and rolled back,
 * so the rows never commit. It still refuses to run against production: dev and
 * production differ only in the database NAME on the same host and port.
 *
 * The shape is deliberate. A merge of two control accounts is only interesting
 * where the ledger is awkward — a line in a closed period, a line posted into
 * no period at all, a child account hanging off the source — so the fixture
 * builds exactly those states rather than a happy path.
 */
import type { PoolClient } from 'pg';
import { assertNotProductionDb } from '../../helpers/assertNotProductionDb';

export const MERGE_COMPANY_ID = '00000000-0000-0000-0000-000000000001';
const CREATED_BY = '00000000-0000-0000-0000-0000000000aa';

export interface MergeFixture {
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
  openPeriodId: string;
  closedPeriodId: string;
}

export function assertMergeTestDb(): void {
  assertNotProductionDb('This test creates GL accounts and journal lines.');
}

async function insertAccount(
  client: PoolClient,
  code: string,
  type: 'asset' | 'liability',
  opts: { parent?: string; system?: boolean; level?: number; subtype?: string | null } = {},
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO gl_accounts
       (company_id, account_code, account_name, account_type, account_subtype,
        normal_balance, parent_account_id, is_system_account, is_active, level)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, $9)
     RETURNING id`,
    [
      MERGE_COMPANY_ID, code, `Merge fixture ${code}`, type, opts.subtype ?? null,
      type === 'asset' ? 'debit' : 'credit', opts.parent ?? null,
      opts.system ?? false, opts.level ?? 1,
    ],
  );
  return rows[0]!.id;
}

async function insertEntry(
  client: PoolClient,
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
    [MERGE_COMPANY_ID, `MF-${Math.random().toString(36).slice(2, 10)}`, periodId, status, CREATED_BY],
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
    [MERGE_COMPANY_ID, entryId, debitAccount, amount, creditAccount],
  );
  return entryId;
}

/** Two periods of the demo company: one open, one closed. Null if it has neither. */
async function findPeriods(client: PoolClient): Promise<{ open: string; closed: string } | null> {
  const { rows } = await client.query<{ status: string; id: string }>(
    `SELECT DISTINCT ON (status) status, id FROM fiscal_periods
      WHERE company_id = $1 AND status IN ('open', 'closed')
      ORDER BY status, start_date DESC`,
    [MERGE_COMPANY_ID],
  );
  const open = rows.find((r) => r.status === 'open')?.id;
  const closed = rows.find((r) => r.status === 'closed')?.id;
  return open && closed ? { open, closed } : null;
}

/** Build the whole fixture. Returns null when the demo company lacks periods. */
export async function createMergeFixture(client: PoolClient): Promise<MergeFixture | null> {
  const periods = await findPeriods(client);
  if (!periods) return null;

  const suffix = Math.random().toString(36).slice(2, 8).toUpperCase();
  const contraId = await insertAccount(client, `ZC-${suffix}`, 'liability');
  const sourceId = await insertAccount(client, `ZS-${suffix}`, 'asset', { level: 1 });
  const targetId = await insertAccount(client, `ZT-${suffix}`, 'asset', { level: 2 });
  const childId = await insertAccount(client, `ZH-${suffix}`, 'asset', { parent: sourceId, level: 2 });
  const grandchildId = await insertAccount(client, `ZG-${suffix}`, 'asset', { parent: childId, level: 3 });
  const systemId = await insertAccount(client, `ZY-${suffix}`, 'asset', { system: true });
  const cleanSourceId = await insertAccount(client, `ZK-${suffix}`, 'asset', { level: 1 });
  const targetChildId = await insertAccount(client, `ZX-${suffix}`, 'asset', { parent: targetId, level: 3 });

  // Source: 100 + 200 open, 50 closed, 25 in no period at all.
  await insertEntry(client, periods.open, 'posted', sourceId, contraId, 100);
  await insertEntry(client, periods.open, 'posted', sourceId, contraId, 200);
  await insertEntry(client, periods.closed, 'posted', sourceId, contraId, 50);
  await insertEntry(client, null, 'posted', sourceId, contraId, 25);
  // Target's own history, so its "before" figure is not zero.
  await insertEntry(client, periods.open, 'posted', targetId, contraId, 40);
  // The clean source: nothing but open-period postings.
  await insertEntry(client, periods.open, 'posted', cleanSourceId, contraId, 700);

  return {
    companyId: MERGE_COMPANY_ID,
    sourceId, targetId, childId, grandchildId, contraId, systemId, cleanSourceId, targetChildId,
    openPeriodId: periods.open, closedPeriodId: periods.closed,
  };
}
