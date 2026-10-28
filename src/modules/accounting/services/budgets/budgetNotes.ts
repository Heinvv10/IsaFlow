/**
 * Budget notes (P2 follow-up F1): the one writer of `accounting_budgets` left in the app. A note is
 * YEAR-scoped: one row per company, account and financial year
 * (uq_accounting_budgets_company_account_year, `WHERE gl_account_id IS NOT NULL`), shown on every
 * version of that year (decision D4, no migration). The legacy amount columns (`period_amounts`,
 * `annual_amount`, `total_amount`) are never written: migration 947 converted them and
 * `budget_months_from_legacy` would re-read them, so a new row leaves them at their defaults.
 *
 * - `setGridNote`: the grid's edit (D6). The year is the viewed version's, never the caller's; a
 *   locked version refuses (409), as its amounts do; the account must be the company's active leaf
 *   revenue/expense account. Trimmed, at most MAX_NOTE_LENGTH; blank clears (a row this module made
 *   and holding no legacy amounts is deleted; any other keeps its row). One audit row (entity
 *   `budget`, the viewed version) when something changed, never the text.
 *   Two writers of one note: last write wins (the upsert never raises 23505).
 * - `carryNotes`: a wizard seed into another year (D5) copies the source year's notes for the
 *   seeded leaf accounts, only where the target year has no non-blank note. Runs in the seed's
 *   savepoint, so a refused seed carries nothing.
 *
 * Neither moves the version's `updated_at` (the grid's token): a note is not an amount.
 */
