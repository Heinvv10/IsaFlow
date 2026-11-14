/**
 * Give an already-seeded, approved credit note the posted journal an approval
 * leaves behind: `amount` on the control account (CR a `receivable` account for a
 * customer note, DR a `payable` account for a supplier note), balanced against a
 * contra account, and link it on `credit_notes.gl_journal_entry_id`.
 *
 * For suites that build their fixture with raw `pg` queries rather than
 * `l1FifoFixture`. Since brief step 7 an application is capped at what the
 * note's journal posted, so a note seeded with no journal (or a line-less one)
 * can no longer be applied by any path.
 */
interface Queryable {
  query: (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
}

async function account(db: Queryable, companyId: string, subtype: string, type: string, normal: string): Promise<string> {
  const found = await db.query(
    'SELECT id FROM gl_accounts WHERE company_id = $1 AND account_subtype = $2 ORDER BY account_code LIMIT 1',
    [companyId, subtype]);
  if (found.rows[0]) return String(found.rows[0].id);
  const code = `CNJ${subtype.slice(0, 4).toUpperCase()}${Math.floor(Math.random() * 1e5)}`;
  const made = await db.query(
    `INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype,
                              normal_balance, is_active, is_system_account)
     VALUES ($1, $2, $3, $4, $5, $6, true, false) RETURNING id`,
    [companyId, code, `${subtype} ${code}`, type, subtype, normal]);
  return String(made.rows[0]!.id);
}

export async function attachPostedJournal(
  db: Queryable,
  args: { companyId: string; userId: string; noteId: string; side: 'customer' | 'supplier'; amount: number },
): Promise<string> {
  const control = args.side === 'customer'
    ? await account(db, args.companyId, 'receivable', 'asset', 'debit')
    : await account(db, args.companyId, 'payable', 'liability', 'credit');
  const contra = await account(db, args.companyId, 'operating_expense', 'expense', 'debit');
  const je = await db.query(
    `INSERT INTO gl_journal_entries (company_id, entry_number, entry_date, description, status, source, created_by, posted_at)
     VALUES ($1, $2, '2026-03-01', 'Credit note (fixture)', 'posted', 'auto_credit_note', $3, NOW()) RETURNING id`,
    [args.companyId, `JE-CNJ-${args.noteId.slice(0, 8)}-${Math.floor(Math.random() * 1e9)}`, args.userId]);
  const jeId = String(je.rows[0]!.id);
  const [ctrlDr, ctrlCr] = args.side === 'supplier' ? [args.amount, 0] : [0, args.amount];
  await db.query(
    `INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit)
     VALUES ($1, $2, $3, $4, $5), ($1, $2, $6, $5, $4)`,
    [args.companyId, jeId, control, ctrlDr, ctrlCr, contra]);
  await db.query('UPDATE credit_notes SET gl_journal_entry_id = $1 WHERE id = $2 AND company_id = $3',
    [jeId, args.noteId, args.companyId]);
  return jeId;
}

/** Everything `attachPostedJournal` made for a company, in FK order — call AFTER its credit notes are deleted. */
export async function dropNoteJournals(db: Queryable, companyId: string): Promise<void> {
  await db.query('DELETE FROM gl_journal_lines WHERE company_id = $1', [companyId]);
  await db.query('DELETE FROM gl_journal_entries WHERE company_id = $1', [companyId]);
  await db.query('DELETE FROM gl_account_balances WHERE gl_account_id IN (SELECT id FROM gl_accounts WHERE company_id = $1)', [companyId]);
  await db.query('DELETE FROM gl_accounts WHERE company_id = $1', [companyId]);
}
