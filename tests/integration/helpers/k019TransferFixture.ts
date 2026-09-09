// Fixture builder for the transfer-link integration tests. Each scenario owns
// its own GL accounts, journals and bank rows, so tests never share state.
import type { Pool } from 'pg';

export const AMOUNT = 5000;
export const DAY = '2026-03-10';

export interface Scenario {
  /** The bank account the incoming legs land on. */
  targetBank: string;
  /** One free counterpart line on `targetBank` per seeded transfer. */
  freeLines: string[];
  /** The journal behind each free line, same order. */
  journals: string[];
  /** The other bank account of each transfer, same order. */
  sourceBanks: string[];
  /** The `imported` rows on `targetBank`. */
  imported: string[];
}

let seq = 0;
function code(prefix: string): string {
  seq += 1;
  return `${prefix}${String(seq).padStart(4, '0')}`;
}

async function addAccount(pool: Pool, companyId: string): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO gl_accounts(id,company_id,account_code,account_name,account_type,normal_balance)
     VALUES($1,$2,$3,'K019 bank','asset','debit')`,
    [id, companyId, code('K19')],
  );
  return id;
}

/**
 * Seed `transfers` allocated outgoing legs, each on its own bank account, each
 * with a journal carrying one free counterpart line on a single target bank,
 * plus `incoming` unallocated rows on that target bank.
 */
export async function seedScenario(
  pool: Pool,
  companyId: string,
  userId: string,
  transfers: number,
  incoming: number,
): Promise<Scenario> {
  const targetBank = await addAccount(pool, companyId);
  const s: Scenario = { targetBank, freeLines: [], journals: [], sourceBanks: [], imported: [] };

  for (let i = 0; i < transfers; i += 1) {
    const sourceBank = await addAccount(pool, companyId);
    const je = crypto.randomUUID();
    const srcLine = crypto.randomUUID();
    const targetLine = crypto.randomUUID();
    const srcTx = crypto.randomUUID();
    await pool.query(
      `INSERT INTO gl_journal_entries(id,company_id,entry_date,description,status,created_by)
       VALUES($1,$2,DATE '${DAY}','K019 transfer','posted',$3)`,
      [je, companyId, userId],
    );
    await pool.query(
      `INSERT INTO gl_journal_lines(id,company_id,journal_entry_id,gl_account_id,debit,credit)
       VALUES($1,$3,$4,$5,0,${AMOUNT}),($2,$3,$4,$6,${AMOUNT},0)`,
      [srcLine, targetLine, companyId, je, sourceBank, targetBank],
    );
    await pool.query(
      `INSERT INTO bank_transactions(id,company_id,bank_account_id,transaction_date,amount,description,status,matched_journal_line_id,transfer_journal_entry_id,allocation_type,allocated_entity_name)
       VALUES($1,$2,$3,DATE '${DAY}',${-AMOUNT},'K019 out','allocated',$4,$5,'transfer','K019 target')`,
      [srcTx, companyId, sourceBank, srcLine, je],
    );
    s.sourceBanks.push(sourceBank);
    s.journals.push(je);
    s.freeLines.push(targetLine);
  }

  for (let i = 0; i < incoming; i += 1) {
    const id = crypto.randomUUID();
    await pool.query(
      `INSERT INTO bank_transactions(id,company_id,bank_account_id,transaction_date,amount,description,status)
       VALUES($1,$2,$3,DATE '${DAY}',${AMOUNT},$4,'imported')`,
      [id, companyId, targetBank, `K019 in ${i}`],
    );
    s.imported.push(id);
  }
  return s;
}

/** Add a second free counterpart line on `targetBank` to an existing journal. */
export async function addSecondLegToJournal(
  pool: Pool,
  companyId: string,
  journalId: string,
  targetBank: string,
): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO gl_journal_lines(id,company_id,journal_entry_id,gl_account_id,debit,credit)
     VALUES($1,$2,$3,$4,${AMOUNT},0)`,
    [id, companyId, journalId, targetBank],
  );
  return id;
}

export async function rowsOn(pool: Pool, companyId: string, bankAccountId: string) {
  const { rows } = await pool.query(
    `SELECT id, status, matched_journal_line_id, transfer_journal_entry_id, counterparty_account_id
       FROM bank_transactions
      WHERE company_id=$1 AND bank_account_id=$2 ORDER BY description`,
    [companyId, bankAccountId],
  );
  return rows as Array<{
    id: string;
    status: string;
    matched_journal_line_id: string | null;
    transfer_journal_entry_id: string | null;
    counterparty_account_id: string | null;
  }>;
}

export async function cleanup(pool: Pool, companyIds: string[], userId: string): Promise<void> {
  await pool.query('DELETE FROM bank_transactions WHERE company_id=ANY($1::uuid[])', [companyIds]);
  await pool.query('DELETE FROM gl_journal_lines WHERE company_id=ANY($1::uuid[])', [companyIds]);
  await pool.query('DELETE FROM gl_journal_entries WHERE company_id=ANY($1::uuid[])', [companyIds]);
  await pool.query(
    `DELETE FROM gl_account_balances WHERE gl_account_id IN
       (SELECT id FROM gl_accounts WHERE company_id=ANY($1::uuid[]))`,
    [companyIds],
  );
  await pool.query('DELETE FROM gl_accounts WHERE company_id=ANY($1::uuid[])', [companyIds]);
  await pool.query('DELETE FROM companies WHERE id=ANY($1::uuid[])', [companyIds]);
  await pool.query('DELETE FROM users WHERE id=$1', [userId]);
}