import { sql, withSavepoint, type DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { RowLockTimeoutError, withRowLockBudget } from '../core/rowLockBudget';
import { auditBudgetWrite, holdYearRegistry } from './budgetVersionScope';
import { BudgetVersionError } from './budgetVersionTypes';
import { inputError } from './gridErrors';
import { isHeaderSql } from './headerSql';

export const MAX_NOTE_LENGTH = 2000;

/** `budget_name` of a row this module creates (the column is NOT NULL; nothing reads it). */
const NOTE_ROW_NAME = 'Notes';

export interface GridNoteInput { versionId: string; glAccountId: string; note: string | null }

/** The note as stored: trimmed, null when blank. A NUL character (Postgres text refuses it, 22021) is a 400. */
export function normaliseNote(note: string | null): string | null {
  const text = (note ?? '').trim();
  if (text.includes('\u0000')) throw inputError('A note cannot contain a NUL character');
  if (text.length > MAX_NOTE_LENGTH) throw inputError(`A note can be at most ${MAX_NOTE_LENGTH} characters`);
  return text === '' ? null : text;
}

/**
 * The version's year, read under FOR SHARE (bounded): a lock that starts now waits for this note,
 * and the row's `updated_at` is not touched. Another company's id is 404, a locked version 409.
 */
async function noteYear(companyId: string, versionId: string): Promise<number> {
  const rows = (await withRowLockBudget(
    () => sql`
      SELECT fiscal_year, status FROM budget_versions
       WHERE id = ${versionId}::UUID AND company_id = ${companyId}::UUID
       FOR SHARE
    `,
    () => new RowLockTimeoutError('This budget version'),
  )) as DbRow[];
  if (!rows[0]) throw new BudgetVersionError('BUDGET_VERSION_NOT_FOUND', 'Budget version not found');
  if (rows[0].status === 'locked') throw new BudgetVersionError('BUDGET_VERSION_LOCKED', 'This budget version is locked');
  return Number(rows[0].fiscal_year);
}

/** The company's active leaf revenue/expense account, or a 400 naming why not. */
async function assertNoteAccount(companyId: string, glAccountId: string): Promise<void> {
  const rows = (await sql`
    SELECT ga.account_type, ga.is_active, ${isHeaderSql()} AS is_header
      FROM gl_accounts ga
     WHERE ga.id = ${glAccountId}::UUID AND ga.company_id = ${companyId}::UUID
  `) as DbRow[];
  const a = rows[0];
  if (!a || (a.account_type !== 'revenue' && a.account_type !== 'expense')) throw inputError('The account is not a revenue or expense account of this company');
  if (a.is_header) throw inputError('A header account takes no note; add it to a sub-account');
  if (a.is_active === false) throw inputError('An inactive account takes no note');
}

export async function setGridNote(companyId: string, actor: { userId: string }, input: GridNoteInput): Promise<{ note: string | null }> {
  const note = normaliseNote(input.note);
  await holdYearRegistry(companyId);
  const fiscalYear = await noteYear(companyId, input.versionId);
  await assertNoteAccount(companyId, input.glAccountId);
  await withSavepoint('budget_grid_note', async () => {
    let changed: DbRow[];
    if (note === null) {
      // Only a row this module made (or a seed carried) and holding no legacy amounts is deleted;
      // any other header (a legacy one keeps its name, status and author) only has its notes cleared.
      const gone = (await sql`
        DELETE FROM accounting_budgets
         WHERE company_id = ${companyId}::UUID AND gl_account_id = ${input.glAccountId}::UUID AND fiscal_year = ${fiscalYear}
           AND budget_name = ${NOTE_ROW_NAME}
           AND COALESCE(period_amounts, '{}'::jsonb) = '{}'::jsonb AND COALESCE(total_amount, 0) = 0 AND COALESCE(annual_amount, 0) = 0
        RETURNING id
      `) as DbRow[];
      const cleared = (await sql`
        UPDATE accounting_budgets SET notes = NULL, updated_at = now()
         WHERE company_id = ${companyId}::UUID AND gl_account_id = ${input.glAccountId}::UUID AND fiscal_year = ${fiscalYear}
           AND notes IS NOT NULL
        RETURNING id
      `) as DbRow[];
      changed = [...gone, ...cleared];
    } else {
      changed = (await sql`
        INSERT INTO accounting_budgets (company_id, gl_account_id, fiscal_year, budget_name, notes, created_by)
        VALUES (${companyId}::UUID, ${input.glAccountId}::UUID, ${fiscalYear}, ${NOTE_ROW_NAME}, ${note}, ${actor.userId})
        ON CONFLICT (company_id, gl_account_id, fiscal_year) WHERE gl_account_id IS NOT NULL
        DO UPDATE SET notes = EXCLUDED.notes, updated_at = now()
         WHERE accounting_budgets.notes IS DISTINCT FROM EXCLUDED.notes
        RETURNING id
      `) as DbRow[];
    }
    // A save that changes nothing (the same text again, clearing no note) leaves no audit row.
    if (changed.length === 0) return;
    // The note also shows on the year's locked versions (D4): name them, so their history finds it.
    const locked = (await sql`
      SELECT id FROM budget_versions
       WHERE company_id = ${companyId}::UUID AND fiscal_year = ${fiscalYear} AND status = 'locked' ORDER BY id
    `) as DbRow[];
    await auditBudgetWrite(companyId, actor.userId, 'update', input.versionId, fiscalYear, {
      glAccountId: input.glAccountId, noteAction: note === null ? 'cleared' : 'set',
      ...(locked.length > 0 ? { alsoShownOnLocked: locked.map((r) => String(r.id)).join(',') } : {}),
    });
  });
  return { note };
}

/**
 * Copies `fromYear`'s non-blank notes of `accountIds` into `toYear` where `toYear` has none (a
 * blank target note counts as none), skipping headers and inactive accounts. Returns how many
 * notes were carried. Same year or no accounts: nothing to do (a year's notes are already shared).
 */
export async function carryNotes(companyId: string, userId: string, fromYear: number, toYear: number, accountIds: readonly string[]): Promise<number> {
  if (fromYear === toYear || accountIds.length === 0) return 0;
  const rows = (await sql`
    INSERT INTO accounting_budgets AS t (company_id, gl_account_id, fiscal_year, budget_name, notes, created_by)
    SELECT s.company_id, s.gl_account_id, ${toYear}, ${NOTE_ROW_NAME}, s.notes, ${userId}
      FROM accounting_budgets s
      JOIN gl_accounts ga ON ga.id = s.gl_account_id AND ga.company_id = s.company_id
     WHERE s.company_id = ${companyId}::UUID AND s.fiscal_year = ${fromYear}
       AND s.gl_account_id = ANY(${[...accountIds]}::UUID[])
       AND NULLIF(BTRIM(s.notes), '') IS NOT NULL
       AND ga.is_active IS NOT FALSE AND NOT ${isHeaderSql()}
     -- One order for every carry, so two seeds into the same year take the note rows' locks alike.
     ORDER BY s.gl_account_id
    ON CONFLICT (company_id, gl_account_id, fiscal_year) WHERE gl_account_id IS NOT NULL
    DO UPDATE SET notes = EXCLUDED.notes, updated_at = now()
     WHERE NULLIF(BTRIM(t.notes), '') IS NULL
    RETURNING t.gl_account_id
  `) as DbRow[];
  if (rows.length > 0) log.info('Carried budget notes', { companyId, fromYear, toYear, notes: rows.length }, 'accounting');
  return rows.length;
}
